import { expect, open, test, type App } from "nsh/test";
const texts = (app: App) => app.texts().join("\n");
type Stats = { prompts: { sessionId: string; text: string }[]; cancels: string[]; pending: string[] };
let controls = 0;
async function control(app: App, token: string, reason?: string, id = "test-session"): Promise<Stats> {
  const request = ++controls;
  await app.host.send("queue-control", { request, token, reason, id });
  const find = () => {
    const text = app.texts().find(text => text.startsWith("QUEUE_CONTROL:"));
    return text ? JSON.parse(text.slice("QUEUE_CONTROL:".length)) as { request: number; data?: Stats; error?: string } : undefined;
  };
  await app.waitUntil(() => find()?.request === request);
  const result = find()!;
  await app.host.send("queue-control-clear");
  if (result.error) throw new Error(result.error);
  return result.data!;
}
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
async function connect(token = "queue-test", desktop = false, height = 900) {
  const app = await open("../QueueTestApp.tsx", { width: 420, height, network: "live", clock: {}, clipboard: "PASTED", host: { params: { queueMockUrl: "http://127.0.0.1:19437" } }, ...(desktop ? { platform: "macos" as const } : {}) });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await ready(app);
  return app;
}
async function send(app: App, value: string) {
  await app.paste("id:message-input", { text: value });
  await app.press("id:send-message");
}
async function start(app: App) {
  await send(app, "queue-root");
  await app.waitUntil(() => texts(app).includes("Running queue-root"));
}
const promptTexts = (stats: Stats) => stats.prompts.map(prompt => prompt.text);

test("generating drafts queue in FIFO order and auto-send only after the current v1 prompt completes", async () => {
  const app = await connect();
  await start(app);
  await send(app, "first");
  await send(app, "second");
  expect(texts(app)).toContain("2 Queued Messages");
  expect(app.shows("id:queue-entry-0")).toBe(true);
  expect(app.shows("id:queue-entry-1")).toBe(true);
  expect(app.value("id:message-input")).toBe("");
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Echo: second"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "first", "second"]);
  expect((await control(app, "queue-test")).cancels).toEqual([]);
  expect(app.shows("id:message-queue")).toBe(false);
  await app.press("id:disconnect");
}, 90000);

test("manual Stop pauses the queue; sending one idle entry does not resume the rest; a fresh message resumes it", async () => {
  const app = await connect();
  await start(app);
  await send(app, "first");
  await send(app, "second");
  await app.press("id:stop-generation");
  await app.waitUntil(() => texts(app).includes("Finished queue-root"));
  expect(texts(app)).toContain("2 Queued Messages");
  await app.press("id:queue-send-0");
  await app.waitUntil(() => texts(app).includes("Echo: first"));
  await app.waitFor("id:send-message");
  expect(app.shows("id:queue-entry-1")).toBe(true);
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "first"]);
  await send(app, "fresh");
  await app.waitUntil(() => texts(app).includes("Echo: second"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "first", "fresh", "second"]);
  await app.press("id:disconnect");
}, 90000);

test("Send Now waits for cancellation, skips the selected entry, and absorbs exactly the old completion", async () => {
  const app = await connect();
  await start(app);
  await send(app, "first");
  await send(app, "queue-now");
  await app.press("id:queue-send-1");
  await app.waitUntil(() => texts(app).includes("Running queue-now"));
  expect(app.shows("id:queue-entry-0")).toBe(true);
  expect(app.shows("id:queue-entry-1")).toBe(false);
  const stats = await control(app, "queue-test");
  expect(promptTexts(stats)).toEqual(["queue-root", "queue-now"]);
  expect(stats.cancels).toEqual(["test-session"]);
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Echo: first"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "queue-now", "first"]);
  await app.press("id:disconnect");
}, 90000);

