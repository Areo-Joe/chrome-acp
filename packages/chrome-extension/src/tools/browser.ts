// Browser tool handler - executes in the extension context
// Communicates with content scripts to access page DOM

import type {
  BrowserToolParams,
  BrowserToolResult,
  BrowserTabsResult,
  BrowserReadResult,
  BrowserExecuteResult,
} from "@chrome-acp/shared/acp";

// Execute browser_tabs: List all open tabs
async function executeBrowserTabs(): Promise<BrowserTabsResult> {
  console.log("[BrowserTool] Listing tabs...");
  const allTabs = await chrome.tabs.query({});

  const tabs = allTabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => ({
      id: tab.id!,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active || false,
    }));

  console.log(`[BrowserTool] Found ${tabs.length} tabs`);
  return { action: "tabs", tabs };
}

// Execute browser_read: Get DOM info from specific tab
async function executeBrowserRead(tabId: number): Promise<BrowserReadResult> {
  console.log(`[BrowserTool] Reading tab ${tabId}...`);

  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error(`Tab ${tabId} not found`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageInfo,
  });

  const pageInfo = results[0]?.result;
  if (!pageInfo) {
    throw new Error("Failed to collect page info");
  }

  console.log(`[BrowserTool] Read complete: ${pageInfo.dom.length} chars`);
  return { action: "read", tabId, ...pageInfo };
}

// Execute browser_execute: Run script in specific tab
async function executeBrowserExecute(
  tabId: number,
  script: string,
): Promise<BrowserExecuteResult> {
  console.log(`[BrowserTool] Executing script in tab ${tabId}...`);

  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error(`Tab ${tabId} not found`);
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN", // Execute in page's main world
      func: executeScriptInMainWorld,
      args: [script],
    });

    const scriptResult = results[0]?.result;
    console.log("[BrowserTool] Script executed");

    return {
      action: "execute",
      tabId,
      url: tab.url || "",
      result: scriptResult?.result,
      error: scriptResult?.error,
    };
  } catch (error) {
    console.error("[BrowserTool] Script execution failed:", error);
    return {
      action: "execute",
      tabId,
      url: tab.url || "",
      error: (error as Error).message,
    };
  }
}

// Main entry point - routes to appropriate action
export async function executeBrowserTool(
  params: BrowserToolParams,
): Promise<BrowserToolResult> {
  console.log("[BrowserTool] Action:", params.action);

  switch (params.action) {
    case "tabs":
      return executeBrowserTabs();
    case "read":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for read action");
      }
      return executeBrowserRead(params.tabId);
    case "execute":
      if (params.tabId === undefined) {
        throw new Error("tabId is required for execute action");
      }
      if (!params.script) {
        throw new Error("script is required for execute action");
      }
      return executeBrowserExecute(params.tabId, params.script);
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}

// Page info type for collectPageInfo return
interface PageInfo {
  url: string;
  title: string;
  dom: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  selection: string | null;
}

// This function is serialized and executed in the page context (ISOLATED world)
// It only collects DOM info, does NOT execute user scripts
function collectPageInfo(): PageInfo {
  // Serialize DOM to a simplified text representation
  function serializeDOM(): string {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            const tagName = el.tagName.toLowerCase();
            if (
              ["script", "style", "noscript", "svg", "path"].includes(tagName)
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    const parts: string[] = [];
    let currentNode: Node | null;

    while ((currentNode = walker.nextNode())) {
      if (currentNode.nodeType === Node.TEXT_NODE) {
        const text = currentNode.textContent?.trim();
        if (text) {
          parts.push(text);
        }
      } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
        const el = currentNode as Element;
        const tagName = el.tagName.toLowerCase();

        if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tagName)) {
          parts.push(`\n\n## `);
        } else if (tagName === "p" || tagName === "div") {
          parts.push("\n");
        } else if (tagName === "li") {
          parts.push("\n- ");
        } else if (tagName === "button") {
          parts.push(`[Button: `);
        } else if (tagName === "input") {
          const type = el.getAttribute("type") || "text";
          const name = el.getAttribute("name") || el.getAttribute("id") || "";
          const value = (el as HTMLInputElement).value || "";
          parts.push(`[Input ${type} "${name}": "${value}"]`);
        } else if (tagName === "img") {
          const alt = el.getAttribute("alt") || "";
          parts.push(`[Image: ${alt}]`);
        }
      }
    }

    return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  return {
    url: window.location.href,
    title: document.title,
    dom: serializeDOM(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    selection: window.getSelection()?.toString() || null,
  };
}

// This function executes user script in the MAIN world (page context)
// When called with world: "MAIN", it runs directly in the page's JavaScript context
// which means it uses the PAGE's CSP, not the extension's CSP
function executeScriptInMainWorld(script: string): { result?: unknown; error?: string } {
  try {
    // Use Function constructor to execute the script
    // This works because we're in the MAIN world with the page's CSP
    // Most pages allow eval/Function (unlike our extension which is MV3)
    const fn = new Function(script);
    const result = fn();
    return { result };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
