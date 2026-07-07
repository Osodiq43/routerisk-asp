import { OKXRouteQuote, SentimentResult } from "./services/okx-dex.js";

export interface IntegratedRiskReport {
  safetyScore: number;
  status: "APPROVED" | "WARNING" | "REJECTED" | "INSUFFICIENT_DATA";
  threatVectors: {
    liquidityDepthRisk: string;
    priceImpactRisk: string;
    routeConcentrationRisk: string;
    apiReliability: string;
    socialSentimentRisk: string;
  };
  dataIntegrity: {
    quoteIsLive: boolean;
    probeIsLive: boolean;
    sentimentIsLive: boolean;
    note: string;
  };
}

export class RouteRiskEngine {
  public analyzeRoute(
    quote: OKXRouteQuote,
    probeImpact: number,
    probeIsLive: boolean,
    sentiment?: SentimentResult
  ): IntegratedRiskReport {
    const sentimentIsLive = sentiment?.isLiveData ?? false;

    // Core safety data must be live; sentiment is supplementary and does not gate scoring
    if (!quote.isLiveData || !probeIsLive) {
      return {
        safetyScore: 0,
        status: "INSUFFICIENT_DATA",
        threatVectors: {
          liquidityDepthRisk: "UNKNOWN: Live data unavailable for this pass.",
          priceImpactRisk: "UNKNOWN: Live data unavailable for this pass.",
          routeConcentrationRisk: "UNKNOWN: Live data unavailable for this pass.",
          apiReliability: "UNKNOWN: Live data unavailable for this pass.",
          socialSentimentRisk: "UNKNOWN: Live data unavailable for this pass.",
        },
        dataIntegrity: {
          quoteIsLive: quote.isLiveData,
          probeIsLive,
          sentimentIsLive,
          note: "One or more upstream OKX calls failed or returned a fallback. Score withheld rather than shown as fake-safe.",
        },
      };
    }

    // Impact-scaling ratio: use magnitude since priceImpactPercent can be negative
    const absQuoteImpact = Math.abs(quote.priceImpactPercentage);
    const absProbeImpact = Math.abs(probeImpact);
    const impactScalingRatio = absProbeImpact > 0.001 ? absQuoteImpact / absProbeImpact : 1;
    let liquidityScore = 100;
    if (impactScalingRatio > 5) liquidityScore = 30;
    else if (impactScalingRatio > 2) liquidityScore = 65;

    let priceImpactScore = 100;
    if (absQuoteImpact > 3.0) priceImpactScore = 20;
    else if (absQuoteImpact > 1.0) priceImpactScore = 60;

    // Only fromTokenIndex === "0" hops are top-level splits of the source token;
    // downstream legs would double-count percentages if included
    const topLevelHops = quote.routePath.filter((hop) => hop.fromTokenIndex === "0");
    const percentByVenue: Record<string, number> = {};
    for (const hop of topLevelHops) {
      percentByVenue[hop.dexName] = (percentByVenue[hop.dexName] || 0) + hop.percent;
    }
    const maxVenueConcentration =
      Object.values(percentByVenue).length > 0 ? Math.max(...Object.values(percentByVenue)) : 0;

    let concentrationScore = 100;
    if (maxVenueConcentration > 80) concentrationScore = 40;
    else if (maxVenueConcentration > 50) concentrationScore = 70;

    const apiScore =
      quote.routePath.length === 0 || quote.routePath.some((h) => h.dexName === "UNKNOWN_DEX") ? 50 : 100;

    let sentimentScore = 100;
    let sentimentMessage = "UNKNOWN: Sentiment data unavailable for this pass — not factored into score.";
    if (sentimentIsLive && sentiment && sentiment.bullishPercent !== null) {
      if (sentiment.bullishPercent > 90 && (sentiment.mentionCount ?? 0) > 1000) {
        sentimentScore = 60;
        sentimentMessage = `CAUTION: ${sentiment.bullishPercent}% bullish skew with elevated mention volume — possible hype/pump pattern.`;
      } else {
        sentimentMessage = `NEUTRAL: No extreme sentiment skew detected (${sentiment.bullishPercent}% bullish).`;
      }
    }

    const weights = sentimentIsLive
      ? { liquidity: 0.30, priceImpact: 0.30, concentration: 0.15, api: 0.10, sentiment: 0.15 }
      : { liquidity: 0.35, priceImpact: 0.35, concentration: 0.20, api: 0.10, sentiment: 0 };

    const finalSafetyScore = Math.round(
      liquidityScore * weights.liquidity +
        priceImpactScore * weights.priceImpact +
        concentrationScore * weights.concentration +
        apiScore * weights.api +
        sentimentScore * weights.sentiment
    );

    const status: IntegratedRiskReport["status"] =
      finalSafetyScore < 50 ? "REJECTED" : finalSafetyScore < 75 ? "WARNING" : "APPROVED";

    return {
      safetyScore: finalSafetyScore,
      status,
      threatVectors: {
        liquidityDepthRisk:
          liquidityScore < 50
            ? `CAUTION: Price impact scales ${impactScalingRatio.toFixed(1)}x from probe to full size — thin route depth.`
            : `STABLE: Price impact scales only ${impactScalingRatio.toFixed(1)}x from probe to full size.`,
        priceImpactRisk:
          priceImpactScore < 50
            ? `DANGER: OKX-reported price impact of ${quote.priceImpactPercentage}% is high.`
            : `CLEAR: Price impact of ${quote.priceImpactPercentage}% is within safe range.`,
        routeConcentrationRisk:
          concentrationScore < 100
            ? `CAUTION: ${maxVenueConcentration.toFixed(1)}% of this route depends on a single DEX venue — single point of failure risk.`
            : `DIVERSIFIED: No single venue dominates the route.`,
        apiReliability:
          apiScore < 100 ? "WARNING: Unresolved DEX name in routing path." : "EXCELLENT: Fully resolved routing path.",
        socialSentimentRisk: sentimentMessage,
      },
      dataIntegrity: {
        quoteIsLive: true,
        probeIsLive: true,
        sentimentIsLive,
        note: sentimentIsLive
          ? "All scored values derived from live OKX endpoint responses, including sentiment."
          : "Core safety score derived from live OKX data. Sentiment vector unavailable this pass and excluded (weights renormalized), not faked.",
      },
    };
  }
}