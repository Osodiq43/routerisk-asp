import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // Added missing import
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { OKXDexService } from "./services/okx-dex.js";
import { RouteRiskEngine } from "./engine.js";
import { RiskSynthesizer } from "./llm.js";

// Diagnostic and isolation imports
import crypto from "crypto";
import os from "os";
import { AsyncLocalStorage } from "async_hooks";
import url from "url";

// Unique process footprint
const PROCESS_ID = crypto.randomUUID().slice(0, 8);
const SYSTEM_HOSTNAME = os.hostname();

const dexService = new OKXDexService();
const riskEngine = new RouteRiskEngine();
const riskLLM = new RiskSynthesizer();

// Native thread-local storage to map logs directly to execution requests
const logLocalStorage = new AsyncLocalStorage<{ sessionId: string }>();

// Safe JSON Stringify helper
function safeJsonStringify(obj: any): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  , 2);
}

// Session mappings
const activeTransports = new Map<string, SSEServerTransport>();
const activeServers = new Map<string, Server>();
const sessionClientIdentifiers = new Map<string, string>(); // sessionId -> client-id

// WebSocket client mappings (WS instance -> clientId)
const wsClients = new Map<WebSocket, string>();

// Intercept console logging to stream execution loops to your terminal
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

function broadcastLog(message: string) {
  // Strict architectural filter to drop all process setup, routing maps, and infrastructure noise
  if (
    message.includes("[DIAGNOSTIC]") || 
    message.includes("=== SERVER STARTUP ===") || 
    message.includes("Hostname:") || 
    message.includes("PID:") || 
    message.includes("Active Session Map") || 
    message.includes("Incoming message to Process") ||
    message.includes("Target Session ID:") ||
    message.includes("Known Session IDs in memory") ||
    message.includes("MATCH FOUND on Process") ||
    message.includes("online on port")
  ) {
    return;
  }

  const store = logLocalStorage.getStore();
  
  if (store) {
    const activeSessionId = store.sessionId;
    const targetClientId = sessionClientIdentifiers.get(activeSessionId);
    
    if (targetClientId) {
      wsClients.forEach((wsClientId, clientWs) => {
        if (wsClientId === targetClientId && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(message);
        }
      });
    }
  }
}

console.error = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? safeJsonStringify(arg) : String(arg)).join(' ');
  originalConsoleError.apply(console, args);
  broadcastLog(msg);
};

console.log = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? safeJsonStringify(arg) : String(arg)).join(' ');
  originalConsoleLog.apply(console, args);
  broadcastLog(msg);
};

console.error(`[DIAGNOSTIC] === SERVER STARTUP ===`);
console.error(`[DIAGNOSTIC] Process Fingerprint: ${PROCESS_ID}`);
console.error(`[DIAGNOSTIC] Hostname: ${SYSTEM_HOSTNAME}`);
console.error(`[DIAGNOSTIC] PID: ${process.pid}`);

