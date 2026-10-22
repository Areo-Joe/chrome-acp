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

- pnpm 12.14.0 (pinned in the root `package.json`)
- Node.js 26.7+ (`nvm use` reads the root `.nvmrc`)
- Chrome browser

### Build

```bash
# From monorepo root
pnpm install
pnpm run build:extension
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this directory (`packages/chrome-extension`)

### Development Mode

```bash
# Browser UI development with Vite hot reload (from monorepo root)
pnpm run dev

# Rebuild extension pages and background when source files change
pnpm --filter @chrome-acp/extension run watch
```

For Chrome API testing, use the unpacked extension. After each rebuild, reload
the extension in `chrome://extensions` and reopen its side panel. The Vite
browser preview supports UI development; Chrome APIs require the extension.

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
- Vite 8 + Rolldown
- pnpm for dependency management and workspace commands

## License

MIT

