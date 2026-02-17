---
title: Supported Agents
description: AI agents that work with Chrome ACP.
---

Chrome ACP works with any [ACP-compatible agent](https://agentclientprotocol.com/get-started/agents). Here are setup instructions for popular agents.

---

## Claude Code

Anthropic's agentic coding tool.

```bash
# Install
npm install -g @chrome-acp/proxy-server @anthropic-ai/claude-code @zed-industries/claude-code-acp

# Run
acp-proxy --no-auth claude-code-acp
```

**Requirements:** `ANTHROPIC_API_KEY` environment variable

**Features:** Image support, Model selection, Extended thinking

---

## Codex CLI

OpenAI's coding agent.

```bash
# Install
npm install -g @chrome-acp/proxy-server @openai/codex @zed-industries/codex-acp

# Run
acp-proxy --no-auth codex-acp
```

**Requirements:** `OPENAI_API_KEY` environment variable

---

## OpenCode

Open-source terminal AI assistant with multi-provider support.

```bash
# Install
npm install -g @chrome-acp/proxy-server
curl -fsSL https://opencode.ai/install | bash

# Run
acp-proxy --no-auth opencode acp
```

---

## Gemini CLI

Google's AI agent with a generous free tier.

```bash
# Install
npm install -g @chrome-acp/proxy-server @google/gemini-cli

# Run
acp-proxy --no-auth gemini -- --experimental-acp
```

**Requirements:** `GOOGLE_API_KEY` or Google Cloud credentials

---

## Qwen Code

Free coding agent using Qwen models (no API key required).

```bash
# Install
npm install -g @chrome-acp/proxy-server @qwen-code/qwen-code@latest

# Run
acp-proxy --no-auth qwen -- --acp
```

---

## Augment Code

AI coding agent by Augment.

```bash
# Install
npm install -g @chrome-acp/proxy-server @augmentcode/auggie

# Run
acp-proxy --no-auth auggie -- --acp
```

---

## Agent Capabilities

Agents can declare their capabilities when creating a session. Chrome ACP supports:

### Image Support

Agents can accept images in prompts:

```typescript
promptCapabilities: {
  image: true  // Enables image attachment button
}
```

When enabled, users can:
- Attach images via button or drag-and-drop
- Paste screenshots from clipboard
- Images are compressed to <2MB and sent as base64

### Model Selection

Agents can expose multiple models:

```typescript
modelState: {
  availableModels: [
    { id: "claude-3-opus", displayName: "Claude 3 Opus" },
    { id: "claude-3-sonnet", displayName: "Claude 3 Sonnet" }
  ],
  currentModelId: "claude-3-sonnet"
}
```

When available, a model selector appears in the chat input footer.

### Extended Thinking

Some agents support "thinking" or "reasoning" modes where they show their thought process:

```typescript
{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "..." } }
```

Thought chunks are displayed in a collapsible "Thinking" section.

---

## Custom Agents

Any ACP-compatible agent works with Chrome ACP:

```bash
acp-proxy --no-auth /path/to/your/agent
```

### Requirements

Your agent must:
1. Accept communication via **stdin/stdout**
2. Implement the **ACP protocol** (NDJSON messages)
3. Handle session lifecycle (`new_session`, `prompt`, etc.)

### Minimal Protocol

```jsonl
← {"request":"new_session","requestId":"1"}
→ {"requestId":"1","sessionId":"abc123","promptCapabilities":{"image":false}}
← {"request":"prompt","requestId":"2","sessionId":"abc123","content":[{"type":"text","text":"Hello"}]}
→ {"requestId":"2","sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi there!"}}
→ {"requestId":"2","promptComplete":{"stopReason":"end_turn"}}
```

### Adding Browser Tools

To use browser tools, your agent must support MCP and connect to:
```
http://localhost:9315/mcp
```

See [Architecture](/reference/architecture/) for MCP protocol details.

---

## Troubleshooting

### Agent doesn't start

```bash
# Test the agent directly
claude-code-acp

# Check if it accepts stdin
echo '{"request":"new_session","requestId":"1"}' | claude-code-acp
```

### Missing API key

```
Error: ANTHROPIC_API_KEY not set
```

Set the required environment variable:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### Agent crashes immediately

Enable debug mode to see detailed logs:
```bash
acp-proxy --debug --no-auth claude-code-acp
```

Check logs in `.acp-proxy/` directory.

