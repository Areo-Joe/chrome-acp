import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { Writable, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import {
  handleMcpRequest,
  setExtensionWebSocket,
  handleBrowserToolResponse,
} from "./mcp/handler.js";
import { log } from "./logger.js";
import { getOrCreateCertificate, getLanIPs, getAgentTlsEnv } from "./cert.js";
import {
  listDir,
  readFile,
  readTextFile as readWorkspaceTextFile,
  writeTextFile as writeWorkspaceTextFile,
  startWatcher,
  type FileChange,
} from "./files.js";
import { TerminalManager } from "./terminals.js";

// Get the directory of this file to resolve public folder path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "..", "public");

// Read our own package version for the ACP `clientInfo` payload.
const CLIENT_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Identifies this client to agents during `initialize`. */
const CLIENT_INFO: acp.Implementation = {
  name: "chrome-acp",
  title: "Chrome ACP",
  version: CLIENT_VERSION,
};

export interface ServerConfig {
  port: number;
  host: string;
  command: string;
  args: string[];
  cwd: string;
  debug?: boolean;
  token?: string;
  termux?: boolean;
  https?: boolean;
  publicUrl?: string;
}

// Pending permission request
// Reference: Zed's `handle_request_permission` waits for the user's decision
// and responds with the ACP `RequestPermissionOutcome`.
interface PendingPermission {
  resolve: (outcome: acp.RequestPermissionOutcome) => void;
  /** Tool call this permission request belongs to. */
  toolCallId: string;
}

// Track connected clients and their agent connections
interface PendingElicitation {
  resolve: (response: acp.CreateElicitationResponse) => void;
}

interface ClientState {
  process: ChildProcess | null;
  connection: acp.ClientConnection | null;
  sessionId: string | null;
  /** Session ID currently being loaded (dedupes concurrent loads like Zed). */
  pendingSessionLoad: string | null;
  /** Set when session/cancel was sent (Zed's `suppress_abort_err`). */
  cancelRequested: boolean;
  pendingPermissions: Map<string, PendingPermission>;
  pendingElicitations: Map<string, PendingElicitation>;
  // Reference: Zed stores the full AgentCapabilities from the initialize response.
  agentCapabilities: acp.AgentCapabilities | null;
  // Reference: Zed stores promptCapabilities from the initialize response
  // (convenience accessor used to gate image attachments).
  promptCapabilities: acp.PromptCapabilities | null;
  // Authentication methods advertised during initialize.
  authMethods: acp.AuthMethod[];
  // Reference: Zed stores `modes` / `configOptions` from session/new|load|resume.
  // When the agent sends configOptions, `modes` is ignored (Zed's `config_state`).
  sessionModes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[] | null;
  // Client-managed terminals for the ACP `terminal/*` methods.
  terminals: TerminalManager;
  // File watcher unsubscribe function
  unsubscribeWatcher: (() => void) | null;
  // Working directory for the current session (used by file explorer and fs/*).
  sessionCwd: string | null;
  // Heartbeat: tracks whether client responded to the last ping
  isAlive: boolean;
}

// Module-level state (set when server starts)
let AGENT_COMMAND: string;
let AGENT_ARGS: string[];
let AGENT_CWD: string;
let BROWSER_MCP_URL: string;
let AGENT_ENV: NodeJS.ProcessEnv;
let AUTH_TOKEN: string | undefined;

const clients = new Map<WSContext, ClientState>();

function getBrowserMcpServers(): acp.McpServer[] {
  return [{
    type: "http",
    url: BROWSER_MCP_URL,
    name: "browser",
    headers: [],
  }];
}

// Heartbeat interval for WebSocket ping/pong (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30_000;

// Generate unique request ID
function generateRequestId(): string {
  return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid message: "${field}" must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): number | undefined {
  if (error instanceof RequestError) return error.code;
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "number" ? candidate.code : undefined;
}

const REQUEST_CANCELLED = -32800;

function requestCancelled(): RequestError {
  return new RequestError(REQUEST_CANCELLED, "Request cancelled");
}

// Send an agent error, preserving the JSON-RPC code (e.g. auth_required).
function sendAgentError(ws: WSContext, prefix: string, error: unknown): void {
  send(ws, "error", {
    message: `${prefix}: ${(error as Error).message}`,
    code: errorCode(error),
  });
}

// Send a message to the WebSocket client
function send(ws: WSContext, type: string, payload?: unknown): void {
  if (ws.readyState === 1) {
    // WebSocket.OPEN
    ws.send(JSON.stringify({ type, payload }));
  }
}

// Get the working directory for a client's session
function getClientCwd(ws: WSContext): string {
  const state = clients.get(ws);
  return state?.sessionCwd || AGENT_CWD;
}

function mapFsError(error: unknown, path: string): RequestError {
  if (error instanceof RequestError) return error;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return RequestError.resourceNotFound(path);
  }
  return RequestError.internalError(undefined, (error as Error).message);
}

// Keep client-side session state in sync with agent notifications.
// Reference: Zed's `handle_session_notification` applies mode/config option
// updates before forwarding the notification to the thread.
function applySessionUpdateToState(
  clientState: ClientState,
  update: acp.SessionUpdate,
): void {
  switch (update.sessionUpdate) {
    case "current_mode_update":
      if (clientState.sessionModes) {
        clientState.sessionModes = {
          ...clientState.sessionModes,
          currentModeId: update.currentModeId,
        };
      }
      break;
    case "config_option_update":
      clientState.configOptions = update.configOptions;
      break;
    // Reference: Zed resolves a pending permission request as cancelled when
    // the tool call it belongs to reaches a terminal status.
    case "tool_call":
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        cancelPermissionsForToolCall(clientState, update.toolCallId);
      }
      break;
  }
}

