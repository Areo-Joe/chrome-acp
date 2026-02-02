# Chrome ACP Extension

Chrome extension for chatting with [ACP](https://agentclientprotocol.com) agents via sidepanel.

Part of the [chrome-acp](https://github.com/Areo-Joe/chrome-acp) monorepo.

## Features

- Sidepanel chat interface for ACP agents
- Real-time streaming responses
- Tool call visualization
- Browser tools for agents (tabs, read, execute)

## Development

### Prerequisites

- [Bun](https://bun.sh) installed
- Chrome browser

### Build

```bash
# From monorepo root
bun install
bun run build:extension

# Or from this directory
bun run build
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this directory (`packages/chrome-extension`)

### Development Mode

```bash
# From monorepo root
bun run dev

# Or from this directory
bun --hot src/index.ts
```

## Usage

1. Start the [proxy server](../proxy-server) with your ACP agent
2. Click the extension icon to open the sidepanel
3. Click "Connect" to connect to the proxy server
4. Start chatting!

## Browser Tools

The extension provides browser capabilities to connected agents:

| Tool | Description |
|------|-------------|
| `browser_tabs` | List all open tabs (returns id, url, title, active status) |
| `browser_read` | Read content of a specific tab (requires tabId from browser_tabs) |
| `browser_execute` | Execute JavaScript in a specific tab (requires tabId from browser_tabs) |

## Configuration

Default proxy server URL: `ws://localhost:9315/ws`

## Tech Stack

- React 19
- Tailwind CSS 4
- Radix UI components
- Bun bundler

## License

MIT

