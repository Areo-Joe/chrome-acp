---
title: Browser Tools
description: Tools the Chrome extension exposes to AI agents.
sidebar:
  order: 2
---

The Chrome extension exposes browser tools to agents via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) using Streamable HTTP transport.

:::note
Browser tools require the Chrome extension. They are not available in the web client.
:::

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_tabs` | List all open tabs (id, url, title, active status) |
| `browser_read` | Read DOM content, viewport info, and selected text |
| `browser_execute` | Execute JavaScript in the page's main world context |

## Usage Flow

A typical workflow for an AI agent:

1. **List tabs** - Call `browser_tabs` to discover available tabs and get their IDs
2. **Read content** - Call `browser_read` with a `tabId` to understand the page
3. **Interact** - Call `browser_execute` with a `tabId` and `script` to interact

---

## browser_tabs

Lists all open browser tabs. Call this first to get tab IDs.

**Parameters:** None

**Returns:**

```json
{
  "tabs": [
    {
      "id": 123456789,
      "url": "https://github.com/Areo-Joe/chrome-acp",
      "title": "GitHub - chrome-acp",
      "active": true
    },
    {
      "id": 987654321,
      "url": "https://docs.example.com",
      "title": "Documentation",
      "active": false
    }
  ]
}
```

---

## browser_read

Reads the DOM content of a tab. Returns a simplified, agent-friendly representation.

**Parameters:**
- `tabId` (number, required) - Tab ID from `browser_tabs`

**Returns:**

```json
{
  "tabId": 123456789,
  "url": "https://example.com/page",
  "title": "Example Page",
  "dom": "<simplified DOM content>",
  "viewport": {
    "width": 1920,
    "height": 1080,
    "scrollX": 0,
    "scrollY": 500
  },
  "selection": "User selected this text"
}
```

### DOM Serialization

The extension uses a custom `collectPageInfo()` function that:

- Extracts semantic HTML structure (headings, links, buttons, forms)
- Removes scripts, styles, and hidden elements
- Preserves interactive elements with their attributes
- Returns a simplified representation optimized for AI understanding

:::tip
The `selection` field contains any text the user has highlighted on the page. This is useful for "explain this" or "what does this mean" workflows.
:::

---

## browser_execute

Executes JavaScript in the page's **main world** context, giving access to the page's JavaScript environment.

**Parameters:**
- `tabId` (number, required) - Tab ID from `browser_tabs`
- `script` (string, required) - JavaScript code to execute

### Execution Model

Your script runs as:
```javascript
(new Function(script))()
```

The **last expression** or explicit `return` statement becomes the tool result.

### Return Value Pattern

Always return structured results:

```javascript
// Good - clear success/failure indication
const btn = document.querySelector('button.submit');
if (!btn) return { success: false, reason: 'Button not found' };
btn.click();
return { success: true, clicked: btn.textContent };

// Bad - no return value
document.querySelector('button').click();
// Result: undefined
```

### Event Handling for Modern Frameworks

Standard DOM methods like `element.click()` or `input.value = 'text'` often **don't work** with React, Vue, or Angular because these frameworks use synthetic event systems.

#### Clicking Elements

```javascript
// Won't trigger React/Vue event handlers
element.click();

// Proper way - dispatch a real MouseEvent
element.dispatchEvent(new MouseEvent('click', {
  bubbles: true,
  cancelable: true,
  view: window
}));
```

#### Setting Input Values

```javascript
// Won't update React state
input.value = 'Hello';

// Proper way - set value AND dispatch events
input.value = 'Hello';
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

#### Submitting Forms

```javascript
// Bypasses validation and framework handlers
form.submit();

// Proper way - dispatch SubmitEvent
form.dispatchEvent(new SubmitEvent('submit', {
  bubbles: true,
  cancelable: true
}));
```

#### Hover Effects

```javascript
element.dispatchEvent(new MouseEvent('mouseenter', {
  bubbles: true,
  view: window
}));
```

#### Keyboard Events

```javascript
element.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'Enter',
  bubbles: true
}));
```

:::caution[Important]
Always use `dispatchEvent` with `{ bubbles: true }` for framework compatibility.
:::

### Example Script

A complete example that fills a form and submits it:

```javascript
// Find form elements
const emailInput = document.querySelector('input[type="email"]');
const passwordInput = document.querySelector('input[type="password"]');
const submitBtn = document.querySelector('button[type="submit"]');

if (!emailInput || !passwordInput) {
  return { success: false, reason: 'Form fields not found' };
}

// Fill email (React-compatible)
emailInput.value = 'user@example.com';
emailInput.dispatchEvent(new Event('input', { bubbles: true }));

// Fill password (React-compatible)
passwordInput.value = 'secretpassword';
passwordInput.dispatchEvent(new Event('input', { bubbles: true }));

// Click submit button
submitBtn.dispatchEvent(new MouseEvent('click', {
  bubbles: true,
  cancelable: true,
  view: window
}));

return {
  success: true,
  filledFields: ['email', 'password'],
  clickedButton: submitBtn.textContent
};
```

---

## Security Considerations

- Scripts execute in the **main world** (same context as the page's JavaScript)
- The agent has full access to page variables, cookies, localStorage
- Be cautious when allowing execution on sensitive pages (banking, email, etc.)
- The extension only exposes tools when connected to a proxy server

## Chrome Permissions

The extension requires these permissions in `manifest.json`:

| Permission | Purpose |
|------------|---------|
| `tabs` | List and access browser tab information |
| `scripting` | Execute JavaScript in tab contexts |
| `activeTab` | Access the currently active tab |
| `sidePanel` | Show the chat UI in Chrome's side panel |
| `declarativeNetRequest` | Strip Content-Security-Policy headers for script execution |

