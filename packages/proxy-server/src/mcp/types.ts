// MCP (Model Context Protocol) Types for Streamable HTTP Transport

// ============================================================================
// Browser Tool Types
// ============================================================================
// IMPORTANT: These types MUST stay in sync with @chrome-acp/shared/src/acp/types.ts
// They define the protocol between proxy-server and browser extension.
//
// Why duplicated? proxy-server uses NodeNext module resolution which requires
// .js extensions, while shared package is designed for bundlers (Bun/Vite).
// Until we have a proper @chrome-acp/protocol package, keep these in sync manually.
// ============================================================================

export interface BrowserToolParams {
  action: "tabs" | "read" | "execute";
  tabId?: number;   // Required for read/execute
  script?: string;  // Required for execute
}

export interface BrowserTabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserTabsResult {
  action: "tabs";
  tabs: BrowserTabInfo[];
}

export interface BrowserReadResult {
  action: "read";
  tabId: number;
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
  tabId: number;
  url: string;
  result?: unknown;
  error?: string;
}

export type BrowserToolResult =
  | BrowserTabsResult
  | BrowserReadResult
  | BrowserExecuteResult;

export interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: McpError;
}

export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

// MCP Protocol Methods
export const MCP_METHODS = {
  INITIALIZE: "initialize",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
} as const;

// MCP Initialize
export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: {
    roots?: { listChanged?: boolean };
    sampling?: Record<string, never>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

// MCP Tools
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolsListResult {
  tools: McpTool[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpToolContent[];
  isError?: boolean;
}

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// Browser Tabs Tool
export const BROWSER_TABS_TOOL: McpTool = {
  name: "browser_tabs",
  description:
    "List all open tabs in the browser. " +
    "Returns an array of tabs with their id, url, title, and whether it's the active tab. " +
    "Use this tool first to get the tabId before calling browser_read or browser_execute.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// Browser Read Tool
export const BROWSER_READ_TOOL: McpTool = {
  name: "browser_read",
  description:
    "Read the content of a specific browser tab. " +
    "Returns page URL, title, simplified DOM content, viewport size, and selected text. " +
    "IMPORTANT: You must call browser_tabs first to get the tabId.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: {
        type: "number",
        description:
          "The tab ID to read from. Get this from browser_tabs tool.",
      },
    },
    required: ["tabId"],
  },
};

// Browser Execute Tool
export const BROWSER_EXECUTE_TOOL: McpTool = {
  name: "browser_execute",
  description:
    "Execute JavaScript code in a specific browser tab. " +
    "The script is executed via `new Function(script)()`, so the LAST EXPRESSION or explicit `return` statement becomes the tool result. " +
    "IMPORTANT: You must call browser_tabs first to get the tabId.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: {
        type: "number",
        description:
          "The tab ID to execute the script in. Get this from browser_tabs tool.",
      },
      script: {
        type: "string",
        description:
          "JavaScript code to execute in the page context.\n\n" +
          "EXECUTION MODEL:\n" +
          "Your script runs as: `(new Function(script))()`. The return value becomes the tool result.\n" +
          "- Use `return { success: true, ... }` to report success with details\n" +
          "- Use `return { success: false, reason: '...' }` to report failure\n" +
          "- If no return, result will be undefined\n\n" +
          "EXAMPLE - Good script with clear return value:\n" +
          "```\n" +
          "const btn = document.querySelector('button.submit');\n" +
          "if (!btn) return { success: false, reason: 'Button not found' };\n" +
          "btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));\n" +
          "return { success: true, clicked: btn.textContent };\n" +
          "```\n\n" +
          "EVENT HANDLING for React/Vue/Angular:\n\n" +
          "1. CLICKING - Do NOT use element.click():\n" +
          "   element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));\n\n" +
          "2. INPUT FIELDS - Setting .value alone won't work:\n" +
          "   input.value = 'text';\n" +
          "   input.dispatchEvent(new Event('input', { bubbles: true }));\n" +
          "   input.dispatchEvent(new Event('change', { bubbles: true }));\n\n" +
          "3. FORM SUBMIT - Do NOT use form.submit() (bypasses validation):\n" +
          "   form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));\n\n" +
          "4. HOVER: element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));\n\n" +
          "5. KEYBOARD: element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));\n\n" +
          "Always use dispatchEvent with { bubbles: true } for framework compatibility.",
      },
    },
    required: ["tabId", "script"],
  },
};

// All browser tools
export const BROWSER_TOOLS = [
  BROWSER_TABS_TOOL,
  BROWSER_READ_TOOL,
  BROWSER_EXECUTE_TOOL,
];

