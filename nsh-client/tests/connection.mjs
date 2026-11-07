// Run from any directory: node nsh-client/tests/connection.mjs
// Uses the workspace's existing ws dependency; run pnpm install first.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../packages/proxy-server/package.json", import.meta.url));
const { WebSocketServer, WebSocket } = require("ws");
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
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    assert.equal(message.jsonrpc, "2.0");
    assert.equal("type" in message, false, "Legacy proxy envelopes must never be sent");
    if (message.method === "session/new") {
      assert.equal(message.params.cwd, "/workspace");
      assert.deepEqual(message.params.mcpServers, []);
      if (token === "session-error") return error(message.id, "Session creation failed");
      update({ sessionUpdate: "available_commands_update", availableCommands: commands });
      return result(message.id, {
        sessionId: "test-session",
        ...(token.startsWith("legacy") ? { modes: {
          currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
        } } : token === "empty" ? {} : { configOptions: options }),
      });
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
    assert.equal(message.method, "initialize", "Only initialization/configuration is allowed; never send a prompt");
    assert.equal(message.params.protocolVersion, 1);
    assert.deepEqual(message.params.clientCapabilities.session.configOptions.boolean, {});
    connects++;
    if (token === "pending") return;
    if (token === "legacy-proxy") {
      socket.send(JSON.stringify({ type: "error", payload: { message: "Unknown message type" } }));
      return;
    }
    later(() => {
      if (token === "agent-error") error(message.id, "Agent unavailable");
      else result(message.id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "mock", version: "1" } });
      if (token === "drop") later(() => socket.close(1011, "Server stopped"), 750);
    }, 1000);
  });
});
let code = 0;
try {
  if (android) {
    const forward = spawnSync("adb", ["reverse", "tcp:19437", "tcp:19437"], { stdio: "inherit" });
    assert.equal(forward.status, 0, "Could not forward the mock proxy port to Android");
  }
  const files = ["tests/connection.test.tsx", "tests/composer.test.tsx"];
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
