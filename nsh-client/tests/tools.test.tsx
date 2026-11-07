import { expect, open, test } from "nsh/test";

async function chat() {
  const app = await open("../App.tsx", { width: 360, height: 640, network: "live" });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", "valid");
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect");
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
  return app;
}

type App = Awaited<ReturnType<typeof chat>>;

async function send(app: App, text: string) {
  await app.type("id:message-input", text);
  await app.press("id:send-message");
}

const joined = (app: App) => app.texts().join("\n");

/** How the mock agent saw its permission requests answered. */
async function outcomes(app: App) {
  await send(app, "outcomes");
  await app.waitUntil(() => joined(app).includes("Outcomes:"));
  return app.texts().find((text) => text.startsWith("Outcomes:"));
}

test("a tool call streams its status and opens to its input and output", async () => {
  const app = await chat();
  await send(app, "read");
  await app.waitFor("id:tool-call");
  await app.waitUntil(() => joined(app).includes("Read it."));
  await app.waitFor("id:send-message");
  expect(joined(app)).toContain("notes.md");
  // Collapsed until the user opens it.
  expect(joined(app)).not.toContain("First note");
  await app.press("id:tool-call-header");
  await app.waitFor("id:tool-call-output");
  expect(app.texts()).toContain("Raw Input:");
  expect(app.texts()).toContain("Output:");
  expect(joined(app)).toContain("\"path\": \"notes.md\"");
  expect(joined(app)).toContain("First note");
  expect(app.shows("id:tool-call-failed")).toBe(false);
  await app.press("id:collapse-tool-call");
  await app.waitFor("id:tool-call-output", { state: "gone" });
  await app.press("id:disconnect");
});

test("a permission request waits for a choice, then the tool runs or is rejected", async () => {
  const app = await chat();
  await send(app, "edit");
  await app.waitFor("id:permission-options");
  expect(app.count("id:permission-options")).toBe(1);
  for (const name of ["Allow", "Always Allow", "Reject"]) expect(app.texts()).toContain(name);
  expect(app.shows("id:send-message")).toBe(false);
  // The turn's indicator says what it waits for.
  expect(app.shows("label:Awaiting Confirmation")).toBe(true);
  await app.press("id:permission-allow-once");
  await app.waitFor("id:permission-options", { state: "gone" });
  // An edit's card opens when its diff arrives.
  await app.waitFor("id:tool-call-diff");
  await app.waitUntil(() => joined(app).includes("Edited it."));
  await app.waitFor("id:send-message");

  await send(app, "edit");
  await app.waitFor("id:permission-options");
  await app.press("id:permission-reject-once");
  await app.waitFor("id:permission-options", { state: "gone" });
  await app.waitFor("label:Rejected");
  await app.waitUntil(() => joined(app).includes("Left it unchanged."));
  await app.waitFor("id:send-message");
  expect(await outcomes(app)).toBe("Outcomes: allow-once, reject-once");
  await app.press("id:disconnect");
});

test("stopping the turn cancels a tool call waiting for permission", async () => {
  const app = await chat();
  await send(app, "run");
  await app.waitFor("id:permission-options");
  expect(app.texts()).toContain("Run Command");
  expect(app.texts()).toContain("ls -la");
  await app.press("id:stop-generation");
  // A canceled tool call with nothing to show is hidden.
  await app.waitFor("id:tool-call", { state: "gone" });
  await app.waitFor("id:send-message");
  expect(await outcomes(app)).toBe("Outcomes: cancelled");
  await app.press("id:disconnect");
});

test("a withdrawn or settled request stops waiting", async () => {
  const app = await chat();
  await send(app, "withdraw");
  await app.waitFor("id:permission-options");
  expect(app.texts()).toContain("Fetching the page");
  // The agent's `$/cancel_request` cancels the tool call and is answered with an error.
  await app.waitFor("id:permission-options", { state: "gone" });
  await app.waitFor("label:Canceled");
  await app.waitFor("id:send-message");

  // A tool call the agent reports finished no longer waits; its request is answered as cancelled.
  await send(app, "finish");
  await app.waitFor("id:permission-options");
  await app.waitFor("id:permission-options", { state: "gone" });
  await app.waitFor("id:send-message");
  expect(app.count("label:Canceled")).toBe(1);
  expect(await outcomes(app)).toBe("Outcomes: error:-32800, cancelled");
  await app.press("id:disconnect");
});

test("a request out of view shows above the message editor until it is answered or scrolled to", async () => {
  const app = await chat();
  await send(app, "busy");
  await app.waitUntil(() => joined(app).includes("Line 40"));
  await app.waitFor("id:awaiting-permission");
  expect(app.texts()).toContain("Awaiting Confirmation (2)");
  // The longest-waiting request is answered from the bar.
  expect(joined(app)).toContain("TODO");
  await app.press("id:awaiting-permission-allow-once");
  await app.waitUntil(() => !app.texts().includes("Awaiting Confirmation (2)"));
  expect(app.shows("id:awaiting-permission")).toBe(true);
  expect(joined(app)).toContain("FIXME");
  // Scrolling to the tool call shows it in place, and the bar goes.
  await app.press("id:scroll-to-permission");
  await app.waitFor("id:awaiting-permission", { state: "gone" });
  await app.press("id:permission-reject-once");
  await app.waitFor("id:send-message");
  expect(await outcomes(app)).toBe("Outcomes: allow-once, reject-once");
  await app.press("id:disconnect");
});

test("an image output shows without the raw input", async () => {
  const app = await chat();
  await send(app, "image");
  await app.waitFor("id:send-message");
  await app.press("id:tool-call-header");
  await app.waitFor("label:Image");
  expect(app.texts()).not.toContain("Raw Input:");
  await app.press("id:disconnect");
});

test("resources, audio, and undisplayable images show as Zed shows them", async () => {
  const app = await chat();
  await send(app, "contents");
  await app.waitFor("id:send-message");
  await app.press("id:tool-call-header");
  await app.waitFor("id:tool-call-output");
  // A text resource shows its text; a binary one its URI.
  expect(joined(app)).toContain("\"debug\": true");
  expect(app.texts()).toContain("file:///archive.zip");
  expect(joined(app)).toContain("Audio content is not supported.");
  expect(joined(app)).toContain("Image content could not be displayed.");
  // An image that cannot show is not an image, so the raw input stays.
  expect(app.texts()).toContain("Raw Input:");
  await app.press("id:disconnect");
});

test("an edit's card opens again when its diff changes", async () => {
  const app = await chat();
  await send(app, "revise");
  await app.waitFor("id:tool-call-diff");
  await app.press("id:tool-call-header");
  await app.waitFor("id:tool-call-diff", { state: "gone" });
  await app.waitFor("id:tool-call-diff");
  await app.waitFor("id:send-message");
  await app.press("id:disconnect");
});

test("a request with an unsupported option kind is refused and shows nothing", async () => {
  const app = await chat();
  await send(app, "unsupported");
  await app.waitFor("id:send-message");
  expect(app.shows("id:tool-call")).toBe(false);
  expect(await outcomes(app)).toBe("Outcomes: error:-32602");
  await app.press("id:disconnect");
});

test("an update for an unknown tool call shows a failed tool call", async () => {
  const app = await chat();
  await send(app, "missing");
  await app.waitFor("id:tool-call");
  await app.waitFor("id:send-message");
  expect(app.texts()).toContain("Tool call not found");
  expect(app.shows("label:Failed")).toBe(true);
  await app.press("id:disconnect");
});