// Modified helper function to pass sessionId down to build scope context dynamically
function buildMcpServer(sessionId: string): Server {
  const server = new Server(
    { name: "routerisk-firewall", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "check_route_safety",
          description: "Summary:\nAnalyzes onchain dex trade swap routing paths for anomalies.\n\nInput requirements:\nTarget blockchain token addresses and full swap route path array payload.",
          inputSchema: {
            type: "object",
            properties: {
              chainId: { type: "string", description: "OKX unique identifier for the target chain index (e.g., '1' for Ethereum, '196' for XLayer)" },
              fromTokenAddress: { type: "string", description: "Contract address of the token being sold (source token)" },
              toTokenAddress: { type: "string", description: "Contract address of the token being bought (target token)" },
              realAmount: { type: "string", description: "The total trade execution size denominated in raw base units" }
            },
            required: ["chainId", "fromTokenAddress", "toTokenAddress", "realAmount"]
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "check_route_safety") {
      throw new Error(`Tool ${request.params.name} not found.`);
    }

    // Force run the entire handler pipeline inside our thread local storage context mapped to sessionId!
    return logLocalStorage.run({ sessionId }, async () => {
      try {
        const args = z.object({
          chainId: z.string(),
          fromTokenAddress: z.string(),
          toTokenAddress: z.string(),
          realAmount: z.string()
        }).parse(request.params.arguments);

        console.error(`[INPUTS]: ${JSON.stringify(args)}`);

        const chainOk = await dexService.isChainSupported(args.chainId);
        if (!chainOk) {
          return {
            content: [{ type: "text", text: `Chain ${args.chainId} is not in OKX's supported-chain list. Aborting.` }],
            isError: true
          };
        }

        console.error(`Resolving token info for source token on chainIndex ${args.chainId}...`);
        const fromTokenInfo = await dexService.getTokenInfo(args.chainId, args.fromTokenAddress);
        console.error(`[TOKEN INFO RESULT]: ${safeJsonStringify(fromTokenInfo)}`);

        const quote = await dexService.getRouteQuote(args.chainId, args.fromTokenAddress, args.toTokenAddress, args.realAmount);
        console.error(`[ROUTE QUOTE RESULT]: ${safeJsonStringify(quote)}`);

        const probeAmount = (BigInt(args.realAmount) / 100n).toString();
        console.error(`Firing probe quote (1% size = ${probeAmount} base units)...`);
        const probe = await dexService.getImpactScalingRisk(args.chainId, args.fromTokenAddress, args.toTokenAddress, probeAmount);
        console.error(`[PROBE QUOTE RESULT]: ${safeJsonStringify(probe)}`);

        let sentiment;
        if (fromTokenInfo.symbol) {
          console.error(`Fetching social sentiment for symbol: ${fromTokenInfo.symbol}...`);
          sentiment = await dexService.getSocialSentiment(fromTokenInfo.symbol);
          console.error(`[SENTIMENT RESULT]: ${safeJsonStringify(sentiment)}`);
        } else {
          console.error("Skipping sentiment lookup - token symbol unresolved.");
        }

        const finalAnalysisReport = riskEngine.analyzeRoute(quote, probe.probeImpact, probe.isLiveData, sentiment);
        console.error(`[DETERMINISTIC ENGINE REPORT]: ${safeJsonStringify(finalAnalysisReport)}`);
        
        console.error("Generating natural language security summary...");
        let aiBrief;
        
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("LLM synthesis request connection timed out after 6 seconds")), 6000)
          );
          
          aiBrief = await Promise.race([
            riskLLM.synthesize(finalAnalysisReport),
            timeoutPromise
          ]) as any;
        } catch (llmError: any) {
          console.error(`[EXPLICIT ERROR CAUGHT - LLM CALL FAILED]: ${llmError.stack || llmError.message}`);
          aiBrief = {
            summary: `Route evaluated with safety score ${finalAnalysisReport.safetyScore}/100. Verification Status: ${finalAnalysisReport.status}. (AI Summary Generation Offline)`,
            recommendedAction: finalAnalysisReport.status === "REJECTED" ? "Execution blocked by system policy." : "Proceed with extra routing slippage protection buffers.",
            isLiveSynthesis: false
          };
        }

        const fullResultPayload = {
          ...finalAnalysisReport,
          aiSummary: aiBrief.summary,
          aiRecommendedAction: aiBrief.recommendedAction
        };

        console.error(`[FINAL PAYLOAD DISPATCHING]: ${safeJsonStringify(fullResultPayload)}`);

        return {
          content: [{ type: "text", text: safeJsonStringify(fullResultPayload) }]
        };

      } catch (error: any) {
        console.error(`[CRITICAL MCP TOOL EXCEPTION]: ${error.stack || error.message}`);
        return {
          content: [{ type: "text", text: `Internal MCP Server Error: ${error.message}` }],
          isError: true
        };
      }
    });
  });

  return server;
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const NETWORK = "eip155:196";
const PAY_TO = process.env.PAY_TO_ADDRESS || "0x073e2d76e3a309a94663a252793eaf00ca24d7b8";

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY || "",
  secretKey: process.env.OKX_SECRET_KEY || "",
  passphrase: process.env.OKX_PASSPHRASE || "",
});

const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(NETWORK, new ExactEvmScheme());

// Header normalizer middleware
app.use((req, res, next) => {
  const rawSig = req.headers["payment-signature"];
  if (rawSig && !req.headers["authorization"]) {
    req.headers["authorization"] = String(rawSig).startsWith("Exact ") ? String(rawSig) : `Exact ${rawSig}`;
  }
  next();
});

// Conditionally hook OKX x402 billing if not bypassed
if (process.env.BYPASS_PAYMENT !== "true") {
  app.use(
    paymentMiddleware(
      {
        "GET /mcp": {
          accepts: [
            {
              scheme: "exact",
              network: NETWORK,
              payTo: PAY_TO,
              price: "$0",
            },
          ],
          description: "RouteRisk MCP -- DEX swap route safety scoring. Zero-fee tier.",
          mimeType: "application/json",
        },
      },
      resourceServer
    )
  );
} else {
  console.log("⚠️ Running in FREE 200 mode. Payment middleware bypassed.");
}

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/mcp/status", (req, res) => {
  res.status(200).json({
    status: "online",
    serviceType: "A2MCP",
    message: `RouteRisk MCP Server Endpoint Online. Mode: ${process.env.BYPASS_PAYMENT === "true" ? "FREE Bypass" : "x402 Active"}`
  });
});

