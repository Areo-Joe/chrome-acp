import { expect, open, test, type App } from "nsh/test";
const texts = (app: App) => app.texts().join("\n");
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
async function connect(token = "valid", height = 800) {
  const app = await open("../App.tsx", { width: 420, height, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await ready(app);
  return app;
}
async function send(app: App, value: string, running = false) {
  const wasOpen = app.shows("id:context-title");
  await app.paste("id:message-input", { text: value });
  await app.press("id:send-message");
  if (!running) await app.waitFor("id:send-message");
  if (wasOpen && !app.shows("id:context-title") && app.shows("id:context-usage")) await details(app);
}
async function details(app: App) {
  await app.hover("id:context-usage").catch(() => app.press("id:context-usage"));
  await app.waitFor("id:context-title");
}

test("v1 context is absent until reported, then shows a ring and Context/Cost details", async () => {
  const app = await connect();
  expect(app.shows("id:context-usage")).toBe(false);
  await send(app, "usage");
  await app.waitFor("id:context-ring");
  expect(app.shows("id:context-cost")).toBe(false);
  await details(app);
  expect(texts(app)).toContain("25%");
  expect(texts(app)).toContain("2.5k");
  expect(texts(app)).toContain("10k");
  expect(texts(app)).toContain("Cost");
  expect(texts(app)).toContain("0.12 USD");
  await app.hover("id:send-message").catch(() => app.press("id:context-usage"));
  await app.waitFor("id:context-title", { state: "gone" });
  await app.press("id:disconnect");
}, 60000);

test("context warning starts at 85%; missing, null and invalid cost preserve cumulative cost", async () => {
  const app = await connect();
  await send(app, "usage");
  await send(app, "usage-warning");
  expect(app.shows("id:context-ring-warning")).toBe(true);
  await details(app);
  expect(texts(app)).toContain("85%");
  expect(texts(app)).toContain("0.12 USD");
  for (const value of ["usage-null", "usage-invalid"]) {
    await send(app, value);
    await app.waitFor("id:context-cost");
    expect(texts(app)).toContain("0.12 USD");
    expect(texts(app)).toContain("25%");
  }
  await send(app, "usage-replace");
  expect(texts(app)).toContain("9.00 credits");
  await send(app, "usage-tiny");
  expect(texts(app)).toContain("0.0050 USD");
  await app.press("id:disconnect");
}, 90000);

test("zero capacity reports zero percent; over-capacity values stay visible while the ring fills", async () => {
  const app = await connect();
  await send(app, "usage-zero");
  await details(app);
  expect(texts(app)).toContain("0%");
  expect(texts(app)).toContain("100");
  expect(texts(app)).toContain("0");
  expect(app.shows("id:context-ring-warning")).toBe(false);
  expect(app.shows("id:context-cost")).toBe(false);
  await send(app, "usage-over");
  expect(texts(app)).toContain("200%");
  expect(app.shows("id:context-ring-warning")).toBe(true);
  await app.press("id:disconnect");
}, 60000);

test("ordinary v1 stop, next send and prompt outcomes preserve reported context and cost", async () => {
  const app = await connect();
  await send(app, "usage");
  await send(app, "usage-slow", true);
  await app.waitFor("id:stop-generation");
  await app.press("id:stop-generation");
  await app.waitFor("id:send-message");
  await details(app);
  expect(texts(app)).toContain("0.12 USD");
  for (const value of ["usage-refuse", "usage-limit", "usage-fail", "usage-no-notification"]) {
    await send(app, value);
    expect(texts(app)).toContain("25%");
    expect(texts(app)).toContain("0.12 USD");
  }
  await app.press("id:disconnect");
}, 120000);

test("history replay and background notifications keep usage independent across retained sessions", async () => {
  const app = await connect("history-usage");
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-saved-a");
  await app.press("id:history-open-saved-a");
  await ready(app);
  await details(app);
  expect(texts(app)).toContain("20%");
  expect(texts(app)).toContain("2.00 credits");
  await send(app, "usage-background");
  await app.waitUntil(() => texts(app).includes("Background usage delivered"));
  await app.press("id:show-sessions");
  await app.press("id:open-chat-1");
  await ready(app);
  await details(app);
  expect(texts(app)).toContain("90%");
  expect(texts(app)).toContain("12.00 credits");
  await app.press("id:show-sessions");
  await app.press("id:history-open-saved-a");
  await ready(app);
  await details(app);
  expect(texts(app)).toContain("20%");
  expect(texts(app)).toContain("2.00 credits");
  await app.press("id:disconnect");
}, 90000);

test("failed history replay discards partial usage and retry accepts the new snapshot", async () => {
  const app = await connect("history-usage-load-error");
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-saved-a");
  await app.press("id:history-open-saved-a");
  await app.waitFor("id:session-error");
  expect(app.shows("id:context-usage")).toBe(false);
  await app.press("id:session-retry");
  await ready(app);
  await details(app);
  expect(texts(app)).toContain("20%");
  expect(texts(app)).toContain("2.00 credits");
  expect(texts(app)).not.toContain("99.00 USD");
  await app.press("id:disconnect");
}, 60000);

test("authentication rebuild clears old usage and cost before restored usage arrives", async () => {
  const app = await connect("auth-prompt");
  await send(app, "usage");
  await send(app, "needs-auth");
  await app.waitFor("id:authenticate-thread");
  await app.press("id:authenticate-thread");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  await details(app);
  expect(texts(app)).toContain("0%");
  expect(app.shows("id:context-cost")).toBe(false);
  expect(texts(app)).not.toContain("0.12 USD");
  await app.press("id:disconnect");
}, 60000);

test("evicted sessions rebuild usage from replay rather than retaining old cost", async () => {
  const app = await connect("history-retention-usage", 1200);
  await send(app, "usage-background");
  await app.waitFor("id:context-ring-warning");
  for (let index = 0; index < 6; index++) {
    await app.press("id:new-session");
    await ready(app);
    expect(app.shows("id:context-usage")).toBe(false);
  }
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-new-1");
  expect(app.shows("id:open-chat-1")).toBe(false);
  await app.press("id:history-open-new-1");
  await ready(app);
  await details(app);
  expect(texts(app)).toContain("30%");
  expect(texts(app)).toContain("2.00 credits");
  expect(texts(app)).not.toContain("12.00 credits");
  await app.press("id:disconnect");
}, 90000);

test("desktop context follows hover, changes appearance, and resets without reopening old details", async () => {
  const app = await open("fixtures/usage-state.tsx", { platform: "macos", clock: {} });
  await app.press("id:snapshot");
  await app.hover("id:context-usage");
  await app.waitFor("id:context-title");
  expect(texts(app)).toContain("85%");
  expect(texts(app)).toContain("1.00 credits");
  await app.setColorScheme("dark");
  expect(app.shows("id:context-ring-warning")).toBe(true);
  await app.hover("id:reset");
  await app.waitFor("id:context-title", { state: "gone" });
  await app.press("id:reset");
  expect(app.shows("id:context-usage")).toBe(false);
  await app.press("id:no-cost");
  expect(app.shows("id:context-title")).toBe(false);
  await app.hover("id:context-usage");
  await app.waitFor("id:context-title");
  expect(texts(app)).toContain("0%");
  expect(app.shows("id:context-cost")).toBe(false);
});

test("v1 zero updates retain cost, and disposed threads ignore subsequent usage", async () => {
  const app = await open("fixtures/usage-state.tsx");
  await app.press("id:snapshot");
  await app.press("id:no-cost");
  await details(app);
  expect(texts(app)).toContain("0%");
  expect(texts(app)).toContain("1.00 credits");
  expect(texts(app)).toContain('{"used":0,"size":0,"cost":{"amount":1,"currency":"credits","_meta":{"retained":true}}}');
  await app.press("id:dispose");
  await app.press("id:snapshot");
  if (!app.shows("id:context-title")) await details(app);
  expect(texts(app)).toContain("0%");
  expect(app.shows("id:context-ring-warning")).toBe(false);
  await app.press("id:reset");
  expect(app.shows("id:context-usage")).toBe(false);
  expect(app.shows("id:context-title")).toBe(false);
});
