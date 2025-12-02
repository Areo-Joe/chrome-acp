# ACP Proxy Server

A WebSocket proxy server that bridges Chrome extensions to ACP (Agent Client Protocol) agents.

## Installation

```bash
bun install
```

## Usage

```bash
# Basic usage
bun run index.ts /path/to/agent

# With custom port
bun run index.ts --port 9000 /path/to/agent

# Pass arguments to the agent (use -- to separate)
bun run index.ts /path/to/agent -- --verbose --model gpt-4
```

## CLI Reference

```
USAGE
  acp-proxy [--port value] <command>...
  acp-proxy --help
  acp-proxy --version

FLAGS
     [--port]    Port to listen on                  [default = 9315]
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

This allows Chrome extensions to communicate with ACP agents despite not being able to spawn subprocesses directly.
