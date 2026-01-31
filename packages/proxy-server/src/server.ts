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
  termux?: boolean;
}

// Pending permission request
interface PendingPermission {
  resolve: (outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// PromptCapabilities from ACP protocol
// Reference: Zed's prompt_capabilities to check image support
interface PromptCapabilities {
  audio?: boolean;
  embeddedContext?: boolean;
  image?: boolean;
}

// Track connected clients and their agent connections
interface ClientState {
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  sessionId: string | null;
  pendingPermissions: Map<string, PendingPermission>;
  // Reference: Zed stores promptCapabilities from initialize response
  promptCapabilities: PromptCapabilities | null;
}

// Module-level state (set when server starts)
let AGENT_COMMAND: string;
let AGENT_ARGS: string[];
let AGENT_CWD: string;
let SERVER_PORT: number;

const clients = new Map<WSContext, ClientState>();

// Permission request timeout (5 minutes)
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

// Generate unique request ID
function generateRequestId(): string {
  return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// Send a message to the WebSocket client
function send(ws: WSContext, type: string, payload?: unknown): void {
  if (ws.readyState === 1) {
    // WebSocket.OPEN
    ws.send(JSON.stringify({ type, payload }));
  }
}

// Create a Client implementation that forwards events to WebSocket
function createClient(ws: WSContext, clientState: ClientState): acp.Client {
  return {
    async requestPermission(params) {
      const requestId = generateRequestId();
      log.debug("Permission requested", { requestId, title: params.toolCall.title });

      // Create a promise that will be resolved when user responds
      const outcomePromise = new Promise<{ outcome: "cancelled" } | { outcome: "selected"; optionId: string }>((resolve) => {
        // Set timeout to auto-cancel if no response
        const timeout = setTimeout(() => {
          log.warn("Permission request timed out", { requestId });
          clientState.pendingPermissions.delete(requestId);
          resolve({ outcome: "cancelled" });
        }, PERMISSION_TIMEOUT_MS);

        // Store the pending request in client's map
        clientState.pendingPermissions.set(requestId, { resolve, timeout });
      });

      // Send permission request to client with our requestId
      send(ws, "permission_request", {
        requestId,
        sessionId: params.sessionId,
        options: params.options,
        toolCall: params.toolCall,
      });

      // Wait for user response
      const outcome = await outcomePromise;
      log.debug("Permission response received", { requestId, outcome });

      return { outcome };
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

// Handle permission response from client
function handlePermissionResponse(ws: WSContext, payload: { requestId: string; outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } }): void {
  const state = clients.get(ws);
  if (!state) {
    log.warn("Permission response from unknown client");
    return;
  }

  const pending = state.pendingPermissions.get(payload.requestId);
  if (!pending) {
    log.warn("Permission response for unknown request", { requestId: payload.requestId });
    return;
  }

  // Clear timeout and resolve the promise
  clearTimeout(pending.timeout);
  state.pendingPermissions.delete(payload.requestId);
  pending.resolve(payload.outcome);
}

// Cancel all pending permissions for a client (called on disconnect)
function cancelPendingPermissions(clientState: ClientState): void {
  for (const [requestId, pending] of clientState.pendingPermissions) {
    log.debug("Cancelling pending permission due to disconnect", { requestId });
    clearTimeout(pending.timeout);
    pending.resolve({ outcome: "cancelled" });
  }
  clientState.pendingPermissions.clear();
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
      (_agent) => createClient(ws, state),
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

    // Reference: Zed stores promptCapabilities from initialize response
    // to check image support via supports_images()
    // Note: promptCapabilities is nested in agentCapabilities
    state.promptCapabilities = initResult.agentCapabilities?.promptCapabilities ?? null;
    log.info("Agent initialized", {
      protocolVersion: initResult.protocolVersion,
      promptCapabilities: state.promptCapabilities,
    });

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
    // Reference: Include promptCapabilities so client can check image support
    // This matches Zed's behavior of checking prompt_capabilities.image
    send(ws, "session_created", {
      ...result,
      promptCapabilities: state.promptCapabilities,
    });
  } catch (error) {
    log.error("Failed to create session", { error: (error as Error).message });
    send(ws, "error", {
      message: `Failed to create session: ${(error as Error).message}`,
    });
  }
}

// Reference: Zed's AcpThread.send() forwards Vec<acp::ContentBlock> to agent
async function handlePrompt(
  ws: WSContext,
  params: { content: ContentBlock[] },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection || !state.sessionId) {
    send(ws, "error", { message: "No active session" });
    return;
  }

  try {
    // Log content blocks for debugging
    const firstText = params.content.find(b => b.type === "text")?.text;
    const images = params.content.filter(b => b.type === "image");
    log.debug("Sending prompt", {
      text: firstText?.slice(0, 100),
      imageCount: images.length,
      blockCount: params.content.length,
    });

    // Log image details for debugging
    for (const img of images) {
      log.debug("Image block", {
        mimeType: img.mimeType,
        dataLength: img.data?.length,
        dataSizeKB: img.data ? Math.round(img.data.length * 0.75 / 1024) : 0, // base64 to bytes approx
        dataPrefix: img.data?.slice(0, 50),
      });
    }

    // Forward ContentBlock[] directly to agent (matches Zed's behavior)
    const result = await state.connection.prompt({
      sessionId: state.sessionId,
      prompt: params.content as acp.ContentBlock[],
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

// Handle cancel request from client - matches Zed's cancel() logic
// 1. Cancel any pending permission requests
// 2. Send session/cancel notification to agent via ACP SDK
// The agent should respond to the original prompt with stopReason="cancelled"
async function handleCancel(ws: WSContext): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection || !state.sessionId) {
    log.warn("Cancel requested but no active session");
    return;
  }

  log.info("Cancel requested", { sessionId: state.sessionId });

  // Cancel any pending permission requests (like Zed does)
  // This ensures permission dialogs are dismissed
  cancelPendingPermissions(state);

  try {
    // Send cancel notification to agent via ACP SDK
    // The agent should:
    // 1. Stop all language model requests
    // 2. Abort all tool call invocations in progress
    // 3. Send any pending session/update notifications
    // 4. Respond to the original session/prompt with stopReason="cancelled"
    await state.connection.cancel({ sessionId: state.sessionId });
    log.debug("Cancel notification sent to agent");
  } catch (error) {
    log.error("Failed to send cancel notification", { error: (error as Error).message });
    // Don't send error to client - the prompt will complete with appropriate status
  }
}

// ContentBlock type matching @agentclientprotocol/sdk
// Reference: Zed's acp::ContentBlock
interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
}

interface ProxyMessage {
  type: "connect" | "disconnect" | "new_session" | "prompt" | "cancel";
  payload?: { cwd?: string } | { content: ContentBlock[] };
}

// Launch PWA via Termux am command
async function launchTermuxPwa(pwaName: string): Promise<void> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  try {
    // Find WebAPK package by app name using aapt
    const { stdout: packagesOutput } = await execAsync(
      "pm list packages 2>/dev/null | grep webapk | cut -d: -f2"
    );
    const packages = packagesOutput.trim().split("\n").filter(Boolean);

    for (const pkg of packages) {
      try {
        // Get APK path
        const { stdout: pathOutput } = await execAsync(`pm path ${pkg} 2>/dev/null | cut -d: -f2`);
        const apkPath = pathOutput.trim();
        if (!apkPath) continue;

        // Check app label using aapt
        const { stdout: aaptOutput } = await execAsync(`aapt dump badging "${apkPath}" 2>/dev/null`);
        const labelMatch = aaptOutput.match(/application-label:'([^']+)'/);
        if (labelMatch && labelMatch[1] === pwaName) {
          // Found the PWA, launch it
          const activityMatch = aaptOutput.match(/launchable-activity: name='([^']+)'/);
          if (activityMatch) {
            const activity = activityMatch[1];
            await execAsync(`am start -n ${pkg}/${activity}`);
            log.info("Launched PWA via Termux", { package: pkg, activity });
            console.log(`📱 Launched PWA: ${pwaName}`);
            return;
          }
        }
      } catch {
        // Skip this package if any error
        continue;
      }
    }
    log.warn("PWA not found", { name: pwaName });
    console.log(`⚠️  PWA "${pwaName}" not found`);
  } catch (error) {
    log.error("Failed to launch PWA", { error: (error as Error).message });
    console.log(`⚠️  Failed to launch PWA: ${(error as Error).message}`);
  }
}

export async function startServer(config: ServerConfig): Promise<void> {
  const { port, command, args, cwd, termux } = config;

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
        clients.set(ws, {
          process: null,
          connection: null,
          sessionId: null,
          pendingPermissions: new Map(),
          promptCapabilities: null,
        });
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
              await handlePrompt(ws, data.payload as { content: ContentBlock[] });
              break;
            case "browser_tool_result":
              // Handle response from extension for browser tool call
              log.trace("Raw browser_tool_result from extension", {
                callId: data.callId,
                result: data.result,
              });
              handleBrowserToolResponse(data.callId, data.result);
              break;
            case "permission_response":
              // Handle user's permission decision
              handlePermissionResponse(ws, data.payload);
              break;
            case "cancel":
              // Handle cancel request - send session/cancel to agent
              await handleCancel(ws);
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
        const state = clients.get(ws);
        if (state) {
          // Cancel any pending permission requests
          cancelPendingPermissions(state);
        }
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

  // Launch PWA via Termux if --termux flag is set
  if (termux) {
    // Small delay to ensure server is ready
    setTimeout(() => {
      launchTermuxPwa("ACP");
    }, 500);
  }

  // Keep the server running
  await new Promise(() => {});
}
