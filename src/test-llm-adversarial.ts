import dotenv from "dotenv"
import { RiskSynthesizer } from "./llm.js";
import { IntegratedRiskReport } from "./engine.js";

dotenv.config({ quiet: true });

function makeReport(overrides: Partial<IntegratedRiskReport> = {}): IntegratedRiskReport {
  return {
    safetyScore: 85,
    status: "APPROVED",
    threatVectors: {
      liquidityDepthRisk: "STABLE: Price impact scales only 1.0x from probe to full size.",
      priceImpactRisk: "CLEAR: Price impact of 0.02% is within safe range.",
      routeConcentrationRisk: "DIVERSIFIED: No single venue dominates the route.",
      apiReliability: "EXCELLENT: Fully resolved routing path.",
      socialSentimentRisk: "NEUTRAL: No extreme sentiment skew detected (50% bullish).",
    },
    dataIntegrity: {
      quoteIsLive: true,
      probeIsLive: true,
      sentimentIsLive: true,
      note: "All scored values derived from live OKX endpoint responses, including sentiment.",
    },
    ...overrides,
  };
}

const REASSURING_LANGUAGE = [
  "safe to proceed", "low risk", "no concerns", "looks fine", "should be fine",
  "generally safe", "acceptable risk", "minor concern", "nothing to worry",
];

const ALARMIST_LANGUAGE = [
  "do not proceed", "dangerous", "reject", "avoid this route", "high risk", "critical",
];

async function runTests() {
  console.log("=== LLM SYNTHESIS ADVERSARIAL TEST ===\n");
  const synthesizer = new RiskSynthesizer();
  let passCount = 0;
  let failCount = 0;

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const check = (name: string, condition: boolean, detail: string) => {
    condition ? passCount++ : failCount++;
    console.log(`${condition ? "PASS" : "FAIL"} - ${name}`);
    if (!condition) console.log(`   ${detail}`);
  };

  const insufficientReport = makeReport({
    status: "INSUFFICIENT_DATA",
    safetyScore: 0,
    threatVectors: {
      liquidityDepthRisk: "UNKNOWN: Live data unavailable for this pass.",
      priceImpactRisk: "UNKNOWN: Live data unavailable for this pass.",
      routeConcentrationRisk: "UNKNOWN: Live data unavailable for this pass.",
      apiReliability: "UNKNOWN: Live data unavailable for this pass.",
      socialSentimentRisk: "UNKNOWN: Live data unavailable for this pass.",
    },
    dataIntegrity: { quoteIsLive: false, probeIsLive: true, sentimentIsLive: false, note: "test" },
  });
  const insufficientResult = await synthesizer.synthesize(insufficientReport);
  check(
    "INSUFFICIENT_DATA short-circuits without calling the LLM API",
    insufficientResult.isLiveSynthesis === false &&
      insufficientResult.summary.toLowerCase().includes("unable"),
    `Got: ${JSON.stringify(insufficientResult)}`
  );

  await wait(1500);

  const rejectedReport = makeReport({
    safetyScore: 15,
    status: "REJECTED",
    threatVectors: {
      liquidityDepthRisk: "CAUTION: Price impact scales 120.0x from probe to full size — thin route depth.",
      priceImpactRisk: "DANGER: OKX-reported price impact of 6% is high.",
      routeConcentrationRisk: "CAUTION: 100.0% of this route depends on a single DEX venue — single point of failure risk.",
      apiReliability: "EXCELLENT: Fully resolved routing path.",
      socialSentimentRisk: "CAUTION: 97% bullish skew with elevated mention volume — possible hype/pump pattern.",
    },
  });
  const rejectedResult = await synthesizer.synthesize(rejectedReport);
  const rejectedTextLower = (rejectedResult.summary + " " + rejectedResult.recommendedAction).toLowerCase();
  const containsReassurance = REASSURING_LANGUAGE.some((phrase) => rejectedTextLower.includes(phrase));
  check(
    "REJECTED report does not get softened into reassuring language",
    !containsReassurance,
    `Generated text: "${rejectedTextLower}"`
  );
  check(
    "REJECTED report's recommended action discourages execution",
    /do not|avoid|manual review|withhold/i.test(rejectedResult.recommendedAction),
    `Action was: "${rejectedResult.recommendedAction}"`
  );

  await wait(1500);

  const approvedReport = makeReport();
  const approvedResult = await synthesizer.synthesize(approvedReport);
  const approvedTextLower = (approvedResult.summary + " " + approvedResult.recommendedAction).toLowerCase();
  const containsAlarm = ALARMIST_LANGUAGE.some((phrase) => approvedTextLower.includes(phrase));
  check(
    "APPROVED report does not get inflated into alarmist language",
    !containsAlarm,
    `Generated text: "${approvedTextLower}"`
  );

  await wait(1500);

  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "";
  const brokenSynthesizer = new RiskSynthesizer();
  const fallbackResult = await brokenSynthesizer.synthesize(approvedReport);
  process.env.GROQ_API_KEY = originalKey;
  check(
    "Broken Groq API key falls back to templated summary instead of crashing",
    fallbackResult.isLiveSynthesis === false && fallbackResult.summary.length > 0,
    `Got: ${JSON.stringify(fallbackResult)}`
  );

  await wait(1500);

  const warningReport = makeReport({
    safetyScore: 65,
    status: "WARNING",
    threatVectors: {
      ...makeReport().threatVectors,
      liquidityDepthRisk: "CAUTION: Price impact scales 8.0x from probe to full size — thin route depth.",
    },
  });
  const warningResult = await synthesizer.synthesize(warningReport);
  const warningTextLower = (warningResult.summary + " " + warningResult.recommendedAction).toLowerCase();
  check(
    "WARNING report does not falsely read as fully safe",
    !REASSURING_LANGUAGE.some((phrase) => warningTextLower.includes(phrase)),
    `Generated text: "${warningTextLower}"`
  );

  console.log(`\n=== ${passCount} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log(
      "\nSome scenarios did not match expectations. Tighten the prompt constraints in llm.ts if failures persist."
    );
    process.exit(1);
  }
}

runTests();