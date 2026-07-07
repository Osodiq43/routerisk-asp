import dotenv from "dotenv";
import CryptoJS from "crypto-js";

dotenv.config({ quiet: true });

const baseUrl = "https://web3.okx.com";
const apiKey = process.env.OKX_API_KEY || "";
const secretKey = process.env.OKX_SECRET_KEY || "";
const passphrase = process.env.OKX_PASSPHRASE || "";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeaders(method: string, requestPath: string, queryString = ""): Record<string, string> {
  const timestamp = new Date().toISOString();
  const stringToSign = timestamp + method + requestPath + queryString;
  const signature = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(stringToSign, secretKey));
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
  };
}

// Reasonable, low-risk sample params for each GET endpoint we can safely probe read-only.
// NOTE: This deliberately excludes anything that creates/broadcasts/cancels real orders
// or transactions (create-order, cancel-order, broadcast-transaction, swap, swap-instruction,
// approve-transaction) — those have side effects or need signed payloads and shouldn't be
// fired blind from a probe script. Those are listed separately below as "manual only."
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

interface ProbeTarget {
  name: string;
  path: string;
  params: Record<string, string>;
}

const probes: ProbeTarget[] = [
  { name: "all-tokens", path: "/api/v6/dex/aggregator/all-tokens", params: { chainIndex: "1" } },
  { name: "get-liquidity", path: "/api/v6/dex/aggregator/get-liquidity", params: { chainIndex: "1" } },
  {
    name: "history",
    path: "/api/v6/dex/aggregator/history",
    params: { chainIndex: "1", fromTokenAddress: WETH, toTokenAddress: USDT },
  },
  {
    name: "quote",
    path: "/api/v6/dex/aggregator/quote",
    params: {
      chainIndex: "1",
      fromTokenAddress: WETH,
      toTokenAddress: USDT,
      amount: "1000000000000000000",
      swapMode: "exactIn",
    },
  },
  { name: "supported-chain (aggregator)", path: "/api/v6/dex/aggregator/supported/chain", params: {} },
  { name: "market-rwa-tokens", path: "/api/v6/dex/market/rwa/tokens", params: { chainIndex: "1" } },
  { name: "social-news-latest", path: "/api/v6/dex/market/social/news/latest", params: {} },
  { name: "social-news-platforms", path: "/api/v6/dex/market/social/news/platforms", params: {} },
  { name: "social-sentiment-ranking", path: "/api/v6/dex/market/social/sentiment/ranking", params: {} },
  { name: "social-vibe-timeline", path: "/api/v6/dex/market/social/vibe/timeline", params: {} },
  { name: "social-vibe-top-kols", path: "/api/v6/dex/market/social/vibe/top-kols", params: {} },
  {
    name: "check-approvals",
    path: "/api/v6/dex/pre-transaction/check-approvals",
    params: { chainIndex: "1", tokenAddress: WETH, ownerAddress: WETH, amount: "1000000000000000000" },
  },
  {
    name: "gas-limit",
    path: "/api/v6/dex/pre-transaction/gas-limit",
    params: { chainIndex: "1", fromAddress: WETH, toAddress: USDT },
  },
  { name: "gas-price", path: "/api/v6/dex/pre-transaction/gas-price", params: { chainIndex: "1" } },
  { name: "nonce", path: "/api/v6/dex/pre-transaction/nonce", params: { chainIndex: "1", address: WETH } },
  { name: "supported-chain (pre-tx)", path: "/api/v6/dex/pre-transaction/supported/chain", params: {} },
  { name: "post-transaction-orders", path: "/api/v6/dex/post-transaction/orders", params: { chainIndex: "1", address: WETH } },
  {
    name: "intent-order-list",
    path: "/api/v6/dex/aggregator/intent/order-list",
    params: { chainIndex: "1", address: WETH },
  },
];

// These are NOT probed automatically — side effects, or need real signed payloads/tx hashes.
// Test these manually, one at a time, only when you actually need them:
const manualOnly = [
  "approve-transaction",
  "swap",
  "swap-instruction",
  "intent/auction-info",
  "intent/cancel-order",
  "intent/cancel-signdata",
  "intent/create-order",
  "intent/order-status",
  "pre-transaction/simulate", // needs a real unsigned tx payload
  "pre-transaction/broadcast-transaction", // BROADCASTS A REAL TX — never fire blind
  "social/news/by-symbol", // needs a symbol param, cheap to test manually
  "social/news/detail", // needs a specific news id
  "social/news/search", // needs a query param
  "social/sentiment/symbol", // needs a symbol param
];

async function probeAll() {
  console.error(`🔍 Probing ${probes.length} read-only endpoints (rate-limited to stay under 3 req/sec)...\n`);
  console.error(`⚠️  Skipping ${manualOnly.length} endpoints that need extra params or have side effects:`);
  console.error(`   ${manualOnly.join(", ")}\n`);

  const results: Record<string, { ok: boolean; sample: any }> = {};

  for (const probe of probes) {
    await delay(400); // stay under rate limits across all calls
    const query = new URLSearchParams(probe.params);
    const queryString = query.toString() ? `?${query.toString()}` : "";
    const url = `${baseUrl}${probe.path}${queryString}`;

    try {
      const response = await fetch(url, { method: "GET", headers: getHeaders("GET", probe.path, queryString) });
      const body = await response.json();
      results[probe.name] = { ok: response.ok, sample: body };
      console.error(`✅ ${probe.name} — HTTP ${response.status}`);
    } catch (e: any) {
      results[probe.name] = { ok: false, sample: { error: e.message } };
      console.error(`❌ ${probe.name} — ${e.message}`);
    }
  }

  console.error("\n\n========== FULL RAW RESULTS ==========\n");
  console.log(JSON.stringify(results, null, 2));
}

probeAll();