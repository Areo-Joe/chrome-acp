import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import {
  type McpRequest,
  type McpResponse,
  type McpInitializeResult,
  type McpToolsListResult,
  type McpToolCallParams,
  type McpToolCallResult,
  type BrowserToolParams,
  type BrowserToolResult,
  type BrowserReadResult,
  type BrowserExecuteResult,
  MCP_METHODS,
  BROWSER_TOOLS,
} from "./types.js";
import { log } from "../logger.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

// Pending browser tool calls waiting for extension response
const pendingBrowserCalls = new Map<
  string,
  {
    resolve: (result: BrowserToolResult) => void;
    reject: (error: Error) => void;
  }
>();

// Reference to connected WebSocket clients (set by server.ts)
let extensionWs: WSContext | null = null;

export function setExtensionWebSocket(ws: WSContext | null): void {
  extensionWs = ws;
}

export function handleBrowserToolResponse(
  callId: string,
  result: BrowserToolResult | { error: string },
): void {
  log.debug("Browser tool response received", { callId });

  const pending = pendingBrowserCalls.get(callId);
  if (!pending) {
    log.warn("No pending call found", { callId });
    return;
  }

  pendingBrowserCalls.delete(callId);

  if ("error" in result && !("url" in result)) {
    log.error("Browser tool error", { error: result.error });
    pending.reject(new Error(result.error));
  } else {
    const browserResult = result as BrowserToolResult;
    log.debug("Browser tool result", {
      action: browserResult.action,
      url: browserResult.url,
    });
    pending.resolve(browserResult);
  }
}

async function executeBrowserTool(
  params: BrowserToolParams,
): Promise<BrowserToolResult> {
  log.debug("Browser tool called", { params });

  if (!extensionWs) {
    log.error("No browser extension connected");
    throw new Error("No browser extension connected");
  }

  const callId = crypto.randomUUID();
  log.debug("Browser tool call", { callId });

  // Send request to extension
  extensionWs.send(
    JSON.stringify({
      type: "browser_tool_call",
      callId,
      params,
    }),
  );

  // Wait for response
  return new Promise((resolve, reject) => {
    pendingBrowserCalls.set(callId, { resolve, reject });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingBrowserCalls.has(callId)) {
        pendingBrowserCalls.delete(callId);
        log.error("Browser tool call timed out", { callId });
        reject(new Error("Browser tool call timed out"));
      }
    }, 30000);
  });
}

function handleInitialize(id: string | number): McpResponse {
  const result: McpInitializeResult = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "chrome-acp-browser",
      version: "1.0.0",
    },
  };

  return { jsonrpc: "2.0", id, result };
}

function handleToolsList(id: string | number): McpResponse {
  const result: McpToolsListResult = {
    tools: BROWSER_TOOLS,
  };

  return { jsonrpc: "2.0", id, result };
}

function formatReadResult(result: BrowserReadResult): McpToolCallResult {
  const textContent = [
    `# Browser Read Result`,
    ``,
    `## Page Info`,
    `- URL: ${result.url}`,
    `- Title: ${result.title}`,
    `- Viewport: ${result.viewport.width}x${result.viewport.height}`,
    `- Scroll Position: (${result.viewport.scrollX}, ${result.viewport.scrollY})`,
    result.selection ? `- Selected Text: "${result.selection}"` : null,
    ``,
    `## Page Content`,
    ``,
    result.dom,
  ]
    .filter(Boolean)
    .join("\n");

  log.debug("Read result", {
    url: result.url,
    title: result.title,
    viewport: result.viewport,
    selection: result.selection,
    domLength: result.dom?.length || 0,
    totalChars: textContent.length,
  });

  return {
    content: [{ type: "text", text: textContent }],
  };
}

function formatExecuteResult(result: BrowserExecuteResult): McpToolCallResult {
  const textContent = [
    `# Browser Execute Result`,
    ``,
    `- URL: ${result.url}`,
    result.result !== undefined
      ? `\n## Script Result\n\`\`\`\n${JSON.stringify(result.result, null, 2)}\n\`\`\``
      : null,
    result.error ? `\n## Script Error\n${result.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  log.debug("Execute result", {
    url: result.url,
    result: result.result,
    error: result.error,
    isError: !!result.error,
    totalChars: textContent.length,
  });

  return {
    content: [{ type: "text", text: textContent }],
    isError: !!result.error,
  };
}

async function handleToolCall(
  id: string | number,
  params: McpToolCallParams,
): Promise<McpResponse> {
  log.info("Tool call started", {
    id,
    tool: params.name,
    arguments: params.arguments,
  });

  // Map tool name to action
  const toolToAction: Record<string, BrowserToolParams["action"]> = {
    browser_read: "read",
    browser_execute: "execute",
  };

  const action = toolToAction[params.name];
  if (!action) {
    log.warn("Unknown tool requested", { tool: params.name });
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: `Unknown tool: ${params.name}`,
      },
    };
  }

  try {
    const browserParams: BrowserToolParams = {
      action,
      script: (params.arguments as { script?: string })?.script,
    };

    const startTime = Date.now();
    const browserResult = await executeBrowserTool(browserParams);
    const duration = Date.now() - startTime;

    log.info("Tool call completed", {
      id,
      tool: params.name,
      action,
      durationMs: duration,
    });

    let result: McpToolCallResult;

    switch (browserResult.action) {
      case "read":
        result = formatReadResult(browserResult);
        break;
      case "execute":
        result = formatExecuteResult(browserResult);
        break;
      default:
        throw new Error(`Unknown action: ${(browserResult as BrowserToolResult).action}`);
    }

    const response: McpResponse = { jsonrpc: "2.0", id, result };
    log.trace("MCP tool call response", { response });
    return response;
  } catch (error) {
    log.error("Tool call failed", {
      id,
      tool: params.name,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    const result: McpToolCallResult = {
      content: [{ type: "text", text: (error as Error).message }],
      isError: true,
    };

    return { jsonrpc: "2.0", id, result };
  }
}

export async function handleMcpRequest(c: Context): Promise<Response> {
  const request = (await c.req.json()) as McpRequest;
  log.debug("MCP request received", { method: request.method });

  let response: McpResponse;

  switch (request.method) {
    case MCP_METHODS.INITIALIZE:
      response = handleInitialize(request.id);
      break;

    case MCP_METHODS.TOOLS_LIST:
      response = handleToolsList(request.id);
      break;

    case MCP_METHODS.TOOLS_CALL:
      response = await handleToolCall(
        request.id,
        request.params as unknown as McpToolCallParams,
      );
      break;

    default:
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
  }

  return c.json(response);
}
