import type {
  ACPSettings,
  ConnectionState,
  ProxyMessage,
  ProxyResponse,
  SessionUpdate,
} from "./types";

export type ConnectionStateHandler = (
  state: ConnectionState,
  error?: string,
) => void;
export type SessionUpdateHandler = (update: SessionUpdate) => void;
export type SessionCreatedHandler = (sessionId: string) => void;
export type PromptCompleteHandler = (stopReason: string) => void;

export class ACPClient {
  private ws: WebSocket | null = null;
  private settings: ACPSettings;
  private connectionState: ConnectionState = "disconnected";
  private sessionId: string | null = null;

  private onConnectionStateChange: ConnectionStateHandler | null = null;
  private onSessionUpdate: SessionUpdateHandler | null = null;
  private onSessionCreated: SessionCreatedHandler | null = null;
  private onPromptComplete: PromptCompleteHandler | null = null;

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

  async connect(): Promise<void> {
    if (this.ws) {
      this.disconnect();
    }

    this.setState("connecting");

    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        this.ws = new WebSocket(this.settings.proxyUrl);

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

        this.ws.onclose = () => {
          console.log("[ACPClient] WebSocket closed");
          this.setState("disconnected");
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
        break;
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

  async sendPrompt(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session");
    }
    this.send({ type: "prompt", payload: { text } });
  }

  cancel(): void {
    this.send({ type: "cancel" });
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
  }
}