for (const reason of ["refusal", "max_tokens", "error"]) {
  test(`ordinary v1 ${reason}: only refusal emits Stopped and automatically processes the queue`, async () => {
    const app = await connect();
    await start(app);
    await send(app, "follow-up");
    await control(app, "queue-test", reason);
    if (reason === "refusal") {
      await app.waitUntil(() => texts(app).includes("Echo: follow-up"));
      expect(app.shows("id:message-queue")).toBe(false);
      expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "follow-up"]);
    } else {
      await app.waitFor("id:thread-error");
      expect(app.shows("id:queue-entry-0")).toBe(true);
      expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
    }
    await app.press("id:disconnect");
  }, 60000);
}

test("editing a queued message appends it to the existing draft without sending or losing either text", async () => {
  const app = await connect();
  await start(app);
  await send(app, "queued text");
  await app.paste("id:message-input", { text: "draft" });
  await app.press("id:queue-edit-0");
  expect(app.value("id:message-input")).toBe("draft\n\nqueued text");
  expect(app.shows("id:message-queue")).toBe(false);
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.press("id:disconnect");
}, 60000);

test("queue collapse, stable ids, removal and Clear All preserve the active generation", async () => {
  const app = await connect();
  await start(app);
  await send(app, "one"); await send(app, "two"); await send(app, "three");
  await app.press("id:queue-remove-1");
  expect(texts(app)).toContain("2 Queued Messages");
  await app.press("id:queue-toggle");
  expect(app.shows("id:queue-entries")).toBe(false);
  await app.press("id:queue-clear");
  expect(app.shows("id:message-queue")).toBe(false);
  await send(app, "four");
  expect(app.shows("id:queue-entries")).toBe(false);
  await app.press("id:queue-toggle");
  expect(app.shows("id:queue-entry-3")).toBe(true);
  expect(app.shows("id:stop-generation")).toBe(true);
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.press("id:disconnect");
}, 90000);

const state = (app: App) => JSON.parse(app.texts().find(text => text.startsWith('{"prompts":'))!);
async function model() {
  const app = await open("fixtures/queue-state.tsx");
  await app.waitFor("text:Phase ready");
  return app;
}
for (const mode of ["sync", "async"]) {
  test(`a ${mode} cancellation failure restores the selected queue entry in its original order`, async () => {
    const app = await model();
    await app.press("id:first");
    await app.waitUntil(() => state(app).prompts.length === 1);
    await app.press("id:a"); await app.press("id:b");
    await app.press(`id:${mode}`);
    await app.press("id:now");
    await app.waitUntil(() => !state(app).loading);
    expect(state(app).queue.map((entry: { id: number }) => entry.id)).toEqual([0, 1]);
    expect(state(app).prompts).toEqual(["root"]);
    expect(texts(app)).toContain(`Cancel failed ${mode === "sync" ? "synchronously" : "asynchronously"}`);
    await app.press("id:finish");
    expect(state(app).prompts).toEqual(["root"]);
  });
}

test("a focused first queue editor defers completion processing; losing focus alone never sends", async () => {
  const app = await model();
  await app.press("id:first");
  await app.waitUntil(() => state(app).prompts.length === 1);
  await app.press("id:a"); await app.press("id:b");
  await app.press("id:focus");
  await app.press("id:finish");
  expect(state(app).queue.length).toBe(2);
  expect(state(app).prompts).toEqual(["root"]);
  await app.press("id:blur");
  expect(state(app).prompts).toEqual(["root"]);
});

test("an empty Send Immediately cancels but does not fast-track the queue", async () => {
  const app = await model();
  await app.press("id:first");
  await app.waitUntil(() => state(app).prompts.length === 1);
  await app.press("id:a");
  await app.press("id:immediate");
  expect(state(app).loading).toBe(true);
  expect(state(app).prompts).toEqual(["root"]);
  await app.press("id:finish-cancel");
  await app.waitUntil(() => !state(app).loading);
  expect(state(app).queue.length).toBe(1);
  expect(state(app).prompts).toEqual(["root"]);
});

