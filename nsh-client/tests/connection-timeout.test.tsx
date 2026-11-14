import { expect, open, test } from "nsh/test";

// Manual clocks are supported by the headless engine; keep this out of device tests.
test("a silent server times out instead of leaving Connect stuck", async () => {
  const app = await open("../App.tsx", { width: 360, height: 640, network: "live", clock: {} });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", "pending");
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await app.wait(30_001);
  expect(app.texts()).toContain("Connection timed out. Check the address, token and server.");
  expect(app.enabled("id:connect")).toBe(true);
});

test("sign-in can remain pending without a fixed deadline", async () => {
  const app = await open("../App.tsx", { width: 360, height: 640, network: "live", clock: {} });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", "auth-single");
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await app.waitFor("id:auth-method-browser-login");
  await app.press("id:auth-method-browser-login");
  await app.wait(60_001);
  expect(app.shows("id:auth-pending")).toBe(true);
  expect(app.shows("id:session-error")).toBe(false);
  expect(app.shows("id:auth-method-browser-login")).toBe(false);
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
  await app.press("id:disconnect");
});

for (const outcome of ["success", "error"]) {
  test(`session creation waits beyond 30 seconds for its ${outcome}`, async () => {
    const app = await open("../App.tsx", { width: 360, height: 640, network: "live", clock: {} });
    await app.clear("id:ws-address");
    await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
    await app.type("id:token", `slow-session-${outcome}`);
    await app.type("id:working-directory", "/workspace");
    await app.press("id:connect");
    await app.waitFor("id:session-loading");
    await app.wait(60_001);
    expect(app.shows("id:session-loading")).toBe(true);
    expect(app.shows("id:session-error")).toBe(false);
    if (outcome === "success") {
      await app.waitFor("id:session-loading", { state: "gone" });
      expect(app.shows("id:session-error")).toBe(false);
      await app.type("id:message-input", "ready");
      expect(app.enabled("id:send-message")).toBe(true);
    } else {
      await app.waitFor("id:session-error");
      expect(app.texts()).toContain("Slow session creation failed");
      expect(app.shows("id:session-loading")).toBe(false);
    }
    await app.press("id:disconnect");
  });

  for (const method of ["load", "resume"]) {
    test(`post-login ${method} waits beyond 30 seconds for its ${outcome}`, async () => {
      const app = await open("../App.tsx", { width: 360, height: 640, network: "live", clock: {} });
      await app.clear("id:ws-address");
      await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
      await app.type("id:token", `auth-slow-${method}-${outcome}`);
      await app.type("id:working-directory", "/workspace");
      await app.press("id:connect");
      await app.waitFor("id:message-input");
      await app.waitFor("id:session-loading", { state: "gone" });
      await app.type("id:message-input", "/login");
      await app.press("id:send-message");
      await app.press("id:auth-method-browser-login");
      await app.waitFor("id:session-loading");
      await app.wait(60_001);
      expect(app.shows("id:session-loading")).toBe(true);
      expect(app.shows("id:session-error")).toBe(false);
      if (outcome === "success") {
        await app.waitFor("id:session-loading", { state: "gone" });
        expect(app.shows("id:session-error")).toBe(false);
        await app.type("id:message-input", "ready");
        expect(app.enabled("id:send-message")).toBe(true);
      } else {
        await app.waitFor("id:session-error");
        expect(app.texts()).toContain("Slow session restoration failed");
        expect(app.shows("id:session-loading")).toBe(false);
      }
      await app.press("id:disconnect");
    });
  }
}
