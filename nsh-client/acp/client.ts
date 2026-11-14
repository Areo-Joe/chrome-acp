import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type AcpProtocolMode = "v1" | "auto";
export const DEFAULT_ACP_PROTOCOL_MODE: AcpProtocolMode = "v1";

/** Zed's AuthRequired::from_error uses the protocol code, never message matching. */
export function authenticationRequired(reason: unknown): { description: string | null } | null {
  if (!(reason instanceof acp.RequestError) || reason.code !== -32000) return null;
  return { description: reason.message === "Authentication required" ? null : reason.message };
}

/** Zed routes valid legacy terminal-auth metadata through the terminal path too. */
export function authenticationKind(method: acp.AuthMethod): "agent" | "terminal" {
  if ("type" in method && method.type === "terminal") return "terminal";
  const terminal = struct(method._meta?.["terminal-auth"], ["label", "command", "args", "env"]);
  if (!terminal || typeof terminal.label !== "string" || typeof terminal.command !== "string") return "agent";
  const args = terminal.args === undefined ? [] : terminal.args;
  const env = terminal.env === undefined ? {} : object(terminal.env);
  return Array.isArray(args) && args.every((arg) => typeof arg === "string")
    && env && Object.values(env).every((value) => typeof value === "string") ? "terminal" : "agent";
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

// Serde structs also accept positional sequences, with trailing default fields omitted.
function struct(value: unknown, fields: readonly string[]): JsonObject | undefined {
  if (!Array.isArray(value)) return object(value);
  if (value.length > fields.length) return undefined;
  return Object.fromEntries(value.map((item, index) => [fields[index], item]));
}

function metadata(value: JsonObject): JsonObject {
  const meta = object(value._meta);
  return meta ? { _meta: meta } : {};
}

function variant(value: unknown, names: readonly string[]): string | undefined {
  if (typeof value === "string") return names.includes(value) ? value : undefined;
  const entries = Object.entries(object(value) ?? {});
  return entries.length === 1 && entries[0][1] === null && names.includes(entries[0][0]) ? entries[0][0] : undefined;
}

/** Zed's locked v1 Plan serde: required entries, DefaultOnError<VecSkipError>,
 * positional structs and externally tagged unit variants. Unknown names are skipped.
 */
export function decodePlan(value: unknown): acp.Plan {
  const input = struct(value, ["entries", "_meta"]);
  if (!input || !("entries" in input)) throw new Error("Invalid ACP plan: entries is required");
  const entries: acp.Plan["entries"] = [];
  for (const value of Array.isArray(input.entries) ? input.entries : []) {
    const entry = struct(value, ["content", "priority", "status", "_meta"]);
    if (!entry || typeof entry.content !== "string") continue;
    const priority = variant(entry.priority, ["high", "medium", "low"]) as acp.PlanEntryPriority | undefined;
    const status = variant(entry.status, ["pending", "in_progress", "completed"]) as acp.PlanEntryStatus | undefined;
    if (priority && status) entries.push({ content: entry.content, priority, status, ...metadata(entry) });
  }
  return { entries, ...metadata(input) };
}

/** Session callbacks are synchronous; a new event-loop turn follows the SDK's
 * already-received dispatch microtasks, like Zed's foreground queue barrier. */
function drainSessionDispatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Mirrors Zed's locked schema 1.15.1, including its enabled v1 extensions.
 * Optional fields use DefaultOnError; authentication arrays use VecSkipError.
 * Unknown fields outside _meta are ignored by serde.
 */
function decodeInitialize(value: unknown): acp.InitializeResponse {
  const input = struct(value, ["protocolVersion", "agentCapabilities", "authMethods", "agentInfo", "_meta"]);
  const version = input?.protocolVersion;
  if (!input || typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 65535) {
    throw new Error("Invalid ACP initialize response: protocolVersion must be an unsigned 16-bit integer");
  }

  type Capability = { flags?: readonly string[]; required?: Record<string, Capability>; optional?: Record<string, Capability> };
  function capabilities(value: unknown, spec: Capability): JsonObject | undefined {
    const flags = spec.flags ?? [];
    const required = Object.entries(spec.required ?? {});
    const optional = Object.entries(spec.optional ?? {});
    const input = struct(value, [...flags, ...required.map(([key]) => key), ...optional.map(([key]) => key), "_meta"]);
    if (!input) return undefined;
    const result = metadata(input);
    for (const key of flags) result[key] = typeof input[key] === "boolean" ? input[key] : false;
    for (const [key, child] of required) result[key] = capabilities(input[key], child) ?? capabilities({}, child)!;
    for (const [key, child] of optional) {
      const decoded = capabilities(input[key], child);
      if (decoded) result[key] = decoded;
    }
    return result;
  }

  const agentSpec: Capability = {
    flags: ["loadSession"],
    required: {
      promptCapabilities: { flags: ["image", "audio", "embeddedContext"] },
      mcpCapabilities: { flags: ["http", "sse", "acp"] },
      sessionCapabilities: { optional: {
        list: {}, delete: {}, additionalDirectories: {},
        systemPrompt: { optional: { mode: { optional: { override: {} } } } },
        fork: {}, archive: {}, status: {}, title: {}, resume: {}, close: {},
      } },
      auth: { optional: { status: {}, logout: {} } },
    },
    optional: { providers: {} },
  };
  const agentCapabilities = (capabilities(input.agentCapabilities, agentSpec) ?? capabilities({}, agentSpec)!) as acp.AgentCapabilities;

  const authMethods: acp.AuthMethod[] = [];
  for (const value of Array.isArray(input.authMethods) ? input.authMethods : []) {
    const method = struct(value, ["id", "name", "description", "_meta"]);
    if (!method || typeof method.id !== "string" || typeof method.name !== "string") continue;
    const common = {
      id: method.id, name: method.name,
      ...(typeof method.description === "string" ? { description: method.description } : {}),
      ...metadata(method),
    };
    const explicitTerminal = method.type === "terminal";
    // Serde accepts numeric variant index 0 as terminal before its untagged fallback.
    if (explicitTerminal || method.type === 0) {
      const args = method.args ?? [];
      const env = method.env ?? {};
      const variables = object(env);
      if (Array.isArray(args) && args.every((arg) => typeof arg === "string")
        && variables && Object.values(variables).every((value) => typeof value === "string")) {
        authMethods.push({
          ...common, type: "terminal",
          ...(args.length ? { args } : {}),
          ...(Object.keys(variables).length ? { env: variables as Record<string, string> } : {}),
        });
        continue;
      }
      // Only the literal terminal tag blocks agent fallback after a schema failure.
      if (explicitTerminal) continue;
    }
    authMethods.push(common);
  }

  const info = struct(input.agentInfo, ["name", "title", "version", "_meta"]);
  const agentInfo = info && typeof info.name === "string" && typeof info.version === "string"
    ? { name: info.name, version: info.version, ...(typeof info.title === "string" ? { title: info.title } : {}), ...metadata(info) }
    : undefined;
  return { protocolVersion: version, agentCapabilities, authMethods, ...(agentInfo ? { agentInfo } : {}), ...metadata(input) };
}

function details(input: JsonObject) {
  return { ...(typeof input.description === "string" ? { description: input.description } : {}), ...metadata(input) };
}

function skipInvalid<T>(value: unknown, decode: (value: unknown) => T | undefined): T[] {
  return Array.isArray(value) ? value.flatMap((item) => { const decoded = decode(item); return decoded === undefined ? [] : [decoded]; }) : [];
}

function decodeMode(value: unknown): acp.SessionMode | undefined {
  const input = struct(value, ["id", "name", "description", "_meta"]);
  if (!input || typeof input.id !== "string" || typeof input.name !== "string") return undefined;
  return { id: input.id, name: input.name, ...details(input) };
}

function decodeModes(value: unknown): acp.SessionModeState | undefined {
  const input = struct(value, ["currentModeId", "availableModes", "_meta"]);
  // DefaultOnError is not serde(default): availableModes is still required.
  if (!input || typeof input.currentModeId !== "string" || !Object.hasOwn(input, "availableModes")) return undefined;
  return { currentModeId: input.currentModeId, availableModes: skipInvalid(input.availableModes, decodeMode), ...metadata(input) };
}

function decodeChoice(value: unknown): acp.SessionConfigSelectOption | undefined {
  const input = struct(value, ["value", "name", "description", "_meta"]);
  if (!input || typeof input.value !== "string" || typeof input.name !== "string") return undefined;
  return { value: input.value, name: input.name, ...details(input) };
}

function decodeGroup(value: unknown): acp.SessionConfigSelectGroup | undefined {
  const input = struct(value, ["group", "name", "options", "_meta"]);
  if (!input || typeof input.group !== "string" || typeof input.name !== "string" || !Object.hasOwn(input, "options")) return undefined;
  return { group: input.group, name: input.name, options: skipInvalid(input.options, decodeChoice), ...metadata(input) };
}

function decodeChoices(value: unknown): acp.SessionConfigSelectOptions | undefined {
  if (!Array.isArray(value)) return undefined;
  // The outer untagged enum tries the entire flat list before the entire grouped
  // list. Only a group's inner options list uses VecSkipError.
  const flat = value.map(decodeChoice);
  if (flat.every((choice) => choice !== undefined)) return flat;
  const grouped = value.map(decodeGroup);
  return grouped.every((group) => group !== undefined) ? grouped : undefined;
}

function decodeConfigOption(value: unknown): acp.SessionConfigOption | undefined {
  // SessionConfigOption has a flattened kind; serde requires a map here.
  const input = object(value);
  if (!input || typeof input.id !== "string" || typeof input.name !== "string") return undefined;
  const common = {
    id: input.id, name: input.name, ...details(input),
    ...(typeof input.category === "string" ? { category: input.category } : {}),
  };
  if ((input.type === "boolean" || input.type === 1) && typeof input.currentValue === "boolean") {
    return { ...common, type: "boolean", currentValue: input.currentValue };
  }
  if ((input.type === "select" || input.type === 0) && typeof input.currentValue === "string") {
    const options = decodeChoices(input.options);
    if (options !== undefined) return { ...common, type: "select", currentValue: input.currentValue, options };
  }
  return undefined;
}

type SessionResponseMethod = "session/new" | "session/load" | "session/resume" | "session/set_config_option";
function decodeSessionResponse(value: unknown, method: "session/new"): acp.NewSessionResponse;
function decodeSessionResponse(value: unknown, method: "session/set_config_option"): acp.SetSessionConfigOptionResponse;
function decodeSessionResponse(value: unknown, method: "session/load" | "session/resume"): acp.LoadSessionResponse;
function decodeSessionResponse(value: unknown, method: SessionResponseMethod): acp.LoadSessionResponse & { sessionId?: string } {
  const isNew = method === "session/new";
  const isConfig = method === "session/set_config_option";
  const nullable = method === "session/load" || method === "session/resume";
  const fields = isConfig ? ["configOptions", "_meta"] : [...(isNew ? ["sessionId"] : []), "modes", "configOptions", "_meta"];
  const input = struct(nullable && value == null ? {} : value, fields);
  if (!input || (isNew && typeof input.sessionId !== "string") || (isConfig && !Object.hasOwn(input, "configOptions"))) {
    throw new Error(`Invalid ACP ${method} response`);
  }
  const modes = isConfig ? undefined : decodeModes(input.modes);
  const configOptions = isConfig || Array.isArray(input.configOptions) ? skipInvalid(input.configOptions, decodeConfigOption) : undefined;
  return {
    ...(isNew ? { sessionId: input.sessionId as string } : {}),
    ...(modes ? { modes } : {}),
    ...(configOptions !== undefined ? { configOptions } : {}),
    ...metadata(input),
  };
}

export type HistorySession = {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  title?: string;
  updatedAt?: string;
  _meta?: Record<string, unknown>;
};
export type HistoryPage = { sessions: HistorySession[]; nextCursor?: string; _meta?: Record<string, unknown> };

/** Zed parses RFC3339, ignores invalid updates, and distinguishes null from absence. */
export function historyTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, offset] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return null;
  if (offset.length > 1 && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return null;
  const time = Date.parse(value.replace(/[t ]/, "T").replace(/z$/, "Z").replace(/:60(?=[.Zz+-])/, ":59"));
  return Number.isFinite(time) ? time + (second === "60" ? 1000 : 0) : null;
}

