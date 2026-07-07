import dotenv from "dotenv";
import CryptoJS from "crypto-js";

dotenv.config({ quiet: true });

export interface OKXRouteHop {
  dexName: string;
  percent: number;
  fromToken: string;
  toToken: string;
  fromTokenIndex: string; // "0" = top-level split; >"0" = downstream leg
}

export interface OKXRouteQuote {
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  priceImpactPercentage: number;
  routePath: OKXRouteHop[];
  isLiveData: boolean;
}

export interface SentimentResult {
  symbol: string;
  bullishPercent: number | null;
  bearishPercent: number | null;
  mentionCount: number | null;
  isLiveData: boolean;
}

export interface TokenInfo {
  decimals: number;
  symbol: string | null;
}

export class OKXDexService {
  private baseUrl = "https://web3.okx.com";
  private apiKey = process.env.OKX_API_KEY || "";
  private secretKey = process.env.OKX_SECRET_KEY || "";
  private passphrase = process.env.OKX_PASSPHRASE || "";

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getHeaders(method: string, requestPath: string, queryString = ""): Record<string, string> {
    const timestamp = new Date().toISOString();
    const stringToSign = timestamp + method + requestPath + queryString;
    const signature = CryptoJS.enc.Base64.stringify(CryptoJS.HmacSHA256(stringToSign, this.secretKey));

    return {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
    };
  }

  private async fetchWithThrottle(url: string, path: string, query = ""): Promise<any> {
    await this.delay(400);
    const response = await fetch(url, { method: "GET", headers: this.getHeaders("GET", path, query) });
    if (!response.ok) throw new Error(`HTTP Boundary Code: ${response.status}`);
    return await response.json();
  }

  private supportedChainsCache: Set<string> | null = null;

  // Validates chain support via /aggregator/supported/chain, caches result for process lifetime.
  // Fail-open on lookup error so a transient failure doesn't block a valid chain.
  async isChainSupported(chainIndex: string): Promise<boolean> {
    try {
      if (!this.supportedChainsCache) {
        const path = "/api/v6/dex/aggregator/supported/chain";
        const resData = await this.fetchWithThrottle(`${this.baseUrl}${path}`, path, "");
        if (resData.code !== "0" || !Array.isArray(resData.data)) {
          throw new Error(resData.msg || "Empty supported-chain data");
        }
        this.supportedChainsCache = new Set(
          resData.data.map((c: any) => String(c.chainIndex ?? c.chainId ?? ""))
        );
      }
      return this.supportedChainsCache.has(String(chainIndex));
    } catch (e: any) {
      console.error(`[CHAIN CHECK FALLBACK]: ${e.message}`);
      return true;
    }
  }

  // Resolves decimals and symbol for a token address via /all-tokens.
  // symbol: null signals sentiment lookup should be skipped, not assumed.
  async getTokenInfo(chainIndex: string, tokenAddress: string): Promise<TokenInfo> {
    try {
      const path = "/api/v6/dex/aggregator/all-tokens";
      const params = new URLSearchParams({ chainIndex });
      const queryString = `?${params.toString()}`;
      const resData = await this.fetchWithThrottle(`${this.baseUrl}${path}${queryString}`, path, queryString);
      const match = (resData?.data || []).find(
        (t: any) => t.tokenContractAddress?.toLowerCase() === tokenAddress.toLowerCase()
      );
      return {
        decimals: match?.decimals ? Number(match.decimals) : 18,
        symbol: match?.tokenSymbol || null,
      };
    } catch {
      return { decimals: 18, symbol: null };
    }
  }

