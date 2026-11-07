import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/optimistic-change.tsx";

test("optimistic values stay until the RPC response; only slow changes show loading", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:slow");
  expect(app.texts()).toContain("Actual: Fast");
  expect(app.texts()).toContain("Displayed: Smart");
  expect(app.texts()).toContain("Pending: true");
  await app.press("id:expert");
  expect(app.texts()).toContain("Sends: 1");
  await app.wait(299);
  expect(app.texts()).toContain("Slow: false");
  await app.wait(2);
  expect(app.texts()).toContain("Slow: true");
  await app.wait(700);
  expect(app.texts()).toContain("Actual: Smart");
  expect(app.texts()).toContain("Displayed: Smart");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Slow: false");
});

test("fast confirmation cancels the loading timer", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:fast");
  await app.wait(60);
  expect(app.texts()).toContain("Actual: Smart");
  expect(app.texts()).toContain("Pending: false");
  await app.wait(300);
  expect(app.texts()).toContain("Slow: false");
});

test("requests beyond 15 seconds remain pending and block another change until their response", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:long");
  await app.press("id:external");
  expect(app.texts()).toContain("Actual: Other");
  expect(app.texts()).toContain("Displayed: Smart");
  await app.wait(15_001);
  expect(app.texts()).toContain("Displayed: Smart");
  expect(app.texts()).toContain("Pending: true");
  expect(app.texts()).toContain("Slow: true");
  expect(app.texts()).toContain("Error: none");
  await app.press("id:expert");
  expect(app.texts()).toContain("Sends: 1");
  await app.wait(1000);
  expect(app.texts()).toContain("Actual: Smart");
  expect(app.texts()).toContain("Displayed: Smart");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Slow: false");
  expect(app.texts()).toContain("Error: none");
});

test("send failures discard the optimistic value", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:reject");
  expect(app.texts()).toContain("Displayed: Fast");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Error: Rejected");
});

test("an old send rejection cannot cancel a newer change", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:late-error");
  await app.press("id:cancel");
  await app.press("id:expert");
  await app.wait(1001);
  expect(app.texts()).toContain("Displayed: Expert");
  expect(app.texts()).toContain("Pending: true");
  expect(app.texts()).toContain("Error: none");
});

test("cancel and dispose clear timers and ignore late failures", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:late-error");
  await app.press("id:cancel");
  await app.wait(1001);
  expect(app.texts()).toContain("Displayed: Fast");
  expect(app.texts()).toContain("Error: none");
  await app.press("id:expert");
  await app.press("id:dispose");
  await app.press("id:silent");
  await app.wait(15_001);
  expect(app.texts()).toContain("Sends: 2");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Slow: false");
  expect(app.texts()).toContain("Error: none");
});

test("choosing the confirmed value does not send or start timers", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:same");
  await app.wait(15_001);
  expect(app.texts()).toContain("Sends: 0");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Error: none");
});

test("a normalized successful RPC clears the overlay and all timers", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:normalized");
  expect(app.texts()).toContain("Displayed: Smart");
  await app.wait(1001);
  expect(app.texts()).toContain("Actual: Other");
  expect(app.texts()).toContain("Displayed: Other");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Slow: false");
  await app.wait(15_001);
  expect(app.texts()).toContain("Error: none");
});

test("a matching notification does not settle an RPC or hide its later rejection", async () => {
  const app = await open(fixture, { width: 360, height: 640, clock: {} });
  await app.press("id:notified-error");
  await app.wait(60);
  expect(app.texts()).toContain("Actual: Smart");
  expect(app.texts()).toContain("Pending: true");
  await app.press("id:expert");
  expect(app.texts()).toContain("Sends: 1");
  await app.wait(1001);
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Displayed: Smart");
  expect(app.texts()).toContain("Error: Rejected after notification");
});
