// Messages sent TO the proxy server
export type ProxyMessage =
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "new_session"; payload?: { cwd?: string } }
  | { type: "prompt"; payload: { text: string } }
  | { type: "cancel" }
  | { type: "browser_tool_result"; callId: string; result: BrowserToolResult | { error: string } };

// Browser tool types
export interface BrowserToolParams {
  action: "read" | "execute" | "screenshot";
  script?: string;
}

export interface BrowserReadResult {
  action: "read";
  url: string;
  title: string;
  dom: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  selection: string | null;
}

export interface BrowserExecuteResult {
  action: "execute";
  url: string;
  result?: unknown;
  error?: string;
}

export interface BrowserScreenshotResult {
  action: "screenshot";
  url: string;
  screenshot: string;
}

export type BrowserToolResult =
  | BrowserReadResult
  | BrowserExecuteResult
  | BrowserScreenshotResult;

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

export interface ProxyBrowserToolCallMessage {
  type: "browser_tool_call";
  callId: string;
  params: BrowserToolParams;
}

export type ProxyResponse =
  | ProxyStatusMessage
  | ProxyErrorMessage
  | ProxySessionCreatedMessage
  | ProxySessionUpdateMessage
  | ProxyPromptCompleteMessage
  | ProxyPermissionRequestMessage
  | ProxyBrowserToolCallMessage;

// Content block types
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export type ContentBlock = TextContent | ImageContent | { type: string; text?: string };

// Session update types from ACP
export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

// Tool call content types from ACP
export interface ToolCallContentBlock {
  type: "content";
  content: ContentBlock;
}

export interface ToolCallDiffContent {
  type: "diff";
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface ToolCallTerminalContent {
  type: "terminal";
  terminalId: string;
}

export type ToolCallContent = ToolCallContentBlock | ToolCallDiffContent | ToolCallTerminalContent;

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  status: string;
  content?: ToolCallContent[];
}

export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: string;
  title?: string;
  content?: ToolCallContent[];
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

export interface PlanUpdate {
  sessionUpdate: "plan";
}

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | AgentThoughtChunkUpdate
  | PlanUpdate
  | UserMessageChunkUpdate;

// Connection state
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

// Settings
export interface ACPSettings {
  proxyUrl: string;
}

export const DEFAULT_SETTINGS: ACPSettings = {
  proxyUrl: "ws://localhost:9315/ws",
};
