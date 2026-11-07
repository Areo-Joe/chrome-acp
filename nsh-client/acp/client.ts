import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface AcpClientSettings {
  url: string;
  cwd: string;
  token?: string;
}

/** ACP v1 over WebSocket. RPC correlation and cancellation belong to the SDK. */
export class AcpClient {
  private readonly settings: AcpClientSettings;
  private connection: acp.ClientConnection | null = null;
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private creatingSession = false;
  private earlyUpdates: acp.SessionNotification[] = [];
  private closeMessage: string | undefined;
  private _agentInfo: acp.Implementation | null = null;
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

  constructor(settings: AcpClientSettings) { this.settings = settings; }

  get agentInfo() { return this._agentInfo; }
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

  async connect(): Promise<void> {
    if (this.connection) throw new Error("Already connected");
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
      if (params.sessionId === this.sessionId) this.applyUpdate(params.update);
      else if (this.creatingSession) {
        if (this.earlyUpdates.length === 128) this.earlyUpdates.shift();
        this.earlyUpdates.push(params);
      }
    });
    // The client does not yet expose a permission UI.
    app.onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }));
    const connection = app.connect(createWebSocketStream(url.toString(), { WebSocket: Socket, cookies: "omit" }));
    this.connection = connection;
    connection.closed.then(() => {
      if (this.connection !== connection) return;
      this.connection = null;
      this.socket?.close();
      this.socket = null;
      this.resetSession();
      this.onState?.(this.closeMessage ? "error" : "disconnected", this.closeMessage);
    });
    try {
      const result = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "nsh-client", version: "1.0.0" },
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
      });
      if (this.connection !== connection) throw new Error("Connection closed");
      if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version: ${result.protocolVersion}`);
      this._agentInfo = result.agentInfo ?? null;
      this.onState?.("connected");
    } catch (reason) {
      const error = new Error(this.closeMessage || (reason instanceof Error ? reason.message : "Agent initialization failed"));
      if (this.connection === connection) {
        this.connection = null;
        connection.close(error);
        this.socket?.close();
        this.socket = null;
        this.resetSession();
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
      this.sessionId = result.sessionId;
      for (const notification of this.earlyUpdates) {
        if (notification.sessionId === this.sessionId) this.applyUpdate(notification.update);
      }
      this._configOptions = result.configOptions ?? null;
      this._sessionModes = this._configOptions ? null : result.modes ?? null;
      this.onConfig?.(this._configOptions);
      this.onModes?.(this._sessionModes);
      this.onCreated?.(result.sessionId);
      return result.sessionId;
    } finally {
      this.creatingSession = false;
      this.earlyUpdates = [];
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
    this.resetSession();
    this.onState?.("disconnected");
  }

  private resetSession(): void {
    this.sessionId = null;
    this.earlyUpdates = [];
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
