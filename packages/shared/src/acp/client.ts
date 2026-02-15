import type {
  ACPSettings,
  BrowserToolParams,
  BrowserToolResult,
  ConnectionState,
  ContentBlock,
  PermissionRequestPayload,
  PromptCapabilities,
  ProxyMessage,
  ProxyResponse,
  SessionUpdate,
  SessionModelState,
  ModelInfo,
} from "./types";

export type ConnectionStateHandler = (
  state: ConnectionState,
  error?: string,
) => void;
export type SessionUpdateHandler = (update: SessionUpdate) => void;
export type SessionCreatedHandler = (sessionId: string) => void;
export type PromptCompleteHandler = (stopReason: string) => void;
export type PermissionRequestHandler = (request: PermissionRequestPayload) => void;
export type BrowserToolCallHandler = (
  params: BrowserToolParams,
) => Promise<BrowserToolResult>;
export type ModelChangedHandler = (modelId: string) => void;

export class ACPClient {
  private ws: WebSocket | null = null;
  private settings: ACPSettings;
  private connectionState: ConnectionState = "disconnected";
  private sessionId: string | null = null;
  // Reference: Zed's prompt_capabilities in MessageEditor
  // Stores capabilities from agent's initialize response
  private _promptCapabilities: PromptCapabilities | null = null;
  // Reference: Zed stores model state from NewSessionResponse
  private _modelState: SessionModelState | null = null;
  private onModelChanged: ModelChangedHandler | null = null;

  private onConnectionStateChange: ConnectionStateHandler | null = null;
  private onSessionUpdate: SessionUpdateHandler | null = null;
  private onSessionCreated: SessionCreatedHandler | null = null;
  private onPromptComplete: PromptCompleteHandler | null = null;
  private onPermissionRequest: PermissionRequestHandler | null = null;
  private onBrowserToolCall: BrowserToolCallHandler | null = null;

  private connectResolve: ((value: void) => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

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

  setModelChangedHandler(handler: ModelChangedHandler): void {
    this.onModelChanged = handler;
  }

  setPermissionRequestHandler(handler: PermissionRequestHandler): void {
    this.onPermissionRequest = handler;
  }

  setBrowserToolCallHandler(handler: BrowserToolCallHandler): void {
    this.onBrowserToolCall = handler;
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

  // Reference: Zed's supports_images() in MessageEditor
  // Returns true if the agent supports image content in prompts
  get supportsImages(): boolean {
    return this._promptCapabilities?.image === true;
  }

  // Reference: Zed's prompt_capabilities in MessageEditor
  getPromptCapabilities(): PromptCapabilities | null {
    return this._promptCapabilities;
  }

  /**
   * Get the current model state (available models and current model ID).
   * Reference: Zed's AgentModelSelector reads from state.available_models
   */
  get modelState(): SessionModelState | null {
    return this._modelState;
  }

  /**
   * Check if the agent supports model selection.
   * Reference: Zed's model_selector() returns Option<Rc<dyn AgentModelSelector>>
   */
  get supportsModelSelection(): boolean {
    return this._modelState !== null && this._modelState.availableModels.length > 0;
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
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          console.log("[ACPClient] WebSocket connected, sending connect command");
          this.send({ type: "connect" });
        };

        this.ws.onmessage = (event) => {
          try {
            const response: ProxyResponse = JSON.parse(event.data);
            this.handleResponse(response);
          } catch (error) {
            console.error("[ACPClient] Failed to parse message:", error);
          }
        };

        this.ws.onerror = () => {
          console.error("[ACPClient] WebSocket error");
          this.setState("error", "WebSocket connection error");
          this.connectReject?.(new Error("WebSocket connection error"));
          this.connectResolve = null;
          this.connectReject = null;
        };

        this.ws.onclose = (event) => {
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
          this.setState("connected");
          this.connectResolve?.();
        } else {
          this.setState("disconnected");
        }
        this.connectResolve = null;
        this.connectReject = null;
        break;

      case "error":
        console.error("[ACPClient] Error:", response.payload.message);
        this.connectReject?.(new Error(response.payload.message));
        this.connectResolve = null;
        this.connectReject = null;
        break;

      case "session_created":
        this.sessionId = response.payload.sessionId;
        // Reference: Zed stores promptCapabilities from session/initialize response
        this._promptCapabilities = response.payload.promptCapabilities ?? null;
        // Reference: Zed stores model state from NewSessionResponse.models
        this._modelState = response.payload.models ?? null;
        console.log("[ACPClient] Session created, promptCapabilities:", this._promptCapabilities, "models:", this._modelState);
        this.onSessionCreated?.(response.payload.sessionId);
        break;

      case "session_update":
        this.onSessionUpdate?.(response.payload.update);
        break;

      case "prompt_complete":
        this.onPromptComplete?.(response.payload.stopReason);
        break;

      case "permission_request":
        console.log("[ACPClient] Permission request:", response.payload);
        this.onPermissionRequest?.(response.payload);
        break;

      case "model_changed":
        console.log("[ACPClient] Model changed:", response.payload.modelId);
        if (this._modelState) {
          this._modelState = {
            ...this._modelState,
            currentModelId: response.payload.modelId,
          };
        }
        this.onModelChanged?.(response.payload.modelId);
        break;

      case "browser_tool_call":
        this.handleBrowserToolCall(response.callId, response.params);
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

  private send(message: ProxyMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  async createSession(cwd?: string): Promise<void> {
    this.send({ type: "new_session", payload: { cwd } });
  }

  // Reference: Zed's MessageEditor.contents() builds Vec<acp::ContentBlock>
  // and sends via AcpThread.send()
  // Accepts either a string (for backward compatibility) or ContentBlock[]
  async sendPrompt(content: string | ContentBlock[]): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session");
    }
    // Convert string to ContentBlock[] for backward compatibility
    const contentBlocks: ContentBlock[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;

    this.send({ type: "prompt", payload: { content: contentBlocks } });
  }

  cancel(): void {
    this.send({ type: "cancel" });
  }

  /**
   * Set the model for the current session.
   * Reference: Zed's AgentModelSelector.select_model() calls connection.set_session_model()
   */
  async setSessionModel(modelId: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session");
    }
    this.send({ type: "set_session_model", payload: { modelId } });
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

  disconnect(): void {
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
    this._modelState = null;
  }
}

