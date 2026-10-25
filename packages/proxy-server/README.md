# ACP Proxy Server

A WebSocket proxy server that bridges Chrome extensions to ACP (Agent Client Protocol) agents.

Part of the [chrome-acp](https://github.com/Areo-Joe/chrome-acp) monorepo.

## Installation

### From npm

```bash
npm install -g @chrome-acp/proxy-server
```

### From source

```bash
# From monorepo root
pnpm install
```

## Usage

### Via npx

```bash
npx @chrome-acp/proxy-server /path/to/agent
```

### Via global install

```bash
acp-proxy /path/to/agent
```

### Via local build

```bash
# From monorepo root
pnpm run build:proxy
node packages/proxy-server/dist/cli/bin.js /path/to/agent
```

To also build the Web client served at `/app/`, run `pnpm run build`.

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

## Direct ACP mode

Use `--acp` to expose ACP JSON-RPC directly on the WebSocket endpoint:

```bash
acp-proxy --acp /path/to/agent -- --model example
```

The default mode retains the existing frontend message protocol. Direct ACP
mode requires an ACP WebSocket client; the current Chrome extension and Web
client use the default protocol.

Connect to `ws://localhost:9315/ws?token=<token>` (or `wss://` with `--https`).
Each authenticated WebSocket connection starts a separate agent process.
Send one JSON-RPC object per WebSocket message, starting with ACP `initialize`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": { "name": "my-client", "version": "1.0.0" },
    "clientCapabilities": {}
  }
}
```

There are no `connect`, `prompt`, or `agent_message` envelopes in this mode.
The client drives initialization, authentication, sessions, prompts, permissions,
and elicitation using ACP. Requests, notifications, responses, IDs, and extension
fields pass through without method-specific translation.

The proxy handles ACP `fs/read_text_file`, `fs/write_text_file`, and the existing
`terminal/*` methods locally using the same implementations as default mode.
It adds file read/write and terminal support to `initialize.clientCapabilities`,
preserving the client's other capabilities. These operations run with the proxy
process's OS permissions. Agent cancellation of a local request is routed to the
local ACP SDK handler. Local operations require an initialized connection and a
live session. The proxy observes `session/new`, `load`, `resume`, `fork`, and
`close` responses to maintain local resource ownership. Loading sessions
are registered before dispatch to allow history-replay requests; failed loads
roll back without removing an existing or concurrently loaded session. Subagent
sessions are registered only when the client advertises `subagents: {}`; they
inherit the parent workspace and are released with their parent.

Successful `session/close` releases that session's local terminals.
`session/delete` removes the history entry without closing an active session
or its terminals, matching Zed's session-list behavior.
Disconnect, SIGINT, and SIGTERM clean up agent and terminal process
groups on Unix. Signal shutdown rejects new operations and waits for all accepted
file writes to settle before exiting, including saves lasting more than one
second. Repeated SIGINT/SIGTERM signals do not interrupt this wait. The one-second
HTTP cleanup deadline starts only after saves finish.
Agent exit drains final stdout/stderr for at most 250 ms, matching
Zed's bounded exit-drain behavior even when descendants hold inherited pipes.
Agent failure closes the WebSocket with code 1011; invalid tokens use code 4001.

Headless terminals run through `/bin/sh` on Unix (the Termux shell is used when
`/bin/sh` is absent). Commands without arguments support shell expressions;
commands with arguments quote the executable and each argument separately.
Default `PAGER` and `GIT_PAGER` values disable pagers, with explicit agent
environment overrides applied afterward. Missing commands return the shell's
nonzero exit code, and shell/working-directory startup failures return ACP
errors. Output limits retain a UTF-8-safe prefix and drop a trailing partial
line, following Zed's truncation policy. Cancelling `terminal/wait_for_exit`
stops that wait without stopping the terminal.

File IO is asynchronous. Reads support request cancellation; writes check
cancellation before starting and finish once accepted, following Zed's write
handler and avoiding partial writes caused by mid-write cancellation. Line-limited reads
preserve newline characters and reject starts beyond the file's last row,
including the empty final row when the file ends in a newline.

This remains a disk-based, headless host: it has no Zed editor buffers, undo/action
log, project-specific environment loader, or PTY screen rendering. Windows uses
PowerShell and best-effort `taskkill /T /F` cleanup; it does not implement Zed's
Windows Job Objects. Unix lifecycle behavior is tested on macOS; Windows and
Android execution require validation on those platforms.

The legacy browser MCP endpoint and browser tool messages are disabled in direct
ACP mode. Configure any MCP servers explicitly in ACP session requests. File
explorer listings, file watcher events, and mobile QR setup remain default-mode
features. Use `--termux` with default mode.

### Verification

From the repository root, using Node.js 26 and the pinned pnpm version:

```bash
pnpm run build:proxy
node --test packages/proxy-server/test/*.test.mjs
```

## CLI Reference

```
USAGE
  acp-proxy [--port value] [--debug] <command>...
  acp-proxy --help
  acp-proxy --version

FLAGS
     [--port]    Port to listen on                  [default = 9315]
     [--acp]     Use direct ACP JSON-RPC over WebSocket
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
| `browser_tabs` | List all open tabs (returns id, url, title, active status) |
| `browser_read` | Read content of a specific tab (requires tabId from browser_tabs) |
| `browser_execute` | Execute JavaScript in a specific tab (requires tabId from browser_tabs) |

## License

MIT
