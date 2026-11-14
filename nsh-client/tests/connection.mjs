// Run from any directory: node nsh-client/tests/connection.mjs
// Run pnpm install in nsh-client first.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const android = args.includes("android");
// Like the Rust CLI, reject a wrong path or token with an HTTP status before the upgrade.
const server = new WebSocketServer({ host: "127.0.0.1", port: 19437, verifyClient: ({ req }, done) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/acp") return done(false, 404);
  done(url.searchParams.get("token") !== "invalid", 401);
} });
await once(server, "listening");
let connects = 0;
const timers = new Set();
// A 1×1 PNG.
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
function later(callback, delay) {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
}
const commands = [
  { name: "review", description: "Review changes", input: { hint: "Files to review" } },
  { name: "reset", description: "Reset context" },
];
function configOptions() {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [
      { name: "Provider", group: "provider", options: [
        { value: "fast", name: "Fast" }, { value: "smart", name: "Smart" },
      ] },
    ] },
    { id: "thinking", name: "Thinking", type: "boolean", currentValue: false },
  ];
}
server.on("connection", (socket, request) => {
  const token = new URL(request.url, "http://localhost").searchParams.get("token");
  const options = configOptions();
  const send = (message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  };
  const result = (id, value) => send({ id, result: value });
  const error = (id, message) => send({ id, error: { code: -32603, message } });
  const update = (value) => send({ method: "session/update", params: { sessionId: "test-session", update: value } });
  const text = (sessionUpdate, value, messageId) => update({ sessionUpdate, content: { type: "text", text: value }, ...(messageId ? { messageId } : {}) });
  let cancelled = false;
  let onCancel = null;
  // Permission requests sent to the client, and how each was answered (an option ID, "cancelled", or "error:<code>").
  let requests = 0;
  const waiting = new Map();
  const outcomes = [];
  const permissionOptions = [
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "allow-always", name: "Always Allow", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
  function requestPermission(toolCall, onAnswer = () => {}, options = permissionOptions) {
    const id = `permission-${++requests}`;
    waiting.set(id, (answer) => {
      outcomes.push(answer);
      onAnswer(answer);
    });
    send({ id, method: "session/request_permission", params: { sessionId: "test-session", toolCall, options } });
    return id;
  }
  const tool = (value) => update({ sessionUpdate: "tool_call", ...value });
  const toolUpdate = (value) => update({ sessionUpdate: "tool_call_update", ...value });
  // Scripted turns, chosen by the prompt's text.
  function prompt(message) {
    assert.equal(message.params.sessionId, "test-session");
    assert.equal(message.params.prompt.length, 1);
    assert.equal(message.params.prompt[0].type, "text");
    const input = message.params.prompt[0].text;
    const stop = (stopReason) => result(message.id, { stopReason });
    cancelled = false;
    onCancel = null;
    switch (input) {
      case "hello":
        text("user_message_chunk", input);
        text("agent_thought_chunk", "Considering the **greeting**", "m1");
        later(() => {
          text("agent_message_chunk", "Hello", "m1");
          text("agent_message_chunk", " there, how can I help?", "m1");
          later(() => stop("end_turn"), 300);
        }, 300);
        return;
      case "slow": {
        let index = 0;
        const tick = () => {
          if (cancelled) {
            text("agent_message_chunk", " [late]");
            return stop("cancelled");
          }
          text("agent_message_chunk", `${index++ ? " " : ""}word${index}`);
          later(tick, 150);
        };
        return tick();
      }
      case "refuse":
        text("agent_message_chunk", "Partial answer");
        return later(() => stop("refusal"), 200);
      case "limit":
        text("agent_message_chunk", "Truncated answer");
        return later(() => stop("max_tokens"), 200);
      case "fail":
        return later(() => error(message.id, "Model unavailable"), 200);
      case "read":
        tool({ toolCallId: "read-1", title: "Read `notes.md`", kind: "read", rawInput: { path: "notes.md" } });
        later(() => toolUpdate({ toolCallId: "read-1", status: "in_progress" }), 100);
        later(() => {
          toolUpdate({ toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "First note" } }] });
          text("agent_message_chunk", "Read it.");
          later(() => stop("end_turn"), 100);
        }, 300);
        return;
      case "edit": {
        const toolCallId = `edit-${requests + 1}`;
        tool({ toolCallId, title: "src/app.ts", kind: "edit", locations: [{ path: "src/app.ts" }] });
        requestPermission({ toolCallId }, (answer) => {
          if (answer !== "allow-once" && answer !== "allow-always") {
            text("agent_message_chunk", "Left it unchanged.");
            return later(() => stop("end_turn"), 100);
          }
          toolUpdate({ toolCallId, content: [{
            type: "diff", path: "src/app.ts",
            oldText: "const a = 1;\nconst b = 2;\nconst c = 3;\n", newText: "const a = 1;\nconst b = 20;\nconst c = 3;\n",
          }] });
          later(() => {
            toolUpdate({ toolCallId, status: "completed" });
            text("agent_message_chunk", "Edited it.");
            later(() => stop("end_turn"), 100);
          }, 200);
        });
        return;
      }
      case "run":
        // Waits for a choice until the turn is cancelled.
        // Blank output still leaves the canceled tool call with nothing to show.
        requestPermission({
          toolCallId: "run-1", title: "ls -la", kind: "execute", rawInput: { command: "ls -la" },
          content: [{ type: "content", content: { type: "text", text: " \n" } }],
        });
        onCancel = () => stop("cancelled");
        return;
      case "withdraw": {
        const id = requestPermission({
          toolCallId: "fetch-1", title: "Fetch https://example.com", kind: "fetch",
          content: [{ type: "content", content: { type: "text", text: "Fetching the page" } }],
        });
        later(() => {
          send({ method: "$/cancel_request", params: { requestId: id } });
          later(() => stop("end_turn"), 300);
        }, 500);
        return;
      }
      case "finish":
        // The agent decides on its own while the choice is still open.
        requestPermission({ toolCallId: "think-1", title: "Plan the work", kind: "think" });
        later(() => {
          toolUpdate({ toolCallId: "think-1", status: "completed", rawOutput: "Planned" });
          later(() => stop("end_turn"), 100);
        }, 500);
        return;
      case "busy": {
        // Two requests, then a reply long enough to scroll them out of view.
        let answered = 0;
        const done = () => { if (++answered === 2) later(() => stop("end_turn"), 100); };
        requestPermission({ toolCallId: "search-1", title: "Search for `TODO`", kind: "search" }, done);
        requestPermission({ toolCallId: "search-2", title: "Search for `FIXME`", kind: "search" }, done);
        text("agent_message_chunk", Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n\n"));
        return;
      }
      case "image":
        tool({
          toolCallId: "shot-1", title: "Take a screenshot", status: "completed", rawInput: { page: "home" },
          content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: pixel } }],
        });
        return later(() => stop("end_turn"), 100);
      case "missing":
        toolUpdate({ toolCallId: "ghost", status: "completed" });
        return later(() => stop("end_turn"), 100);
      case "revise": {
        // The same diff slot gets different text after the user had time to collapse it.
        const diff = (newText) => [{ type: "diff", path: "src/app.ts", oldText: "const a = 1;\n", newText }];
        tool({ toolCallId: "revise-1", title: "src/app.ts", kind: "edit", status: "in_progress", content: diff("const a = 2;\n") });
        later(() => {
          toolUpdate({ toolCallId: "revise-1", content: diff("const a = 3;\n") });
          later(() => {
            toolUpdate({ toolCallId: "revise-1", status: "completed" });
            stop("end_turn");
          }, 300);
        }, 1500);
        return;
      }
      case "contents":
        tool({
          toolCallId: "contents-1", title: "Gather files", status: "completed",
          content: [
            { type: "content", content: { type: "resource", resource: { uri: "file:///config.json", mimeType: "application/json", text: "{\"debug\": true}" } } },
            { type: "content", content: { type: "resource", resource: { uri: "file:///archive.zip", mimeType: "application/zip", blob: "UEs=" } } },
            { type: "content", content: { type: "audio", mimeType: "audio/wav", data: "UklGRg==" } },
            { type: "content", content: { type: "image", mimeType: "image/png", data: "not base64!" } },
          ],
        });
        return later(() => stop("end_turn"), 100);
      case "unsupported":
        requestPermission(
          { toolCallId: "odd-1", title: "Odd request", kind: "other" },
          () => later(() => stop("end_turn"), 100),
          [{ optionId: "maybe", name: "Maybe", kind: "maybe" }],
        );
        return;
      case "outcomes":
        text("agent_message_chunk", `Outcomes: ${outcomes.join(", ")}`);
        return later(() => stop("end_turn"), 100);
      default:
        text("agent_message_chunk", `Echo: ${input.replaceAll(" ", "·")}`);
        return later(() => stop("end_turn"), 100);
    }
  }
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    assert.equal(message.jsonrpc, "2.0");
    assert.equal("type" in message, false, "Only JSON-RPC objects are sent");
    if (message.method === undefined) {
      const answer = waiting.get(message.id);
      assert.ok(answer, `Unexpected response ${message.id}`);
      waiting.delete(message.id);
      if (message.error) return answer(`error:${message.error.code}`);
      const outcome = message.result.outcome;
      return answer(outcome.outcome === "selected" ? outcome.optionId : outcome.outcome);
    }
    if (message.method === "session/new") {
      assert.equal(message.params.cwd, "/workspace");
      assert.deepEqual(message.params.mcpServers, []);
      if (token === "session-error") return error(message.id, "Session creation failed");
      result(message.id, {
        sessionId: "test-session",
        ...(token.startsWith("legacy") ? { modes: {
          currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
        } } : token === "empty" ? {} : { configOptions: options }),
      });
      update({ sessionUpdate: "available_commands_update", availableCommands: commands });
      return;
    }
    if (message.method === "session/set_config_option") {
      assert.notEqual(token, "legacy");
      const option = options.find((option) => option.id === message.params.configId);
      assert.ok(option, "Unknown config ID");
      if (typeof message.params.value === "boolean") assert.equal(message.params.type, "boolean");
      if (token === "config-error") return error(message.id, "Configuration rejected");
      if (token === "config-normalized" || token === "config-removed") {
        later(() => {
          options.find((option) => option.id === "thinking").currentValue = true;
          result(message.id, { configOptions: token === "config-removed" ? options.filter((entry) => entry.id !== "model") : options });
        }, 500);
        return;
      }
      if (token === "config-notified-error") {
        later(() => {
          option.currentValue = message.params.value;
          update({ sessionUpdate: "config_option_update", configOptions: options });
        }, 100);
        later(() => error(message.id, "Configuration rejected"), 900);
        return;
      }
      if (token === "config-error-updated") {
        later(() => {
          options.find((option) => option.id === "thinking").currentValue = true;
          update({ sessionUpdate: "config_option_update", configOptions: options });
        }, 100);
        later(() => error(message.id, "Configuration rejected"), 400);
        return;
      }
      later(() => {
        option.currentValue = message.params.value;
        // The RPC response alone is authoritative; no companion notification.
        result(message.id, { configOptions: options });
      }, 1200);
      return;
    }
    if (message.method === "session/set_mode") {
      assert.ok(token.startsWith("legacy"));
      if (token === "legacy-notified") {
        update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
        later(() => result(message.id, {}), 500);
        return;
      }
      return result(message.id, {});
    }
    if (message.method === "session/prompt") return prompt(message);
    if (message.method === "session/cancel") {
      assert.equal(message.id, undefined, "session/cancel is a notification");
      assert.equal(message.params.sessionId, "test-session");
      cancelled = true;
      if (onCancel) later(onCancel, 100);
      onCancel = null;
      return;
    }
    assert.equal(message.method, "initialize", `Unexpected method ${message.method}`);
    assert.equal(message.params.protocolVersion, 1);
    assert.deepEqual(message.params.clientCapabilities.session.configOptions.boolean, {});
    connects++;
    if (token === "pending") return;
    if (token === "not-acp") {
      socket.send(JSON.stringify({ type: "error", payload: { message: "Unknown message type" } }));
      return;
    }
    later(() => {
      if (token === "agent-error") error(message.id, "Agent unavailable");
      else result(message.id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "mock", title: "Mock Agent", version: "1" } });
      if (token === "drop") later(() => socket.close(1011, "Server stopped"), 750);
    }, 1000);
  });
});
let code = 0;
try {
  if (android) {
    const forward = spawnSync("adb", ["reverse", "tcp:19437", "tcp:19437"], { stdio: "inherit" });
    assert.equal(forward.status, 0, "Could not forward the mock server port to Android");
  }
  const files = ["tests/connection.test.tsx", "tests/composer.test.tsx", "tests/thread.test.tsx", "tests/tools.test.tsx"];
  if (!android) files.push("tests/connection-timeout.test.tsx", "tests/optimistic-change.test.tsx");
  for (const file of files) {
    const child = spawn(`${root}.nsh/toolchain/bin/nsh`, ["test", file, ...args], { cwd: root, stdio: "inherit" });
    [code] = await once(child, "exit");
    if (code !== 0) break;
  }
  if (!args.includes("--filter") && code === 0) assert.ok(connects >= 4, "Expected real WebSocket connect handshakes");
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
  if (android) spawnSync("adb", ["reverse", "--remove", "tcp:19437"], { stdio: "inherit" });
}
process.exitCode = code ?? 1;
