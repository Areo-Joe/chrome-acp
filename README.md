# Chrome ACP

A Chrome extension for chatting with [ACP](https://agentclientprotocol.com) agents via sidepanel.

## Architecture

```
Chrome Extension ◄──WebSocket──► Proxy Server ◄──stdin/stdout──► ACP Agent
```

Chrome extensions can't spawn subprocesses, so a local proxy server bridges the connection.

## Quick Start

### 1. Install dependencies

```bash
bun install
cd proxy-server && bun install && cd ..
```

### 2. Start proxy server

```bash
cd proxy-server
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
4. Select the project root directory (where `manifest.json` is)

### 5. Start chatting

Click extension icon → Open sidepanel → Connect → Chat

## Browser Tools

The extension exposes three browser tools to agents via MCP:

| Tool | Description |
|------|-------------|
| `browser_read` | Read current page content (returns simplified DOM) |
| `browser_execute` | Execute JavaScript on the page |
| `browser_screenshot` | Capture screenshot of current page |

## License

MIT
