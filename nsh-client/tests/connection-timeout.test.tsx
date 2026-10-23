import { expect, open, test } from "nsh/test";

// Manual clocks are supported by the headless engine; keep this out of device tests.
test("a silent proxy times out instead of leaving Connect stuck", async () => {
  const app = await open("../App.tsx", { network: "live", clock: {} });
  await app.type("id:ws-address", "ws://127.0.0.1:19437");
  await app.type("id:token", "pending");
  await app.press("id:connect");
  await app.wait(30_001);
  expect(app.texts()).toContain("Connection timed out. Check the address, token and proxy.");
  expect(app.enabled("id:connect")).toBe(true);
});
