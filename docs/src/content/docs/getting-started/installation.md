---
title: Installation
description: Detailed installation instructions for Chrome ACP.
sidebar:
  order: 3
---

This guide covers detailed installation options for Chrome ACP.

## Installing the Proxy Server

### Using npm (recommended)

```bash
npm install -g @chrome-acp/proxy-server
```

### Using Bun

```bash
bun install -g @chrome-acp/proxy-server
```

### Using pnpm

```bash
pnpm install -g @chrome-acp/proxy-server
```

## Installing an ACP Agent

You need an ACP-compatible agent to use Chrome ACP. Here are installation instructions for popular agents:

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code @zed-industries/claude-code-acp
```

### Codex CLI (OpenAI)

```bash
npm install -g @openai/codex @zed-industries/codex-acp
```

### OpenCode

```bash
curl -fsSL https://opencode.ai/install | bash
```

### Gemini CLI

```bash
npm install -g @google/gemini-cli
```

### Qwen Code

```bash
npm install -g @qwen-code/qwen-code@latest
```

### Augment Code

```bash
npm install -g @augmentcode/auggie
```

## Installing the Chrome Extension

The Chrome extension enables browser tools (reading tabs, executing scripts).

### From Releases (recommended)

1. Download `chrome-extension.zip` from [Releases](https://github.com/Areo-Joe/chrome-acp/releases)
2. Unzip the file
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in top right)
5. Click **Load unpacked**
6. Select the unzipped folder

### Building from Source

```bash
# Clone the repository
git clone https://github.com/Areo-Joe/chrome-acp.git
cd chrome-acp

# Install dependencies
bun install

# Build the extension
bun run build:extension

# Load packages/chrome-extension/dist in Chrome
```

## Verifying Installation

Run the proxy server to verify everything is installed correctly:

```bash
acp-proxy --help
```

You should see the available CLI options.

## Next Steps

- Follow the [Quick Start](/chrome-acp/getting-started/quick-start/) guide
- Learn about [CLI Options](/chrome-acp/reference/cli-reference/)