  async getRouteQuote(chainIndex: string, fromToken: string, toToken: string, amount: string): Promise<OKXRouteQuote> {
    try {
      const path = "/api/v6/dex/aggregator/quote";
      const params = new URLSearchParams({
        amount,
        chainIndex,
        fromTokenAddress: fromToken,
        swapMode: "exactIn",
        toTokenAddress: toToken,
      });
      const queryString = `?${params.toString()}`;

      const resData = await this.fetchWithThrottle(`${this.baseUrl}${path}${queryString}`, path, queryString);
      if (resData.code !== "0" || !resData.data?.[0]) throw new Error(resData.msg || "Empty data");

      const data = resData.data[0];
      return {
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        amount,
        // real field is priceImpactPercent, no trailing "age"
        priceImpactPercentage: Number(data.priceImpactPercent) || 0,
        routePath: (data.dexRouterList || []).map((hop: any) => ({
          dexName: hop.dexProtocol?.dexName || "UNKNOWN_DEX",
          percent: Number(hop.dexProtocol?.percent) || 0,
          fromToken: hop.fromToken?.tokenContractAddress || fromToken,
          toToken: hop.toToken?.tokenContractAddress || toToken,
          fromTokenIndex: hop.fromTokenIndex ?? "0",
        })),
        isLiveData: true,
      };
    } catch (e: any) {
      console.error(`[FALLBACK TRIGGERED - getRouteQuote]: ${e.message}`);
      return {
        fromTokenAddress: fromToken,
        toTokenAddress: toToken,
        amount,
        priceImpactPercentage: 0.1,
        routePath: [{ dexName: "UNKNOWN_DEX", percent: 100, fromToken, toToken, fromTokenIndex: "0" }],
        isLiveData: false,
      };
    }
  }

  // Depth-risk proxy via a small probe quote compared against the real trade's impact.
  // No raw liquidity endpoint exists in this API; only touches the confirmed /quote endpoint.
  async getImpactScalingRisk(
    chainIndex: string,
    fromToken: string,
    toToken: string,
    probeAmount: string
  ): Promise<{ probeImpact: number; isLiveData: boolean }> {
    try {
      const path = "/api/v6/dex/aggregator/quote";
      const params = new URLSearchParams({
        amount: probeAmount,
        chainIndex,
        fromTokenAddress: fromToken,
        swapMode: "exactIn",
        toTokenAddress: toToken,
      });
      const queryString = `?${params.toString()}`;

      const resData = await this.fetchWithThrottle(`${this.baseUrl}${path}${queryString}`, path, queryString);
      if (resData.code !== "0" || !resData.data?.[0]) throw new Error(resData.msg || "Empty probe data");

      const probeImpact = Number(resData.data[0].priceImpactPercent) || 0;
      return { probeImpact, isLiveData: true };
    } catch (e: any) {
      console.error(`[FALLBACK TRIGGERED - getImpactScalingRisk]: ${e.message}`);
      return { probeImpact: 0, isLiveData: false };
    }
  }

  // Ratios from the API are decimals (0-1), e.g. 0.53 = 53% bullish.
  async getSocialSentiment(symbol: string): Promise<SentimentResult> {
    try {
      const path = "/api/v6/dex/market/social/sentiment/ranking";
      const resData = await this.fetchWithThrottle(`${this.baseUrl}${path}`, path, "");

      if (resData.code !== "0" || !Array.isArray(resData.data?.details)) {
        throw new Error(resData.msg || "Empty sentiment data");
      }

      const match = resData.data.details.find(
        (row: any) => (row.tokenSymbol || "").toUpperCase() === symbol.toUpperCase()
      );

      if (!match) throw new Error(`Symbol ${symbol} not found in sentiment ranking`);

      const bullishRatio = Number(match.sentiment?.bullishRatio);
      const bearishRatio = Number(match.sentiment?.bearishRatio);

      return {
        symbol,
        bullishPercent: Number.isFinite(bullishRatio) ? bullishRatio * 100 : null,
        bearishPercent: Number.isFinite(bearishRatio) ? bearishRatio * 100 : null,
        mentionCount: match.mentionCount !== undefined ? Number(match.mentionCount) : null,
        isLiveData: true,
      };
    } catch (e: any) {
      console.error(`[FALLBACK TRIGGERED - getSocialSentiment]: ${e.message}`);
      return { symbol, bullishPercent: null, bearishPercent: null, mentionCount: null, isLiveData: false };
    }
  }
}