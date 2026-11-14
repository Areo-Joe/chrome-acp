import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
export type AcpProtocolMode = "v1" | "auto";
export const DEFAULT_ACP_PROTOCOL_MODE: AcpProtocolMode = "v1";

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

export interface AcpClientSettings {
  url: string;
  cwd: string;
  token?: string;
  protocolMode?: AcpProtocolMode;
}

/** ACP v1 over WebSocket. RPC correlation and cancellation belong to the SDK. */
export class AcpClient {
  private readonly settings: AcpClientSettings;
  private connection: acp.ClientConnection | null = null;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private creatingSession = false;
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
      if (params.sessionId !== this.sessionId) {
        // Like Zed v1, only registered sessions receive notifications.
        console.warn("Received session notification for unknown session:", params.sessionId);
        return;
      }
      this.applyUpdate(params.update);
    });
    app.onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => {
      if (params.sessionId !== this.sessionId) throw acp.RequestError.sessionNotFound(params.sessionId);
      if (!this.onPermission) return { outcome: { outcome: "cancelled" } };
      return this.onPermission(params, signal);
    });
    const connection = app.connect(createWebSocketStream(url.toString(), { WebSocket: Socket, cookies: "omit" }));
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
    if (this.creatingSession) throw new Error("Session creation already in progress");
    this.creatingSession = true;
    this.resetSession();
    try {
      const result = await connection.agent.request(acp.methods.agent.session.new, { cwd: this.settings.cwd, mcpServers: [] });
      if (this.connection !== connection) throw new Error("Connection closed");
      this._configOptions = result.configOptions ?? null;
      this._sessionModes = this._configOptions ? null : result.modes ?? null;
      // Initialize the response state before registering, as Zed v1 does.
      this.sessionId = result.sessionId;
      this.onConfig?.(this._configOptions);
      this.onModes?.(this._sessionModes);
      this.onCreated?.(result.sessionId);
      return result.sessionId;
    } finally {
      this.creatingSession = false;
    }
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    const params: acp.SetSessionConfigOptionRequest = typeof value === "boolean"
      ? { sessionId, configId, value, type: "boolean" } : { sessionId, configId, value };
    const result = await connection.agent.request(acp.methods.agent.session.setConfigOption, params);
    if (this.connection !== connection || this.sessionId !== sessionId) return;
    this._configOptions = result.configOptions;
    this._sessionModes = null;
    this.onConfig?.(this._configOptions);
    this.onModes?.(null);
  }

  async setSessionMode(modeId: string): Promise<void> {
    const connection = this.requireConnection();
    const sessionId = this.requireSession();
    const previousModes = this._sessionModes;
    await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
    if (this.connection !== connection || this.sessionId !== sessionId || !previousModes) return;
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
    // Zed creates a fresh AcpConnection per connection; this client can be reused.
    this._agentInfo = null;
    this._agentCapabilities = null;
    this._authMethods = [];
    this.resetSession();
  }

  private resetSession(): void {
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
    if (!this.sessionId) throw new Error("No active session");
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
