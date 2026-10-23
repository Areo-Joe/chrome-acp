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
const server = new WebSocketServer({ host: "127.0.0.1", port: 19437 });
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
  const url = new URL(request.url, "http://localhost");
  assert.equal(url.pathname, "/ws");
  const token = url.searchParams.get("token");
  if (token === "invalid") return socket.close(4001, "Unauthorized: Invalid token");
  const options = configOptions();
  const send = (type, payload) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, payload }));
  };
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "ping") return send("pong");
    if (message.type === "disconnect") return socket.close();
    if (message.type === "new_session") {
      if (token === "session-error") return send("error", { message: "Session creation failed" });
      // Exercise commands arriving before the session/new response, as real agents do.
      send("session_update", { sessionId: "test-session", update: {
        sessionUpdate: "available_commands_update", availableCommands: commands,
      } });
      return send("session_created", {
        sessionId: "test-session",
        ...(token === "legacy" ? { modes: {
          currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }],
        } } : token === "empty" ? {} : { configOptions: options }),
      });
    }
    if (message.type === "set_config_option") {
      assert.notEqual(token, "legacy");
      const option = options.find((option) => option.id === message.payload.configId);
      assert.ok(option, "Unknown config ID");
      if (token === "config-error") return send("error", { message: "Configuration rejected" });
      later(() => {
        option.currentValue = message.payload.value;
        send("config_options_changed", { configOptions: options });
      }, 1200);
      return;
    }
    if (message.type === "set_session_mode") {
      assert.equal(token, "legacy");
      return send("mode_changed", { modeId: message.payload.modeId });
    }
    assert.equal(message.type, "connect", "Only initialization/configuration is allowed; never send a prompt");
    connects++;
    if (token === "pending") return;
    later(() => {
      if (token === "agent-error") send("error", { message: "Agent unavailable" });
      else send("status", { connected: true });
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
  if (!android) files.push("tests/connection-timeout.test.tsx");
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
