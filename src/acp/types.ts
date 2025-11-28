// Proxy Protocol Types (communication with proxy server)
export interface ProxyConnectParams {
  command: string;
  args?: string[];
  cwd?: string;
}

// Messages sent TO the proxy server
export type ProxyMessage =
  | { type: "connect"; payload: ProxyConnectParams }
  | { type: "disconnect" }
  | { type: "new_session"; payload?: { cwd?: string } }
  | { type: "prompt"; payload: { text: string } }
  | { type: "cancel" };

// Messages received FROM the proxy server
export interface ProxyStatusMessage {
  type: "status";
  payload: {
    connected: boolean;
    agentInfo?: { name?: string; version?: string };
    capabilities?: unknown;
  };
}

export interface ProxyErrorMessage {
  type: "error";
  payload: { message: string };
}

export interface ProxySessionCreatedMessage {
  type: "session_created";
  payload: { sessionId: string };
}

export interface ProxySessionUpdateMessage {
  type: "session_update";
  payload: {
    sessionId: string;
    update: SessionUpdate;
  };
}

export interface ProxyPromptCompleteMessage {
  type: "prompt_complete";
  payload: { stopReason: string };
}

export interface ProxyPermissionRequestMessage {
  type: "permission_request";
  payload: unknown;
}

export type ProxyResponse =
  | ProxyStatusMessage
  | ProxyErrorMessage
  | ProxySessionCreatedMessage
  | ProxySessionUpdateMessage
  | ProxyPromptCompleteMessage
  | ProxyPermissionRequestMessage;

// Session update types from ACP
export type SessionUpdate =
  | {
      sessionUpdate: "agent_message_chunk";
      content: { type: string; text?: string };
    }
  | { sessionUpdate: "tool_call"; title: string; status: string }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: string }
  | { sessionUpdate: "plan" | "agent_thought_chunk" | "user_message_chunk" };

// Connection state
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

// Settings
export interface ACPSettings {
  proxyUrl: string;
  agentCommand: string;
  agentArgs?: string[];
  agentCwd?: string;
}

export const DEFAULT_SETTINGS: ACPSettings = {
  proxyUrl: "ws://localhost:9315/ws",
  agentCommand: "",
  agentArgs: [],
  agentCwd: "",
};
