import { RouteRiskEngine } from "./engine.js";
import { OKXRouteQuote, SentimentResult } from "./services/okx-dex.js";

function makeQuote(overrides: Partial<OKXRouteQuote> = {}): OKXRouteQuote {
  return {
    fromTokenAddress: "0xFROM",
    toTokenAddress: "0xTO",
    amount: "1000000000000000000",
    priceImpactPercentage: 0.01,
    routePath: [
      { dexName: "Uniswap V3", percent: 100, fromToken: "0xFROM", toToken: "0xTO", fromTokenIndex: "0" },
    ],
    isLiveData: true,
    ...overrides,
  };
}

function makeSentiment(overrides: Partial<SentimentResult> = {}): SentimentResult {
  return {
    symbol: "TEST",
    bullishPercent: 50,
    bearishPercent: 30,
    mentionCount: 40,
    isLiveData: true,
    ...overrides,
  };
}

interface Scenario {
  name: string;
  quote: OKXRouteQuote;
  probeImpact: number;
  probeIsLive: boolean;
  sentiment?: SentimentResult;
  expect: "APPROVED" | "WARNING" | "REJECTED" | "INSUFFICIENT_DATA";
}

const engine = new RouteRiskEngine();

const scenarios: Scenario[] = [
  {
    name: "Baseline safe route",
    quote: makeQuote(),
    probeImpact: 0.008,
    probeIsLive: true,
    sentiment: makeSentiment(),
    expect: "APPROVED",
  },
  {
    name: "High raw price impact (5% - large, costly trade)",
    quote: makeQuote({ priceImpactPercentage: 5.0 }),
    probeImpact: 0.01,
    probeIsLive: true,
    expect: "REJECTED",
  },
  {
    name: "Thin liquidity - impact scales 8x from probe to full size",
    quote: makeQuote({ priceImpactPercentage: 0.8 }),
    probeImpact: 0.1,
    probeIsLive: true,
    expect: "WARNING",
  },
  {
    name: "Single-venue concentration - one DEX handles 100% of route",
    quote: makeQuote({
      routePath: [
        { dexName: "SketchySwap", percent: 100, fromToken: "0xFROM", toToken: "0xTO", fromTokenIndex: "0" },
      ],
    }),
    probeImpact: 0.01,
    probeIsLive: true,
    // Concentration alone isn't disqualifying - a single venue is often the correct,
    // most efficient route. It's a contributing signal, not an independent red flag.
    expect: "APPROVED",
  },
  {
    name: "Unresolved DEX name in route (parsing/API reliability failure)",
    quote: makeQuote({
      routePath: [
        { dexName: "UNKNOWN_DEX", percent: 100, fromToken: "0xFROM", toToken: "0xTO", fromTokenIndex: "0" },
      ],
    }),
    probeImpact: 0.01,
    probeIsLive: true,
    expect: "APPROVED",
  },
  {
    name: "Sentiment pump pattern (95% bullish, 5000 mentions)",
    quote: makeQuote(),
    probeImpact: 0.01,
    probeIsLive: true,
    sentiment: makeSentiment({ bullishPercent: 95, mentionCount: 5000 }),
    expect: "APPROVED",
  },
  {
    name: "Quote call failed (fallback triggered upstream)",
    quote: makeQuote({ isLiveData: false }),
    probeImpact: 0,
    probeIsLive: true,
    expect: "INSUFFICIENT_DATA",
  },
  {
    name: "Probe call failed (fallback triggered upstream)",
    quote: makeQuote(),
    probeImpact: 0,
    probeIsLive: false,
    expect: "INSUFFICIENT_DATA",
  },
  {
    name: "WORST CASE - everything bad at once",
    quote: makeQuote({
      priceImpactPercentage: 6.0,
      routePath: [
        { dexName: "SketchySwap", percent: 100, fromToken: "0xFROM", toToken: "0xTO", fromTokenIndex: "0" },
      ],
    }),
    probeImpact: 0.05,
    probeIsLive: true,
    sentiment: makeSentiment({ bullishPercent: 97, mentionCount: 8000 }),
    expect: "REJECTED",
  },
];

let passCount = 0;
let failCount = 0;

console.log("=== ADVERSARIAL ENGINE TEST ===\n");

for (const s of scenarios) {
  const result = engine.analyzeRoute(s.quote, s.probeImpact, s.probeIsLive, s.sentiment);
  const pass = result.status === s.expect;
  pass ? passCount++ : failCount++;

  console.log(`${pass ? "PASS" : "FAIL"} - ${s.name}`);
  console.log(`   expected: ${s.expect} | got: ${result.status} | score: ${result.safetyScore}`);
  if (!pass) {
    console.log(`   FULL REPORT: ${JSON.stringify(result, null, 2)}`);
  }
  console.log("");
}

console.log(`=== ${passCount} passed, ${failCount} failed (of ${scenarios.length}) ===`);

if (failCount > 0) {
  console.log(
    "\nSome scenarios did not match expectations. Either the weighting/thresholds need\n" +
    "tuning, or an expectation above was set wrong. Don't trust the engine's danger\n" +
    "detection until every scenario here passes."
  );
  process.exit(1);
}