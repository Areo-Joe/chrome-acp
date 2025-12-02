# Chrome ACP

A Chrome extension for chatting with [ACP](https://agentclientprotocol.com) agents.

Since Chrome extensions cannot spawn subprocesses, this uses a local proxy server to bridge the extension to your ACP agent.

## Features

- Chat with any ACP-compatible agent from Chrome's sidepanel
- Streaming responses with Markdown rendering
- Tool call visualization with status indicators

## Architecture

```
┌─────────────────────┐                    ┌─────────────────────┐
│                     │     WebSocket      │                     │
│  Chrome Extension   │◄──────────────────►│    Proxy Server     │
│   (Sidepanel UI)    │   localhost:9315   │   (Hono + Node.js)  │
│                     │                    │                     │
└─────────────────────┘                    └──────────┬──────────┘
                                                      │
                                                      │ stdin/stdout
                                                      │ (ACP Protocol)
                                                      ▼
                                           ┌─────────────────────┐
                                           │     ACP Agent       │
                                           │    (subprocess)     │
                                           └─────────────────────┘
```

**How it works:**
1. The proxy server spawns your ACP agent as a subprocess
2. It communicates with the agent using the native ACP protocol over stdin/stdout
3. The Chrome extension connects to the proxy via WebSocket
4. Messages are bridged between the extension UI and the agent in real-time

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- Chrome or Chromium-based browser
- An ACP-compatible agent

### 1. Install Dependencies

```bash
# Install extension dependencies
bun install

# Install proxy server dependencies
cd proxy-server && bun install && cd ..
```

### 2. Start the Proxy Server

```bash
cd proxy-server

# Basic usage
bun src/cli/bin.ts /path/to/your-agent

# With custom port
bun src/cli/bin.ts --port 9315 /path/to/your-agent

# With agent arguments (use -- separator)
bun src/cli/bin.ts /path/to/your-agent -- --verbose --model gpt-4
```

The proxy server will start and display connection info:
```
🚀 ACP Proxy Server running on http://localhost:9315
   WebSocket endpoint: ws://localhost:9315/ws
   Health check: http://localhost:9315/health

📦 Agent: /path/to/your-agent
   Working directory: /current/directory
```

### 3. Build the Extension

```bash
bun run build
```

This creates a production build in the `dist/` folder.

### 4. Load Extension in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `dist/` folder from this project

### 5. Start Chatting

1. Click the extension icon in Chrome to open the sidepanel
2. The default proxy URL (`ws://localhost:9315/ws`) should work out of the box
3. Click **Connect**
4. Start chatting with your agent!

## Project Structure

```
chrome-acp/
├── src/                      # Extension source code
│   ├── App.tsx               # Main React application
│   ├── acp/                  # ACP client implementation
│   │   ├── client.ts         # WebSocket client for proxy communication
│   │   └── types.ts          # TypeScript type definitions
│   ├── components/           # React components
│   │   ├── ACPConnect.tsx    # Connection settings UI
│   │   ├── ChatInterface.tsx # Main chat interface
│   │   ├── ChatMessage.tsx   # Message rendering
│   │   ├── ai-elements/      # AI Elements UI components
│   │   └── ui/               # shadcn/ui components
│   ├── background.ts         # Chrome extension service worker
│   ├── sidepanel.html        # Extension sidepanel entry
│   └── index.html            # Dev server entry
├── proxy-server/             # Proxy server (separate package)
│   ├── src/
│   │   ├── server.ts         # WebSocket server & ACP bridge
│   │   ├── agent.ts          # Agent process management
│   │   └── cli/              # CLI implementation
│   └── package.json
├── dist/                     # Built extension (load this in Chrome)
├── build.ts                  # Bun build script
└── manifest.json             # Chrome extension manifest
```

## Development

### Running the Dev Server

For development outside the extension context:

```bash
bun dev
```

This starts a hot-reloading dev server at `http://localhost:3000`.

### Building for Production

```bash
bun run build
```

Build options:
```bash
# Show all build options
bun run build.ts --help

# Custom output directory
bun run build.ts --outdir=my-dist

# Without minification (for debugging)
bun run build.ts --no-minify
```

### Proxy Server Development

```bash
cd proxy-server

# Run directly
bun src/cli/bin.ts /path/to/agent

# Build the CLI (for distribution)
bun run build
```

## Configuration

### Proxy Server Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `9315` | Port for the WebSocket server |

### Extension Settings

The extension UI allows configuring:
- **Proxy URL** — WebSocket endpoint (default: `ws://localhost:9315/ws`)
- **Working Directory** — Optional CWD for the agent session

## Troubleshooting

### "WebSocket connection error"
- Ensure the proxy server is running
- Check that the proxy URL in the extension matches the server address
- Verify no firewall is blocking localhost connections

### "Failed to connect to agent"
- Verify the agent command path is correct
- Check that the agent is executable
- Look at the proxy server console for error details

### Extension not appearing
- Make sure you loaded the `dist/` folder, not the project root
- Try clicking "Reload" on the extension in `chrome://extensions`
- Check the Chrome extension errors for details

### Agent not responding
- Verify your agent implements the ACP protocol correctly
- Check the proxy server logs for protocol errors
- Ensure the agent is writing to stdout (not stderr)

## License

MIT
