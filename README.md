# Chrome ACP

A Chrome extension and web client for chatting with [ACP](https://agentclientprotocol.com) agents.

## Features

### Chat Interface
- **Streaming responses** - Real-time message streaming from agents
- **Image attachments** - Paste or upload images (auto-compressed to max 2MB)
- **Thinking display** - Collapsible reasoning/thinking sections
- **Cancel requests** - Stop in-progress agent requests
- **Permission handling** - Approve/reject tool calls before execution
- **Tab state persistence** - Switch between Chat/Files without losing state

### File Explorer
- **Tree-based browsing** - Lazy-loaded directory navigation
- **Syntax highlighting** - 50+ languages via [shiki](https://shiki.style)
- **Image preview** - View images directly in the preview panel
- **Real-time watching** - Auto-refresh when files change on disk
- **Path protection** - Prevents directory traversal attacks

### Model Selection
- **Dynamic switching** - Change models when supported by the agent
- **Mobile-optimized** - Touch-friendly picker UI

### Mobile Support
- **QR code scanning** - Scan to connect from mobile devices
- **Swipe gestures** - Swipe left/right to switch Chat/Files tabs

## Architecture

```
Chrome Extension ◄──┐
                    ├──WebSocket──► Proxy Server ◄──stdin/stdout──► ACP Agent
Web Client (PWA) ◄──┘
```

Chrome extensions can't spawn subprocesses, so a local proxy server bridges the connection. The web client provides an alternative browser-based UI.

## Packages

This is a Bun monorepo with four packages:

| Package | Description |
|---------|-------------|
| [`packages/chrome-extension`](./packages/chrome-extension) | Chrome extension with sidepanel chat UI |
| [`packages/web-client`](./packages/web-client) | PWA web client, served at `http://localhost:{port}/app` |
| [`packages/shared`](./packages/shared) | Shared UI components and utilities (`@chrome-acp/shared`) |
| [`packages/proxy-server`](./packages/proxy-server) | WebSocket proxy server (npm: `@chrome-acp/proxy-server`) |

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Start proxy server

```bash
cd packages/proxy-server
bun src/cli/bin.ts [options] <agent-command> [-- agent-args]
```

**Examples:**

```bash
# Basic
bun src/cli/bin.ts /path/to/agent

# Custom port
bun src/cli/bin.ts --port 8080 /path/to/agent

# Agent with arguments
bun src/cli/bin.ts /path/to/agent config.json

# Agent with flags (use -- to separate)
bun src/cli/bin.ts /path/to/agent -- --model gpt-4 --verbose
```

`--` separates proxy server flags from agent flags. Arguments after `--` are passed directly to the agent.

The agent must speak [ACP protocol](https://agentclientprotocol.com) over stdin/stdout.

### 3. Build extension

```bash
bun run build
```

### 4. Load extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `packages/chrome-extension` directory

### 5. Start chatting

**Option A: Chrome Extension**

Click extension icon → Open sidepanel → Connect → Chat

**Option B: Web Client**

Open `http://localhost:9315/app` in your browser (no extension needed)

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `9315` | Server port |
| `--host` | `localhost` | Host to bind (use `0.0.0.0` for network access) |
| `--https` | `false` | Enable HTTPS with self-signed certificate (for LAN only) |
| `--no-auth` | `false` | ⚠️ Disable authentication (dangerous for remote access) |
| `--termux` | `false` | Auto-launch PWA via Termux on Android |
| `--debug` | `false` | Enable debug logging to file |

## Remote Access

### LAN Access with HTTPS

For accessing from other devices on your network (e.g., mobile):

```bash
bun src/cli/bin.ts --https --host 0.0.0.0 /path/to/agent
```

The server will print URLs with embedded auth tokens:
```
🔗 Local:   https://localhost:9315/app?token=abc123...
🔗 Network: https://192.168.1.100:9315/app?token=abc123...
📱 Scan QR code to connect from mobile
```

> **Note:** HTTPS is required for camera access (QR scanning) on mobile devices.

### Authentication

By default, a random token is generated on each server start.

```bash
# Use auto-generated token (printed to terminal)
bun src/cli/bin.ts --host 0.0.0.0 /path/to/agent

# Use custom token via environment variable
ACP_AUTH_TOKEN=mytoken bun src/cli/bin.ts --host 0.0.0.0 /path/to/agent

# Disable authentication (dangerous!)
bun src/cli/bin.ts --no-auth /path/to/agent
```

### QR Code Connection

When running with `--host 0.0.0.0`, the server displays a QR code in the terminal. Scan it with the web client's camera to auto-fill the connection URL and token.

### Termux (Android)

Run agents directly on your Android device:

```bash
bun src/cli/bin.ts --termux /path/to/agent
```

This automatically launches the PWA after the server starts.

## Browser Tools

The extension exposes browser tools to agents via MCP:

| Tool | Description |
|------|-------------|
| `browser_tabs` | List all open tabs (id, url, title, active status) |
| `browser_read` | Read DOM content of a tab as simplified Markdown |
| `browser_execute` | Execute JavaScript in a tab's page context |

**Usage flow:**
1. Agent calls `browser_tabs` to list available tabs
2. Agent calls `browser_read` with a `tabId` to read page content
3. Agent calls `browser_execute` with a `tabId` and `script` to interact with the page

> **Note:** Browser tools require the Chrome extension. They are not available in the web client.

## Development

```bash
# Build all packages
bun run build

# Build individual packages
bun run build:extension  # Chrome extension
bun run build:proxy      # Proxy server
bun run build:web        # Web client

# Development mode (extension with hot reload)
bun run dev

# Release new version
just release <version>
```

## License

MIT