function cancelPermissionsForToolCall(
  clientState: ClientState,
  toolCallId: string,
): void {
  for (const [requestId, pending] of clientState.pendingPermissions) {
    if (pending.toolCallId !== toolCallId) continue;
    log.debug("Cancelling permission for finished tool call", { requestId, toolCallId });
    clientState.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: "cancelled" });
  }
}

// Create a Client app that forwards events to WebSocket.
// Uses the SDK's typed handler builder (`acp.client(...)`), which is the
// recommended API; the legacy `Client` interface is deprecated.
function createClientApp(ws: WSContext, clientState: ClientState): acp.ClientApp {
  const app = acp.client({ name: "chrome-acp" });

  app.onRequest(
    acp.methods.client.session.requestPermission,
    async ({ params, signal }) => {
      const requestId = generateRequestId();
      log.debug("Permission requested", {
        requestId,
        title: params.toolCall.title,
        options: params.options.map((option) => option.kind),
      });

      // Create a promise that will be resolved when the user responds.
      // Reference: Zed waits for the user without an artificial timeout;
      // cancellation comes from session/cancel or connection close.
      const outcomePromise = new Promise<acp.RequestPermissionOutcome>((resolve) => {
        clientState.pendingPermissions.set(requestId, {
          resolve,
          toolCallId: params.toolCall.toolCallId,
        });
      });

      // Send permission request to client with our requestId
      send(ws, "permission_request", {
        requestId,
        sessionId: params.sessionId,
        options: params.options,
        toolCall: params.toolCall,
      });

      // Reference: Zed cancels the pending permission when the ACP request is
      // cancelled or the connection closes.
      if (signal.aborted) {
        clientState.pendingPermissions.delete(requestId);
        return { outcome: { outcome: "cancelled" as const } };
      }
      const onAbort = () => {
        const pending = clientState.pendingPermissions.get(requestId);
        if (!pending) return;
        clientState.pendingPermissions.delete(requestId);
        pending.resolve({ outcome: "cancelled" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Wait for user response
        const outcome = await outcomePromise;
        log.debug("Permission response received", { requestId, outcome });
        return { outcome };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  );

  // Reference: Zed's `handle_session_notification` applies mode/config option
  // side effects before forwarding the raw update.
  app.onNotification(acp.methods.client.session.update, ({ params }) => {
    applySessionUpdateToState(clientState, params.update);
    send(ws, "session_update", params);
  });

  // Reference: Zed's `handle_read_text_file`. ACP paths are absolute.
  app.onRequest(acp.methods.client.fs.readTextFile, ({ params, signal }) => {
    log.debug("Read text file", { path: params.path, line: params.line, limit: params.limit });
    if (signal.aborted) throw requestCancelled();
    try {
      const content = readWorkspaceTextFile(params.path, params.line, params.limit);
      return { content };
    } catch (error) {
      throw mapFsError(error, params.path);
    }
  });

  // Reference: Zed's `handle_write_text_file`.
  app.onRequest(acp.methods.client.fs.writeTextFile, ({ params, signal }) => {
    log.debug("Write text file", { path: params.path });
    if (signal.aborted) throw requestCancelled();
    try {
      writeWorkspaceTextFile(params.path, params.content);
      return {};
    } catch (error) {
      throw mapFsError(error, params.path);
    }
  });

  // Reference: Zed's `handle_create_elicitation` (form + URL modes).
  app.onRequest(
    acp.methods.client.elicitation.create,
    async ({ params, signal }) => {
      const requestId = generateRequestId();
      if (signal.aborted) return { action: "cancel" as const };

      // Reference: Zed waits for the user; cancellation comes from
      // session/cancel, request abort, or connection close.
      const responsePromise = new Promise<acp.CreateElicitationResponse>((resolve) => {
        clientState.pendingElicitations.set(requestId, { resolve });
      });

      send(ws, "elicitation_request", { requestId, request: params });

      const onAbort = () => {
        const pending = clientState.pendingElicitations.get(requestId);
        if (!pending) return;
        clientState.pendingElicitations.delete(requestId);
        send(ws, "elicitation_cancelled", {});
        pending.resolve({ action: "cancel" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        return await responsePromise;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  );

  // Reference: Zed's `handle_complete_elicitation`.
  app.onNotification(acp.methods.client.elicitation.complete, ({ params }) => {
    send(ws, "elicitation_complete", { elicitationId: params.elicitationId });
  });

  // Reference: Zed's `handle_create_terminal`.
  app.onRequest(acp.methods.client.terminal.create, ({ params, signal }) => {
    if (signal.aborted) throw requestCancelled();
    const terminalId = clientState.terminals.create(params);
    return { terminalId };
  });

  // Reference: Zed's `handle_terminal_output`.
  app.onRequest(acp.methods.client.terminal.output, ({ params }) => {
    return clientState.terminals.output(params.terminalId, params.sessionId);
  });

  // Reference: Zed's `handle_wait_for_terminal_exit`.
  app.onRequest(acp.methods.client.terminal.waitForExit, ({ params, signal }) => {
    if (signal.aborted) return Promise.reject(requestCancelled());
    return new Promise<acp.TerminalExitStatus>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(requestCancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      clientState.terminals.waitForExit(params.terminalId, params.sessionId).then(
        (status) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(status);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  });

  // Reference: Zed's `handle_kill_terminal`.
  app.onRequest(acp.methods.client.terminal.kill, ({ params }) => {
    clientState.terminals.kill(params.terminalId, params.sessionId);
    return {};
  });

  // Reference: Zed's `handle_release_terminal`.
  app.onRequest(acp.methods.client.terminal.release, ({ params }) => {
    clientState.terminals.release(params.terminalId, params.sessionId);
    return {};
  });

  return app;
}

// Handle permission response from client
function handlePermissionResponse(ws: WSContext, payload: { requestId: string; outcome: acp.RequestPermissionOutcome }): void {
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

  // Resolve the promise
  state.pendingPermissions.delete(payload.requestId);
  pending.resolve(payload.outcome);
}

// Handle an elicitation response from the client.
function handleElicitationResponse(
  ws: WSContext,
  payload: { requestId: string; response: acp.CreateElicitationResponse },
): void {
  const state = clients.get(ws);
  const pending = state?.pendingElicitations.get(payload.requestId);
  if (!state || !pending) {
    log.warn("Elicitation response for unknown request", { requestId: payload.requestId });
    return;
  }
  state.pendingElicitations.delete(payload.requestId);
  pending.resolve(payload.response);
}

function cancelPendingElicitations(clientState: ClientState, ws?: WSContext): void {
  if (clientState.pendingElicitations.size === 0) return;
  for (const [requestId, pending] of clientState.pendingElicitations) {
    log.debug("Cancelling pending elicitation", { requestId });
    pending.resolve({ action: "cancel" });
  }
  clientState.pendingElicitations.clear();
  if (ws) send(ws, "elicitation_cancelled", {});
}

// Cancel all pending permissions for a client (called on disconnect)
function cancelPendingPermissions(clientState: ClientState): void {
  for (const [requestId, pending] of clientState.pendingPermissions) {
    log.debug("Cancelling pending permission due to disconnect", { requestId });
    pending.resolve({ outcome: "cancelled" });
  }
  clientState.pendingPermissions.clear();
}

async function handleConnect(ws: WSContext): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  // Kill existing process if any
  if (state.process) {
    // Cancel pending work from the previous connection.
    cancelPendingPermissions(state);
    cancelPendingElicitations(state, ws);
    state.terminals.dispose();
    state.process.kill();
    state.process = null;
    state.connection = null;
    state.agentCapabilities = null;
    state.promptCapabilities = null;
    state.authMethods = [];
    state.sessionModes = null;
    state.configOptions = null;
    state.pendingSessionLoad = null;
  }

  try {
    log.info("Spawning agent", { command: AGENT_COMMAND, args: AGENT_ARGS });

    // Spawn the agent process using Node.js child_process
    const agentProcess = spawn(AGENT_COMMAND, AGENT_ARGS, {
      cwd: AGENT_CWD,
      stdio: ["pipe", "pipe", "inherit"],
      env: AGENT_ENV,
    });

    state.process = agentProcess;

    // Spawn failures (ENOENT, EACCES, ...) would otherwise crash the server.
    agentProcess.on("error", (error) => {
      log.error("Failed to spawn agent", { error: error.message });
      state.process = null;
      state.connection = null;
      send(ws, "error", {
        message: `Failed to spawn agent: ${error.message}`,
      });
    });

    // Create streams for ACP SDK
    const input = Writable.toWeb(
      agentProcess.stdin!,
    ) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(
      agentProcess.stdout!,
    ) as unknown as ReadableStream<Uint8Array>;

    // Create the ACP connection using the SDK's client app builder.
    const stream = acp.ndJsonStream(input, output);
    const connection = createClientApp(ws, state).connect(stream);
    state.connection = connection;

    // Initialize the connection.
    // Reference: Zed's `client_capabilities_for_agent` — advertise everything
    // this client can actually serve: file system access, terminals, session
    // config options (including booleans), live notices, and plans.
    const initResult = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: CLIENT_INFO,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
        session: {
          configOptions: {
            boolean: {},
          },
          notices: {},
          compaction: {},
        },
        plan: {},
        elicitation: {
          form: {},
          url: {},
        },
        _meta: {
          terminal_output: true,
        },
      },
    });

    // Reference: Zed rejects agents that negotiate an unsupported version.
    if (initResult.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `Unsupported ACP protocol version ${initResult.protocolVersion} (expected ${acp.PROTOCOL_VERSION})`,
      );
    }

    // Reference: Zed stores full agentCapabilities from initialize response
    // This includes loadSession, promptCapabilities, sessionCapabilities, etc.
    state.agentCapabilities = initResult.agentCapabilities ?? null;
    state.promptCapabilities = initResult.agentCapabilities?.promptCapabilities ?? null;
    state.authMethods = initResult.authMethods ?? [];

    log.info("Agent initialized", {
      protocolVersion: initResult.protocolVersion,
      loadSession: state.agentCapabilities?.loadSession,
      sessionList: !!state.agentCapabilities?.sessionCapabilities?.list,
      sessionResume: !!state.agentCapabilities?.sessionCapabilities?.resume,
      promptCapabilities: state.promptCapabilities,
      mcpCapabilities: state.agentCapabilities?.mcpCapabilities,
      authMethods: state.authMethods.map((method) => method.id),
    });

    send(ws, "status", {
      connected: true,
      protocolVersion: initResult.protocolVersion,
      agentInfo: initResult.agentInfo,
      capabilities: state.agentCapabilities,
      authMethods: state.authMethods,
    });

    // Handle connection close. Guard against a stale connection from a
    // previous connect() nulling out a newer one.
    connection.closed.then(() => {
      if (state.connection !== connection) return;
      log.info("Agent connection closed");
      state.connection = null;
      state.sessionId = null;
      state.pendingSessionLoad = null;
      state.cancelRequested = false;
      send(ws, "status", { connected: false });
    });
  } catch (error) {
    log.error("Failed to connect", { error: (error as Error).message });
    send(ws, "error", {
      message: `Failed to connect: ${(error as Error).message}`,
    });
  }
}

// Reference: Zed's `config_state` — when the agent returns `configOptions`, the
// legacy `modes` state is ignored (configOptions may include a "mode" category).
function applySessionConfig(
  state: ClientState,
  result: {
    modes?: acp.SessionModeState | null;
    configOptions?: acp.SessionConfigOption[] | null;
  },
): void {
  state.configOptions = result.configOptions ?? null;
  state.sessionModes = state.configOptions ? null : (result.modes ?? null);
}

/** Session-scoped state included in `session_created` / `session_loaded` / `session_resumed`. */
function sessionStatePayload(state: ClientState) {
  return {
    promptCapabilities: state.promptCapabilities,
    modes: state.sessionModes,
    configOptions: state.configOptions,
  };
}

/** Restart the file watcher and push a fresh root listing for a session. */
async function refreshWorkspace(
  ws: WSContext,
  state: ClientState,
  sessionCwd: string,
): Promise<void> {
  if (state.unsubscribeWatcher) {
    state.unsubscribeWatcher();
  }
  state.unsubscribeWatcher = await startWatcher(sessionCwd, (changes) => {
    send(ws, "file_changes", { changes });
  });

  const rootItems = listDir(sessionCwd, "");
  if (rootItems !== null) {
    send(ws, "dir_listing", { path: "", items: rootItems });
  }
}

/**
 * Close a session we are switching away from, when the agent supports it.
 * Reference: Zed sends `session/close` when the last thread handle drops.
 */
async function closeSessionIfSupported(
  state: ClientState,
  sessionId: string | null,
): Promise<void> {
  if (!sessionId || !state.connection) return;
  if (!state.agentCapabilities?.sessionCapabilities?.close) return;
  try {
    await state.connection.agent.request(acp.methods.agent.session.close, { sessionId });
    log.debug("Closed previous session", { sessionId });
  } catch (error) {
    log.warn("Failed to close previous session", {
      sessionId,
      error: (error as Error).message,
    });
  }
}

interface SessionStateSnapshot {
  sessionId: string | null;
  sessionCwd: string | null;
  sessionModes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[] | null;
}

function snapshotSessionState(state: ClientState): SessionStateSnapshot {
  return {
    sessionId: state.sessionId,
    sessionCwd: state.sessionCwd,
    sessionModes: state.sessionModes,
    configOptions: state.configOptions,
  };
}

function restoreSessionState(state: ClientState, snapshot: SessionStateSnapshot): void {
  state.sessionId = snapshot.sessionId;
  state.sessionCwd = snapshot.sessionCwd;
  state.sessionModes = snapshot.sessionModes;
  state.configOptions = snapshot.configOptions;
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
    const sessionCwd = params.cwd || AGENT_CWD;
    const result = await state.connection.agent.request(acp.methods.agent.session.new, {
      cwd: sessionCwd,
      mcpServers: getBrowserMcpServers(),
    });

    const previousSessionId = state.sessionId;
    if (previousSessionId) state.terminals.disposeSession(previousSessionId);
    state.sessionId = result.sessionId;
    state.sessionCwd = sessionCwd;
    // Reference: Zed's `config_state(response.modes, response.config_options)`.
    applySessionConfig(state, result);
    await closeSessionIfSupported(state, previousSessionId);
    log.info("Session created", {
      sessionId: result.sessionId,
      cwd: sessionCwd,
      hasModes: !!result.modes,
      configOptionCount: result.configOptions?.length ?? 0,
    });

    // Register the session with the client before the (async) workspace setup
    // so notifications that arrive during it are not dropped.
    send(ws, "session_created", {
      sessionId: result.sessionId,
      ...sessionStatePayload(state),
    });
    await refreshWorkspace(ws, state, sessionCwd);
  } catch (error) {
    log.error("Failed to create session", { error: (error as Error).message });
    sendAgentError(ws, "Failed to create session", error);
  }
}

// ============================================================================
// Session History Operations
// Reference: Zed's AgentConnection trait - list_sessions, load_session, resume_session
// ============================================================================

/**
 * List sessions from the agent.
 * Reference: Zed's AcpSessionList.list_sessions()
 */
async function handleListSessions(
  ws: WSContext,
  params: { cwd?: string; cursor?: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  // Check if agent supports listing sessions
  // Reference: Zed checks agent_capabilities.session_capabilities.list
  if (!state.agentCapabilities?.sessionCapabilities?.list) {
    send(ws, "error", { message: "Listing sessions is not supported by this agent" });
    return;
  }

  try {
    const result = await state.connection.agent.request(acp.methods.agent.session.list, {
      cwd: params.cwd,
      cursor: params.cursor,
    });

    log.info("Sessions listed", { count: result.sessions.length, hasMore: !!result.nextCursor });

    // The SDK's SessionInfo already matches the wire shape Zed consumes.
    send(ws, "session_list", {
      sessions: result.sessions,
      nextCursor: result.nextCursor,
      _meta: result._meta,
    });
  } catch (error) {
    log.error("Failed to list sessions", { error: (error as Error).message });
    sendAgentError(ws, "Failed to list sessions", error);
  }
}

/**
 * Load an existing session with history replay.
 * Reference: Zed's AcpConnection.load_session()
 */
async function handleLoadSession(
  ws: WSContext,
  params: { sessionId: string; cwd?: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  // Check if agent supports loading sessions
  // Reference: Zed checks agent_capabilities.load_session
  if (!state.agentCapabilities?.loadSession) {
    send(ws, "error", { message: "Loading sessions is not supported by this agent" });
    return;
  }

  if (state.pendingSessionLoad === params.sessionId) {
    send(ws, "error", { message: `Session ${params.sessionId} is already loading` });
    return;
  }
  const previous = snapshotSessionState(state);
  state.pendingSessionLoad = params.sessionId;
  try {
    const sessionCwd = params.cwd || AGENT_CWD;
    const sessionId = params.sessionId;
    // Register the session before the request so replayed `session/update`
    // notifications are attributed to it (Zed registers a pending session first).
    if (state.sessionId && state.sessionId !== sessionId) {
      state.terminals.disposeSession(state.sessionId);
    }
    state.sessionId = sessionId;
    state.sessionCwd = sessionCwd;
    const result = await state.connection.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd: sessionCwd,
      mcpServers: getBrowserMcpServers(),
    });

    // Reference: Zed's `SessionConfigResponse { modes, config_options }`.
    applySessionConfig(state, result);
    if (previous.sessionId && previous.sessionId !== sessionId) {
      await closeSessionIfSupported(state, previous.sessionId);
    }
    log.info("Session loaded", {
      sessionId,
      cwd: sessionCwd,
      hasModes: !!result.modes,
      configOptionCount: result.configOptions?.length ?? 0,
    });

    send(ws, "session_loaded", {
      sessionId,
      ...sessionStatePayload(state),
    });
    await refreshWorkspace(ws, state, sessionCwd);
  } catch (error) {
    restoreSessionState(state, previous);
    log.error("Failed to load session", { error: (error as Error).message });
    sendAgentError(ws, "Failed to load session", error);
  } finally {
    if (state.pendingSessionLoad === params.sessionId) {
      state.pendingSessionLoad = null;
    }
  }
}

/**
 * Resume an existing session without history replay.
 * Reference: Zed's AcpConnection.resume_session()
 */
async function handleResumeSession(
  ws: WSContext,
  params: { sessionId: string; cwd?: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  // Check if agent supports resuming sessions
  // Reference: Zed checks agent_capabilities.session_capabilities.resume
  if (!state.agentCapabilities?.sessionCapabilities?.resume) {
    send(ws, "error", { message: "Resuming sessions is not supported by this agent" });
    return;
  }

  const previous = snapshotSessionState(state);
  try {
    const sessionCwd = params.cwd || AGENT_CWD;
    const sessionId = params.sessionId;
    // Register the session before the request (see load above).
    if (state.sessionId && state.sessionId !== sessionId) {
      state.terminals.disposeSession(state.sessionId);
    }
    state.sessionId = sessionId;
    state.sessionCwd = sessionCwd;
    const result = await state.connection.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: sessionCwd,
      mcpServers: getBrowserMcpServers(),
    });

    // Reference: Zed's `SessionConfigResponse { modes, config_options }`.
    applySessionConfig(state, result);
    if (previous.sessionId && previous.sessionId !== sessionId) {
      await closeSessionIfSupported(state, previous.sessionId);
    }
    log.info("Session resumed", {
      sessionId,
      cwd: sessionCwd,
      hasModes: !!result.modes,
      configOptionCount: result.configOptions?.length ?? 0,
    });

    send(ws, "session_resumed", {
      sessionId,
      ...sessionStatePayload(state),
    });
    await refreshWorkspace(ws, state, sessionCwd);
  } catch (error) {
    restoreSessionState(state, previous);
    log.error("Failed to resume session", { error: (error as Error).message });
    sendAgentError(ws, "Failed to resume session", error);
  } finally {
    if (state.pendingSessionLoad === params.sessionId) {
      state.pendingSessionLoad = null;
    }
  }
}

/**
 * Change the session mode.
 * Reference: Zed's `AcpSessionModes::set_mode` — optimistic local update with
 * rollback if the agent rejects the request.
 */
async function handleSetSessionMode(
  ws: WSContext,
  params: { modeId: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection || !state.sessionId) {
    send(ws, "error", { message: "No active session" });
    return;
  }

  if (!state.sessionModes) {
    send(ws, "error", { message: "Session modes are not supported by this agent" });
    return;
  }

  const previousModeId = state.sessionModes.currentModeId;
  state.sessionModes = { ...state.sessionModes, currentModeId: params.modeId };

  try {
    log.info("Setting session mode", { sessionId: state.sessionId, modeId: params.modeId });
    await state.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: state.sessionId,
      modeId: params.modeId,
    });
    send(ws, "mode_changed", { modeId: params.modeId });
  } catch (error) {
    if (state.sessionModes) {
      state.sessionModes = { ...state.sessionModes, currentModeId: previousModeId };
    }
    log.error("Failed to set session mode", { error: (error as Error).message });
    sendAgentError(ws, "Failed to set session mode", error);
  }
}

/**
 * Change a session configuration option.
 * Reference: Zed's `ConfigOptions::set_config_option` — the response contains
 * the full, updated option list.
 */
async function handleSetConfigOption(
  ws: WSContext,
  params: { configId: string; value: string | boolean },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection || !state.sessionId) {
    send(ws, "error", { message: "No active session" });
    return;
  }

  if (!state.configOptions) {
    send(ws, "error", { message: "Session configuration is not supported by this agent" });
    return;
  }

  try {
    log.info("Setting session config option", {
      sessionId: state.sessionId,
      configId: params.configId,
      value: params.value,
    });
    const result = await state.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      typeof params.value === "boolean"
        ? { sessionId: state.sessionId, configId: params.configId, type: "boolean", value: params.value }
        : { sessionId: state.sessionId, configId: params.configId, value: params.value },
    );
    state.configOptions = result.configOptions;
    send(ws, "config_options_changed", { configOptions: state.configOptions });
  } catch (error) {
    log.error("Failed to set session config option", { error: (error as Error).message });
    sendAgentError(ws, "Failed to set session config option", error);
  }
}

