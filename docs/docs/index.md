---
pageType: home
hero:
  name: Chrome ACP
  text: Browser Control for AI Agents
  tagline: Chat with AI agents and give them the power to see and interact with your browser.
  actions:
    - theme: brand
      text: Quick Start
      link: /getting-started/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/Areo-Joe/chrome-acp
features:
  - title: Works with Any ACP Agent
    details: Claude Code, OpenCode, Gemini CLI, Codex CLI, and more.
    icon: 🔌
  - title: Runs Anywhere
    details: Local machine, server, even Termux on Android.
    icon: 💻
  - title: Operates as You
    details: Agents interact with pages using your real browser session.
    icon: 👤
  - title: Browser Tools
    details: Read tabs, execute scripts, and interact with web pages.
    icon: 🔍
---

## Quick Install

```bash
# Install
npm install -g @chrome-acp/proxy-server @anthropic-ai/claude-code @zed-industries/claude-code-acp

# Start
acp-proxy --no-auth claude-code-acp
```

Then open http://localhost:9315 in your browser.

