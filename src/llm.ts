import { IntegratedRiskReport } from "./engine.js";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export interface SynthesizedReport {
  summary: string;
  recommendedAction: string;
  isLiveSynthesis: boolean;
}

export class RiskSynthesizer {
  private apiKey = process.env.GROQ_API_KEY || "";
  private endpoint = "https://api.groq.com/openai/v1/chat/completions";

  async synthesize(report: IntegratedRiskReport): Promise<SynthesizedReport> {
    if (report.status === "INSUFFICIENT_DATA") {
      return {
        summary: "Unable to generate a risk assessment: one or more required upstream data sources were unavailable for this pass.",
        recommendedAction: "Retry the request. Do not proceed with this route until a full assessment succeeds.",
        isLiveSynthesis: false,
      };
    }

    if (!this.apiKey) {
      console.warn("[WARN - RiskSynthesizer]: GROQ_API_KEY is blank. Using local fallback module.");
      return { ...this.templatedFallback(report), isLiveSynthesis: false };
    }

    try {
      const prompt = this.buildPrompt(report);
      console.error(`[DEBUG LLM PROMPT SENT TO GROQ]:\n${prompt}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 250,
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Groq API returned HTTP status ${response.status}`);
      }

      const data = await response.json() as any;
      const text = data?.choices?.[0]?.message?.content;
      console.error(`[DEBUG LLM RAW RESPONSE RECEIVED]:\n${text}`);

      if (!text) throw new Error("Empty text returned from Groq response channel");

      const parsed = this.parseModelOutput(text);
      return { ...parsed, isLiveSynthesis: true };
    } catch (e: any) {
      console.warn(`[API FALLBACK - RiskSynthesizer]: ${e.message || "Unknown error"}`);
      return { ...this.templatedFallback(report), isLiveSynthesis: false };
    }
  }

  private buildPrompt(report: IntegratedRiskReport): string {
    return `You are a security dispatch narrator for a DeFi routing risk system. You do NOT judge risk yourself — a deterministic scoring engine has already produced the verdict below. Your only job is to explain it clearly in plain language for a trading agent or developer deciding whether to execute this route.

RULES:
- Never contradict or soften the given status/score. If status is REJECTED, your summary must clearly convey danger, not hedge it.
- Reference only the data provided below. Do not invent numbers, causes, or context not present here.
- Keep it to 2-3 sentences for the summary, 1 sentence for the recommended action.
- Respond in exactly this format, nothing else:
SUMMARY: <text>
ACTION: <text>

VERDICT DATA:
Score: ${report.safetyScore}/100
Status: ${report.status}
Liquidity depth: ${report.threatVectors.liquidityDepthRisk}
Price impact: ${report.threatVectors.priceImpactRisk}
Route concentration: ${report.threatVectors.routeConcentrationRisk}
API reliability: ${report.threatVectors.apiReliability}
Social sentiment: ${report.threatVectors.socialSentimentRisk}`;
  }

  private parseModelOutput(text: string): { summary: string; recommendedAction: string } {
    const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=\n(?:ACTION|SUMMARY):|$)/is);
    const actionMatch = text.match(/ACTION:\s*(.+)/is);
    
    if (summaryMatch && actionMatch) {
      return {
        summary: summaryMatch[1].trim(),
        recommendedAction: actionMatch[1].trim(),
      };
    }

    console.warn("[WARN]: Model layout match failed. Using raw block separation.");
    return {
      summary: text.replace(/(SUMMARY|ACTION):/gi, "").substring(0, 150).trim(),
      recommendedAction: "Review route verification engine parameters manually."
    };
  }

  private templatedFallback(report: IntegratedRiskReport): { summary: string; recommendedAction: string } {
    const vectorLines = Object.values(report.threatVectors).join(" ");
    return {
      summary: `Route scored ${report.safetyScore}/100 (${report.status}). ${vectorLines}`,
      recommendedAction:
        report.status === "REJECTED"
          ? "Do not execute this route without manual review."
          : report.status === "WARNING"
          ? "Proceed only with reduced size or added slippage protection."
          : "Route appears safe to execute under current conditions.",
    };
  }
}