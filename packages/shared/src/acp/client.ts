import type {
  ACPSettings,
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  BrowserToolParams,
  BrowserToolResult,
  ConnectionState,
  ContentBlock,
  CreateElicitationResponse,
  ElicitationRequestPayload,
  FileItem,
  FileContent,
  FileChange,
  ListSessionsRequest,
  ListSessionsResponse,
  PermissionRequestPayload,
  PromptCapabilities,
  ProxyMessage,
  ProxyResponse,
  ProxySessionState,
  SessionRef,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
  SessionInfo,
  SessionInfoUpdate,
  SessionModeState,
  ModelPickerState,
  SessionUpdate,
  Usage,
  UsageUpdate,
} from "./types";

/**
 * Error thrown when disconnect() is called while a connection is in progress.
 * Callers can use `instanceof` to distinguish this from real connection errors.
 */
export class DisconnectRequestedError extends Error {
  constructor() {
    super("Disconnect requested");
    this.name = "DisconnectRequestedError";
  }
}

export type ConnectionStateHandler = (
  state: ConnectionState,
  error?: string,
) => void;
export type SessionUpdateHandler = (sessionId: string, update: SessionUpdate) => void;
export type SessionCreatedHandler = (sessionId: string) => void;
export type PromptCompleteHandler = (stopReason: string) => void;
export type PermissionRequestHandler = (request: PermissionRequestPayload) => void;
export type BrowserToolCallHandler = (
  params: BrowserToolParams,
) => Promise<BrowserToolResult>;
export type FileChangesHandler = (changes: FileChange[]) => void;
// Handler for server-pushed directory listings (e.g., after session cwd change)
export type DirListingPushHandler = (path: string, items: FileItem[]) => void;
// Handler for session loaded/resumed events
export type SessionLoadedHandler = (sessionId: string) => void;
// Handler fired before switching the active session.
// This matches Zed's model more closely: the UI changes active thread first,
// then receives updates for that thread while load/resume is in flight.
export type SessionSwitchingHandler = (sessionId: string) => void;
export type SessionModesChangedHandler = (modes: SessionModeState | null) => void;
export type ConfigOptionsChangedHandler = (options: SessionConfigOption[] | null) => void;
export type UsageChangedHandler = (usage: UsageUpdate | null) => void;
export type TurnUsageChangedHandler = (usage: Usage | null) => void;
export type AvailableCommandsChangedHandler = (commands: AvailableCommand[]) => void;
export type SessionInfoChangedHandler = (info: SessionInfo | null) => void;
export type ErrorHandler = (message: string, code?: number) => void;
export type ElicitationRequestHandler = (request: ElicitationRequestPayload) => void;
export type ElicitationCompleteHandler = (elicitationId: string) => void;
export type ElicitationCancelledHandler = () => void;

export class ACPClient {
  private ws: WebSocket | null = null;
  private settings: ACPSettings;
  private connectionState: ConnectionState = "disconnected";
  private sessionId: string | null = null;
  private pendingSessionTarget: string | null = null;
  private _lastSessionLoadMode: "load" | "resume" | null = null;
  // Reference: Zed stores full agentCapabilities from initialize response
  // Used to check supports_load_session, supports_resume_session, etc.
  private _agentCapabilities: AgentCapabilities | null = null;
  // Reference: Zed's prompt_capabilities in MessageEditor
  private _promptCapabilities: PromptCapabilities | null = null;
  private _authMethods: AuthMethod[] = [];
  // Reference: Zed stores session config from new/load/resume responses.
  // When configOptions are present, `modes` is ignored (Zed's `config_state`).
  private _sessionModes: SessionModeState | null = null;
  private _configOptions: SessionConfigOption[] | null = null;
  private _usage: UsageUpdate | null = null;
  private _turnUsage: Usage | null = null;
  private _availableCommands: AvailableCommand[] = [];
  private _sessionInfo: SessionInfo | null = null;
  // Agents may emit `session/update` notifications before the
  // `session/new|load|resume` response. Keep them so session-scoped state
  // (commands, usage, modes, config options) is not lost.
  private earlySessionUpdates = new Map<string, SessionUpdate[]>();

  private onSessionLoaded: SessionLoadedHandler | null = null;
  private onSessionSwitching: SessionSwitchingHandler | null = null;
  private onSessionModesChanged: SessionModesChangedHandler | null = null;
  private onConfigOptionsChanged: ConfigOptionsChangedHandler | null = null;
  private onUsageChanged: UsageChangedHandler | null = null;
  private onTurnUsageChanged: TurnUsageChangedHandler | null = null;
  private onAvailableCommandsChanged: AvailableCommandsChangedHandler | null = null;
  private onSessionInfoChanged: SessionInfoChangedHandler | null = null;
  private onError: ErrorHandler | null = null;
  private onElicitationRequest: ElicitationRequestHandler | null = null;
  private onElicitationComplete: ElicitationCompleteHandler | null = null;
  private onElicitationCancelled: ElicitationCancelledHandler | null = null;

