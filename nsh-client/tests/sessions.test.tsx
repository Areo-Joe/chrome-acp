import { expect, open, test, type App } from "nsh/test";
const texts = (app: App) => app.texts().join("\n");
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
async function connect(token = "history") {
  const app = await open("../App.tsx", { width: 420, height: 800, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await ready(app);
  return app;
}
async function history(app: App) {
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-saved-a");
}
async function send(app: App, value: string) {
  await app.type("id:message-input", value);
  await app.press("id:send-message");
}

test("history paginates with an opaque empty cursor, uses the session directory, and reuses open views", async () => {
  const app = await connect();
  await app.type("id:message-input", "draft for first chat");
  await history(app);
  expect(texts(app)).toContain("Saved alpha");
  expect(app.shows("id:history-open-saved-b")).toBe(false);
  await app.press("id:history-more");
  await app.waitFor("id:history-open-saved-b");
  await app.press("id:history-open-saved-a");
  await ready(app);
  expect(texts(app)).toContain("History of Saved alpha");
  expect(app.value("id:message-input")).toBe("");
  await app.type("id:message-input", "draft for alpha");
  await app.press("id:show-sessions");
  await app.press("id:open-chat-1");
  expect(app.value("id:message-input")).toBe("draft for first chat");
  await history(app);
  await app.press("id:history-open-saved-a");
  expect(app.value("id:message-input")).toBe("draft for alpha");
  await app.clear("id:message-input");
  await send(app, "stats");
  await app.waitUntil(() => texts(app).includes("New: 1; Loads: 1; Auth: 0"));
  await app.press("id:disconnect");
});

test("new chat shares the connection and preserves each open chat's messages and draft", async () => {
  const app = await connect();
  await send(app, "first message");
  await app.waitUntil(() => texts(app).includes("Reply in new-1: first message"));
  await app.type("id:message-input", "first draft");
  await app.press("id:new-session");
  await ready(app);
  expect(app.value("id:message-input")).toBe("");
  expect(texts(app)).not.toContain("first message");
  await app.type("id:message-input", "second draft");
  await history(app);
  await app.press("id:open-chat-1");
  expect(app.value("id:message-input")).toBe("first draft");
  expect(texts(app)).toContain("Reply in new-1: first message");
  await history(app);
  await app.press("id:open-chat-2");
  expect(app.value("id:message-input")).toBe("second draft");
  await app.clear("id:message-input");
  await send(app, "stats");
  await app.waitUntil(() => texts(app).includes("New: 2; Loads: 0; Auth: 0"));
  await app.press("id:disconnect");
});

test("switching keeps an inactive turn running and routes its reply to the original chat", async () => {
  const app = await connect();
  await send(app, "slow");
  await app.waitUntil(() => texts(app).includes("Working in the background"));
  await app.press("id:new-session");
  await ready(app);
  await send(app, "second");
  await app.waitUntil(() => texts(app).includes("Reply in new-2: second"));
  expect(texts(app)).not.toContain("Working in the background");
  await history(app);
  await app.press("id:open-chat-1");
  await app.waitUntil(() => texts(app).includes("Background complete"));
  expect(texts(app)).not.toContain("Reply in new-2: second");
  await app.press("id:disconnect");
});

test("list failure can retry while the existing chat and draft remain usable", async () => {
  const app = await connect("history-list-error");
  await app.type("id:message-input", "kept draft");
  await app.press("id:show-sessions");
  await app.waitFor("id:history-error");
  expect(texts(app)).toContain("History unavailable");
  await app.press("id:history-retry");
  await app.waitFor("id:history-open-saved-a");
  await app.press("id:history-back");
  expect(app.value("id:message-input")).toBe("kept draft");
  await app.press("id:disconnect");
});

test("a failed next page retries that cursor and retains the earlier page", async () => {
  const app = await connect("history-page-error");
  await history(app);
  await app.press("id:history-more");
  await app.waitFor("id:history-error");
  expect(app.shows("id:history-open-saved-a")).toBe(true);
  await app.press("id:history-retry");
  await app.waitFor("id:history-open-saved-b");
  expect(app.shows("id:history-open-saved-a")).toBe(true);
  await app.press("id:disconnect");
});

test("failed replay retries the original session without creating a replacement or resending input", async () => {
  const app = await connect("history-load-error");
  await history(app);
  await app.press("id:history-open-saved-a");
  await app.waitFor("id:session-error");
  expect(texts(app)).toContain("History replay failed");
  expect(texts(app)).not.toContain("Discarded failed replay");
  await app.type("id:message-input", "unsent history draft");
  await app.press("id:session-retry");
  await ready(app);
  expect(texts(app)).toContain("History of Saved alpha");
  expect(texts(app)).not.toContain("Discarded failed replay");
  expect(app.value("id:message-input")).toBe("unsent history draft");
  await app.clear("id:message-input");
  await send(app, "stats");
  await app.waitUntil(() => texts(app).includes("New: 1; Loads: 2; Auth: 0"));
  await app.press("id:disconnect");
});

test("opening history can authenticate and then restore that session with its own directory", async () => {
  const app = await connect("history-auth");
  await history(app);
  await app.press("id:history-open-saved-a");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  expect(texts(app)).toContain("History of Saved alpha");
  await send(app, "stats");
  await app.waitUntil(() => texts(app).includes("New: 1; Loads: 2; Auth: 1"));
  await app.press("id:disconnect");
});

test("resume-only history opens without fabricated earlier messages and explains the missing replay", async () => {
  const app = await connect("history-resume");
  await history(app);
  await app.press("id:history-open-saved-a");
  await ready(app);
  expect(app.shows("id:session-resumed")).toBe(true);
  expect(texts(app)).not.toContain("History of Saved alpha");
  await send(app, "continue");
  await app.waitUntil(() => texts(app).includes("Reply in saved-a: continue"));
  await app.press("id:disconnect");
});

test("capabilities gate restoring, listing, and additional directories", async () => {
  const app = await connect("history-list-only");
  await history(app);
  expect(app.enabled("id:history-open-saved-a")).toBe(false);
  expect(app.shows("id:history-open-unsupported")).toBe(true);
  await app.press("id:disconnect");
  const other = await connect("history-no-additional");
  await history(other);
  await other.press("id:history-open-saved-a");
  await ready(other);
  expect(texts(other)).toContain("History of Saved alpha");
  await other.press("id:disconnect");
});

test("session-info updates rename the chat and list without leaking to another open session", async () => {
  const app = await connect();
  await history(app);
  await app.press("id:history-open-saved-a");
  await ready(app);
  await send(app, "rename");
  await app.waitUntil(() => texts(app).includes("Renamed session"));
  await history(app);
  expect(texts(app)).toContain("Renamed session");
  await app.press("id:open-chat-1");
  expect(texts(app)).not.toContain("Renamed session");
  await app.press("id:disconnect");
});

test("deleting requires confirmation, reports failures, and refreshes the list after retry", async () => {
  const app = await connect("history-delete-error");
  await history(app);
  await app.press("id:history-delete-saved-a");
  expect(app.shows("id:history-delete-confirm")).toBe(true);
  await app.press("id:history-delete-cancel");
  expect(app.shows("id:history-open-saved-a")).toBe(true);
  await app.press("id:history-delete-saved-a");
  await app.press("id:history-delete-confirm");
  await app.waitUntil(() => texts(app).includes("Deletion rejected"));
  await app.press("id:history-delete-confirm");
  await app.waitFor("id:history-open-saved-a", { state: "gone" });
  await app.waitFor("id:history-open-saved-b");
  await app.press("id:history-back");
  await send(app, "still connected");
  await app.waitUntil(() => texts(app).includes("Reply in new-1: still connected"));
  await app.press("id:disconnect");
});

test("deleting the active historical session returns to the retained chat", async () => {
  const app = await connect();
  await app.type("id:message-input", "retained draft");
  await history(app);
  await app.press("id:history-open-saved-a");
  await ready(app);
  await history(app);
  await app.press("id:history-delete-saved-a");
  await app.press("id:history-delete-confirm");
  await app.waitFor("id:history-open-saved-a", { state: "gone" });
  await app.press("id:history-back");
  expect(app.value("id:message-input")).toBe("retained draft");
  expect(texts(app)).not.toContain("History of Saved alpha");
  await app.press("id:disconnect");
});

test("history can close and reopen during a pending list without starting a duplicate request", async () => {
  const app = await connect("history-delayed");
  await app.press("id:show-sessions");
  await app.waitFor("id:history-loading");
  await app.press("id:history-back");
  await app.type("id:message-input", "kept while listing");
  await app.press("id:show-sessions");
  await app.waitFor("id:history-open-saved-a");
  await app.press("id:history-back");
  expect(app.value("id:message-input")).toBe("kept while listing");
  await app.press("id:disconnect");
});

test("agents without history still retain open chats on the same connection", async () => {
  const app = await connect("empty");
  await app.type("id:message-input", "local draft");
  await app.press("id:show-sessions");
  expect(app.shows("id:history-unsupported")).toBe(true);
  await app.press("id:open-chat-1");
  expect(app.value("id:message-input")).toBe("local draft");
  await app.press("id:disconnect");
});

test("a repeated next cursor ends pagination as in Zed's collect_all_sessions", async () => {
  const app = await connect("history-repeated-cursor");
  await history(app);
  await app.press("id:history-more");
  await app.waitFor("id:history-open-saved-b");
  expect(app.shows("id:history-more")).toBe(false);
  await app.press("id:disconnect");
});

test("explicit null info fields clear the title instead of preserving the previous value", async () => {
  const app = await connect();
  await history(app);
  await app.press("id:history-open-saved-a");
  await ready(app);
  await send(app, "clear-info");
  await app.waitUntil(() => texts(app).includes("Cleared metadata."));
  await history(app);
  expect(texts(app)).toContain("Untitled session");
  expect(texts(app)).not.toContain("Saved alpha");
  await app.press("id:history-back");
  expect(app.shows("id:chat-title")).toBe(true);
  await app.press("id:disconnect");
});

test("live metadata wins over an in-flight list, while a later refresh can supply newer metadata", async () => {
  const app = await connect("history-info-race");
  await history(app); // list 1
  await app.press("id:history-open-saved-a");
  await ready(app); // onReady starts list 2
  await app.press("id:show-sessions");
  await app.waitFor("id:history-loading", { state: "gone" });
  await app.press("id:history-refresh"); // list 3 carries an old snapshot
  await app.waitUntil(() => texts(app).includes("Updated during list"));
  await app.waitFor("id:history-loading", { state: "gone" });
  expect(texts(app)).toContain("Updated during list");
  await app.press("id:history-refresh"); // list 4 is newer than that info update
  await app.waitUntil(() => texts(app).includes("Newer title from list"));
  expect(texts(app)).not.toContain("Updated during list");
  await app.press("id:disconnect");
});

test("agents without delete support do not expose delete actions", async () => {
  const app = await connect("history-no-delete");
  await history(app);
  expect(app.shows("id:history-delete-saved-a")).toBe(false);
  await app.press("id:disconnect");
});

test("returning to a chat during deletion keeps its composer locked until deletion finishes", async () => {
  const app = await connect("history-delete-pending");
  await history(app);
  await app.press("id:history-open-saved-a");
  await ready(app);
  await history(app);
  await app.press("id:history-delete-saved-a");
  await app.press("id:history-delete-confirm");
  await app.press("id:history-back");
  await app.waitFor("id:session-deleting");
  await app.type("id:message-input", "must not send into a deleted session");
  expect(app.enabled("id:send-message")).toBe(false);
  await app.waitFor("id:session-deleting", { state: "gone" });
  expect(app.value("id:message-input")).toBe("");
  expect(texts(app)).not.toContain("History of Saved alpha");
  await app.press("id:disconnect");
});