export function historyInfoPatch(update: acp.SessionUpdate): Partial<HistorySession> {
  if (update.sessionUpdate !== "session_info_update") return {};
  return {
    ...(Object.hasOwn(update, "title") && (typeof update.title === "string" || update.title === null) ? { title: update.title ?? undefined } : {}),
    ...(update.updatedAt === null ? { updatedAt: undefined } : historyTimestamp(update.updatedAt) !== null ? { updatedAt: update.updatedAt! } : {}),
    ...(object(update._meta) ? { _meta: update._meta! } : {}),
  };
}

/** Zed v1 ListSessionsResponse: required list, DefaultOnError + VecSkipError. */
function decodeHistory(value: unknown): HistoryPage {
  const input = struct(value, ["sessions", "nextCursor", "_meta"]);
  if (!input || !Object.hasOwn(input, "sessions")) throw new Error("Invalid ACP session/list response");
  const sessions = skipInvalid(input.sessions, (value): HistorySession | undefined => {
    const entry = struct(value, ["sessionId", "cwd", "additionalDirectories", "title", "updatedAt", "archived", "_meta"]);
    if (!entry || typeof entry.sessionId !== "string" || typeof entry.cwd !== "string") return undefined;
    return {
      sessionId: entry.sessionId, cwd: entry.cwd,
      additionalDirectories: skipInvalid(entry.additionalDirectories, (value) => typeof value === "string" ? value : undefined),
      ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      ...(historyTimestamp(entry.updatedAt) !== null ? { updatedAt: entry.updatedAt as string } : {}),
      ...metadata(entry),
    };
  });
  return { sessions, ...(typeof input.nextCursor === "string" ? { nextCursor: input.nextCursor } : {}), ...metadata(input) };
}

