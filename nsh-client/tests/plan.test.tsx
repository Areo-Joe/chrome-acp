import { expect, open, test, type App } from "nsh/test";
const texts = (app: App) => app.texts().join("\n");
async function connect(token = "valid") {
  const app = await open("../App.tsx", { width: 420, height: 800, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await ready(app);
  return app;
}
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
async function send(app: App, value: string, running = false) {
  // Paste literal mock commands so native spelling corrections cannot change them.
  await app.paste("id:message-input", { text: value });
  await app.press("id:send-message");
  if (!running) await app.waitFor("id:send-message");
}

test("ordinary plan starts collapsed, shows the first active task, and keeps wire order", async () => {
  const app = await connect();
  expect(app.shows("id:plan")).toBe(false);
  await send(app, "plan");
  await app.waitFor("id:plan");
  expect(texts(app)).toContain("Current:");
  expect(texts(app)).toContain("Implement");
  expect(texts(app)).toContain("3 left");
  expect(app.shows("id:plan-entries")).toBe(false);
  await app.press("id:plan-toggle");
  expect(texts(app)).toContain("1/4");
  await app.waitUntil(() => texts(app).includes("Verify behavior"));
  expect(texts(app).indexOf("Read")).toBeLessThan(texts(app).indexOf("Verify behavior"));
  expect(app.shows("id:plan-entry-3")).toBe(true);
  expect(app.shows("id:plan-pending-2")).toBe(true);
  await app.press("id:plan-toggle");
  expect(app.shows("id:plan-entries")).toBe(false);
  expect(texts(app)).toContain("3 left");
  await app.press("id:disconnect");
}, 60000);

test("dismiss only hides; identical notifications re-show with expansion preserved; snapshots replace", async () => {
  const app = await connect();
  await send(app, "plan");
  await app.press("id:plan-toggle");
  await app.press("id:dismiss-plan");
  expect(app.shows("id:plan")).toBe(false);
  await send(app, "plan");
  await app.waitFor("id:plan-entries");
  expect(texts(app)).toContain("1/4");
  await send(app, "plan-replace");
  expect(texts(app)).toContain("Replacement");
  expect(texts(app)).toContain("1 Tasks");
  expect(texts(app)).not.toContain("Verify behavior");
  expect(app.shows("id:plan-entry-1")).toBe(false);
  await send(app, "plan-empty");
  expect(app.shows("id:plan")).toBe(false);
  await send(app, "plan-pending");
  await app.waitFor("id:plan-entries");
  expect(texts(app)).toContain("4 Tasks");
  await app.press("id:disconnect");
}, 60000);

test("completion persists until the next prompt removes only completed items", async () => {
  const app = await connect();
  await send(app, "plan");
  await app.press("id:plan-toggle");
  await send(app, "after");
  expect(texts(app)).toContain("3 Tasks");
  expect(texts(app)).not.toContain("Read");
  expect(texts(app)).toContain("Verify behavior");
  await send(app, "plan-done");
  expect(texts(app)).toContain("All Done");
  await send(app, "after");
  expect(app.shows("id:plan")).toBe(false);
  await app.press("id:disconnect");
}, 60000);

test("stop, refusal, output limit and prompt error retain the most recent plan", async () => {
  const app = await connect();
  await send(app, "plan-slow", true);
  await app.waitFor("id:plan");
  await app.press("id:plan-toggle");
  await app.press("id:stop-generation");
  await app.waitFor("id:send-message");
  expect(texts(app)).toContain("1/4");
  for (const value of ["plan-refuse", "plan-limit", "plan-fail"]) {
    await send(app, value);
    await app.waitFor("id:thread-error");
    expect(texts(app)).toContain("1/4");
    expect(app.shows("id:plan-entry-3")).toBe(true);
  }
  await app.press("id:disconnect");
}, 60000);

test("v1 history replays plans and retains expansion and dismissal independently per conversation", async () => {
  const app = await connect("history-plan");
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-saved-a");
  await app.press("id:history-open-saved-a");
  await ready(app);
  await app.waitFor("id:plan");
  expect(texts(app)).toContain("Plan for saved-a");
  await app.press("id:plan-toggle");
  await send(app, "plan-background");
  await app.waitUntil(() => texts(app).includes("Background plan delivered"));
  await app.press("id:show-sessions");
  await app.press("id:open-chat-1");
  await ready(app);
  expect(texts(app)).toContain("1 Tasks");
  expect(app.shows("id:plan-entries")).toBe(false);
  await app.press("id:dismiss-plan");
  await app.press("id:show-sessions");
  await app.press("id:history-open-saved-a");
  await ready(app);
  expect(app.shows("id:plan-entries")).toBe(true);
  expect(texts(app)).toContain("Plan for saved-a");
  await app.press("id:show-sessions");
  await app.press("id:open-chat-1");
  await ready(app);
  expect(app.shows("id:plan")).toBe(false);
  await app.press("id:disconnect");
}, 60000);

test("successful authentication rebuilds plan view state and accepts restored plan replay", async () => {
  const app = await connect("auth-prompt");
  await send(app, "plan");
  await app.press("id:plan-toggle");
  await send(app, "needs-auth");
  await app.waitFor("id:thread-error");
  await app.press("id:authenticate-thread");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  await app.waitFor("id:plan");
  expect(app.shows("id:plan-entries")).toBe(false);
  expect(texts(app)).toContain("1 Tasks");
  await app.press("id:plan-toggle");
  await app.waitUntil(() => texts(app).includes("Restored plan"));
  expect(texts(app)).not.toContain("Verify behavior");
  await app.press("id:disconnect");
}, 60000);

const state = (app: App) => JSON.parse(app.texts().find(text => text.startsWith('{"plan":'))!);

test("plan metadata is replaced with each snapshot and survives completed-entry cleanup while hidden", async () => {
  const app = await open("fixtures/plan-state.tsx");
  await app.press("id:snapshot");
  await app.press("id:expand");
  await app.press("id:dismiss");
  await app.press("id:send");
  expect(state(app).visible).toBe(false);
  expect(state(app).expanded).toBe(true);
  expect(JSON.stringify(state(app).plan)).toBe(JSON.stringify({ entries: [
    { content: "Active", priority: "high", status: "in_progress", _meta: { entry: [2] } },
  ], _meta: { plan: [true, null] } }));
  await app.press("id:replacement");
  expect(state(app).visible).toBe(true);
  expect(state(app).plan._meta).toBe(undefined);
  expect(state(app).plan.entries[0]._meta).toBe(undefined);
  await app.press("id:reset");
  expect(state(app).plan).toBe(null);
  expect(state(app).visible).toBe(false);
  expect(state(app).expanded).toBe(false);
}, 60000);

test("synchronous cancellation failure leaves completed plan entries intact", async () => {
  const app = await open("fixtures/plan-state.tsx");
  await app.press("id:send");
  await app.waitUntil(() => state(app).calls === 1);
  await app.press("id:snapshot");
  await app.press("id:sync-failure");
  await app.press("id:send");
  expect(state(app).plan.entries.length).toBe(2);
  expect(texts(app)).toContain("Synchronous cancellation failure");
  expect(state(app).calls).toBe(1);
}, 60000);

test("next send clears completed items before cancellation finishes, including asynchronous failure", async () => {
  const app = await open("fixtures/plan-state.tsx");
  await app.press("id:send");
  await app.waitUntil(() => state(app).calls === 1);
  await app.press("id:snapshot");
  await app.press("id:async-failure");
  await app.press("id:send");
  expect(state(app).plan.entries.length).toBe(1);
  expect(state(app).plan.entries[0].content).toBe("Active");
  expect(state(app).calls).toBe(1);
  await app.press("id:finish-cancellation");
  await app.waitUntil(() => state(app).generating === false);
  expect(state(app).plan.entries.length).toBe(1);
  expect(state(app).calls).toBe(1);
}, 60000);

test("released threads ignore subsequent plan notifications", async () => {
  const app = await open("fixtures/plan-state.tsx");
  await app.press("id:snapshot");
  await app.press("id:dispose");
  await app.press("id:replacement");
  expect(state(app).plan.entries.length).toBe(2);
  expect(state(app).plan.entries[0].content).toBe("Done");
}, 60000);