test("disposed owners cannot dispatch queued content after a cancellation settles", async () => {
  const app = await model();
  await app.press("id:first");
  await app.waitUntil(() => state(app).prompts.length === 1);
  await app.press("id:a"); await app.press("id:b");
  await app.press("id:now");
  expect(state(app).loading).toBe(true);
  await app.press("id:dispose");
  await app.press("id:finish-cancel");
  expect(state(app).prompts).toEqual(["root"]);
});

test("unsupported recovered queue content survives validation, fast track and edit attempts", async () => {
  const app = await model();
  await app.press("id:unsupported");
  await app.press("id:unsupported-now");
  await app.press("id:fast");
  await app.press("id:unsupported-edit");
  expect(state(app).prompts).toEqual([]);
  expect(state(app).queue).toEqual([{ id: 0, content: [{ type: "_future", source: { opaque: true } }] }]);
  expect(state(app).fast).toBe(true);
});

test("Enter on an empty main editor fast-tracks only once and waits for the cancelled turn", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "queue-fast");
  await send(app, "last");
  await app.submit("id:message-input");
  await app.waitUntil(() => texts(app).includes("Running queue-fast"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "queue-fast"]);
  expect(app.shows("id:queue-entry-1")).toBe(true);
  await app.submit("id:message-input");
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "queue-fast"]);
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Echo: last"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "queue-fast", "last"]);
  await app.press("id:disconnect");
}, 90000);

test("a focused first read-only queue editor defers automatic sending until an explicit action", async () => {
  const app = await connect();
  await start(app);
  await send(app, "first"); await send(app, "second");
  await app.press("id:queue-focus-0");
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Finished queue-root"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  expect(app.shows("id:queue-entry-0")).toBe(true);
  await app.press("id:queue-send-0");
  await app.waitUntil(() => texts(app).includes("Echo: second"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "first", "second"]);
  await app.press("id:disconnect");
}, 90000);

test("typing in a queued read-only editor promotes its source into the main editor", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "queued");
  await app.press("id:queue-focus-0");
  await app.keyboard.press("x");
  await app.waitFor("id:message-queue", { state: "gone" });
  const value = app.value("id:message-input")!;
  expect(value).toContain("queued");
  expect(value).toContain("x");
  expect(value.length).toBe(7);
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.press("id:disconnect");
}, 60000);

test("Zed v1 keyboard: Up restores the last queued message; Mod+Shift+Enter interrupts with the draft", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "first"); await send(app, "queue-last");
  await app.keyboard.press("up");
  await app.waitUntil(() => app.value("id:message-input") === "queue-last");
  expect(app.shows("id:queue-entry-1")).toBe(false);
  await app.keyboard.press("mod+shift+enter");
  await app.waitUntil(() => texts(app).includes("Running queue-last"));
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root", "queue-last"]);
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Echo: first"));
  await app.press("id:disconnect");
}, 90000);

