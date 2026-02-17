---
title: Quick Start
description: Get up and running with Chrome ACP in minutes.
sidebar:
  order: 2
---

Get Chrome ACP running in just a few minutes.

## Prerequisites

- **Node.js 18+** (or Bun)
- A supported AI agent (we'll use Claude Code in this guide)

## Step 1: Install

Install the proxy server and an ACP agent:

```bash
npm install -g @chrome-acp/proxy-server @anthropic-ai/claude-code @zed-industries/claude-code-acp
```

## Step 2: Start the Proxy

```bash
acp-proxy --no-auth claude-code-acp
```

You should see output like:

```
  ACP Proxy Server

  Open in browser:
    Local:   http://localhost:9315/app

  Agent: claude-code-acp
  CWD:   /your/current/directory

  Press Ctrl+C to stop
```

## Step 3: Open the Web Client

Open http://localhost:9315 in your browser.

That's it! You can now chat with Claude Code through your browser.

## Using the Chrome Extension

For full browser control (reading tabs, executing scripts), install the Chrome extension:

1. Download `chrome-extension.zip` from [Releases](https://github.com/Areo-Joe/chrome-acp/releases)
2. Unzip the file
3. Go to `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in top right)
5. Click **Load unpacked** and select the unzipped folder
6. Click the extension icon → Connect to your running proxy

## What's Next?

- Learn about [Browser Tools](/chrome-acp/guides/browser-tools/) the extension provides
- See all [Supported Agents](/chrome-acp/guides/supported-agents/)
- Configure [Remote Access](/chrome-acp/guides/remote-access/) for mobile devices

