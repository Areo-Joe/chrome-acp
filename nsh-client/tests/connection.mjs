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
server.on("connection", (socket, request) => {
  const url = new URL(request.url, "http://localhost");
  assert.equal(url.pathname, "/ws");
  const token = url.searchParams.get("token");
  if (token === "invalid") return socket.close(4001, "Unauthorized: Invalid token");
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "ping") return socket.send(JSON.stringify({ type: "pong" }));
    if (message.type === "disconnect") return socket.close();
    assert.equal(message.type, "connect");
    connects++;
    if (token === "pending") return;
    later(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(token === "agent-error"
        ? { type: "error", payload: { message: "Agent unavailable" } }
        : { type: "status", payload: { connected: true } }));
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
  const files = android
    ? ["tests/connection.test.tsx"]
    : ["tests/connection.test.tsx", "tests/connection-timeout.test.tsx"];
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
