# Chrome ACP Extension - Progress

## Overview

Adding ACP (Agent Client Protocol) support to a Chrome extension. Since Chrome extensions cannot spawn subprocesses or use stdin/stdout directly, we implemented a **proxy server** architecture.

## Architecture

```
┌─────────────────────┐    WebSocket     ┌─────────────────────┐
│  Chrome Extension   │◄───────────────►│   Proxy Server      │
│  (Sidepanel UI)     │  localhost:9315  │   (Bun + Node.js)   │
└─────────────────────┘                  └──────────┬──────────┘
                                                    │ stdin/stdout
                                                    │ (native ACP via SDK)
                                                    ▼
                                         ┌─────────────────────┐
                                         │   ACP Agent         │
                                         │   (subprocess)      │
                                         └─────────────────────┘
```

## Completed ✅

### Proxy Server (`proxy-server/`)

- **`index.ts`** - Main server with WebSocket endpoint
  - Uses `@agentclientprotocol/sdk` for proper ACP communication
  - Uses Node.js `child_process.spawn` for agent subprocess
  - Handles: `connect`, `disconnect`, `new_session`, `prompt` messages
  - Forwards `session_update` notifications to extension

- **`src/types.ts`** - Protocol type definitions
- **`src/agent.ts`** - (Legacy, now using SDK instead)

### Chrome Extension (`src/`)

- **`acp/types.ts`** - Client-side protocol types
  - `ProxyMessage` - messages sent to proxy
  - `ProxyResponse` - messages received from proxy
  - `SessionUpdate` - streaming content updates

- **`acp/client.ts`** - `ACPClient` class
  - WebSocket connection to proxy server
  - Session management
  - Event handlers for updates

- **`components/ACPConnect.tsx`** - Settings/Connect UI
  - Proxy URL input
  - Agent command input
  - Agent arguments input (comma-separated)
  - Working directory input
  - Connect/Disconnect button
  - Connection status indicator

- **`App.tsx`** - Updated to include ACP connection UI and Chat interface

- **`components/ChatMessage.tsx`** - Individual message display
  - User/Agent message rendering with icons
  - Tool call display with status indicators
  - Streaming cursor animation

- **`components/ChatInterface.tsx`** - Main chat UI
  - Message list with auto-scroll
  - Text input with Enter to send
  - Session auto-creation
  - Cancel prompt support
  - Tool call status updates

## TODO 📋

### High Priority

1. ~~**Chat UI Component**~~ ✅
   - ~~Text input for prompts~~
   - ~~Message display area~~
   - ~~Streaming response rendering~~
   - Markdown support for agent responses (pending)

2. ~~**Session Management UI**~~ ✅
   - ~~Auto-create session on connect~~
   - ~~Session status display~~

### Medium Priority

3. **Permission Handling**
   - Currently auto-approves first option
   - Need UI to display permission requests
   - Let user choose from options

4. **File Operations**
   - Forward `readTextFile` requests to extension
   - Forward `writeTextFile` requests to extension
   - Use Chrome extension APIs or content scripts

5. **Tool Call Display**
   - Show tool calls in progress
   - Display tool call results

### Low Priority

6. **Error Handling**
   - Better reconnection logic
   - Timeout handling
   - User-friendly error messages

7. **Settings Persistence**
   - Currently uses localStorage
   - Consider using `chrome.storage.sync`

8. **Terminal Support**
   - Handle `createTerminal` requests
   - Display terminal output in UI

## How to Run

### Start Proxy Server
```bash
cd proxy-server
bun run index.ts
```

### Build Extension
```bash
bun run build
```

### Load Extension
1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder

### Configure & Connect
1. Open extension sidepanel
2. Enter agent command (e.g., `/path/to/acp-agent`)
3. Add arguments if needed
4. Click "Connect"

## Dependencies

### Proxy Server
- `@agentclientprotocol/sdk` - Official ACP SDK

### Extension
- React + TypeScript
- Tailwind CSS
- shadcn/ui components

## Protocol Messages

### Extension → Proxy
| Type | Payload | Description |
|------|---------|-------------|
| `connect` | `{command, args, cwd}` | Spawn agent |
| `disconnect` | - | Kill agent |
| `new_session` | `{cwd?}` | Create session |
| `prompt` | `{text}` | Send prompt |
| `cancel` | - | Cancel current prompt |

### Proxy → Extension
| Type | Payload | Description |
|------|---------|-------------|
| `status` | `{connected, agentInfo}` | Connection status |
| `error` | `{message}` | Error occurred |
| `session_created` | `{sessionId}` | Session ready |
| `session_update` | `{update}` | Streaming content |
| `prompt_complete` | `{stopReason}` | Prompt finished |
| `permission_request` | `{toolCall, options}` | Tool approval needed |

