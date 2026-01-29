import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import {
  handleMcpRequest,
  setExtensionWebSocket,
  handleBrowserToolResponse,
} from "./mcp/handler.js";
import { log } from "./logger.js";

// Get the directory of this file to resolve public folder path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "..", "public");

export interface ServerConfig {
  port: number;
  command: string;
  args: string[];
  cwd: string;
  debug?: boolean;
}

// Track connected clients and their agent connections
interface ClientState {
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  sessionId: string | null;
}

// Module-level state (set when server starts)
let AGENT_COMMAND: string;
let AGENT_ARGS: string[];
let AGENT_CWD: string;
let SERVER_PORT: number;

const clients = new Map<WSContext, ClientState>();

// Send a message to the WebSocket client
function send(ws: WSContext, type: string, payload?: unknown): void {
  if (ws.readyState === 1) {
    // WebSocket.OPEN
    ws.send(JSON.stringify({ type, payload }));
  }
}

// Create a Client implementation that forwards events to WebSocket
function createClient(ws: WSContext): acp.Client {
  return {
    async requestPermission(params) {
      log.debug("Permission requested", { title: params.toolCall.title });
      send(ws, "permission_request", params);

      // For now, auto-approve with the first option
      // TODO: Wait for user response from WebSocket
      return {
        outcome: {
          outcome: "selected",
          optionId: params.options[0]?.optionId || "",
        },
      };
    },

    async sessionUpdate(params) {
      send(ws, "session_update", params);
    },

    async readTextFile(params) {
      log.debug("Read file", { path: params.path });
      // TODO: Forward to extension to read file
      return { content: "" };
    },

    async writeTextFile(params) {
      log.debug("Write file", { path: params.path });
      // TODO: Forward to extension to write file
      return {};
    },
  };
}

async function handleConnect(ws: WSContext): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  // Kill existing process if any
  if (state.process) {
    state.process.kill();
    state.process = null;
    state.connection = null;
  }

  try {
    log.info("Spawning agent", { command: AGENT_COMMAND, args: AGENT_ARGS });

    // Spawn the agent process using Node.js child_process
    const agentProcess = spawn(AGENT_COMMAND, AGENT_ARGS, {
      cwd: AGENT_CWD,
      stdio: ["pipe", "pipe", "inherit"],
    });

    state.process = agentProcess;

    // Create streams for ACP SDK
    const input = Writable.toWeb(
      agentProcess.stdin!,
    ) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(
      agentProcess.stdout!,
    ) as unknown as ReadableStream<Uint8Array>;

    // Create ACP connection
    const stream = acp.ndJsonStream(input, output);
    const connection = new acp.ClientSideConnection(
      (_agent) => createClient(ws),
      stream,
    );

    state.connection = connection;

    // Initialize the connection
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: "zed",
        version: "1.0.0",
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    log.info("Agent initialized", { protocolVersion: initResult.protocolVersion });

    send(ws, "status", {
      connected: true,
      agentInfo: initResult.agentInfo,
      capabilities: initResult.agentCapabilities,
    });

    // Handle connection close
    connection.closed.then(() => {
      log.info("Agent connection closed");
      state.connection = null;
      state.sessionId = null;
      send(ws, "status", { connected: false });
    });
  } catch (error) {
    log.error("Failed to connect", { error: (error as Error).message });
    send(ws, "error", {
      message: `Failed to connect: ${(error as Error).message}`,
    });
  }
}