test("retained background queues continue on their own session and never enter the selected chat", async () => {
  const app = await connect("history");
  await start(app);
  await send(app, "background follow-up");
  await app.press("id:new-session");
  await ready(app);
  expect(app.shows("id:message-queue")).toBe(false);
  await control(app, "history", "end_turn", "new-1");
  await app.press("id:show-sessions");
  await app.press("id:open-chat-1");
  await ready(app);
  await app.waitUntil(() => texts(app).includes("Reply in new-1: background follow-up"));
  expect((await control(app, "history")).prompts.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([
    { sessionId: "new-1", text: "queue-root" }, { sessionId: "new-1", text: "background follow-up" },
  ]);
  expect(app.shows("id:message-queue")).toBe(false);
  await app.press("id:disconnect");
}, 90000);

test("an evicted idle session restores its queued input paused after replay", async () => {
  const app = await connect("history-retention", false, 1200);
  await start(app);
  await send(app, "queue-restored");
  await app.press("id:stop-generation");
  await app.waitUntil(() => texts(app).includes("Finished queue-root"));
  for (let index = 0; index < 6; index++) { await app.press("id:new-session"); await ready(app); }
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-new-1");
  expect(app.shows("id:open-chat-1")).toBe(false);
  await app.press("id:history-open-new-1");
  await ready(app);
  await app.waitFor("id:queue-entry-0");
  expect(app.value("id:queue-input-0")).toBe("queue-restored");
  expect(promptTexts(await control(app, "history-retention"))).toEqual(["queue-root"]);
  await app.press("id:queue-send-0");
  await app.waitUntil(() => texts(app).includes("Running queue-restored"));
  expect(promptTexts(await control(app, "history-retention"))).toEqual(["queue-root", "queue-restored"]);
  await app.press("id:disconnect");
}, 90000);

test("successful authentication restores the queue paused and never automatically resends it", async () => {
  const app = await connect("auth-prompt");
  await start(app);
  await send(app, "after-login");
  await control(app, "auth-prompt", "auth");
  await app.waitFor("id:authenticate-thread");
  await app.press("id:authenticate-thread");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  await app.waitFor("id:queue-entry-0");
  expect(app.value("id:message-input")).toBe("queue-root");
  expect(app.value("id:queue-input-0")).toBe("after-login");
  expect(promptTexts(await control(app, "auth-prompt"))).toEqual(["queue-root"]);
  await app.clear("id:message-input");
  await app.press("id:queue-send-0");
  await app.waitUntil(() => texts(app).includes("Echo: after-login"));
  expect(promptTexts(await control(app, "auth-prompt"))).toEqual(["queue-root", "after-login"]);
  await app.press("id:disconnect");
}, 90000);

for (const mode of ["sync", "async"]) {
  test(`Send Immediately preserves the main draft and queue on ${mode} cancellation failure`, async () => {
    const app = await model();
    await app.press("id:first");
    await app.waitUntil(() => state(app).prompts.length === 1);
    await app.press("id:a");
    await app.press("id:stage");
    await app.press(`id:${mode}`);
    await app.press("id:immediate");
    await app.waitUntil(() => !state(app).loading);
    expect(state(app).draft).toBe("interrupt draft");
    expect(state(app).queue.length).toBe(1);
    expect(state(app).prompts).toEqual(["root"]);
  });
}

test("editing replaces an empty whitespace-only draft as Zed's message editor does", async () => {
  const app = await connect();
  await start(app);
  await send(app, "queued source");
  await app.paste("id:message-input", { text: "  \n  " });
  await app.press("id:queue-edit-0");
  expect(app.value("id:message-input")).toBe("queued source");
  await app.press("id:disconnect");
}, 60000);

test("pasting into a queued read-only editor promotes the message without duplicate insertion", async () => {
  const app = await connect();
  await start(app);
  await send(app, "queued");
  await app.press("id:queue-focus-0");
  await app.keyboard.press("mod+v");
  await app.waitFor("id:message-queue", { state: "gone" });
  const value = app.value("id:message-input")!;
  expect(value).toContain("queued");
  expect(value).toContain("PASTED");
  expect(value.length).toBe(12);
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.press("id:disconnect");
}, 60000);

test("promoted input inserts at the preview cursor without deleting source text, including Unicode", async () => {
  const app = await model();
  await app.press("id:cursor");
  expect(state(app).draft).toBe("prefix\n\n你🙂X好");
  expect(state(app).queue).toEqual([]);
  expect(state(app).prompts).toEqual([]);
});

test("Zed v1 keyboard: empty Mod+Shift+Enter does nothing; Escape returns to the main editor", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "queued");
  await app.keyboard.press("mod+shift+enter");
  expect((await control(app, "queue-test")).cancels).toEqual([]);
  await app.press("id:queue-focus-0");
  await app.keyboard.press("escape");
  await app.keyboard.press("x");
  expect(app.value("id:message-input")).toBe("x");
  expect(app.value("id:queue-input-0")).toBe("queued");
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.press("id:disconnect");
}, 60000);

