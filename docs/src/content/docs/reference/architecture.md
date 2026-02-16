---
title: Architecture
description: Technical architecture of Chrome ACP.
sidebar:
  order: 2
---

This page describes the technical architecture of Chrome ACP in detail.

## Overview

Chrome ACP consists of four main components:

```
┌─────────────────────┐     WebSocket     ┌──────────────────┐     stdin/stdout     ┌───────────┐
│   Chrome Extension  │ ◄───────────────► │   Proxy Server   │ ◄─────────────────► │ ACP Agent │
│    or Web Client    │                   │                  │                      │           │
└─────────────────────┘                   └──────────────────┘                      └───────────┘
```

## Why a Proxy Server?

Chrome extensions run in a browser sandbox and **cannot spawn subprocesses**. The proxy server acts as a local bridge that:

1. Spawns the ACP agent subprocess
2. Communicates with the agent via stdin/stdout (NDJSON)
3. Relays messages to/from browser clients via WebSocket
4. Exposes browser tools to agents via MCP

---

## Components

### Chrome Extension

**Location:** `packages/chrome-extension`

A Chrome Manifest V3 extension with:
- **Sidepanel UI** - Chat interface in Chrome's side panel
- **Background service worker** - Maintains WebSocket connection to proxy
- **Browser tools** - `browser_tabs`, `browser_read`, `browser_execute`

Uses `chrome.scripting.executeScript()` with `world: "MAIN"` to run scripts in the page's JavaScript context.

### Web Client

**Location:** `packages/web-client`

A Progressive Web App (PWA) served by the proxy server. Features:
- Same chat UI as the extension (shared components)
- No browser tool access (runs in regular web context)
- Mobile-friendly for QR code connections

### Proxy Server

**Location:** `packages/proxy-server`

A Node.js server built with [Hono](https://hono.dev/):
- Serves web client at `/app`
- WebSocket endpoint at `/ws`
- MCP endpoint at `/mcp` (Streamable HTTP)
- File explorer API for workspace browsing

### Shared Package

**Location:** `packages/shared`

Shared code used by both chrome-extension and web-client:
- `ACPClient` - WebSocket client for proxy communication
- UI components (shadcn/ui + Vercel AI Elements)
- TypeScript type definitions

---

## WebSocket Protocol

Communication between browser clients and proxy server uses JSON messages.

### Client → Server Messages

| Type | Description |
|------|-------------|
| `connect` | Initial handshake (sends auth token) |
| `new_session` | Request new ACP session |
| `prompt` | Send user message with content blocks |
| `cancel` | Cancel current agent response |
| `set_session_model` | Switch AI model |
| `permission_response` | User response to permission request |
| `browser_tool_result` | Result from browser tool execution |

### Server → Client Messages

| Type | Description |
|------|-------------|
| `connected` | Connection confirmed |
| `error` | Error occurred |
| `session_created` | New session ready |
| `session_update` | Agent response chunks |
| `prompt_complete` | Agent finished responding |
| `permission_request` | Request user confirmation |
| `browser_tool_call` | Request browser tool execution |
| `model_state` | Available models and current selection |

### Session Update Types

The `session_update` message has different subtypes:

```typescript
type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; status: string; ... }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; ... };
```

---

## Content Types

Messages support multiple content types:

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }  // base64
  | { type: "resource_link"; uri: string; mimeType?: string };
```

### Image Support

Agents can declare image support via `promptCapabilities`:

```typescript
interface PromptCapabilities {
  audio?: boolean;
  image?: boolean;
  embeddedContext?: boolean;
}
```

The client checks `promptCapabilities.image` to enable/disable image attachments.

---

## Permission System

Some operations require user confirmation:

```typescript
interface PermissionOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}
```

Flow:
1. Agent requests operation → Proxy sends `permission_request`
2. UI shows permission buttons → User clicks one
3. Client sends `permission_response` with selected `optionId`
4. Proxy forwards decision → Agent continues or aborts

---

## Model Selection

Agents can expose multiple models:

```typescript
interface SessionModelState {
  availableModels: Array<{
    id: string;
    displayName?: string;
    provider?: string;
  }>;
  currentModelId?: string;
}
```

The UI shows a model selector popover. When user switches:
1. Client sends `set_session_model` with new `modelId`
2. Proxy forwards to agent
3. Agent updates session model

---

## File Explorer

The proxy server provides file system access for workspace browsing:

### List Directory

```typescript
// Request
{ type: "list_dir", path: "/some/path" }

// Response
{
  items: [
    { name: "src", type: "directory" },
    { name: "README.md", type: "file" }
  ]
}
```

### Read File

```typescript
// Request
{ type: "read_file", path: "/some/path/file.txt" }

// Response
{
  path: "/some/path/file.txt",
  content: "file contents...",
  mimeType: "text/plain"
}
```

---

## MCP Integration

Browser tools are exposed to agents via MCP (Model Context Protocol):

- **Transport:** Streamable HTTP at `/mcp`
- **Protocol Version:** `2024-11-05`

### MCP Methods

| Method | Description |
|--------|-------------|
| `initialize` | Protocol handshake |
| `tools/list` | List available browser tools |
| `tools/call` | Execute a browser tool |

### Tool Definitions

```typescript
const BROWSER_TOOLS = [
  {
    name: "browser_tabs",
    description: "List all open tabs...",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "browser_read",
    description: "Read the content of a specific tab...",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"]
    }
  },
  {
    name: "browser_execute",
    description: "Execute JavaScript in a tab...",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        script: { type: "string" }
      },
      required: ["tabId", "script"]
    }
  }
];
```

### MCP Flow

```
Agent                    Proxy                   Extension
  │                        │                         │
  │── tools/call ─────────►│                         │
  │   (browser_tabs)       │                         │
  │                        │── browser_tool_call ───►│
  │                        │                         │
  │                        │◄── browser_tool_result ─│
  │                        │    (tabs array)         │
  │◄── MCP response ───────│                         │
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Package Manager | Bun (workspaces) |
| UI Framework | React + TypeScript |
| Styling | Tailwind CSS |
| UI Components | shadcn/ui + Vercel AI Elements |
| Server | Hono (HTTP + WebSocket) |
| Build | Bun (extension), Vite (web-client) |