async function handleNewSession(
  ws: WSContext,
  params: { cwd?: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  try {
    const result = await state.connection.newSession({
      cwd: params.cwd || AGENT_CWD,
      mcpServers: [
        {
          type: "http",
          url: `http://localhost:${SERVER_PORT}/mcp`,
          name: "browser",
          headers: [],
        },
      ],
    });

    state.sessionId = result.sessionId;
    log.info("Session created", { sessionId: result.sessionId });
    send(ws, "session_created", result);
  } catch (error) {
    log.error("Failed to create session", { error: (error as Error).message });
    send(ws, "error", {
      message: `Failed to create session: ${(error as Error).message}`,
    });
  }
}

async function handlePrompt(
  ws: WSContext,
  params: { text: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection || !state.sessionId) {
    send(ws, "error", { message: "No active session" });
    return;
  }

  try {
    log.debug("Sending prompt", { text: params.text.slice(0, 100) });

    const result = await state.connection.prompt({
      sessionId: state.sessionId,
      prompt: [{ type: "text", text: params.text }],
    });

    log.info("Prompt completed", { stopReason: result.stopReason });
    send(ws, "prompt_complete", result);
  } catch (error) {
    log.error("Prompt failed", { error: (error as Error).message });
    send(ws, "error", {
      message: `Prompt failed: ${(error as Error).message}`,
    });
  }
}

function handleDisconnect(ws: WSContext): void {
  const state = clients.get(ws);
  if (!state) return;

  if (state.process) {
    state.process.kill();
    state.process = null;
  }
  state.connection = null;
  state.sessionId = null;

  send(ws, "status", { connected: false });
}

interface ProxyMessage {
  type: "connect" | "disconnect" | "new_session" | "prompt" | "cancel";
  payload?: { cwd?: string } | { text: string };
}

export async function startServer(config: ServerConfig): Promise<void> {
  const { port, command, args, cwd } = config;

  // Set module-level config
  AGENT_COMMAND = command;
  AGENT_ARGS = args;
  AGENT_CWD = cwd;
  SERVER_PORT = port;

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  // Root endpoint - redirect to PWA
  app.get("/", (c) => {
    return c.redirect("/app/");
  });

  // MCP Streamable HTTP endpoint for browser tool
  app.post("/mcp", handleMcpRequest);

  // Serve PWA from /app (use absolute path so it works from any CWD)
  app.use("/app/*", serveStatic({
    root: PUBLIC_DIR,
    rewriteRequestPath: (path) => path.replace(/^\/app/, ""),
  }));

  // Redirect /app to /app/ for clean URLs
  app.get("/app", (c) => c.redirect("/app/"));

  // WebSocket endpoint
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        log.info("Client connected");
        clients.set(ws, { process: null, connection: null, sessionId: null });
        // Register this WebSocket for browser tool calls
        setExtensionWebSocket(ws);
      },
      async onMessage(event, ws) {
        try {
          const data = JSON.parse(event.data.toString());
          log.debug("Received message", { type: data.type });

          switch (data.type) {
            case "connect":
              await handleConnect(ws);
              break;
            case "disconnect":
              handleDisconnect(ws);
              break;
            case "new_session":
              await handleNewSession(
                ws,
                (data.payload as { cwd?: string }) || {},
              );
              break;
            case "prompt":
              await handlePrompt(ws, data.payload as { text: string });
              break;
            case "browser_tool_result":
              // Handle response from extension for browser tool call
              log.trace("Raw browser_tool_result from extension", {
                callId: data.callId,
                result: data.result,
              });
              handleBrowserToolResponse(data.callId, data.result);
              break;
            default:
              send(ws, "error", {
                message: `Unknown message type: ${data.type}`,
              });
          }
        } catch (error) {
          log.error("WebSocket message error", { error: (error as Error).message });
          send(ws, "error", { message: `Error: ${(error as Error).message}` });
        }
      },
      onClose(_event, ws) {
        log.info("Client disconnected");
        handleDisconnect(ws);
        clients.delete(ws);
        // Clear extension WebSocket if this was it
        setExtensionWebSocket(null);
      },
    })),
  );

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server);

  // Log server startup info (keep console for user-facing banner)
  console.log(`🚀 ACP Proxy Server running on http://localhost:${port}`);
  console.log(`   Chat UI: http://localhost:${port}/app`);
  console.log(`   WebSocket: ws://localhost:${port}/ws`);
  console.log(`   MCP: http://localhost:${port}/mcp`);
  console.log(``);
  console.log(`📦 Agent: ${AGENT_COMMAND} ${AGENT_ARGS.join(" ")}`);
  console.log(`   Working directory: ${AGENT_CWD}`);
  console.log(``);
  console.log(`🌐 Browser tool available via MCP`);

  // Also log to file when debug is enabled
  log.info("Server started", {
    port,
    wsEndpoint: `ws://localhost:${port}/ws`,
    mcpEndpoint: `http://localhost:${port}/mcp`,
    agent: AGENT_COMMAND,
    agentArgs: AGENT_ARGS,
    cwd: AGENT_CWD,
  });

  // Keep the server running
  await new Promise(() => {});
}
