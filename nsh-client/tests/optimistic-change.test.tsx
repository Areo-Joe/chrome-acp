import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/optimistic-change.tsx";

test("optimistic values stay until confirmation; only slow changes show loading", async () => {
  const app = await open(fixture, { clock: {} });
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
  const app = await open(fixture, { clock: {} });
  await app.press("id:fast");
  await app.wait(60);
  expect(app.texts()).toContain("Actual: Smart");
  expect(app.texts()).toContain("Pending: false");
  await app.wait(300);
  expect(app.texts()).toContain("Slow: false");
});

test("timeouts discard the overlay and reveal the latest authoritative state", async () => {
  const app = await open(fixture, { clock: {} });
  await app.press("id:silent");
  await app.press("id:external");
  expect(app.texts()).toContain("Actual: Other");
  expect(app.texts()).toContain("Displayed: Smart");
  await app.wait(15_001);
  expect(app.texts()).toContain("Displayed: Other");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Slow: false");
  expect(app.texts()).toContain("Error: The change was not confirmed.");
});

test("send failures discard the optimistic value", async () => {
  const app = await open(fixture, { clock: {} });
  await app.press("id:reject");
  expect(app.texts()).toContain("Displayed: Fast");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Error: Rejected");
});

test("an old send rejection cannot cancel a newer change", async () => {
  const app = await open(fixture, { clock: {} });
  await app.press("id:late-error");
  await app.press("id:confirm");
  await app.press("id:expert");
  await app.wait(1001);
  expect(app.texts()).toContain("Displayed: Expert");
  expect(app.texts()).toContain("Pending: true");
  expect(app.texts()).toContain("Error: none");
});

test("cancel and dispose clear timers and ignore late failures", async () => {
  const app = await open(fixture, { clock: {} });
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
  const app = await open(fixture, { clock: {} });
  await app.press("id:same");
  await app.wait(15_001);
  expect(app.texts()).toContain("Sends: 0");
  expect(app.texts()).toContain("Pending: false");
  expect(app.texts()).toContain("Error: none");
});
