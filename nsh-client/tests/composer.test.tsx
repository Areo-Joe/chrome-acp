import { expect, open, test } from "nsh/test";

async function chat(token = "valid") {
  const app = await open("../App.tsx", { network: "live" });
  await app.type("id:ws-address", "ws://127.0.0.1:19437");
  await app.type("id:token", token);
  await app.press("id:connect");
  await app.waitFor("id:message-input");
  return app;
}

test("drafts support multiline and advertised slash commands without sending", async () => {
  const app = await chat();
  await app.waitFor("id:config-model");
  await app.type("id:message-input", "/re");
  await app.waitFor("id:command-review");
  expect(app.shows("id:command-reset")).toBe(true);
  await app.press("id:command-review");
  expect(app.value("id:message-input")).toBe("/review ");
  expect(app.texts()).toContain("Files to review");
  await app.type("id:message-input", "src\nSecond line");
  expect(app.value("id:message-input")).toBe("/review src\nSecond line");
  expect(app.shows("id:command-review")).toBe(false);
  expect(app.enabled("id:send-message")).toBe(false);
  await app.press("id:disconnect");
  expect(app.value("id:token")).toBe("valid");
});

test("configuration selectors wait for agent confirmation", async () => {
  const app = await chat();
  await app.waitFor("id:config-model");
  await app.press("id:config-model");
  await app.waitFor("id:choice-model-smart");
  await app.press("id:choice-model-smart");
  expect(app.texts()).toContain("Updating…");
  expect(app.enabled("id:config-thinking")).toBe(false);
  await app.waitUntil(() => app.enabled("id:config-model"));
  expect(app.texts()).toContain("Smart");
  await app.press("id:config-thinking");
  await app.waitFor("id:choice-thinking-true");
  await app.press("id:choice-thinking-true");
  await app.waitUntil(() => app.enabled("id:config-thinking") && !app.shows("id:choice-thinking-true"));
  expect(app.texts()).toContain("On");
  await app.press("id:disconnect");
});

test("agents without config options can expose the legacy mode selector", async () => {
  const app = await chat("legacy");
  await app.waitFor("id:config-legacy-mode");
  expect(app.shows("id:config-model")).toBe(false);
  await app.press("id:config-legacy-mode");
  await app.waitFor("id:choice-legacy-mode-code");
  await app.press("id:choice-legacy-mode-code");
  await app.waitFor("text:Code");
  await app.press("id:disconnect");
});

test("agents without selectors still allow a draft", async () => {
  const app = await chat("empty");
  await app.waitFor("id:session-loading", { state: "gone" });
  expect(app.shows("id:config-model")).toBe(false);
  expect(app.shows("id:config-legacy-mode")).toBe(false);
  await app.type("id:message-input", "Hello");
  expect(app.value("id:message-input")).toBe("Hello");
  expect(app.enabled("id:send-message")).toBe(false);
  await app.back();
  expect(app.enabled("id:connect")).toBe(true);
});

test("session errors stay on Chat and allow disconnect", async () => {
  const app = await chat("session-error");
  await app.waitFor("id:session-error");
  expect(app.texts()).toContain("Session creation failed");
  expect(app.shows("id:chat-page")).toBe(true);
  expect(app.enabled("id:send-message")).toBe(false);
  await app.press("id:disconnect");
  expect(app.enabled("id:connect")).toBe(true);
});

test("rejected configuration retains the confirmed value and connection", async () => {
  const app = await chat("config-error");
  await app.waitFor("id:config-model");
  await app.press("id:config-model");
  await app.press("id:choice-model-smart");
  await app.waitFor("id:session-error");
  expect(app.texts()).toContain("Configuration rejected");
  expect(app.texts()).toContain("Fast");
  expect(app.enabled("id:config-model")).toBe(true);
  await app.press("id:disconnect");
});
