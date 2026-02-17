---
title: CLI Reference
description: Command-line options for the acp-proxy server.
sidebar:
  order: 1
---

Complete reference for the `acp-proxy` command.

## Usage

```bash
acp-proxy [options] <agent-command> [-- <agent-args>]
```

**Arguments:**
- `<agent-command>` - The ACP agent executable to run
- `[agent-args]` - Arguments passed to the agent (after `--`)

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `9315` | Server port |
| `--host` | `localhost` | Host to bind |
| `--https` | `false` | Enable HTTPS with self-signed certificate |
| `--no-auth` | `false` | Disable authentication |
| `--termux` | `false` | Auto-launch PWA via Termux API |
| `--debug` | `false` | Enable debug logging to file |

---

## Environment Variables

### `ACP_AUTH_TOKEN`

Set a custom authentication token instead of auto-generating one:

```bash
export ACP_AUTH_TOKEN="my-secret-token"
acp-proxy --host 0.0.0.0 claude-code-acp
```

When not set, a random token is generated and printed to the console.

### Agent Environment

The proxy inherits and passes through all environment variables to the agent. Set API keys before starting:

```bash
# For Claude Code
export ANTHROPIC_API_KEY="sk-ant-..."

# For OpenAI Codex
export OPENAI_API_KEY="sk-..."

# For Gemini CLI
export GOOGLE_API_KEY="..."

acp-proxy --no-auth claude-code-acp
```

---

## Examples

### Basic Local Usage

```bash
acp-proxy --no-auth claude-code-acp
```

Output:
```
  ACP Proxy Server

  Open in browser:
    Local:   http://localhost:9315/app

  Agent: claude-code-acp
  CWD:   /home/user/project

  Press Ctrl+C to stop
```

### Custom Port

```bash
acp-proxy --port 8080 --no-auth claude-code-acp
```

### Network Access with HTTPS

```bash
acp-proxy --https --host 0.0.0.0 claude-code-acp
```

Output includes:
- URLs with embedded auth token
- QR code for mobile connection

### Agent with Arguments

Use `--` to separate proxy options from agent arguments:

```bash
# Gemini CLI with experimental ACP flag
acp-proxy --no-auth gemini -- --experimental-acp

# Qwen Code with ACP mode
acp-proxy --no-auth qwen -- --acp
```

### Debug Mode

```bash
acp-proxy --debug --no-auth claude-code-acp
```

Debug logs are written to `.acp-proxy/` in the current working directory:
- **Format:** `.acp-proxy/acp-proxy-YYYY-MM-DD_HH-MM-SS.log`
- **Example:** `.acp-proxy/acp-proxy-2026-02-16_14-30-45.log`

---

## HTTPS Configuration

When `--https` is enabled:

1. **Self-signed certificate** is generated automatically
2. Certificate is stored in `~/.acp-proxy/` (persisted and reused)
3. Browser will show a security warning - this is expected

:::tip[LAN Only]
Self-signed certificates are only suitable for local network use. For public access, use a reverse proxy with proper TLS termination.
:::

### Why HTTPS?

Required for:
- **Camera access** on mobile (for QR scanning)
- **Service Worker** registration on non-localhost origins
- **Secure WebSocket** (wss://) connections

---

## Termux Mode

The `--termux` flag is designed for running on Android:

```bash
acp-proxy --termux claude-code-acp
```

Behavior:
1. Starts the proxy server
2. Waits for server to be ready
3. Launches the PWA URL using Termux's `termux-open-url` command

### Termux Setup

```bash
# Install Node.js
pkg install nodejs

# Install Chrome ACP
npm install -g @chrome-acp/proxy-server

# Install your agent
npm install -g @anthropic-ai/claude-code @zed-industries/claude-code-acp

# Run
acp-proxy --termux claude-code-acp
```

---

## Working Directory

The agent runs in the **current working directory**. This determines:

- Which files the agent can access
- The project context for coding agents
- The base path for file operations

```bash
cd /path/to/your/project
acp-proxy --no-auth claude-code-acp
```

---

## Authentication

### With Authentication (default)

When authentication is enabled (no `--no-auth` flag):

1. Server generates random token (or uses `ACP_AUTH_TOKEN`)
2. Token is embedded in printed URLs
3. Clients must provide token to connect

Token format in URL:
```
http://192.168.1.100:9315/app?token=abc123...
```

### Without Authentication

```bash
acp-proxy --no-auth claude-code-acp
```

:::caution
Only use `--no-auth` when:
- Binding to `localhost` only
- On a trusted private network
- For development/testing

Never use `--no-auth` with `--host 0.0.0.0` on public networks!
:::

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Clean shutdown (Ctrl+C) |
| `1` | Agent process failed to start |
| `1` | Invalid command-line arguments |