export interface AcpClientSettings {
  url: string;
  cwd: string;
  token?: string;
  protocolMode?: AcpProtocolMode;
  additionalDirectories?: string[];
}

type SessionOperation = {
  done: Promise<void>;
  finish: () => void;
  resultId: string | null;
  targetId: string | null;
  previousId: string | null;
  succeeded: boolean;
};

/** ACP v1 over WebSocket. RPC correlation and cancellation belong to the SDK. */
export class AcpClient {
  private readonly settings: AcpClientSettings;
  private owner: AcpClient = this;
  private readonly sessionClients = new Set<AcpClient>();
  private readonly sessions = new Map<string, AcpClient>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly configurationTasks = new Set<AbortController>();
  private readonly authenticationTasks = new Set<AbortController>();
  private readonly historyListeners = new Set<(sessionId?: string, update?: acp.SessionUpdate) => void>();
  private connection: acp.ClientConnection | null = null;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  // Zed replaces the session's configuration owner when reopening the same ID.
  private sessionGeneration = 0;
  private sessionOperation: SessionOperation | null = null;
  private closeMessage: string | undefined;
  private _agentInfo: acp.Implementation | null = null;
  private _agentCapabilities: acp.AgentCapabilities | null = null;
  private _authMethods: acp.AuthMethod[] = [];
  private _configOptions: acp.SessionConfigOption[] | null = null;
  private _sessionModes: acp.SessionModeState | null = null;
  private _availableCommands: acp.AvailableCommand[] = [];
  private onState?: (state: ConnectionState, error?: string) => void;
  private onError?: (message: string) => void;
  private onCreated?: (sessionId: string) => void;
  private onConfig?: (options: acp.SessionConfigOption[] | null) => void;
  private onModes?: (modes: acp.SessionModeState | null) => void;
  private onCommands?: (commands: acp.AvailableCommand[]) => void;
  private onUpdate?: (update: acp.SessionUpdate) => void;
  private onPermission?: (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>;

  constructor(settings: AcpClientSettings) { this.settings = settings; }

  /** A session-scoped handle shares one initialized transport, like Zed's session registry. */
  forkSession(cwd = this.settings.cwd, additionalDirectories: string[] = []): AcpClient {
    const root = this.owner;
    const child = new AcpClient({ ...root.settings, cwd, additionalDirectories });
    child.owner = root;
    child.connection = root.requireConnection();
    child._agentInfo = root._agentInfo;
    child._agentCapabilities = root._agentCapabilities;
    child._authMethods = root._authMethods;
    root.sessionClients.add(child);
    return child;
  }

  get workingDirectory() { return this.settings.cwd; }
  get currentSessionId() { return this.sessionId; }
  get supportsHistory() { return this._agentCapabilities?.sessionCapabilities?.list != null; }
  get supportsDelete() { return this.supportsHistory && this._agentCapabilities?.sessionCapabilities?.delete != null; }
  get supportsRestore() { return this._agentCapabilities?.loadSession === true || this._agentCapabilities?.sessionCapabilities?.resume != null; }
  get resumesWithoutHistory() { return this._agentCapabilities?.loadSession !== true; }

  watchHistory(listener: (sessionId?: string, update?: acp.SessionUpdate) => void): () => void {
    this.owner.historyListeners.add(listener);
    return () => { this.owner.historyListeners.delete(listener); };
  }

  async listSessions(request: { cwd?: string; cursor?: string } = {}): Promise<HistoryPage> {
    if (!this.supportsHistory) throw new Error("Listing sessions is not supported by this agent.");
    const connection = this.requireConnection();
    const response = await connection.agent.request(acp.methods.agent.session.list, {
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    });
    if (this.connection !== connection) throw new Error("Connection closed");
    return decodeHistory(response);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.supportsDelete) throw new Error("Deleting sessions is not supported by this agent.");
    const connection = this.requireConnection();
    try {
      const response = await connection.agent.request(acp.methods.agent.session.delete, { sessionId });
      if (!struct(response ?? {}, ["_meta"])) throw new Error("Invalid ACP session/delete response");
    } catch (error) {
      // Zed treats an already-missing session as successfully deleted.
      if (!(error instanceof acp.RequestError) || error.code !== -32002) throw error;
    }
    if (this.connection !== connection) throw new Error("Connection closed");
    for (const listener of this.owner.historyListeners) listener();
  }