/**
 * Authenticate with one of the methods advertised during `initialize`.
 * Reference: Zed's `AcpConnection::authenticate`.
 */
async function handleAuthenticate(
  ws: WSContext,
  params: { methodId: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  const method = state.authMethods.find((candidate) => candidate.id === params.methodId);
  if (!method) {
    send(ws, "error", { message: `Unknown authentication method: ${params.methodId}` });
    return;
  }
  // Reference: Zed only sends `authenticate` for agent-managed methods;
  // terminal methods are run as an interactive agent process instead.
  if ("type" in method && method.type === "terminal") {
    send(ws, "error", {
      message: `Authentication method ${params.methodId} requires an interactive terminal`,
    });
    return;
  }

  try {
    log.info("Authenticating", { methodId: params.methodId });
    await state.connection.agent.request(acp.methods.agent.authenticate, {
      methodId: params.methodId,
    });
    send(ws, "authenticated", { methodId: params.methodId });
  } catch (error) {
    log.error("Authentication failed", { error: (error as Error).message });
    sendAgentError(ws, "Authentication failed", error);
  }
}

/**
 * Log out of the current authentication method.
 * Reference: Zed's `AcpConnection::logout` (gated on `agentCapabilities.auth.logout`).
 */
async function handleLogout(ws: WSContext): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  if (!state.agentCapabilities?.auth?.logout) {
    send(ws, "error", { message: "Logout is not supported by this agent" });
    return;
  }

  try {
    await state.connection.agent.request(acp.methods.agent.logout, {});
    log.info("Logged out");
    send(ws, "logged_out", {});
  } catch (error) {
    log.error("Logout failed", { error: (error as Error).message });
    sendAgentError(ws, "Logout failed", error);
  }
}

