import { expect, open, test } from "nsh/test";

async function chat(token = "valid") {
  const app = await open("../App.tsx", { width: 360, height: 640, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
  return app;
}

async function send(app: Awaited<ReturnType<typeof chat>>, text: string) {
  await app.type("id:message-input", text);
  await app.press("id:send-message");
}

const joined = (app: Awaited<ReturnType<typeof chat>>) => app.texts().join("\n");

test("a sent message streams the reply, its thought, and ends the turn", async () => {
  const app = await chat();
  await send(app, "hello \n");
  expect(app.value("id:message-input")).toBe("");
  expect(app.shows("id:stop-generation")).toBe(true);
  expect(app.shows("id:generating")).toBe(true);
  // The echoed prompt does not show a second user message.
  await app.waitFor("text:Thinking");
  expect(app.texts().filter((text) => text === "hello")).toHaveLength(1);
  // The streaming thought is open; it closes once the reply starts.
  await app.waitUntil(() => joined(app).includes("Considering the greeting"));
  await app.waitUntil(() => joined(app).includes("Hello there, how can I help?"));
  await app.waitUntil(() => !joined(app).includes("Considering the greeting"));
  await app.waitFor("id:send-message");
  expect(app.shows("id:generating")).toBe(false);
  expect(app.shows("id:thread-error")).toBe(false);
  // The user can reopen a closed thought.
  await app.press("id:thought-toggle");
  await app.waitUntil(() => joined(app).includes("Considering the greeting"));
  // Zed build_chunks_from_creases trims the outer leading/trailing whitespace.
  await send(app, "  again");
  await app.waitUntil(() => joined(app).includes("Echo: again"));
  await app.press("id:disconnect");
});

test("stop ends the turn at once and keeps what streamed", async () => {
  const app = await chat();
  await send(app, "slow");
  await app.waitUntil(() => joined(app).includes("word2"));
  await app.press("id:stop-generation");
  expect(app.shows("id:send-message")).toBe(true);
  expect(app.shows("id:generating")).toBe(false);
  // Updates the agent sends before it answers `cancelled` still arrive.
  await app.waitUntil(() => joined(app).includes("[late]"));
  expect(app.shows("id:thread-error")).toBe(false);
  await send(app, "after");
  await app.waitUntil(() => joined(app).includes("Echo: after"));
  await app.press("id:disconnect");
});

test("a refusal removes the refused turn and explains it", async () => {
  const app = await chat();
  await send(app, "refuse");
  await app.waitFor("id:thread-error");
  expect(app.texts()).toContain("Request Refused");
  expect(joined(app)).toContain("Mock Agent refused to respond to this prompt.");
  expect(app.shows("id:copy-thread-error")).toBe(true);
  expect(app.texts()).not.toContain("refuse");
  expect(joined(app)).not.toContain("Partial answer");
  await app.press("id:dismiss-thread-error");
  expect(app.shows("id:thread-error")).toBe(false);
  await app.press("id:disconnect");
});

test("the output limit and failed prompts show an error and keep the turn", async () => {
  const app = await chat();
  await send(app, "limit");
  await app.waitFor("id:thread-error");
  expect(app.texts()).toContain("Output Limit Reached");
  expect(joined(app)).toContain("Truncated answer");
  expect(app.shows("id:copy-thread-error")).toBe(false);
  await send(app, "fail");
  await app.waitUntil(() => joined(app).includes("Model unavailable"));
  expect(app.texts()).toContain("An Error Happened");
  expect(app.shows("id:copy-thread-error")).toBe(true);
  expect(app.texts()).toContain("fail");
  expect(app.shows("id:send-message")).toBe(true);
  await app.press("id:disconnect");
});
