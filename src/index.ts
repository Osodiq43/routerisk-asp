import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import { exec } from "child_process";
import { OKXDexService } from "./services/okx-dex.js";
import { RouteRiskEngine } from "./engine.js";
import { RiskSynthesizer } from "./llm.js";

const dexService = new OKXDexService();
const riskEngine = new RouteRiskEngine();
const riskLLM = new RiskSynthesizer();

function buildMcpServer(): Server {
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
              chainId: { type: "string", description: "OKX unique identifier for the target chain index (e.g., '1' for Ethereum, '8453' for Base)" },
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

    try {
      const args = z.object({
        chainId: z.string(),
        fromTokenAddress: z.string(),
        toTokenAddress: z.string(),
        realAmount: z.string()
      }).parse(request.params.arguments);

      const chainOk = await dexService.isChainSupported(args.chainId);
      if (!chainOk) {
        return {
          content: [{ type: "text", text: `Chain ${args.chainId} is not in OKX's supported-chain list. Aborting.` }],
          isError: true
        };
      }

      console.error("Resolving token info for source token...");
      const fromTokenInfo = await dexService.getTokenInfo(args.chainId, args.fromTokenAddress);

      const quote = await dexService.getRouteQuote(args.chainId, args.fromTokenAddress, args.toTokenAddress, args.realAmount);

      const probeAmount = (BigInt(args.realAmount) / 100n).toString();
      console.error(`Firing probe quote (1% size = ${probeAmount} base units)...`);
      const probe = await dexService.getImpactScalingRisk(args.chainId, args.fromTokenAddress, args.toTokenAddress, probeAmount);

      let sentiment;
      if (fromTokenInfo.symbol) {
        console.error(`Fetching social sentiment for symbol: ${fromTokenInfo.symbol}...`);
        sentiment = await dexService.getSocialSentiment(fromTokenInfo.symbol);
      } else {
        console.error("Skipping sentiment lookup - token symbol unresolved.");
      }

      const finalAnalysisReport = riskEngine.analyzeRoute(quote, probe.probeImpact, probe.isLiveData, sentiment);

      console.error("Generating natural language security summary...");
      const aiBrief = await riskLLM.synthesize(finalAnalysisReport);

      const fullResultPayload = {
        ...finalAnalysisReport,
        aiSummary: aiBrief.summary,
        aiRecommendedAction: aiBrief.recommendedAction,
        isAiLive: aiBrief.isLiveSynthesis
      };

      return {
        content: [{ type: "text", text: JSON.stringify(fullResultPayload, null, 2) }]
      };

    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Internal MCP Server Error: ${error.message}` }],
        isError: true
      };
    }
  });

  return server;
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const activeTransports = new Map<string, SSEServerTransport>();
const activeServers = new Map<string, Server>();

let fallbackTransport: SSEServerTransport | null = null;
let fallbackServer: Server | null = null;

const activeCommercialTasks = new Map<string, any>();

// x402 pricing validation endpoint
app.post("/x402/validate", (req, res) => {
  const { buyerAgentId } = req.body;
  console.error(`[x402]: Incoming verification from Agent #${buyerAgentId || "Unknown"}`);

  res.status(200).json({
    valid: true,
    fee: "0",
    currency: "USDT",
    paymentMode: "free_tier",
    message: "Validation pass. Zero-fee tier operational."
  });
});

// Sync channel for direct task acceptance
app.post("/mcp/action/direct-accept", (req, res) => {
  const { taskId, buyerAgentId, paymentDetails } = req.body;
  console.error(`[Commerce]: Task #${taskId} accepted.`);

  activeCommercialTasks.set(taskId, {
    status: "accepted",
    buyerAgentId,
    timestamp: new Date().toISOString(),
    paymentDetails
  });

  res.status(200).json({
    ok: true,
    message: "Channel successfully opened."
  });
});

// Diagnostics path for checking task states
app.get("/mcp/tasks/:taskId", (req, res) => {
  const task = activeCommercialTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ ok: false, error: "Task reference not found." });
  }
  res.status(200).json({ ok: true, data: task });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/mcp", (req, res) => {
  if (req.headers.accept !== "text/event-stream" && !req.query.sessionId) {
    return res.status(200).json({
      status: "online",
      serviceType: "A2MCP",
      message: "RouteRisk MCP Server Endpoint Online."
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const sessionId = req.query.sessionId as string || Math.random().toString(36).substring(2);
  const messageUrl = `/mcp/messages?sessionId=${sessionId}`;

  const transport = new SSEServerTransport(messageUrl, res as any);
  const server = buildMcpServer(); 

  activeTransports.set(sessionId, transport);
  activeServers.set(sessionId, server);
  
  fallbackTransport = transport;
  fallbackServer = server;

  server.connect(transport).catch((error) => {
    console.error(`Failed to connect session ${sessionId}:`, error);
    activeTransports.delete(sessionId);
    activeServers.delete(sessionId);
    if (fallbackTransport === transport) fallbackTransport = null;
    if (fallbackServer === server) fallbackServer = null;
  });

  req.on("close", () => {
    activeTransports.delete(sessionId);
    activeServers.delete(sessionId);
    if (fallbackTransport === transport) fallbackTransport = null;
    if (fallbackServer === server) fallbackServer = null;
  });
});

app.post("/mcp/messages", (req, res) => {
  const sessionId = req.query.sessionId as string;
  let transport = activeTransports.get(sessionId);

  if (!transport && fallbackTransport) {
    transport = fallbackTransport;
  }

  if (transport) {
    transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No active SSE session found.");
  }
});

function startHeartbeatLoop() {
  runHeartbeat();
  setInterval(runHeartbeat, 3 * 60 * 1000);
}

function runHeartbeat() {
  exec("onchainos agent heartbeat", (error, stdout, stderr) => {
    if (error) {
      console.error(`[Heartbeat Error]: ${error.message}`);
      return;
    }
    if (stderr && !stderr.includes("warn")) {
      console.error(`[Heartbeat Warning]: ${stderr.trim()}`);
      return;
    }
    console.error(`[Heartbeat Sync]: ${stdout.trim() || "Pulse signaled online."}`);
  });
}

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.error(`RouteRisk MCP Security Firewall online on port ${PORT}`);
  startHeartbeatLoop();
});