  /** Dispose only this session's registration; the transport belongs to the connection. */
  forgetSession(): void {
    for (const task of this.configurationTasks) task.abort();
    this.configurationTasks.clear();
    for (const task of this.authenticationTasks) task.abort();
    this.authenticationTasks.clear();
    this.sessionOperation = null;
    this.resetSession();
    this.owner.sessionClients.delete(this);
    if (this !== this.owner) {
      this.connection = null;
      this._agentInfo = null;
      this._agentCapabilities = null;
      this._authMethods = [];
    }
  }

  /** Zed's released thread remains pending until close + queued dispatch finish.
   * A replacement using this ID must wait for that owner even after its view is gone. */
  releaseSession(): Promise<void> {
    const root = this.owner;
    const connection = this.connection;
    const id = this.sessionId;
    const operation = this.sessionOperation;
    const supportsClose = this._agentCapabilities?.sessionCapabilities?.close != null;
    this.forgetSession();
    if (!connection) return Promise.resolve();
    const affected = new Set([id, operation?.targetId ?? null, operation?.previousId ?? null].filter((value): value is string => value !== null));
    let releasing!: Promise<void>;
    releasing = (async () => {
      // A dropped loading view must not let its replacement overtake the wire
      // operation. Zed keeps the weak thread's task in pending_sessions too.
      if (operation) await operation.done;
      if (root.connection !== connection) return;
      const releaseId = operation?.resultId ?? id;
      if (releaseId === null) {
        await drainSessionDispatch();
        return;
      }
      if (!affected.has(releaseId)) {
        affected.add(releaseId);
        root.releases.set(releaseId, releasing);
      }
      if (supportsClose && (!operation || operation.succeeded) && !root.sessions.has(releaseId)) {
        try {
          const response = await connection.agent.request(acp.methods.agent.session.close, { sessionId: releaseId });
          if (!struct(response ?? {}, ["_meta"])) throw new Error("Invalid ACP session/close response");
        } catch (error) {
          console.warn("ACP session release failed:", error instanceof Error ? error.message : String(error));
        }
      }
      await drainSessionDispatch();
    })();
    for (const key of affected) root.releases.set(key, releasing);
    const finished = () => {
      for (const key of affected) if (root.releases.get(key) === releasing) root.releases.delete(key);
    };
    void releasing.then(finished, finished);
    return releasing;
  }

