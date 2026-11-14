import { expect, open, test } from "nsh/test";

async function connect(token: string) {
  const app = await open("../App.tsx", { width: 360, height: 640, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await app.waitFor("id:chat-page");
  return app;
}

type App = Awaited<ReturnType<typeof connect>>;
const texts = (app: App) => app.texts().join("\n");
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
async function send(app: App, message: string) {
  await app.type("id:message-input", message);
  await app.press("id:send-message");
}

test("session authentication offers choices, hides them while pending, and creates the session after sign-in", async () => {
  const app = await connect("auth-multiple");
  await app.waitFor("id:authentication");
  expect(texts(app)).toContain("Authenticate to Mock Agent");
  expect(texts(app)).toContain("Please sign in to continue.");
  expect(app.shows("id:message-input")).toBe(false);
  expect(app.enabled("id:auth-method-terminal-login")).toBe(false);
  await app.press("id:auth-method-browser-login");
  expect(app.shows("id:auth-pending")).toBe(true);
  expect(texts(app)).toContain("Authenticating to Mock Agent…");
  expect(app.shows("id:auth-method-browser-login")).toBe(false);
  await ready(app);
  await send(app, "auth-status");
  await app.waitUntil(() => texts(app).includes("Auth calls: 1; New sessions: 2; Restores: 0; Prompts: 1"));
  await app.press("id:disconnect");
});

test("failed sign-in keeps the transport and offers the choices again", async () => {
  const app = await connect("auth-multiple");
  await app.waitFor("id:auth-method-reject-login");
  await app.press("id:auth-method-reject-login");
  await app.waitUntil(() => texts(app).includes("Sign-in did not complete: Login rejected"));
  expect(app.shows("id:auth-method-browser-login")).toBe(true);
  expect(app.shows("id:auth-pending")).toBe(false);
  await app.press("id:auth-method-browser-login");
  await ready(app);
  await send(app, "auth-status");
  await app.waitUntil(() => texts(app).includes("Auth calls: 2; New sessions: 2; Restores: 0; Prompts: 1"));
  await app.press("id:disconnect");
});

test("a single sign-in choice requires a user action and has no redundant default description", async () => {
  const app = await connect("auth-single");
  await app.waitFor("id:auth-method-browser-login");
  expect(app.shows("id:auth-pending")).toBe(false);
  expect(texts(app)).not.toContain("Choose one of the following authentication options:");
  expect(app.shows("id:auth-description")).toBe(false);
  await app.press("id:auth-method-browser-login");
  await ready(app);
  await app.press("id:disconnect");
});

test("an explicit empty authentication description does not receive the default choice description", async () => {
  const app = await connect("auth-empty-description");
  await app.waitFor("id:auth-method-browser-login");
  expect(texts(app)).not.toContain("Choose one of the following authentication options:");
  await app.press("id:disconnect");
});

for (const token of ["auth-none", "auth-terminal-only", "auth-legacy"]) {
  test(`${token}: unavailable sign-in never becomes an agent-managed login RPC`, async () => {
    const app = await connect(token);
    await app.waitFor("id:authentication");
    expect(app.shows("id:auth-pending")).toBe(false);
    if (token !== "auth-none") {
      const id = token === "auth-legacy" ? "legacy-login" : "terminal-login";
      expect(app.enabled(`id:auth-method-${id}`)).toBe(false);
      expect(app.shows("id:terminal-auth-unavailable")).toBe(true);
    }
    await app.press("id:disconnect");
    await app.waitFor("id:ws-address");
  });
}

test("a prompt auth error waits for Authenticate, restores the failed draft, and loads history without resending", async () => {
  const app = await connect("auth-prompt");
  await ready(app);
  await send(app, "needs-auth");
  await app.waitFor("id:authenticate-thread");
  expect(texts(app)).toContain("Authentication Required");
  expect(texts(app)).toContain("Credentials expired");
  expect(app.shows("id:authentication")).toBe(false);
  await app.type("id:message-input", "new unsent draft");
  await app.press("id:authenticate-thread");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  expect(app.value("id:message-input")).toBe("needs-auth");
  expect(texts(app)).toContain("Restored history.");
  expect(app.shows("id:thread-error")).toBe(false);
  expect(app.shows("id:stop-generation")).toBe(false);
  await app.clear("id:message-input");
  await send(app, "auth-status");
  await app.waitUntil(() => texts(app).includes("Auth calls: 1; New sessions: 1; Restores: 1; Prompts: 2"));
  await app.press("id:disconnect");
});

for (const command of ["/login", "/logout"]) {
  test(`advertising auth does not force login; manual ${command} reopens the existing session`, async () => {
    const app = await connect("auth-advertised");
    await ready(app);
    expect(app.shows("id:authentication")).toBe(false);
    await send(app, ` ${command} \n`);
    await app.waitFor("id:auth-method-browser-login");
    expect(texts(app)).toContain("Choose one of the following authentication options:");
    await app.press("id:auth-method-browser-login");
    await ready(app);
    await send(app, "auth-status");
    await app.waitUntil(() => texts(app).includes("Auth calls: 1; New sessions: 1; Restores: 1; Prompts: 1"));
    await app.press("id:disconnect");
  });
}

test("an advertised agent logout command takes precedence over the local sign-in shortcut", async () => {
  const app = await connect("auth-agent-logout");
  await ready(app);
  await send(app, "/logout");
  await app.waitUntil(() => texts(app).includes("Echo: /logout"));
  expect(app.shows("id:authentication")).toBe(false);
  await app.waitFor("id:send-message");
  await send(app, "auth-status");
  await app.waitUntil(() => texts(app).includes("Auth calls: 0; New sessions: 1; Restores: 0; Prompts: 2"));
  await app.press("id:disconnect");
});

test("a configuration reply from before sign-in cannot overwrite the restored selectors", async () => {
  const app = await connect("auth-late-config");
  await ready(app);
  await app.press("id:config-model");
  await app.waitFor("id:choice-model-smart");
  await app.press("id:choice-model-smart");
  expect(texts(app)).toContain("Smart");
  await send(app, "/login");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  expect(texts(app)).toContain("Fast");
  // The mock releases the held pre-login config response before answering this prompt.
  await send(app, "auth-status");
  await app.waitUntil(() => texts(app).includes("Auth calls: 1; New sessions: 1; Restores: 1; Prompts: 1"));
  expect(texts(app)).toContain("Fast");
  expect(texts(app)).not.toContain("Smart");
  expect(app.shows("id:session-error")).toBe(false);
  await app.press("id:disconnect");
});

test("reauthentication uses resume when history load is unavailable", async () => {
  const app = await connect("auth-resume");
  await ready(app);
  await send(app, "needs-auth");
  await app.waitFor("id:authenticate-thread");
  await app.press("id:authenticate-thread");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  expect(app.value("id:message-input")).toBe("needs-auth");
  expect(texts(app)).not.toContain("Restored history.");
  await app.press("id:disconnect");
});

test("reauthentication never creates a replacement session when load and resume are unavailable", async () => {
  const app = await connect("auth-no-restore");
  await ready(app);
  await send(app, "needs-auth");
  await app.waitFor("id:authenticate-thread");
  await app.press("id:authenticate-thread");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await app.waitUntil(() => texts(app).includes("Loading or resuming sessions is not supported by this agent."));
  expect(app.value("id:message-input")).toBe("needs-auth");
  expect(app.enabled("id:send-message")).toBe(false);
  await app.press("id:disconnect");
});

test("ordinary errors with auth wording do not enter authentication", async () => {
  const app = await connect("auth-fake");
  await app.waitFor("id:session-error");
  expect(texts(app)).toContain("Authentication required");
  expect(app.shows("id:authentication")).toBe(false);
  await app.press("id:disconnect");
});

test("disconnect while signing in ignores the old response after another connection", async () => {
  const app = await connect("auth-single");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await app.press("id:disconnect");
  await app.waitFor("id:ws-address");
  await app.clear("id:token");
  await app.type("id:token", "valid");
  await app.press("id:connect");
  await ready(app);
  expect(app.shows("id:authentication")).toBe(false);
  expect(app.shows("id:session-error")).toBe(false);
  await send(app, "hello");
  await app.waitUntil(() => texts(app).includes("Hello there, how can I help?"));
  await app.press("id:disconnect");
});

test("agent exit during sign-in returns to the connection form", async () => {
  const app = await connect("auth-drop");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await app.waitFor("id:ws-address");
  expect(texts(app)).toContain("Agent exited during login");
});

for (const route of ["load", "resume", "error"]) {
  test(`sign-in releases the old session before reopening: close ${route}`, async () => {
    const app = await connect(`auth-close-${route}`);
    await ready(app);
    await send(app, "/login");
    await app.press("id:auth-method-browser-login");
    await ready(app);
    expect(texts(app)).not.toContain("Stale before close response.");
    expect(texts(app)).not.toContain("Stale after close response.");
    expect(app.shows("id:session-error")).toBe(false);
    if (route !== "resume") expect(texts(app)).toContain("Restored history.");
    await send(app, "auth-status");
    await app.waitUntil(() => texts(app).includes("Auth calls: 1; New sessions: 1; Restores: 1; Prompts: 1; Closes: 1"));
    await app.press("id:disconnect");
  });
}
