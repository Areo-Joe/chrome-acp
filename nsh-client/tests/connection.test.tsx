import { expect, open, test } from "nsh/test";

const ADDRESS = "ws://127.0.0.1:19437";

async function form(token: string) {
  const app = await open("../App.tsx", { network: "live" });
  await app.type("id:ws-address", ADDRESS);
  await app.type("id:token", token);
  expect(app.value("id:ws-address")).toBe(ADDRESS);
  expect(app.value("id:token")).toBe(token);
  return app;
}

test("invalid addresses keep Connect disabled", async () => {
  const app = await open("../App.tsx");
  expect(app.enabled("id:connect")).toBe(false);
  await app.type("id:ws-address", "https://example.com");
  expect(app.enabled("id:connect")).toBe(false);
  expect(app.texts()).toContain("Enter a valid ws:// or wss:// address.");
});

test("waits for agent status, prevents duplicate connects, and disconnects", async () => {
  const app = await form("valid");
  await app.press("id:connect");
  expect(app.enabled("id:connect")).toBe(false);
  expect(app.enabled("id:ws-address")).toBe(false);
  expect(app.texts()).toContain("Connecting…");
  await app.waitFor("text:Disconnect");
  expect(app.texts()).toContain("Connected");
  expect(app.enabled("id:connect")).toBe(false);
  await app.press("id:disconnect");
  expect(app.texts()).toContain("Disconnected");
  expect(app.enabled("id:connect")).toBe(true);
  expect(app.enabled("id:ws-address")).toBe(true);
});

test("authentication failure stays visible and permits retry", async () => {
  const app = await form("invalid");
  await app.press("id:connect");
  await app.waitFor("id:connection-error");
  expect(app.texts()).toContain("Unauthorized: Invalid token");
  expect(app.enabled("id:connect")).toBe(true);
  await app.clear("id:token");
  await app.type("id:token", "valid");
  await app.press("id:connect");
  await app.waitFor("text:Disconnect");
  expect(app.shows("id:connection-error")).toBe(false);
  await app.press("id:disconnect");
});

test("agent initialization failure releases the form", async () => {
  const app = await form("agent-error");
  await app.press("id:connect");
  await app.waitFor("id:connection-error");
  expect(app.texts()).toContain("Agent unavailable");
  expect(app.enabled("id:connect")).toBe(true);
});

test("server disconnect returns the page to Disconnected", async () => {
  const app = await form("drop");
  await app.press("id:connect");
  await app.waitFor("text:Disconnect");
  await app.waitFor("text:Disconnected");
  expect(app.enabled("id:connect")).toBe(true);
});

test("cancel closes the pending attempt and allows a new connection", async () => {
  const app = await form("pending");
  await app.press("id:connect");
  await app.waitFor("text:Cancel");
  await app.press("id:disconnect");
  expect(app.texts()).toContain("Disconnected");
  await app.clear("id:token");
  await app.type("id:token", "valid");
  await app.press("id:connect");
  await app.waitFor("text:Disconnect");
  await app.press("id:disconnect");
});