/**
 * Delete a session from the agent's session list.
 * Reference: Zed's `session/delete` (AgentCapabilities.session_capabilities.delete).
 */
async function handleDeleteSession(
  ws: WSContext,
  params: { sessionId: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  if (!state.agentCapabilities?.sessionCapabilities?.delete) {
    send(ws, "error", { message: "Deleting sessions is not supported by this agent" });
    return;
  }

  try {
    await state.connection.agent.request(acp.methods.agent.session.delete, {
      sessionId: params.sessionId,
    });
    state.terminals.disposeSession(params.sessionId);
    log.info("Session deleted", { sessionId: params.sessionId });
    send(ws, "session_deleted", { sessionId: params.sessionId });
  } catch (error) {
    log.error("Failed to delete session", { error: (error as Error).message });
    sendAgentError(ws, "Failed to delete session", error);
  }
}

/**
 * Close an active session and release agent resources.
 * Reference: Zed's `session/close` (AgentCapabilities.session_capabilities.close).
 */
async function handleCloseSession(
  ws: WSContext,
  params: { sessionId: string },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection) {
    send(ws, "error", { message: "Not connected to agent" });
    return;
  }

  if (!state.agentCapabilities?.sessionCapabilities?.close) {
    send(ws, "error", { message: "Closing sessions is not supported by this agent" });
    return;
  }

  try {
    await state.connection.agent.request(acp.methods.agent.session.close, {
      sessionId: params.sessionId,
    });
    state.terminals.disposeSession(params.sessionId);
    if (state.sessionId === params.sessionId) {
      state.sessionId = null;
    }
    log.info("Session closed", { sessionId: params.sessionId });
    send(ws, "session_closed", { sessionId: params.sessionId });
  } catch (error) {
    log.error("Failed to close session", { error: (error as Error).message });
    sendAgentError(ws, "Failed to close session", error);
  }
}

