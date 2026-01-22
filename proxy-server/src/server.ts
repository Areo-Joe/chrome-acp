import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import {
  handleMcpRequest,
  setExtensionWebSocket,
  handleBrowserToolResponse,
} from "./mcp/handler.js";

export interface ServerConfig {
  port: number;
  command: string;
  args: string[];
  cwd: string;
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
      console.log("[Client] Permission requested:", params.toolCall.title);
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
      console.log("[Client] Read file:", params.path);
      // TODO: Forward to extension to read file
      return { content: "" };
    },

    async writeTextFile(params) {
      console.log("[Client] Write file:", params.path);
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
    console.log(
      `[Server] Spawning agent: ${AGENT_COMMAND} ${AGENT_ARGS.join(" ")}`,
    );

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

    console.log(
      `[Server] Agent initialized (protocol v${initResult.protocolVersion})`,
    );

    send(ws, "status", {
      connected: true,
      agentInfo: initResult.agentInfo,
      capabilities: initResult.agentCapabilities,
    });

    // Handle connection close
    connection.closed.then(() => {
      console.log("[Server] Agent connection closed");
      state.connection = null;
      state.sessionId = null;
      send(ws, "status", { connected: false });
    });
  } catch (error) {
    console.error("[Server] Failed to connect:", error);
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
    console.log(`[Server] Session created: ${result.sessionId}`);
    send(ws, "session_created", result);
  } catch (error) {
    console.error("[Server] Failed to create session:", error);
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
    console.log(`[Server] Sending prompt: ${params.text.slice(0, 50)}...`);

    const result = await state.connection.prompt({
      sessionId: state.sessionId,
      prompt: [{ type: "text", text: params.text }],
    });

    console.log(`[Server] Prompt completed: ${result.stopReason}`);
    send(ws, "prompt_complete", result);
  } catch (error) {
    console.error("[Server] Prompt failed:", error);
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

  // Root endpoint
  app.get("/", (c) => {
    return c.text("ACP Proxy Server");
  });

  // MCP Streamable HTTP endpoint for browser tool
  app.post("/mcp", handleMcpRequest);

  // WebSocket endpoint
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        console.log("[Server] Client connected");
        clients.set(ws, { process: null, connection: null, sessionId: null });
        // Register this WebSocket for browser tool calls
        setExtensionWebSocket(ws);
      },
      async onMessage(event, ws) {
        try {
          const data = JSON.parse(event.data.toString());
          console.log(`[Server] Received: ${data.type}`);

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
              handleBrowserToolResponse(data.callId, data.result);
              break;
            default:
              send(ws, "error", {
                message: `Unknown message type: ${data.type}`,
              });
          }
        } catch (error) {
          console.error("[Server] Error:", error);
          send(ws, "error", { message: `Error: ${(error as Error).message}` });
        }
      },
      onClose(_event, ws) {
        console.log("[Server] Client disconnected");
        handleDisconnect(ws);
        clients.delete(ws);
        // Clear extension WebSocket if this was it
        setExtensionWebSocket(null);
      },
    })),
  );

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server);

  console.log(`🚀 ACP Proxy Server running on http://localhost:${port}`);
  console.log(`   WebSocket endpoint: ws://localhost:${port}/ws`);
  console.log(`   MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`   Health check: http://localhost:${port}/health`);
  console.log(``);
  console.log(`📦 Agent: ${AGENT_COMMAND} ${AGENT_ARGS.join(" ")}`);
  console.log(`   Working directory: ${AGENT_CWD}`);
  console.log(``);
  console.log(`🌐 Browser tool available via MCP`);

  // Keep the server running
  await new Promise(() => {});
}