  private beginSessionOperation(): SessionOperation {
    if (this.sessionOperation) throw new Error("Session creation already in progress");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const operation = { done, finish, resultId: null, targetId: null, previousId: null, succeeded: false };
    this.sessionOperation = operation;
    return operation;
  }

  private registerSession(sessionId: string): void {
    const existing = this.owner.sessions.get(sessionId);
    if (existing && existing !== this) throw new Error("Session is already open");
    this.sessionId = sessionId;
    this.owner.sessions.set(sessionId, this);
  }

  private directories() {
    const extra = this._agentCapabilities?.sessionCapabilities?.additionalDirectories != null ? this.settings.additionalDirectories ?? [] : [];
    return { cwd: this.settings.cwd, mcpServers: [], ...(extra.length ? { additionalDirectories: extra } : {}) };
  }

  get agentInfo() { return this._agentInfo; }
  /** Connection-scoped initialize data, available before the connected callback. */
  get agentCapabilities(): Readonly<acp.AgentCapabilities> | null { return this._agentCapabilities; }
  get authMethods(): readonly acp.AuthMethod[] { return this._authMethods; }
  get configOptions() { return this._configOptions; }
  get sessionModes() { return this._sessionModes; }
  get availableCommands() { return this._availableCommands; }

  setConnectionStateHandler(handler: NonNullable<AcpClient["onState"]>) { this.onState = handler; }
  setErrorHandler(handler: NonNullable<AcpClient["onError"]>) { this.onError = handler; }
  setSessionCreatedHandler(handler: NonNullable<AcpClient["onCreated"]>) { this.onCreated = handler; }
  setConfigOptionsChangedHandler(handler: NonNullable<AcpClient["onConfig"]>) {
    this.onConfig = handler;
    handler(this._configOptions);
  }
  setSessionModesChangedHandler(handler: NonNullable<AcpClient["onModes"]>) {
    this.onModes = handler;
    handler(this._sessionModes);
  }
  setAvailableCommandsChangedHandler(handler: NonNullable<AcpClient["onCommands"]>) {
    this.onCommands = handler;
    handler(this._availableCommands);
  }
  /** Updates of the session's conversation (messages, thoughts, tool calls), in arrival order. */
  setSessionUpdateHandler(handler: AcpClient["onUpdate"]) { this.onUpdate = handler; }
  /** Answers the session's permission requests; `signal` aborts when the agent withdraws one. Without a handler they are cancelled. */
  setPermissionHandler(handler: AcpClient["onPermission"]) { this.onPermission = handler; }

