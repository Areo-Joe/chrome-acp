# ACP Proxy Server

A WebSocket proxy server that bridges Chrome extensions to ACP (Agent Client Protocol) agents.

Part of the [chrome-acp](https://github.com/Areo-Joe/chrome-acp) monorepo.

## Installation

### From npm

```bash
npm install -g acp-proxy-server
```

### From source

```bash
# From monorepo root
bun install
```

## Usage

### Via npx

```bash
npx acp-proxy-server /path/to/agent
```

### Via global install

```bash
acp-proxy /path/to/agent
```

### Via source

```bash
bun src/cli/bin.ts /path/to/agent
```

### Examples

```bash
# Basic usage
acp-proxy /path/to/agent

# With custom port
acp-proxy --port 9000 /path/to/agent

# With debug logging
acp-proxy --debug /path/to/agent

# Pass arguments to the agent (use -- to separate)
acp-proxy /path/to/agent -- --verbose --model gpt-4
```

## CLI Reference

```
USAGE
  acp-proxy [--port value] [--debug] <command>...
  acp-proxy --help
  acp-proxy --version

FLAGS
     [--port]    Port to listen on                  [default = 9315]
     [--debug]   Enable debug logging
  -h  --help     Print help information and exit
  -v  --version  Print version information and exit

ARGUMENTS
  command...  Agent command followed by its arguments
```

## How It Works

The proxy server:
1. Listens for WebSocket connections from the Chrome extension
2. When a "connect" message is received, spawns the configured ACP agent as a subprocess
3. Bridges messages between the WebSocket (extension) and stdin/stdout (agent)
4. Exposes browser tools to agents via MCP (Model Context Protocol)

This allows Chrome extensions to communicate with ACP agents despite not being able to spawn subprocesses directly.

## Browser Tools (via MCP)

The proxy server exposes an MCP endpoint at `http://localhost:{port}/mcp` with these tools:

| Tool | Description |
|------|-------------|
| `browser_read` | Read current page content (returns simplified DOM) |
| `browser_execute` | Execute JavaScript on the page |
| `browser_screenshot` | Capture screenshot of current page |

## License

MIT
