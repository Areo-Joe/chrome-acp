import { expect, open, test, type App } from "nsh/test";
const text = (app: App) => app.texts().join("\n");
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
async function connect(token = "history-retention", failed = false) {
  const app = await open("../App.tsx", { width: 420, height: 1800, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  if (failed) await app.waitFor("id:session-error");
  else await ready(app);
  return app;
}
async function add(app: App, count: number) {
  for (let index = 0; index < count; index++) {
    await app.press("id:new-session");
    await ready(app);
  }
}
async function history(app: App) {
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-saved-a");
}
async function send(app: App, message: string) {
  await app.type("id:message-input", message);
  await app.press("id:send-message");
}

for (const token of ["history-retention", "history-retention-error", "history-retention-no-close", "history-retention-blocked"]) {
  test(`${token}: retain five idle background views and reopen an evicted ID after release`, async () => {
    const app = await connect(token);
    await add(app, 6);
    await history(app);
    expect(app.shows("id:open-chat-1")).toBe(false);
    for (let key = 2; key <= 7; key++) expect(app.shows(`id:open-chat-${key}`)).toBe(true);
    await app.waitFor("id:history-open-new-1");
    await app.press("id:history-open-new-1");
    await ready(app);
    expect(text(app)).toContain("History of New 1");
    expect(text(app)).not.toContain("Old closing output");
    expect(text(app)).not.toContain("Old output after close response");
    await send(app, "stats");
    await app.waitUntil(() => text(app).includes("New: 7; Loads: 1; Auth: 0"));
    await app.press("id:disconnect");
  });
}

test("resume-only agents retain idle owners because history cannot be replayed", async () => {
  const app = await connect("history-retention-resume");
  await add(app, 7);
  await history(app);
  for (let key = 1; key <= 8; key++) expect(app.shows(`id:open-chat-${key}`)).toBe(true);
  await app.press("id:open-chat-1");
  expect(app.shows("id:session-resumed")).toBe(false);
  await send(app, "stats");
  await app.waitUntil(() => text(app).includes("New: 8; Loads: 0; Auth: 0"));
  await app.press("id:disconnect");
});

test("ordinary drafts survive view eviction and reopen without being sent", async () => {
  const app = await connect();
  await app.type("id:message-input", "saved draft\nwith trailing space ");
  await add(app, 6);
  await history(app);
  expect(app.shows("id:open-chat-1")).toBe(false);
  await app.press("id:history-open-new-1");
  await ready(app);
  expect(app.value("id:message-input")).toBe("saved draft\nwith trailing space ");
  expect(text(app)).not.toContain("Reply in new-1");
  await app.clear("id:message-input");
  await send(app, "stats");
  await app.waitUntil(() => text(app).includes("New: 7; Loads: 1; Auth: 0"));
  await app.press("id:disconnect");
});

test("retention follows local conversation activity rather than session creation or server timestamps", async () => {
  const app = await connect();
  await add(app, 5);
  await history(app);
  await app.press("id:open-chat-1");
  await send(app, "recent activity");
  await app.waitUntil(() => text(app).includes("Reply in new-1: recent activity"));
  await app.waitFor("id:stop-generation", { state: "gone" });
  await add(app, 1);
  await history(app);
  expect(app.shows("id:open-chat-1")).toBe(true);
  expect(app.shows("id:open-chat-2")).toBe(false);
  await app.press("id:disconnect");
});

test("running turns stay retained and completing a background turn triggers cleanup", async () => {
  const app = await connect();
  await send(app, "slow");
  await app.waitUntil(() => text(app).includes("Working in the background"));
  await add(app, 6);
  await history(app);
  expect(app.shows("id:open-chat-1")).toBe(true);
  expect(app.shows("id:open-chat-2")).toBe(true);
  await app.waitUntil(() => !app.shows("id:open-chat-2"));
  expect(app.shows("id:open-chat-1")).toBe(true);
  await app.press("id:open-chat-1");
  expect(text(app)).toContain("Background complete");
  await send(app, "stats");
  await app.waitUntil(() => text(app).includes("New: 7; Loads: 0; Auth: 0"));
  await app.press("id:disconnect");
});

test("a pending permission keeps an otherwise idle background owner alive", async () => {
  const app = await connect();
  await send(app, "idle-permission");
  await app.waitFor("id:permission-options");
  await app.waitFor("id:stop-generation", { state: "gone" });
  await add(app, 6);
  await history(app);
  expect(app.shows("id:open-chat-1")).toBe(true);
  expect(app.shows("id:open-chat-2")).toBe(true);
  await app.press("id:open-chat-1");
  await app.press("id:permission-allow-once");
  await app.waitUntil(() => text(app).includes("Permission complete"));
  await app.press("id:disconnect");
});

test("Stop keeps an unsettled prompt owner until its RPC has actually finished", async () => {
  const app = await connect();
  await send(app, "slow");
  await app.waitUntil(() => text(app).includes("Working in the background"));
  await app.press("id:stop-generation");
  await app.waitFor("id:stop-generation", { state: "gone" });
  await add(app, 6);
  await history(app);
  expect(app.shows("id:open-chat-1")).toBe(true);
  expect(app.shows("id:open-chat-2")).toBe(true);
  await app.waitUntil(() => !app.shows("id:open-chat-2"));
  expect(app.shows("id:open-chat-1")).toBe(true);
  await app.press("id:disconnect");
});

test("a zero idle limit releases all background owners and preserves their drafts for reopening", async () => {
  const app = await open("./fixtures/retention-zero.tsx", { width: 420, height: 800, network: "live" });
  await ready(app);
  expect(text(app)).toContain("Owners: 1");
  await app.type("id:message-input", "saved with a zero limit");
  await app.press("id:new");
  await ready(app);
  expect(text(app)).toContain("Owners: 2");
  await app.press("id:restore-new-1");
  await ready(app);
  expect(text(app)).toContain("Owners: 3");
  expect(app.value("id:message-input")).toBe("saved with a zero limit");
});

test("settling an inactive permission refreshes its local activity before idle cleanup", async () => {
  const app = await connect();
  await send(app, "idle-permission-withdraw");
  await app.waitFor("id:permission-options");
  await app.waitFor("id:stop-generation", { state: "gone" });
  await add(app, 6);
  await history(app);
  expect(app.shows("id:open-chat-1")).toBe(true);
  expect(app.shows("id:open-chat-2")).toBe(true);
  await app.press("id:history-back");
  await send(app, "withdraw-permission");
  await app.waitFor("id:stop-generation", { state: "gone" });
  await history(app);
  await app.waitUntil(() => !app.shows("id:open-chat-2"));
  expect(app.shows("id:open-chat-1")).toBe(true);
  await app.press("id:disconnect");
});

test("an evicted known session remains reopenable without an agent list capability", async () => {
  const app = await connect("history-retention-no-list");
  await add(app, 6);
  await app.press("id:show-sessions");
  await app.waitFor("id:history-unsupported");
  expect(app.shows("id:open-chat-1")).toBe(false);
  await app.waitFor("id:history-open-new-1");
  await app.press("id:history-open-new-1");
  await ready(app);
  expect(text(app)).toContain("History of New 1");
  await app.press("id:disconnect");
});

for (const token of ["session-error", "history-failed-load", "history-failed-resume"]) {
  test(`${token}: failed views without an established thread obey the idle limit`, async () => {
    const app = await connect(token, true);
    for (let index = 0; index < 6; index++) {
      await app.press("id:new-session");
      await app.waitFor("id:session-error");
    }
    await app.press("id:show-sessions");
    expect(app.shows("id:open-chat-1")).toBe(false);
    for (let key = 2; key <= 7; key++) expect(app.shows(`id:open-chat-${key}`)).toBe(true);
    await app.press("id:disconnect");
  });
}

test("unowned saved input protects a failed view even without a session ID or load capability", async () => {
  const app = await connect("session-error", true);
  await app.type("id:message-input", "unsent input before a session exists");
  for (let index = 0; index < 7; index++) {
    await app.press("id:new-session");
    await app.waitFor("id:session-error");
  }
  await app.press("id:show-sessions");
  expect(app.shows("id:open-chat-1")).toBe(true);
  expect(app.shows("id:open-chat-2")).toBe(false);
  await app.press("id:open-chat-1");
  expect(app.value("id:message-input")).toBe("unsent input before a session exists");
  await app.press("id:disconnect");
});

test("reclaiming a pending new view closes its eventual session without changing the current view", async () => {
  const app = await open("./fixtures/retention-zero.tsx", { width: 420, height: 800, network: "live" });
  await app.waitFor("id:session-loading");
  await app.press("id:new");
  await ready(app);
  expect(text(app)).toContain("Owners: 2");
  await app.type("id:message-input", "draft of the current view");
  await app.wait(1300);
  expect(text(app)).toContain("Owners: 2");
  expect(app.value("id:message-input")).toBe("draft of the current view");
  expect(text(app)).not.toContain("Old closing output");
});

test("reclaiming a pending load waits for replay and close before another view opens the ID", async () => {
  const app = await open("./fixtures/retention-zero.tsx", { width: 420, height: 800, network: "live" });
  await ready(app);
  await app.press("id:new");
  await ready(app);
  await app.press("id:restore-new-1");
  await app.waitUntil(() => text(app).includes("Pending history start"));
  await app.press("id:new");
  await ready(app);
  expect(text(app)).toContain("Owners: 4");
  await app.press("id:restore-new-1");
  await ready(app);
  expect(text(app)).toContain("Owners: 5");
  expect(text(app).split("History of New 1").length - 1).toBe(1);
  expect(text(app)).not.toContain("Pending history start");
  expect(text(app)).not.toContain("Old closing output");
});