  private onConnectionStateChange: ConnectionStateHandler | null = null;
  private onSessionUpdate: SessionUpdateHandler | null = null;
  private onSessionCreated: SessionCreatedHandler | null = null;
  private onPromptComplete: PromptCompleteHandler | null = null;
  private onPermissionRequest: PermissionRequestHandler | null = null;
  private onBrowserToolCall: BrowserToolCallHandler | null = null;
  private fileChangesHandlers: Set<FileChangesHandler> = new Set();
  private onDirListingPush: DirListingPushHandler | null = null;

  // Pending file operations - keyed by unique requestId to handle concurrent requests
  private requestIdCounter = 0;
  private pendingDirListing: Map<number, { resolve: (items: FileItem[]) => void; reject: (err: Error) => void }> = new Map();
  private pendingFileRead: Map<number, { resolve: (content: FileContent) => void; reject: (err: Error) => void }> = new Map();
  // Pending session operations
  private pendingSessionList: { resolve: (response: ListSessionsResponse) => void; reject: (err: Error) => void } | null = null;
  private pendingSessionLoad: { resolve: (sessionId: string) => void; reject: (err: Error) => void } | null = null;
  private pendingSessionResume: { resolve: (sessionId: string) => void; reject: (err: Error) => void } | null = null;
  private pendingSessionDelete: { resolve: (sessionId: string) => void; reject: (err: Error) => void } | null = null;
  private pendingSessionClose: { resolve: (sessionId: string) => void; reject: (err: Error) => void } | null = null;
  private pendingAuthenticate: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private pendingLogout: { resolve: () => void; reject: (err: Error) => void } | null = null;
  // Track requestId for each path to match responses
  private dirListingRequestIds: Map<string, number> = new Map();
  private fileReadRequestIds: Map<string, number> = new Map();