function isAbortError(error: unknown): boolean {
  // Gemini CLI workaround: internal error whose `data.details` says the request
  // was aborted (Zed's `suppress_abort_err` handling).
  if (!(error instanceof RequestError) || error.code !== -32603) return false;
  const data = error.data;
  if (!data || typeof data !== "object") return false;
  const details = (data as { details?: unknown }).details;
  return (
    typeof details === "string" &&
    (details.includes("This operation was aborted") ||
      details.includes("The user aborted a request"))
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof RequestError && error.data && typeof error.data === "object") {
    const details = (error.data as { details?: unknown }).details;
    if (typeof details === "string") return details;
  }
  return (error as Error).message;
}

// Reference: Zed's AcpThread.send() forwards Vec<acp::ContentBlock> to agent
async function handlePrompt(
  ws: WSContext,
  params: { content: acp.ContentBlock[] },
): Promise<void> {
  const state = clients.get(ws);
  if (!state?.connection || !state.sessionId) {
    send(ws, "error", { message: "No active session" });
    return;
  }

  state.cancelRequested = false;
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
    const result = await state.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: state.sessionId,
      prompt: params.content,
    });

    log.info("Prompt completed", { stopReason: result.stopReason });
    send(ws, "prompt_complete", result);
  } catch (error) {
    if (state.cancelRequested && isAbortError(error)) {
      log.info("Treating aborted prompt as cancelled");
      send(ws, "prompt_complete", { stopReason: "cancelled" });
      return;
    }
    log.error("Prompt failed", { error: (error as Error).message });
    send(ws, "error", {
      message: `Prompt failed: ${errorDetail(error)}`,
      code: errorCode(error),
    });
  } finally {
    state.cancelRequested = false;
  }
}