test("a queued preview rejects deletion and preserves selected source text when typing promotes it", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "queued");
  await app.press("id:queue-focus-0");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.value("id:queue-input-0") === "queued");
  expect(app.value("id:message-input")).toBe("");
  await app.keyboard.press("x");
  await app.waitFor("id:message-queue", { state: "gone" });
  const value = app.value("id:message-input")!;
  expect(value.replace("x", "")).toBe("queued");
  expect(value.length).toBe(7);
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.press("id:disconnect");
}, 60000);


test("Zed v1 keyboard: Mod+Enter queues a generating draft without cancellation", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await app.paste("id:message-input", { text: "shortcut-follow-up" });
  await app.keyboard.press("mod+enter");
  await app.waitUntil(() => app.value("id:message-input") === "");
  expect(app.value("id:queue-input-0")).toBe("shortcut-follow-up");
  const stats = await control(app, "queue-test");
  expect(promptTexts(stats)).toEqual(["queue-root"]);
  expect(stats.cancels).toEqual([]);
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Echo: shortcut-follow-up"));
  await app.press("id:disconnect");
}, 90000);

test("Zed v1 keyboard: empty Mod+Enter fast-tracks once through ordinary send", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "queue-fast");
  await send(app, "last");
  await app.keyboard.press("mod+enter");
  await app.waitUntil(() => texts(app).includes("Running queue-fast"));
  await app.keyboard.press("mod+enter");
  const stats = await control(app, "queue-test");
  expect(promptTexts(stats)).toEqual(["queue-root", "queue-fast"]);
  expect(stats.cancels).toEqual(["test-session"]);
  expect(app.value("id:queue-input-1")).toBe("last");
  await control(app, "queue-test", "end_turn");
  await app.waitUntil(() => texts(app).includes("Echo: last"));
  await app.press("id:disconnect");
}, 90000);

test("Zed v1 keyboard: Shift+Enter leaves the preview unchanged; Mod+Enter returns to main", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "queued");
  await app.press("id:queue-focus-0");
  await app.keyboard.press("shift+enter");
  expect(app.value("id:queue-input-0")).toBe("queued");
  expect(app.value("id:message-input")).toBe("");
  // The ignored newline must also preserve preview focus: a stopped turn
  // cannot auto-send its first entry while the user is still inspecting it.
  await control(app, "queue-test", "end_turn");
  await app.waitFor("id:send-message");
  expect(promptTexts(await control(app, "queue-test"))).toEqual(["queue-root"]);
  await app.keyboard.press("mod+enter");
  await app.keyboard.press("x");
  expect(app.value("id:message-input")).toBe("x");
  expect(app.value("id:queue-input-0")).toBe("queued");
  expect((await control(app, "queue-test")).cancels).toEqual([]);
  await app.press("id:disconnect");
}, 90000);

test("Zed v1 keyboard: Mod+Shift+Enter sends the focused queued entry immediately", async () => {
  const app = await connect("queue-test", true);
  await start(app);
  await send(app, "first");
  await send(app, "queue-selected");
  await app.press("id:queue-focus-1");
  await app.keyboard.press("mod+shift+enter");
  await app.waitUntil(() => texts(app).includes("Running queue-selected"));
  const stats = await control(app, "queue-test");
  expect(promptTexts(stats)).toEqual(["queue-root", "queue-selected"]);
  expect(stats.cancels).toEqual(["test-session"]);
  expect(app.value("id:queue-input-0")).toBe("first");
  expect(app.shows("id:queue-entry-1")).toBe(false);
  await app.press("id:disconnect");
}, 90000);
