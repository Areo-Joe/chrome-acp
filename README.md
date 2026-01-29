# Chrome ACP

A Chrome extension and web client for chatting with [ACP](https://agentclientprotocol.com) agents.

## Architecture

```
Chrome Extension ◄──┐
                    ├──WebSocket──► Proxy Server ◄──stdin/stdout──► ACP Agent
Web Client (PWA) ◄──┘
```

Chrome extensions can't spawn subprocesses, so a local proxy server bridges the connection. The web client provides an alternative browser-based UI.

## Packages

This is a Bun monorepo with three packages:

| Package | Description |
|---------|-------------|
| [`packages/chrome-extension`](./packages/chrome-extension) | Chrome extension with sidepanel chat UI |
| [`packages/proxy-server`](./packages/proxy-server) | WebSocket proxy server (npm: `acp-proxy-server`) |
| [`packages/web-client`](./packages/web-client) | PWA web client, served at `http://localhost:{port}/app` |

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Start proxy server

```bash
cd packages/proxy-server
bun src/cli/bin.ts [proxy-options] <agent-command> [-- agent-args]
```

**Examples:**

```bash
# Basic
bun src/cli/bin.ts /path/to/agent

# Proxy server on custom port
bun src/cli/bin.ts --port 8080 /path/to/agent

# Agent with arguments (no dashes, no -- needed)
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

## Browser Tools

The extension exposes three browser tools to agents via MCP:

| Tool | Description |
|------|-------------|
| `browser_read` | Read current page content (returns simplified DOM) |
| `browser_execute` | Execute JavaScript on the page |
| `browser_screenshot` | Capture screenshot of current page |

## Development

```bash
# Build all packages
bun run build

# Build individual packages
bun run build:extension  # Chrome extension
bun run build:proxy      # Proxy server
bun run build:web        # Web client

# Development mode (extension)
bun run dev
```

## License

MIT