function handleDisconnect(ws: WSContext): void {
  const state = clients.get(ws);
  if (!state) return;

  // Cancel pending permission prompts and stop client-managed terminals.
  cancelPendingPermissions(state);
  cancelPendingElicitations(state, ws);
  state.terminals.dispose();

  if (state.process) {
    state.process.kill();
    state.process = null;
  }
  state.connection = null;
  state.sessionId = null;
  state.pendingSessionLoad = null;
  state.cancelRequested = false;
  state.sessionCwd = null;
  state.sessionModes = null;
  state.configOptions = null;
  state.agentCapabilities = null;
  state.promptCapabilities = null;
  state.authMethods = [];

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
  state.cancelRequested = true;

  // Cancel pending permission/elicitation requests (like Zed does).
  cancelPendingPermissions(state);
  cancelPendingElicitations(state, ws);

  try {
    // Send cancel notification to agent via ACP SDK
    // The agent should:
    // 1. Stop all language model requests
    // 2. Abort all tool call invocations in progress
    // 3. Send any pending session/update notifications
    // 4. Respond to the original session/prompt with stopReason="cancelled"
    await state.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: state.sessionId,
    });
    log.debug("Cancel notification sent to agent");
  } catch (error) {
    log.error("Failed to send cancel notification", { error: (error as Error).message });
    // Don't send error to client - the prompt will complete with appropriate status
  }
}

// ============================================================================
// File Explorer Handlers
// ============================================================================