  private connectResolve: ((value: void) => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  // Heartbeat state
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly PONG_TIMEOUT_MS = 10_000;
  private static readonly MAX_MISSED_PONGS = 2;

  constructor(settings: ACPSettings) {
    this.settings = settings;
  }

  updateSettings(settings: ACPSettings): void {
    this.settings = settings;
  }

  setConnectionStateHandler(handler: ConnectionStateHandler): void {
    this.onConnectionStateChange = handler;
  }

  setSessionUpdateHandler(handler: SessionUpdateHandler): void {
    this.onSessionUpdate = handler;
  }

  setSessionCreatedHandler(handler: SessionCreatedHandler): void {
    this.onSessionCreated = handler;
  }

  setPromptCompleteHandler(handler: PromptCompleteHandler): void {
    this.onPromptComplete = handler;
  }

  setPermissionRequestHandler(handler: PermissionRequestHandler): void {
    this.onPermissionRequest = handler;
  }

  setBrowserToolCallHandler(handler: BrowserToolCallHandler): void {
    this.onBrowserToolCall = handler;
  }

  setSessionSwitchingHandler(handler: SessionSwitchingHandler | null): void {
    this.onSessionSwitching = handler;
  }

  setSessionModesChangedHandler(handler: SessionModesChangedHandler): void {
    this.onSessionModesChanged = handler;
    handler(this._sessionModes);
  }

  setConfigOptionsChangedHandler(handler: ConfigOptionsChangedHandler): void {
    this.onConfigOptionsChanged = handler;
    handler(this._configOptions);
  }

  setUsageChangedHandler(handler: UsageChangedHandler): void {
    this.onUsageChanged = handler;
    handler(this._usage);
  }

  setTurnUsageChangedHandler(handler: TurnUsageChangedHandler): void {
    this.onTurnUsageChanged = handler;
    handler(this._turnUsage);
  }

  setAvailableCommandsChangedHandler(handler: AvailableCommandsChangedHandler): void {
    this.onAvailableCommandsChanged = handler;
    handler(this._availableCommands);
  }

  setSessionInfoChangedHandler(handler: SessionInfoChangedHandler): void {
    this.onSessionInfoChanged = handler;
    handler(this._sessionInfo);
  }

  /** Called for `error` messages sent by the proxy (prompt/session failures). */
  setErrorHandler(handler: ErrorHandler): void {
    this.onError = handler;
  }

  /** Called when the agent requests structured input from the user. */
  setElicitationRequestHandler(handler: ElicitationRequestHandler): void {
    this.onElicitationRequest = handler;
  }

  /** Called when a URL-based elicitation completes. */
  setElicitationCompleteHandler(handler: ElicitationCompleteHandler): void {
    this.onElicitationComplete = handler;
  }

  /** Called when a pending elicitation is cancelled (e.g. prompt cancel). */
  setElicitationCancelledHandler(handler: ElicitationCancelledHandler): void {
    this.onElicitationCancelled = handler;
  }

  /**
   * Set handler for server-pushed directory listings.
   * Called when server sends a dir_listing without a corresponding request
   * (e.g., after session cwd change).
   * Pass null to clear the handler.
   */
  setDirListingPushHandler(handler: DirListingPushHandler | null): void {
    this.onDirListingPush = handler;
  }

  private setState(state: ConnectionState, error?: string): void {
    this.connectionState = state;
    this.onConnectionStateChange?.(state, error);
  }

  getState(): ConnectionState {
    return this.connectionState;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** How the active session was opened: `load` replays history, `resume` does not. */
  get lastSessionLoadMode(): "load" | "resume" | null {
    return this._lastSessionLoadMode;
  }

  // Reference: Zed's supports_images() in MessageEditor
  get supportsImages(): boolean {
    return this._promptCapabilities?.image === true;
  }

  getPromptCapabilities(): PromptCapabilities | null {
    return this._promptCapabilities;
  }

  /**
   * Get the current model state derived from the `model` session config option.
   * ACP now represents model selection as a config option (category "model").
   */
  get modelState(): ModelPickerState | null {
    const option = findConfigOption(this._configOptions, "model");
    if (!option || option.type !== "select") return null;
    const availableModels = flattenConfigSelectOptions(option.options).map((choice) => ({
      modelId: choice.value,
      name: choice.name,
      description: choice.description,
    }));
    return {
      availableModels,
      currentModelId: String(option.currentValue),
    };
  }

  get supportsModelSelection(): boolean {
    return this.modelState !== null;
  }

  get sessionModes(): SessionModeState | null {
    return this._sessionModes;
  }

  get configOptions(): SessionConfigOption[] | null {
    return this._configOptions;
  }

  get usage(): UsageUpdate | null {
    return this._usage;
  }

  /** Token usage reported by the most recent `session/prompt` response. */
  get turnUsage(): Usage | null {
    return this._turnUsage;
  }

  get availableCommands(): AvailableCommand[] {
    return this._availableCommands;
  }

  get sessionInfo(): SessionInfo | null {
    return this._sessionInfo;
  }

  get authMethods(): AuthMethod[] {
    return this._authMethods;
  }

  // ============================================================================
  // Session Capability Getters
  // Reference: Zed's AgentConnection supports_* methods
  // ============================================================================

  get agentCapabilities(): AgentCapabilities | null {
    return this._agentCapabilities;
  }

  get supportsLoadSession(): boolean {
    return this._agentCapabilities?.loadSession === true;
  }

  get supportsResumeSession(): boolean {
    return this._agentCapabilities?.sessionCapabilities?.resume != null;
  }

  get supportsSessionList(): boolean {
    return this._agentCapabilities?.sessionCapabilities?.list != null;
  }

  get supportsDeleteSession(): boolean {
    return this._agentCapabilities?.sessionCapabilities?.delete != null;
  }

  get supportsCloseSession(): boolean {
    return this._agentCapabilities?.sessionCapabilities?.close != null;
  }

  get supportsLogout(): boolean {
    return this._agentCapabilities?.auth?.logout != null;
  }

  /** Session modes are only used when the agent does not send config options. */
  get supportsSessionModes(): boolean {
    return this._sessionModes !== null;
  }

  /** Config option selectors (includes mode/model/thought_level categories). */
  get supportsConfigOptions(): boolean {
    return this._configOptions !== null && this._configOptions.length > 0;
  }

  get supportsSessionHistory(): boolean {
    return this.supportsLoadSession || this.supportsResumeSession;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      this.disconnect();
    }

    this.setState("connecting");

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        // Build WebSocket URL with token if provided
        let wsUrl = this.settings.proxyUrl;
        if (this.settings.token) {
          const url = new URL(wsUrl);
          url.searchParams.set("token", this.settings.token);
          wsUrl = url.toString();
        }
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
          // Guard against race condition: check if this WebSocket is still current
          if (this.ws !== ws) {
            console.log("[ACPClient] WebSocket opened but already disconnected/replaced, closing stale socket");
            ws.close();
            return;
          }
          console.log("[ACPClient] WebSocket connected, sending connect command");
          this.send({ type: "connect" });
        };

        ws.onmessage = (event) => {
          // Ignore messages from stale sockets
          if (this.ws !== ws || typeof event.data !== "string") return;
          try {
            const response: ProxyResponse = JSON.parse(event.data);
            this.handleResponse(response);
          } catch (error) {
            console.error("[ACPClient] Failed to parse message:", error);
          }
        };

        ws.onerror = () => {
          // Ignore errors from stale sockets
          if (this.ws !== ws) return;
          console.error("[ACPClient] WebSocket error");
          this.setState("error", "WebSocket connection error");
          this.connectReject?.(new Error("WebSocket connection error"));
          this.connectResolve = null;
          this.connectReject = null;
        };

        ws.onclose = (event) => {
          // Ignore close events from stale sockets (replaced by a new connection)
          if (this.ws !== ws) return;
          console.log("[ACPClient] WebSocket closed", event.code, event.reason);

          // Check if closed due to auth failure (code 4001) or other error during connect
          if (this.connectReject) {
            const errorMessage = event.reason || `Connection closed (code: ${event.code})`;
            this.setState("error", errorMessage);
            this.connectReject(new Error(errorMessage));
            this.connectResolve = null;
            this.connectReject = null;
          } else {
            this.setState("disconnected");
          }

          this.ws = null;
          this.sessionId = null;
        };
      } catch (error) {
        this.setState("error", (error as Error).message);
        reject(error);
      }
    });
  }

  private handleResponse(response: ProxyResponse): void {
    console.log("[ACPClient] Received:", response.type);

    switch (response.type) {
      case "status":
        if (response.payload.connected) {
          this._agentCapabilities = response.payload.capabilities ?? null;
          this._authMethods = response.payload.authMethods ?? [];
          this.setState("connected");
          this.startHeartbeat();
          this.connectResolve?.();
        } else {
          this.stopHeartbeat();
          this.setState("disconnected");
        }
        this.connectResolve = null;
        this.connectReject = null;
        break;

      case "error":
        console.error("[ACPClient] Error:", response.payload.message);
        this.onError?.(response.payload.message, response.payload.code);
        this.pendingSessionTarget = null;
        // Reject pending session operations if any
        this.rejectPendingSessions(new Error(response.payload.message));
        this.connectReject?.(new Error(response.payload.message));
        this.connectResolve = null;
        this.connectReject = null;
        break;

      case "session_created":
        this._lastSessionLoadMode = null;
        this.applySessionState(response.payload, { resetTransient: true });
        this.pendingSessionTarget = null;
        console.log("[ACPClient] Session created:", response.payload.sessionId);
        this.onSessionCreated?.(response.payload.sessionId);
        this.emitSessionState();
        break;

      // Session history responses - Reference: Zed's AgentSessionList
      case "session_list":
        console.log("[ACPClient] Session list received:", response.payload.sessions.length, "sessions");
        this.pendingSessionList?.resolve(response.payload);
        this.pendingSessionList = null;
        break;

      case "session_loaded":
        this.applySessionState(response.payload, { resetTransient: false });
        this.pendingSessionTarget = null;
        console.log("[ACPClient] Session loaded:", response.payload.sessionId);
        this.pendingSessionLoad?.resolve(response.payload.sessionId);
        this.pendingSessionLoad = null;
        this.onSessionLoaded?.(response.payload.sessionId);
        this.emitSessionState();
        break;

      case "session_resumed":
        this.applySessionState(response.payload, { resetTransient: false });
        this.pendingSessionTarget = null;
        console.log("[ACPClient] Session resumed:", response.payload.sessionId);
        this.pendingSessionResume?.resolve(response.payload.sessionId);
        this.pendingSessionResume = null;
        this.onSessionLoaded?.(response.payload.sessionId);
        this.emitSessionState();
        break;

      case "session_deleted":
        console.log("[ACPClient] Session deleted:", response.payload.sessionId);
        this.pendingSessionDelete?.resolve(response.payload.sessionId);
        this.pendingSessionDelete = null;
        break;

      case "session_closed":
        console.log("[ACPClient] Session closed:", response.payload.sessionId);
        if (this.sessionId === response.payload.sessionId) {
          this.sessionId = null;
        }
        this.pendingSessionClose?.resolve(response.payload.sessionId);
        this.pendingSessionClose = null;
        break;

      case "session_update": {
        // Only apply session-scoped state for the current/pending session;
        // updates for other sessions are still forwarded to the UI, which
        // filters by active session id.
        if (
          response.payload.sessionId === this.sessionId ||
          response.payload.sessionId === this.pendingSessionTarget
        ) {
          this.applySessionUpdate(response.payload.update);
        } else {
          this.bufferEarlySessionUpdate(
            response.payload.sessionId,
            response.payload.update,
          );
        }
        this.onSessionUpdate?.(response.payload.sessionId, response.payload.update);
        break;
      }

      case "prompt_complete":
        console.log("[ACPClient] Prompt complete:", response.payload.stopReason);
        // Reference: Zed's `update_token_usage` records the turn usage from
        // the prompt response.
        this._turnUsage = response.payload.usage ?? null;
        this.onTurnUsageChanged?.(this._turnUsage);
        this.onPromptComplete?.(response.payload.stopReason);
        break;

      case "permission_request":
        console.log("[ACPClient] Permission request:", response.payload);
        this.onPermissionRequest?.(response.payload);
        break;

      case "mode_changed":
        console.log("[ACPClient] Mode changed:", response.payload.modeId);
        if (this._sessionModes) {
          this._sessionModes = {
            ...this._sessionModes,
            currentModeId: response.payload.modeId,
          };
          this.onSessionModesChanged?.(this._sessionModes);
        }
        break;

      case "config_options_changed":
        console.log("[ACPClient] Config options changed");
        this.setConfigOptions(response.payload.configOptions);
        break;

      case "authenticated":
        console.log("[ACPClient] Authenticated:", response.payload.methodId);
        this.pendingAuthenticate?.resolve();
        this.pendingAuthenticate = null;
        break;

      case "elicitation_request":
        this.onElicitationRequest?.(response.payload);
        break;

      case "elicitation_complete":
        this.onElicitationComplete?.(response.payload.elicitationId);
        break;

      case "elicitation_cancelled":
        this.onElicitationCancelled?.();
        break;

      case "logged_out":
        console.log("[ACPClient] Logged out");
        this.pendingLogout?.resolve();
        this.pendingLogout = null;
        break;

      case "browser_tool_call":
        this.handleBrowserToolCall(response.callId, response.params);
        break;

      case "dir_listing": {
        const requestId = this.dirListingRequestIds.get(response.payload.path);
        if (requestId !== undefined) {
          // Response to a client request
          const pending = this.pendingDirListing.get(requestId);
          if (pending) {
            pending.resolve(response.payload.items);
            this.pendingDirListing.delete(requestId);
          }
          this.dirListingRequestIds.delete(response.payload.path);
        } else {
          // Server-pushed listing (e.g., after session cwd change)
          this.onDirListingPush?.(response.payload.path, response.payload.items);
        }
        break;
      }

      case "file_content": {
        const requestId = this.fileReadRequestIds.get(response.payload.path);
        if (requestId !== undefined) {
          const pending = this.pendingFileRead.get(requestId);
          if (pending) {
            pending.resolve(response.payload);
            this.pendingFileRead.delete(requestId);
          }
          this.fileReadRequestIds.delete(response.payload.path);
        }
        break;
      }

      case "file_changes":
        for (const handler of this.fileChangesHandlers) {
          handler(response.payload.changes);
        }
        break;

      case "pong":
        this.missedPongs = 0;
        if (this.heartbeatTimeout) {
          clearTimeout(this.heartbeatTimeout);
          this.heartbeatTimeout = null;
        }
        break;
    }
  }

  private async handleBrowserToolCall(
    callId: string,
    params: BrowserToolParams,
  ): Promise<void> {
    console.log("[ACPClient] Browser tool call:", callId, params);

    if (!this.onBrowserToolCall) {
      console.error("[ACPClient] No browser tool handler registered");
      this.send({
        type: "browser_tool_result",
        callId,
        result: { error: "No browser tool handler registered" },
      });
      return;
    }

    try {
      const result = await this.onBrowserToolCall(params);
      this.send({
        type: "browser_tool_result",
        callId,
        result,
      });
    } catch (error) {
      console.error("[ACPClient] Browser tool error:", error);
      this.send({
        type: "browser_tool_result",
        callId,
        result: { error: (error as Error).message },
      });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPongs = 0;

    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      this.ws.send(JSON.stringify({ type: "ping" }));

      this.heartbeatTimeout = setTimeout(() => {
        this.missedPongs++;
        if (this.missedPongs >= ACPClient.MAX_MISSED_PONGS) {
          console.warn(`[ACPClient] Server unresponsive (${this.missedPongs} missed pongs), closing connection`);
          this.stopHeartbeat();
          this.ws?.close(4000, "Heartbeat timeout");
        }
      }, ACPClient.PONG_TIMEOUT_MS);
    }, ACPClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private send(message: ProxyMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  // ============================================================================
  // Session state handling
  // ============================================================================

  /** Clear per-session state before switching to a session that will replay. */
  private resetTransientSessionState(sessionId: string): void {
    this._sessionModes = null;
    this._configOptions = null;
    this._usage = null;
    this._turnUsage = null;
    this._availableCommands = [];
    this._sessionInfo = {
      sessionId,
      cwd: this.settings.cwd ?? "",
    };
    this.emitSessionState();
  }

  private applySessionState(
    state: ProxySessionState,
    options: { resetTransient: boolean },
  ): void {
    this.sessionId = state.sessionId;
    this._promptCapabilities = state.promptCapabilities ?? null;
    // Turn usage is not replayed by `session/load`; always start a fresh turn.
    this._turnUsage = null;

    // A new session starts fresh; `session/load` replays updates before the
    // response, so keep the state those updates already populated.
    if (options.resetTransient) {
      this._sessionModes = null;
      this._configOptions = null;
      this._usage = null;
      this._turnUsage = null;
      this._availableCommands = [];
      this._sessionInfo = {
        sessionId: state.sessionId,
        cwd: this.settings.cwd ?? "",
      };
    }

    // Apply updates that arrived before the session response (some agents send
    // `available_commands_update` before the `session/new` result).
    const buffered = this.earlySessionUpdates.get(state.sessionId);
    if (buffered) {
      this.earlySessionUpdates.delete(state.sessionId);
      for (const update of buffered) {
        this.applySessionUpdate(update);
      }
    }

    // The response's config state is authoritative (Zed's `config_state`):
    // configOptions win over legacy modes whenever present.
    if (options.resetTransient) {
      this._configOptions =
        state.configOptions !== undefined && state.configOptions !== null
          ? state.configOptions
          : null;
      this._sessionModes = this._configOptions !== null ? null : (state.modes ?? null);
    } else {
      if (state.modes !== undefined && state.modes !== null) {
        this._sessionModes = state.modes;
        this._configOptions = null;
      }
      if (state.configOptions !== undefined && state.configOptions !== null) {
        this._configOptions = state.configOptions;
        this._sessionModes = null;
      }
      if (!this._sessionInfo) {
        this._sessionInfo = {
          sessionId: state.sessionId,
          cwd: this.settings.cwd ?? "",
        };
      } else {
        this._sessionInfo = { ...this._sessionInfo, sessionId: state.sessionId };
      }
    }
  }

  private bufferEarlySessionUpdate(sessionId: string, update: SessionUpdate): void {
    const buffered = this.earlySessionUpdates.get(sessionId) ?? [];
    buffered.push(update);
    this.earlySessionUpdates.set(sessionId, buffered);
    // Avoid unbounded growth if an update references a session we never create.
    if (this.earlySessionUpdates.size > 8) {
      const oldest = this.earlySessionUpdates.keys().next().value;
      if (oldest !== undefined) this.earlySessionUpdates.delete(oldest);
    }
  }

  private emitSessionState(): void {
    this.onSessionModesChanged?.(this._sessionModes);
    this.onConfigOptionsChanged?.(this._configOptions);
    this.onUsageChanged?.(this._usage);
    this.onTurnUsageChanged?.(this._turnUsage);
    this.onAvailableCommandsChanged?.(this._availableCommands);
    this.onSessionInfoChanged?.(this._sessionInfo);
  }

  // Reference: Zed's `handle_session_notification` applies mode/config/usage/
  // commands/session-info side effects before forwarding the update.
  private applySessionUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "current_mode_update":
        if (this._sessionModes) {
          this._sessionModes = {
            ...this._sessionModes,
            currentModeId: update.currentModeId,
          };
          this.onSessionModesChanged?.(this._sessionModes);
        }
        break;
      case "config_option_update":
        this.setConfigOptions(update.configOptions);
        break;
      case "usage_update":
        // Reference: Zed keeps the previous cost when the update omits it.
        this._usage = {
          ...update,
          cost: update.cost ?? this._usage?.cost ?? null,
        };
        this.onUsageChanged?.(this._usage);
        break;
      case "available_commands_update":
        this._availableCommands = update.availableCommands;
        this.onAvailableCommandsChanged?.(this._availableCommands);
        break;
      case "session_info_update":
        this.applySessionInfoUpdate(update);
        break;
    }
  }

  // Reference: Zed's `AgentSessionInfo::apply_update` (tri-state: omitted is
  // unchanged, null clears, value sets).
  private applySessionInfoUpdate(update: SessionInfoUpdate): void {
    const current = this._sessionInfo ?? {
      sessionId: this.sessionId ?? "",
      cwd: this.settings.cwd ?? "",
    };
    const next: SessionInfo = { ...current };
    if (update.title !== undefined) {
      next.title = update.title;
    }
    if (update.updatedAt !== undefined) {
      // Reference: Zed ignores unparseable timestamps (keeps the old value).
      if (update.updatedAt === null || !Number.isNaN(Date.parse(update.updatedAt))) {
        next.updatedAt = update.updatedAt;
      }
    }
    // Reference: Zed's `AgentSessionInfo::apply_update` replaces v1 meta when
    // present (null clears it).
    if (update._meta !== undefined) {
      next._meta = update._meta;
    }
    this._sessionInfo = next;
    this.onSessionInfoChanged?.(this._sessionInfo);
  }

  private setConfigOptions(options: SessionConfigOption[]): void {
    this._configOptions = options.length > 0 ? options : null;
    // Zed ignores legacy modes whenever config options are present.
    if (this._configOptions) {
      this._sessionModes = null;
    }
    this.onConfigOptionsChanged?.(this._configOptions);
  }

  // ============================================================================
  // Session operations
  // ============================================================================

  async createSession(cwd?: string): Promise<void> {
    const sessionCwd = cwd ?? this.settings.cwd;
    this.send({ type: "new_session", payload: { cwd: sessionCwd } });
  }

  // Reference: Zed's MessageEditor.contents() builds Vec<acp::ContentBlock>
  async sendPrompt(content: string | ContentBlock[]): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session");
    }
    const contentBlocks: ContentBlock[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;

    this.send({ type: "prompt", payload: { content: contentBlocks } });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  /** Change the session mode (legacy `modes`, ignored when config options exist). */
  async setSessionMode(modeId: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session");
    }
    this.send({ type: "set_session_mode", payload: { modeId } });
  }

  /** Set a session config option (select or boolean). */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session");
    }
    this.send({ type: "set_config_option", payload: { configId, value } });
  }

  /**
   * Select a model. ACP represents model selection as a `model` config option.
   * Reference: Zed's AgentModelSelector.select_model().
   */
  async setSessionModel(modelId: string): Promise<void> {
    const option = findConfigOption(this._configOptions, "model");
    if (!option) {
      throw new Error("Model selection is not supported by this agent");
    }
    // Optimistically update the picker; the agent may confirm via
    // config_option_update. Revert on failure (like Zed's optimistic mode).
    const previous = this._configOptions;
    this._configOptions = previous?.map((candidate) =>
      candidate.id === option.id && candidate.type === "select"
        ? { ...candidate, currentValue: modelId }
        : candidate,
    ) ?? null;
    this.onConfigOptionsChanged?.(this._configOptions);

    try {
      await this.setConfigOption(option.id, modelId);
    } catch (error) {
      this._configOptions = previous;
      this.onConfigOptionsChanged?.(this._configOptions);
      throw error;
    }
  }

  respondToElicitation(
    requestId: string,
    response: CreateElicitationResponse,
  ): void {
    this.send({ type: "elicitation_response", payload: { requestId, response } });
  }

  respondToPermission(requestId: string, optionId: string | null): void {
    const outcome = optionId
      ? { outcome: "selected" as const, optionId }
      : { outcome: "cancelled" as const };

    this.send({
      type: "permission_response",
      payload: { requestId, outcome },
    });
  }

  // ============================================================================
  // Session History Methods
  // Reference: Zed's AgentSessionList trait and AgentConnection methods
  // ============================================================================

  setSessionLoadedHandler(handler: SessionLoadedHandler): void {
    this.onSessionLoaded = handler;
  }

  async listSessions(request?: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!this.supportsSessionList) {
      throw new Error("Listing sessions is not supported by this agent");
    }
    return new Promise((resolve, reject) => {
      this.pendingSessionList = { resolve, reject };
      try {
        this.send({ type: "list_sessions", payload: request });
      } catch (err) {
        this.pendingSessionList = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingSessionList) {
          const pending = this.pendingSessionList;
          this.pendingSessionList = null;
          pending.reject(new Error("List sessions timed out"));
        }
      }, 30000);
    });
  }

  async loadSession(request: SessionRef): Promise<string> {
    if (!this.supportsLoadSession) {
      throw new Error("Loading sessions is not supported by this agent");
    }
    return new Promise((resolve, reject) => {
      this.pendingSessionTarget = request.sessionId;
      this._lastSessionLoadMode = "load";
      this.onSessionSwitching?.(request.sessionId);
      // Replayed updates repopulate this state; clear the previous session's
      // values so they cannot leak into the loaded thread (Zed creates a new
      // thread for loads).
      this.resetTransientSessionState(request.sessionId);
      this.pendingSessionLoad = { resolve, reject };
      try {
        this.send({ type: "load_session", payload: request });
      } catch (err) {
        this.pendingSessionTarget = null;
        this.pendingSessionLoad = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingSessionLoad) {
          this.pendingSessionTarget = null;
          const pending = this.pendingSessionLoad;
          this.pendingSessionLoad = null;
          pending.reject(new Error("Load session timed out"));
        }
      }, 60000);
    });
  }

  async resumeSession(request: SessionRef): Promise<string> {
    if (!this.supportsResumeSession) {
      throw new Error("Resuming sessions is not supported by this agent");
    }
    return new Promise((resolve, reject) => {
      this.pendingSessionTarget = request.sessionId;
      this._lastSessionLoadMode = "resume";
      this.onSessionSwitching?.(request.sessionId);
      this.resetTransientSessionState(request.sessionId);
      this.pendingSessionResume = { resolve, reject };
      try {
        this.send({ type: "resume_session", payload: request });
      } catch (err) {
        this.pendingSessionTarget = null;
        this.pendingSessionResume = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingSessionResume) {
          this.pendingSessionTarget = null;
          const pending = this.pendingSessionResume;
          this.pendingSessionResume = null;
          pending.reject(new Error("Resume session timed out"));
        }
      }, 30000);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.supportsDeleteSession) {
      throw new Error("Deleting sessions is not supported by this agent");
    }
    return new Promise((resolve, reject) => {
      this.pendingSessionDelete = {
        resolve: () => resolve(),
        reject,
      };
      try {
        this.send({ type: "delete_session", payload: { sessionId } });
      } catch (err) {
        this.pendingSessionDelete = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingSessionDelete) {
          const pending = this.pendingSessionDelete;
          this.pendingSessionDelete = null;
          pending.reject(new Error("Delete session timed out"));
        }
      }, 30000);
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.supportsCloseSession) {
      throw new Error("Closing sessions is not supported by this agent");
    }
    return new Promise((resolve, reject) => {
      this.pendingSessionClose = {
        resolve: () => resolve(),
        reject,
      };
      try {
        this.send({ type: "close_session", payload: { sessionId } });
      } catch (err) {
        this.pendingSessionClose = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingSessionClose) {
          const pending = this.pendingSessionClose;
          this.pendingSessionClose = null;
          pending.reject(new Error("Close session timed out"));
        }
      }, 30000);
    });
  }

  async logout(): Promise<void> {
    if (!this.supportsLogout) {
      throw new Error("Logout is not supported by this agent");
    }
    return new Promise((resolve, reject) => {
      this.pendingLogout = { resolve, reject };
      try {
        this.send({ type: "logout" });
      } catch (err) {
        this.pendingLogout = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingLogout) {
          const pending = this.pendingLogout;
          this.pendingLogout = null;
          pending.reject(new Error("Logout timed out"));
        }
      }, 30000);
    });
  }

  async authenticate(methodId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingAuthenticate = { resolve, reject };
      try {
        this.send({ type: "authenticate", payload: { methodId } });
      } catch (err) {
        this.pendingAuthenticate = null;
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingAuthenticate) {
          const pending = this.pendingAuthenticate;
          this.pendingAuthenticate = null;
          pending.reject(new Error("Authentication timed out"));
        }
      }, 60000);
    });
  }

  // ============================================================================
  // File Explorer Methods
  // ============================================================================

  async listDir(path: string): Promise<FileItem[]> {
    const requestId = ++this.requestIdCounter;
    return new Promise((resolve, reject) => {
      this.pendingDirListing.set(requestId, { resolve, reject });
      this.dirListingRequestIds.set(path, requestId);
      try {
        this.send({ type: "list_dir", payload: { path } });
      } catch (err) {
        this.pendingDirListing.delete(requestId);
        this.dirListingRequestIds.delete(path);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingDirListing.has(requestId)) {
          this.pendingDirListing.delete(requestId);
          this.dirListingRequestIds.delete(path);
          reject(new Error("Directory listing timed out"));
        }
      }, 10000);
    });
  }

  async readFile(path: string): Promise<FileContent> {
    const requestId = ++this.requestIdCounter;
    return new Promise((resolve, reject) => {
      this.pendingFileRead.set(requestId, { resolve, reject });
      this.fileReadRequestIds.set(path, requestId);
      try {
        this.send({ type: "read_file", payload: { path } });
      } catch (err) {
        this.pendingFileRead.delete(requestId);
        this.fileReadRequestIds.delete(path);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pendingFileRead.has(requestId)) {
          this.pendingFileRead.delete(requestId);
          this.fileReadRequestIds.delete(path);
          reject(new Error("File read timed out"));
        }
      }, 10000);
    });
  }

  onFileChanges(handler: FileChangesHandler): () => void {
    this.fileChangesHandlers.add(handler);
    return () => {
      this.fileChangesHandlers.delete(handler);
    };
  }

  private rejectPendingSessions(error: Error): void {
    this.pendingSessionList?.reject(error);
    this.pendingSessionList = null;
    this.pendingSessionLoad?.reject(error);
    this.pendingSessionLoad = null;
    this.pendingSessionResume?.reject(error);
    this.pendingSessionResume = null;
    this.pendingSessionDelete?.reject(error);
    this.pendingSessionDelete = null;
    this.pendingSessionClose?.reject(error);
    this.pendingSessionClose = null;
    this.pendingAuthenticate?.reject(error);
    this.pendingAuthenticate = null;
    this.pendingLogout?.reject(error);
    this.pendingLogout = null;
  }

  disconnect(): void {
    this.stopHeartbeat();

    // Reject any pending connect promise with a distinguishable error
    if (this.connectReject) {
      this.connectReject(new DisconnectRequestedError());
    }
    this.connectResolve = null;
    this.connectReject = null;

    if (this.ws) {
      try {
        this.send({ type: "disconnect" });
      } catch {
        // Ignore send errors during disconnect
      }
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
    this.sessionId = null;
    this.pendingSessionTarget = null;
    this._lastSessionLoadMode = null;
    this._sessionModes = null;
    this._configOptions = null;
    this._usage = null;
    this._turnUsage = null;
    this._availableCommands = [];
    this._sessionInfo = null;
    this.earlySessionUpdates.clear();
    this._agentCapabilities = null;
    this._authMethods = [];
    this.emitSessionState();

    // Reject all pending operations before clearing
    const disconnectError = new Error("Disconnected");
    for (const { reject } of this.pendingDirListing.values()) {
      reject(disconnectError);
    }
    for (const { reject } of this.pendingFileRead.values()) {
      reject(disconnectError);
    }
    this.rejectPendingSessions(disconnectError);

    this.pendingDirListing.clear();
    this.pendingFileRead.clear();
    this.dirListingRequestIds.clear();
    this.fileReadRequestIds.clear();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function findConfigOption(
  options: SessionConfigOption[] | null,
  category: string,
): SessionConfigOption | null {
  return options?.find((option) => option.category === category) ?? null;
}

/** Flatten grouped or ungrouped select options. */
export function flattenConfigSelectOptions(
  options: SessionConfigSelectOptions,
): SessionConfigSelectOption[] {
  const flattened: SessionConfigSelectOption[] = [];
  for (const option of options) {
    if ("group" in option) {
      flattened.push(...option.options);
    } else {
      flattened.push(option);
    }
  }
  return flattened;
}
