# Chrome ACP Extension

Chrome extension for chatting with [ACP](https://agentclientprotocol.com) agents via sidepanel.

Part of the [chrome-acp](https://github.com/Areo-Joe/chrome-acp) monorepo.

## Features

- Sidepanel chat interface for ACP agents
- Real-time streaming responses
- Tool call visualization
- Browser tools for agents (read, execute)

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
| `browser_read` | Read current page content (simplified DOM) |
| `browser_execute` | Execute JavaScript on the page |

## Configuration

Default proxy server URL: `ws://localhost:9315/ws`

## Tech Stack

- React 19
- Tailwind CSS 4
- Radix UI components
- Bun bundler

## License

MIT

