# Chrome ACP Extension

A Chrome extension that provides a chat interface for [Agent Client Protocol (ACP)](https://agentclientprotocol.com) agents. Since Chrome extensions cannot spawn subprocesses directly, this uses a proxy server architecture.

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

## Quick Start

### 1. Install Dependencies

```bash
bun install
cd proxy-server && bun install
```

### 2. Start Proxy Server

```bash
cd proxy-server
bun run index.ts
```

### 3. Build Extension

```bash
bun run build
```

### 4. Load Extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` folder

### 5. Connect to Agent

1. Open the extension sidepanel
2. Enter your agent command (e.g., `/path/to/your-acp-agent`)
3. Add arguments if needed
4. Click "Connect"

## Features

- **Chat Interface** - Built with [AI Elements](https://ai-elements.dev) components
  - Streaming message responses with Markdown rendering
  - Tool call display with status indicators
  - Auto-scroll with scroll-to-bottom button
- **Session Management** - Auto-creates session on connect
- **Collapsible Settings** - Clean UI that hides settings when connected

## Development

```bash
# Start dev server (for testing outside extension)
bun dev

# Build for production
bun run build
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4
- **UI Components**: shadcn/ui + AI Elements
- **Build**: Bun
- **Protocol**: ACP via `@agentclientprotocol/sdk`
