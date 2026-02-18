---
title: Remote Access
description: Access Chrome ACP from other devices on your network.
---

Chrome ACP can be accessed from other devices on your local network, such as mobile phones, tablets, or other computers.

## Quick Start

```bash
acp-proxy --https --host 0.0.0.0 claude-code-acp
```

This:
1. Binds to all network interfaces (`0.0.0.0`)
2. Enables HTTPS with a self-signed certificate
3. Generates an authentication token
4. Prints URLs and QR code for connection

---

## Server Output

When running with remote access enabled:

```
  ACP Proxy Server (HTTPS)

  Open in browser:
    Local:   https://localhost:9315/app?token=abc123...
    Network: https://192.168.1.100:9315/app?token=abc123...

  Scan QR code to connect:
    ┌──────────────────────┐
    │ █▀▀▀▀▀█ ▄▄▄▄ █▀▀▀▀▀█ │
    │ █ ███ █ ▀▄▄▀ █ ███ █ │
    │ ...                   │
    └──────────────────────┘

  Agent: claude-code-acp
  CWD:   /home/user/project

  Press Ctrl+C to stop
```

The QR code contains the full URL with the embedded auth token.

---

## Why HTTPS?

HTTPS is required for several browser features:

| Feature | Requires HTTPS |
|---------|----------------|
| Camera access (QR scanning in web client) | Yes |
| Service Worker / PWA install | Yes (on non-localhost) |
| Secure WebSocket (wss://) | Yes |
| Clipboard access | Yes (on some browsers) |

### Self-Signed Certificate

Chrome ACP generates a self-signed certificate on startup:
- Valid for 365 days
- Stored in `~/.acp-proxy/` (persisted and reused)
- Automatically regenerated if expiring within 7 days or LAN IP changes
- Browser will show a security warning

**To accept the certificate:**
1. Navigate to the URL
2. Click "Advanced" or "Show Details"
3. Click "Proceed to site" or "Accept the Risk"

:::tip
On mobile, you may need to visit the URL directly before scanning the QR code to accept the certificate.
:::

---

## Authentication Flow

### How It Works

1. **Token Generation:** Server generates a random 64-character hex token at startup
2. **URL Embedding:** Token is appended as `?token=abc123...`
3. **Connection:** Client sends token in initial WebSocket handshake
4. **Validation:** Server validates token before accepting connection

### Custom Token

Set a fixed token instead of random generation:

```bash
export ACP_AUTH_TOKEN="my-secret-token"
acp-proxy --host 0.0.0.0 --https claude-code-acp
```

Useful for:
- Automation scripts
- Persistent URLs in bookmarks
- Sharing access with known parties

### Token in QR Code

The QR code encodes the complete URL including token:
```
https://192.168.1.100:9315/app?token=abc123def456...
```

Scan with any QR reader or your phone's camera.

---

## Connecting from Mobile

### Method 1: QR Code (Recommended)

1. Start proxy with `--https --host 0.0.0.0`
2. Open phone camera and point at QR code
3. Tap the URL notification
4. Accept the certificate warning
5. Start chatting!

### Method 2: Manual URL

1. Find your computer's IP address:
   ```bash
   # macOS/Linux
   ifconfig | grep "inet "

   # Windows
   ipconfig
   ```
2. Open browser on mobile
3. Navigate to `https://<your-ip>:9315/app?token=<token>`

---

## Termux (Android)

Run Chrome ACP directly on your Android device.

### Installation

```bash
# Install Termux from F-Droid (not Play Store)
# https://f-droid.org/packages/com.termux/

# Open Termux and install Node.js
pkg update && pkg upgrade
pkg install nodejs

# Install Chrome ACP
npm install -g @chrome-acp/proxy-server

# Install an agent
npm install -g @anthropic-ai/claude-code @zed-industries/claude-code-acp
```

### Running with Auto-Launch

```bash
acp-proxy --termux claude-code-acp
```

The `--termux` flag:
1. Starts the proxy server on localhost
2. Waits for server to be ready
3. Calls `termux-open-url` to launch the PWA

### Requirements

For auto-launch to work:
- Install **Termux:API** app from F-Droid
- Grant Termux API permissions
- Install termux-api package: `pkg install termux-api`

---

## Network Options

| Option | Default | Description |
|--------|---------|-------------|
| `--host` | `localhost` | Bind address |
| `--port` | `9315` | Server port |
| `--https` | `false` | Enable HTTPS |
| `--public-url` | - | Public WebSocket URL for QR code |
| `--no-auth` | `false` | Disable authentication |

### Common Configurations

**Local only (default):**
```bash
acp-proxy --no-auth claude-code-acp
# http://localhost:9315/app
```

**LAN access with auth:**
```bash
acp-proxy --https --host 0.0.0.0 claude-code-acp
# https://192.168.1.x:9315/app?token=...
```

**Custom port:**
```bash
acp-proxy --https --host 0.0.0.0 --port 8443 claude-code-acp
# https://192.168.1.x:8443/app?token=...
```

---

## Security Considerations

:::caution[Important]
Remote access exposes your AI agent to network connections. Be careful!
:::

### Do's

- Use `--https` for any non-localhost access
- Keep authentication enabled (don't use `--no-auth`)
- Use on trusted networks only (home, office)
- Stop the server when not in use

### Don'ts

- Don't use `--no-auth` with `--host 0.0.0.0`
- Don't expose to the internet without additional security
- Don't share your auth token publicly
- Don't run on untrusted networks

### For Public Access

If you need public access:
1. Use a reverse proxy (nginx, Caddy)
2. Set up proper TLS certificates (Let's Encrypt)
3. Add additional authentication (basic auth, OAuth)
4. Consider VPN access instead

---

## Server Deployment

When deploying on a server with a domain name, the auto-detected LAN IP won't work for the QR code. Use `--public-url` to specify the actual WebSocket URL:

```bash
acp-proxy --host 0.0.0.0 --public-url wss://example.com/ws claude-code-acp
```

This makes the QR code contain `wss://example.com/ws` instead of the local network IP.

### Example: nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /ws {
        proxy_pass http://localhost:9315/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location / {
        proxy_pass http://localhost:9315;
        proxy_set_header Host $host;
    }
}
```

Then run:
```bash
acp-proxy --host 0.0.0.0 --public-url wss://example.com/ws claude-code-acp
```