// Unbuffered json endpoint to read active sessions. Filters and isolated by custom client-id header.
app.get("/mcp/active-sessions", (req, res) => {
  const targetId = req.headers["x-client-id"] || req.query.clientId;
  
  if (targetId) {
    const matchingSessions = Array.from(sessionClientIdentifiers.entries())
      .filter(([_, cid]) => cid === targetId)
      .map(([sid, _]) => sid);
      
    return res.status(200).json({
      processId: PROCESS_ID,
      activeSessionIds: matchingSessions
    });
  }

  res.status(200).json({
    processId: PROCESS_ID,
    activeSessionIds: Array.from(activeTransports.keys())
  });
});

app.get("/mcp", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const host = req.headers.host || "localhost:8080";
  const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const messageUrl = `${protocol}://${host}/mcp/messages`;

  const transport = new SSEServerTransport(messageUrl as any, res as any);
  const sessionId = transport.sessionId;

  // Capture client identifier for this specific sandbox session
  const clientId = req.headers["x-client-id"];
  if (clientId) {
    sessionClientIdentifiers.set(sessionId, String(clientId));
  }

  // Pass session ID down dynamically to link scope execution
  const sessionServer = buildMcpServer(sessionId);

  activeTransports.set(sessionId, transport);
  activeServers.set(sessionId, sessionServer);

  // Bind registration logging to this specific session execution context
  logLocalStorage.run({ sessionId }, () => {
    console.error(`[DIAGNOSTIC][GET /mcp] Process [${PROCESS_ID}] on [${SYSTEM_HOSTNAME}] created Session: "${sessionId}"`);
    console.error(`[DIAGNOSTIC][GET /mcp] Active Session Map on this process: [${[...activeTransports.keys()].join(", ")}]`);
  });

  sessionServer.connect(transport).catch((error) => {
    console.error(`Failed to connect session ${sessionId}:`, error);
    activeTransports.delete(sessionId);
    activeServers.delete(sessionId);
    sessionClientIdentifiers.delete(sessionId);
  });

  req.on("close", () => {
    logLocalStorage.run({ sessionId }, () => {
      console.error(`[DIAGNOSTIC][CLOSE /mcp] Process [${PROCESS_ID}] closed Session: "${sessionId}"`);
    });
    activeTransports.delete(sessionId);
    activeServers.delete(sessionId);
    sessionClientIdentifiers.delete(sessionId);
  });
});

app.post("/mcp/messages", (req, res) => {
  const sessionId = req.query.sessionId as string;

  // Execute logging tracking directly within the specific thread context
  logLocalStorage.run({ sessionId }, () => {
    console.error(`[DIAGNOSTIC][POST] Incoming message to Process [${PROCESS_ID}] on [${SYSTEM_HOSTNAME}]`);
    console.error(`[DIAGNOSTIC][POST] Target Session ID: "${sessionId}"`);
    console.error(`[DIAGNOSTIC][POST] Known Session IDs in memory on THIS process: [${[...activeTransports.keys()].join(", ")}]`);

    const transport = activeTransports.get(sessionId);
    if (transport) {
      console.error(`[DIAGNOSTIC][POST] MATCH FOUND on Process [${PROCESS_ID}]. Routing payload.`);
      transport.handlePostMessage(req, res, req.body);
    } else {
      console.error(`[DIAGNOSTIC][POST] MISMATCH! Process [${PROCESS_ID}] has no record of "${sessionId}". Sending 400.`);
      res.status(400).send(`No active SSE session found on process ${PROCESS_ID}.`);
    }
  });
});

// Setup server and bind WebSocket Server
const PORT = Number(process.env.PORT) || 8080;
const serverInstance = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket connection upgrades and read matching client ID parameters
serverInstance.on("upgrade", (request, socket, head) => {
  const parsedUrl = url.parse(request.url || "", true);
  if (parsedUrl.pathname === "/mcp/logs") {
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const clientId = String(parsedUrl.query.clientId || "");
      wss.emit("connection", ws, request, clientId);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket, request: http.IncomingMessage, clientId: string) => {
  wsClients.set(ws, clientId);
  ws.send(`[SYSTEM] Linked to RouteRisk Process ${PROCESS_ID} Log Streamer.`);
  ws.on("close", () => wsClients.delete(ws));
});

if (process.env.RUN_EXPRESS === "true" || process.env.NODE_ENV === "production") {
  serverInstance.listen(PORT, "0.0.0.0", () => {
    console.error(`RouteRisk MCP Security Firewall online on port ${PORT}`);
  });
} else {
  const transport = new StdioServerTransport();
  // Pass dynamic fallback ID for local testing
  const localServer = buildMcpServer("local-session");
  localServer.connect(transport).catch((error) => {
    console.error("Failed to connect standard transport:", error);
  });
}