  async connect(): Promise<void> {
    if (this.connection) throw new Error("Already connected");
    const protocolMode = this.settings.protocolMode ?? DEFAULT_ACP_PROTOCOL_MODE;
    if (protocolMode === "auto") {
      // TODO: Match Zed's acp-beta negotiation: try v2, fall back to v1 only on version incompatibility.
      throw new Error("ACP protocol mode 'auto' is unimplemented.");
    }
    this.resetConnectionState();
    this.closeMessage = undefined;
    this.onState?.("connecting");
    const url = new URL(this.settings.url);
    if (this.settings.token) url.searchParams.set("token", this.settings.token);
    const owner = this;
    // Keep the socket's close reason for the UI while using the SDK transport
    // unchanged for framing, stream lifecycle, and JSON-RPC processing.
    const Socket = function (address: string) {
      const socket = new WebSocket(address);
      owner.socket = socket;
      let opened = false;
      socket.addEventListener("open", () => { opened = true; });
      // The server answers a bad token or a failed agent spawn with an HTTP
      // status before the upgrade, which WebSocket does not expose. Record it
      // on "error" too: the SDK closes the connection from that event, before "close".
      const failedBeforeOpen = () => {
        if (owner.socket === socket && !opened && !owner.closeMessage) {
          owner.closeMessage = "Could not open the connection. Check the address and token, and that the agent can start.";
        }
      };
      socket.addEventListener("error", failedBeforeOpen);
      socket.addEventListener("message", (event) => {
        const data = (event as Event & { data: unknown }).data;
        if (typeof data !== "string") return;
        let value: unknown;
        try { value = JSON.parse(data); } catch { return; }
        if (value && typeof value === "object" && !Array.isArray(value) && !("jsonrpc" in value)) {
          // The SDK would answer a non-JSON-RPC message with a protocol error,
          // which a server that is not ACP may answer in turn, forever.
          event.stopImmediatePropagation();
          owner.closeMessage = "This server does not speak ACP. Connect to an ACP WebSocket endpoint.";
          owner.connection?.close(new Error(owner.closeMessage));
        }
      });
      socket.onclose = (event) => {
        failedBeforeOpen();
        if (owner.socket === socket && !owner.closeMessage) owner.closeMessage = event.reason || undefined;
      };
      return socket;
    } as unknown as WebSocketConstructor;
    const app = acp.client({ name: "nsh-client" });
    app.onNotification(acp.methods.client.session.update, ({ params }) => {
      const session = this.sessions.get(params.sessionId);
      if (!session) {
        // Like Zed v1, only registered sessions receive notifications.
        console.warn("Received session notification for unknown session:", params.sessionId);
        return;
      }
      session.applyUpdate(params.update);
      if (params.update.sessionUpdate === "session_info_update") {
        for (const listener of this.historyListeners) listener(params.sessionId, params.update);
      }
    });
    app.onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => {
      const session = this.sessions.get(params.sessionId);
      if (!session) throw acp.RequestError.sessionNotFound(params.sessionId);
      if (!session.onPermission) return { outcome: { outcome: "cancelled" } };
      return session.onPermission(params, signal);
    });
    const stream = createWebSocketStream(url.toString(), { WebSocket: Socket, cookies: "omit" });
    // Canonicalize the ordinary v1 plan's serde representations before SDK
    // validation. Framing, dispatch ordering and all other notifications stay SDK-owned.
    const readable = stream.readable.pipeThrough(new TransformStream({
      transform(message, controller) {
        if ("method" in message && message.method === acp.methods.client.session.update && !("id" in message)) {
          const params = object(message.params);
          const update = object(params?.update);
          if (params && update?.sessionUpdate === "plan") {
            try {
              message = { ...message, params: { ...params, update: { sessionUpdate: "plan", ...decodePlan(update) } } };
            } catch { /* Leave invalid notifications for the SDK to reject. */ }
          }
        }
        controller.enqueue(message);
      },
    }));
    const connection = app.connect({ writable: stream.writable, readable });
    this.connection = connection;
    connection.closed.then(() => {
      if (this.connection !== connection) return;
      this.connection = null;
      this.socket?.close();
      this.socket = null;
      this.resetConnectionState();
      this.onState?.(this.closeMessage ? "error" : "disconnected", this.closeMessage);
    });
    try {
      const response = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "nsh-client", version: "1.0.0" },
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
      });
      if (this.connection !== connection) throw new Error("Connection closed");
      const result = decodeInitialize(response);
      if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version: ${result.protocolVersion}`);
      this._agentInfo = result.agentInfo ?? null;
      this._agentCapabilities = result.agentCapabilities ?? {};
      this._authMethods = result.authMethods ?? [];
      this.onState?.("connected");
    } catch (reason) {
      const error = new Error(this.closeMessage || (reason instanceof Error ? reason.message : "Agent initialization failed"));
      if (this.connection === connection) {
        this.connection = null;
        connection.close(error);
        this.socket?.close();
        this.socket = null;
        this.resetConnectionState();
        this.onState?.("error", error.message);
        this.onError?.(error.message);
      }
      throw error;
    }
  }

  async createSession(): Promise<string> {
    const connection = this.requireConnection();
    const operation = this.beginSessionOperation();
    this.resetSession();
    try {
      const response = await connection.agent.request(acp.methods.agent.session.new, this.directories());
      const result = decodeSessionResponse(response, "session/new");
      operation.resultId = result.sessionId;
      operation.succeeded = true;
      if (this.connection !== connection || this.sessionOperation !== operation) throw new Error("Connection closed");
      this._configOptions = result.configOptions ?? null;
      this._sessionModes = this._configOptions ? null : result.modes ?? null;
      // Initialize the response state before registering, as Zed v1 does.
      this.registerSession(result.sessionId);
      this.onConfig?.(this._configOptions);
      this.onModes?.(this._sessionModes);
      this.onCreated?.(result.sessionId);
      return result.sessionId;
    } finally {
      if (this.sessionOperation === operation) this.sessionOperation = null;
      operation.finish();
    }
  }

  /** Agent-managed v1 login. Terminal methods require a separate host process. */
  async authenticate(methodId: string): Promise<void> {
    const connection = this.requireConnection();
    if (!this._authMethods.some((method) => method.id === methodId && !("type" in method && method.type === "terminal"))) {
      throw new Error("Authentication method is not supported for agent-managed login");
    }
    const task = new AbortController();
    this.authenticationTasks.add(task);
    let response: unknown;
    try {
      response = await connection.agent.request(acp.methods.agent.authenticate, { methodId }, { cancellationSignal: task.signal, stopWaitingOnCancel: true });
    } finally {
      this.authenticationTasks.delete(task);
    }
    if (this.connection !== connection) throw new Error("Connection closed");
    // Rust AuthenticateResponse is a DefaultOnNull struct with one optional _meta field.
    if (!struct(response ?? {}, ["_meta"])) throw new Error("Invalid ACP authenticate response");
  }

  /** Zed v1 reopens an existing session after login, preferring full history load. */
  async restoreSession(sessionId: string): Promise<string> {
    const connection = this.requireConnection();
    const operation = this.beginSessionOperation();
    const previousSessionId = this.sessionId;
    operation.previousId = previousSessionId;
    operation.targetId = sessionId;
    // Capture the predecessor before this operation can itself be released;
    // rereading the map after close could otherwise wait on its own successor.
    const predecessor = this.owner.releases.get(sessionId);
    this.resetSession();
    try {
      // Zed releases the old thread, waits for its optional close RPC, then drains
      // foreground dispatch before another thread can register the same ID.
      if (previousSessionId !== null) {
        if (this._agentCapabilities?.sessionCapabilities?.close != null) {
          try {
            const response = await connection.agent.request(acp.methods.agent.session.close, { sessionId: previousSessionId });
            if (!struct(response ?? {}, ["_meta"])) throw new Error("Invalid ACP session/close response");
          } catch (error) {
            // Zed logs close failures and still permits reopening the session.
            console.warn("ACP session release failed:", error instanceof Error ? error.message : String(error));
          }
        }
        await drainSessionDispatch();
      }
      await predecessor;
      if (this.connection !== connection || this.sessionOperation !== operation) throw new Error("Connection closed");
      const load = this._agentCapabilities?.loadSession === true;
      if (!load && this._agentCapabilities?.sessionCapabilities?.resume == null) {
        throw new Error("Loading or resuming sessions is not supported by this agent.");
      }
      // Unlike session/new, register the known ID before replay starts.
      this.registerSession(sessionId);
      operation.resultId = sessionId;
      const params = { sessionId, ...this.directories() };
      const response = load
        ? await connection.agent.request<acp.LoadSessionResponse>(acp.methods.agent.session.load, params)
        : await connection.agent.request<acp.ResumeSessionResponse>(acp.methods.agent.session.resume, params);
      const result = decodeSessionResponse(response, load ? "session/load" : "session/resume");
      operation.succeeded = true;
      if (this.connection !== connection || this.sessionOperation !== operation) throw new Error("Connection closed");
      this._configOptions = result.configOptions ?? null;
      this._sessionModes = this._configOptions ? null : result.modes ?? null;
      this.onConfig?.(this._configOptions);
      this.onModes?.(this._sessionModes);
      this.onCreated?.(sessionId);
      return sessionId;
    } catch (error) {
      if (this.connection === connection && this.sessionId === sessionId) {
        // Zed drains failed replay before removing its session/pending owner.
        // Keep this operation locked until the old dispatch has finished.
        await drainSessionDispatch();
        if (this.connection === connection && this.sessionOperation === operation) this.resetSession();
      }
      throw error;
    } finally {
      if (this.sessionOperation === operation) this.sessionOperation = null;
      operation.finish();
    }
  }

  private async configurationRequest(connection: acp.ClientConnection, method: string, params: unknown): Promise<unknown> {
    const task = new AbortController();
    this.configurationTasks.add(task);
    try {
      return await connection.agent.request(method, params, { cancellationSignal: task.signal, stopWaitingOnCancel: true });
    } finally {
      this.configurationTasks.delete(task);
    }
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    const generation = this.sessionGeneration;
    const params: acp.SetSessionConfigOptionRequest = typeof value === "boolean"
      ? { sessionId, configId, value, type: "boolean" } : { sessionId, configId, value };
    const response = await this.configurationRequest(connection, acp.methods.agent.session.setConfigOption, params);
    const result = decodeSessionResponse(response, "session/set_config_option");
    if (this.connection !== connection || this.sessionId !== sessionId || this.sessionGeneration !== generation) return;
    this._configOptions = result.configOptions;
    this._sessionModes = null;
    this.onConfig?.(this._configOptions);
    this.onModes?.(null);
  }

  async setSessionMode(modeId: string): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    const generation = this.sessionGeneration;
    const previousModes = this._sessionModes;
    await this.configurationRequest(connection, acp.methods.agent.session.setMode, { sessionId, modeId });
    if (this.connection !== connection || this.sessionId !== sessionId || this.sessionGeneration !== generation || !previousModes) return;
    // Notifications replace the snapshot. Like Zed, keep a newer mode update
    // instead of overwriting it with the original choice on an empty success.
    if (this._sessionModes !== previousModes) return;
    this._sessionModes = { ...previousModes, currentModeId: modeId };
    this.onModes?.(this._sessionModes);
  }

  /** Runs one turn: resolves with its stop reason once the agent ends it. */
  async prompt(prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    return connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt });
  }

  /** Asks the agent to stop the running turn; its prompt then resolves as `cancelled`. */
  async cancel(): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  disconnect(): void {
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.socket?.close();
    this.socket = null;
    this.resetConnectionState();
    this.onState?.("disconnected");
  }

  private resetConnectionState(): void {
    this.sessionOperation = null;
    if (this.owner === this) {
      this.releases.clear();
      for (const child of this.sessionClients) {
        child.connection = null;
        child.resetConnectionState();
      }
      this.sessionClients.clear();
    }
    // Zed creates a fresh AcpConnection per connection; this client can be reused.
    this._agentInfo = null;
    this._agentCapabilities = null;
    this._authMethods = [];
    this.resetSession();
  }

  private resetSession(): void {
    this.sessionGeneration += 1;
    if (this.sessionId !== null && this.owner.sessions.get(this.sessionId) === this) this.owner.sessions.delete(this.sessionId);
    this.sessionId = null;
    this._configOptions = null;
    this._sessionModes = null;
    this._availableCommands = [];
  }

  private requireConnection(): acp.ClientConnection {
    if (!this.connection) throw new Error("Not connected to agent");
    return this.connection;
  }

  private requireSession(): string {
    if (this.sessionId === null) throw new Error("No active session");
    return this.sessionId;
  }

  private applyUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this._availableCommands = update.availableCommands;
        this.onCommands?.(this._availableCommands);
        break;
      case "config_option_update":
        this._configOptions = update.configOptions;
        this._sessionModes = null;
        this.onConfig?.(this._configOptions);
        this.onModes?.(null);
        break;
      case "current_mode_update":
        if (this._sessionModes) {
          this._sessionModes = { ...this._sessionModes, currentModeId: update.currentModeId };
          this.onModes?.(this._sessionModes);
        }
        break;
      default:
        this.onUpdate?.(update);
    }
  }
}
