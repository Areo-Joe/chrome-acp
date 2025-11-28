import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ProxyConnectParams } from "./src/types";

const PORT = parseInt(process.env.PORT || "9315");

// Track connected clients and their agent connections
interface ClientState {
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  sessionId: string | null;
}

const clients = new Map<WebSocket, ClientState>();

// Send a message to the WebSocket client
function send(ws: WebSocket, type: string, payload?: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// Create a Client implementation that forwards events to WebSocket
function createClient(ws: WebSocket): acp.Client {
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

async function handleConnect(ws: WebSocket, params: ProxyConnectParams): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  // Kill existing process if any
  if (state.process) {
    state.process.kill();
    state.process = null;
    state.connection = null;
  }

  try {
    const { command, args = [], cwd } = params;
    console.log(`[Server] Spawning agent: ${command} ${args.join(" ")}`);

    // Spawn the agent process using Node.js child_process
    const agentProcess = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });

    state.process = agentProcess;

    // Create streams for ACP SDK
    const input = Writable.toWeb(agentProcess.stdin!);
    const output = Readable.toWeb(agentProcess.stdout!);

    // Create ACP connection
    const stream = acp.ndJsonStream(input, output);
    const connection = new acp.ClientSideConnection(
      (_agent) => createClient(ws),
      stream
    );

    state.connection = connection;

    // Initialize the connection
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    console.log(`[Server] Agent initialized (protocol v${initResult.protocolVersion})`);

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
    send(ws, "error", { message: `Failed to connect: ${(error as Error).message}` });
  }
}

async function handleNewSession(ws: WebSocket, params: { cwd?: string }): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  try {
    const result = await state.connection.newSession({
      cwd: params.cwd || process.cwd(),
      mcpServers: [],
    });

    state.sessionId = result.sessionId;
    console.log(`[Server] Session created: ${result.sessionId}`);
    send(ws, "session_created", result);
  } catch (error) {
    console.error("[Server] Failed to create session:", error);
    send(ws, "error", { message: `Failed to create session: ${(error as Error).message}` });
  }
}

async function handlePrompt(ws: WebSocket, params: { text: string }): Promise<void> {
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
    send(ws, "error", { message: `Prompt failed: ${(error as Error).message}` });
  }
}

function handleDisconnect(ws: WebSocket): void {
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
  payload?: unknown;
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    return new Response("ACP Proxy Server", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("[Server] Client connected");
      clients.set(ws, { process: null, connection: null, sessionId: null });
    },
    async message(ws, message) {
      try {
        const data: ProxyMessage = JSON.parse(message.toString());
        console.log(`[Server] Received: ${data.type}`);

        switch (data.type) {
          case "connect":
            await handleConnect(ws, data.payload as ProxyConnectParams);
            break;
          case "disconnect":
            handleDisconnect(ws);
            break;
          case "new_session":
            await handleNewSession(ws, (data.payload as { cwd?: string }) || {});
            break;
          case "prompt":
            await handlePrompt(ws, data.payload as { text: string });
            break;
          default:
            send(ws, "error", { message: `Unknown message type: ${data.type}` });
        }
      } catch (error) {
        console.error("[Server] Error:", error);
        send(ws, "error", { message: `Error: ${(error as Error).message}` });
      }
    },
    close(ws) {
      console.log("[Server] Client disconnected");
      handleDisconnect(ws);
      clients.delete(ws);
    },
  },
});

console.log(`🚀 ACP Proxy Server running on http://localhost:${PORT}`);
console.log(`   WebSocket endpoint: ws://localhost:${PORT}/ws`);
console.log(`   Health check: http://localhost:${PORT}/health`);