function handleListDir(ws: WSContext, payload: { path: string }): void {
  const cwd = getClientCwd(ws);
  const items = listDir(cwd, payload.path);
  if (items === null) {
    log.debug(`list_dir failed: ${payload.path || "(root)"}`);
    send(ws, "error", { message: `list_dir failed: ${payload.path || "(root)"}` });
    return;
  }
  send(ws, "dir_listing", { path: payload.path, items });
}

function handleReadFile(ws: WSContext, payload: { path: string }): void {
  const cwd = getClientCwd(ws);
  const content = readFile(cwd, payload.path);
  if (content === null) {
    send(ws, "error", { message: "Access denied or file not found" });
    return;
  }
  send(ws, "file_content", content);
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
  const { port, host, command, args, cwd, token, termux, https, publicUrl } = config;

  // Set module-level config
  AGENT_COMMAND = command;
  AGENT_ARGS = args;
  AGENT_CWD = cwd;
  BROWSER_MCP_URL = `${https ? "https" : "http"}://localhost:${port}/mcp`;
  AGENT_ENV = { ...process.env };
  AUTH_TOKEN = token;

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

  // WebSocket endpoint with token validation
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      // Validate token before upgrade if auth is enabled
      if (AUTH_TOKEN) {
        const url = new URL(c.req.url);
        const providedToken = url.searchParams.get("token");
        if (providedToken !== AUTH_TOKEN) {
          log.warn("WebSocket connection rejected: invalid token");
          // Return empty handlers - connection will be rejected
          return {
            onOpen(_event, ws) {
              ws.close(4001, "Unauthorized: Invalid token");
            },
            onMessage() {},
            onClose() {},
          };
        }
      }

      return {
        onOpen(_event, ws) {
          log.info("Client connected");
          const state: ClientState = {
            process: null,
            connection: null,
            sessionId: null,
            pendingSessionLoad: null,
            cancelRequested: false,
            pendingPermissions: new Map(),
            pendingElicitations: new Map(),
            agentCapabilities: null,
            promptCapabilities: null,
            authMethods: [],
            sessionModes: null,
            configOptions: null,
            terminals: new TerminalManager(),
            unsubscribeWatcher: null,
            sessionCwd: null,
            isAlive: true,
          };
          clients.set(ws, state);

          // Listen for protocol-level pong frames to track liveness
          const rawWs = ws.raw as RawWebSocket;
          rawWs.on("pong", () => {
            state.isAlive = true;
          });

          // Register this WebSocket for browser tool calls
          setExtensionWebSocket(ws);
        },
      async onMessage(event, ws) {
        try {
          const parsed: unknown = JSON.parse(event.data.toString());
          if (!isObject(parsed)) {
            throw new Error("Invalid message: expected a JSON object");
          }
          const type = requireString(parsed.type, "type");
          const payload = isObject(parsed.payload) ? parsed.payload : {};
          log.debug("Received message", { type });

          switch (type) {
            case "connect":
              await handleConnect(ws);
              break;
            case "disconnect":
              handleDisconnect(ws);
              break;
            case "new_session":
              await handleNewSession(ws, { cwd: optionalString(payload.cwd) });
              break;
            case "prompt": {
              const content = payload.content;
              if (
                !Array.isArray(content) ||
                !content.every(
                  (block) => isObject(block) && typeof block.type === "string",
                )
              ) {
                throw new Error(
                  "Invalid message: prompt.content must be an array of content blocks",
                );
              }
              await handlePrompt(ws, { content: content as acp.ContentBlock[] });
              break;
            }
            case "browser_tool_result": {
              // Handle response from extension for browser tool call
              const callId = requireString(parsed.callId, "callId");
              log.trace("Raw browser_tool_result from extension", {
                callId,
                result: parsed.result,
              });
              handleBrowserToolResponse(
                callId,
                parsed.result as Parameters<typeof handleBrowserToolResponse>[1],
              );
              break;
            }
            case "permission_response": {
              const requestId = requireString(payload.requestId, "requestId");
              const outcome = payload.outcome;
              if (!isObject(outcome)) {
                throw new Error("Invalid message: permission outcome missing");
              }
              let parsedOutcome: acp.RequestPermissionOutcome;
              if (outcome.outcome === "cancelled") {
                parsedOutcome = { outcome: "cancelled" };
              } else if (outcome.outcome === "selected") {
                parsedOutcome = {
                  outcome: "selected",
                  optionId: requireString(outcome.optionId, "outcome.optionId"),
                };
              } else {
                throw new Error("Invalid message: unknown permission outcome");
              }
              handlePermissionResponse(ws, {
                requestId,
                outcome: parsedOutcome,
              });
              break;
            }
            case "elicitation_response": {
              const requestId = requireString(payload.requestId, "requestId");
              const response = payload.response;
              if (!isObject(response)) {
                throw new Error("Invalid message: elicitation response missing");
              }
              let parsedResponse: acp.CreateElicitationResponse;
              if (response.action === "accept") {
                parsedResponse = {
                  action: "accept",
                  content: isObject(response.content)
                    ? (response.content as Record<string, acp.ElicitationContentValue>)
                    : undefined,
                };
              } else if (
                response.action === "decline" ||
                response.action === "cancel"
              ) {
                parsedResponse = { action: response.action };
              } else {
                throw new Error("Invalid message: unknown elicitation action");
              }
              handleElicitationResponse(ws, {
                requestId,
                response: parsedResponse,
              });
              break;
            }
            case "cancel":
              // Handle cancel request - send session/cancel to agent
              await handleCancel(ws);
              break;
            case "set_session_mode":
              await handleSetSessionMode(ws, {
                modeId: requireString(payload.modeId, "modeId"),
              });
              break;
            case "set_config_option": {
              const value = payload.value;
              if (typeof value !== "string" && typeof value !== "boolean") {
                throw new Error(
                  'Invalid message: "value" must be a string or boolean',
                );
              }
              await handleSetConfigOption(ws, {
                configId: requireString(payload.configId, "configId"),
                value,
              });
              break;
            }
            case "authenticate":
              await handleAuthenticate(ws, {
                methodId: requireString(payload.methodId, "methodId"),
              });
              break;
            case "logout":
              await handleLogout(ws);
              break;
            // Session history operations - Reference: Zed's AgentSessionList
            case "list_sessions":
              await handleListSessions(ws, {
                cwd: optionalString(payload.cwd),
                cursor: optionalString(payload.cursor),
              });
              break;
            case "load_session":
              await handleLoadSession(ws, {
                sessionId: requireString(payload.sessionId, "sessionId"),
                cwd: optionalString(payload.cwd),
              });
              break;
            case "resume_session":
              await handleResumeSession(ws, {
                sessionId: requireString(payload.sessionId, "sessionId"),
                cwd: optionalString(payload.cwd),
              });
              break;
            case "delete_session":
              await handleDeleteSession(ws, {
                sessionId: requireString(payload.sessionId, "sessionId"),
              });
              break;
            case "close_session":
              await handleCloseSession(ws, {
                sessionId: requireString(payload.sessionId, "sessionId"),
              });
              break;
            case "list_dir":
              handleListDir(ws, {
                path: requireString(payload.path, "path"),
              });
              break;
            case "read_file":
              handleReadFile(ws, {
                path: requireString(payload.path, "path"),
              });
              break;
            case "ping":
              send(ws, "pong");
              break;
            default:
              send(ws, "error", {
                message: `Unknown message type: ${type}`,
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
          // Unsubscribe from file watcher
          state.unsubscribeWatcher?.();
        }
        handleDisconnect(ws);
        clients.delete(ws);
        // Clear extension WebSocket if this was it
        setExtensionWebSocket(null);
      },
    };
    }),
  );

  // Create server with optional HTTPS
  let server;
  if (https) {
    const tlsOptions = await getOrCreateCertificate();
    AGENT_ENV = getAgentTlsEnv(tlsOptions.cert);
    server = serve({
      fetch: app.fetch,
      port,
      hostname: host,
      createServer: createHttpsServer,
      serverOptions: tlsOptions,
    });
  } else {
    server = serve({ fetch: app.fetch, port, hostname: host });
  }
  injectWebSocket(server);

  // Heartbeat: periodically ping all connected clients to keep
  // connections alive through intermediate gateways and detect dead clients.
  setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.isAlive) {
        log.info("Client heartbeat timeout, terminating connection");
        const rawWs = ws.raw as RawWebSocket;
        rawWs.terminate();
        continue;
      }
      state.isAlive = false;
      (ws.raw as RawWebSocket).ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Protocol strings based on HTTPS mode
  const httpProtocol = https ? "https" : "http";
  const wsProtocol = https ? "wss" : "ws";

  // Get actual LAN IP when binding to 0.0.0.0
  let displayHost = host;
  if (host === "0.0.0.0") {
    const lanIPs = getLanIPs();
    displayHost = lanIPs[0] || "localhost";
  }

  // Build URLs
  const localWsUrl = `${wsProtocol}://localhost:${port}/ws`;
  const networkWsUrl = `${wsProtocol}://${displayHost}:${port}/ws`;
  const localAppUrl = `${httpProtocol}://localhost:${port}/app`;
  const networkAppUrl = `${httpProtocol}://${displayHost}:${port}/app`;
  const tokenSuffix = AUTH_TOKEN ? `?token=${AUTH_TOKEN}` : "";

  // Print startup banner
  console.log();
  console.log(`  🚀 ACP Proxy Server${https ? " (HTTPS)" : ""}`);
  console.log();

  // One-click URLs (open in browser)
  console.log(`  Open in browser:`);
  console.log(`    ➜ Local:   ${localAppUrl}${tokenSuffix}`);
  if (host === "0.0.0.0") {
    console.log(`    ➜ Network: ${networkAppUrl}${tokenSuffix}`);
  }
  console.log();

  // Manual connection info (for form input)
  console.log(`  Manual connection:`);
  if (host === "0.0.0.0") {
    console.log(`    URL:   ${networkWsUrl}`);
  } else {
    console.log(`    URL:   ${localWsUrl}`);
  }
  if (AUTH_TOKEN) {
    console.log(`    Token: ${AUTH_TOKEN}`);
  }
  console.log();

  // Show QR code for mobile connection
  if (AUTH_TOKEN) {
    // Use publicUrl if provided, otherwise fall back to networkWsUrl
    const qrUrl = publicUrl || networkWsUrl;
    const qrData = JSON.stringify({ url: qrUrl, token: AUTH_TOKEN });

    const QRCode = await import("qrcode");
    const qrString = await QRCode.toString(qrData, { type: "terminal", small: true });
    console.log(`  📱 Scan QR to connect on mobile:`);
    if (publicUrl) {
      console.log(`    (using --public-url: ${publicUrl})`);
    }
    console.log();
    console.log(qrString);
  } else {
    console.log(`  ⚠️  Authentication disabled (--no-auth)`);
    console.log();
  }

  // Agent info
  const agentDisplay = AGENT_ARGS.length > 0
    ? `${AGENT_COMMAND} ${AGENT_ARGS.join(" ")}`
    : AGENT_COMMAND;
  console.log(`  📦 Agent: ${agentDisplay}`);
  console.log(`     CWD:   ${AGENT_CWD}`);
  console.log();
  console.log(`  Press Ctrl+C to stop`);
  console.log();

  // Also log to file when debug is enabled
  log.info("Server started", {
    port,
    host,
    https,
    publicUrl,
    wsEndpoint: `${wsProtocol}://${displayHost}:${port}/ws`,
    mcpEndpoint: `${httpProtocol}://${displayHost}:${port}/mcp`,
    agent: AGENT_COMMAND,
    agentArgs: AGENT_ARGS,
    cwd: AGENT_CWD,
    authEnabled: !!AUTH_TOKEN,
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
