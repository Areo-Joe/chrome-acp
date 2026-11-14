import { expect, open, test, type App } from "nsh/test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { imageFixtures } from "./fixtures/images";
const texts = (app: App) => app.texts().join("\n");
let sequence = 0;
type Stats = { imageFixtureDirectory: string; prompts: { sessionId: string; content: ContentBlock[] }[]; cancels: string[] };
async function control(app: App, token: string, reason?: string, id = "test-session"): Promise<Stats> {
  const request = ++sequence;
  await app.host.send("queue-control", { request, token, reason, id });
  const result = () => {
    const text = app.texts().find(text => text.startsWith("QUEUE_CONTROL:"));
    return text ? JSON.parse(text.slice(14)) as { request: number; data: Stats } : null;
  };
  await app.waitUntil(() => result()?.request === request);
  const value = result()!.data;
  await app.host.send("queue-control-clear");
  return value;
}
async function ready(app: App) { await app.waitFor("id:message-input"); await app.waitFor("id:session-loading", { state: "gone" }); }
async function connect(token = "images") {
  const app = await open("../QueueTestApp.tsx", { width: 420, height: 700, network: "live", clock: {},
    host: { params: { queueMockUrl: "http://127.0.0.1:19439" } } });
  await app.host.send("queue-connect", { address: "ws://127.0.0.1:19439/acp", token, directory: "/workspace" });
  await ready(app); return app;
}
async function paste(app: App) { await app.paste("id:message-input", { files: ["tests/fixtures/red.png"] }); await app.waitFor("id:draft-images"); }
const image = { type: "image", data: imageFixtures.red.normalized, mimeType: "image/png", uri: "zed:///agent/pasted-image?name=Image" };

test("native image bridge: clipboard bytes normalize, display and send without host mocks", async () => {
  const app = await connect(); await paste(app);
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[0].content).toEqual([image]);
  expect(app.count("id:user-image")).toBe(1);
  await app.screenshot("/tmp/nsh-images-native.png");
  await app.press("id:disconnect");
}, 90000);

test("native image bridge: queue editing retains the image and existing draft", async () => {
  const app = await connect();
  await app.paste("id:message-input", { text: "queue-root" }); await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Running queue-root"));
  await paste(app); await app.press("id:send-message"); await app.waitFor("id:queue-entry-0");
  await app.paste("id:message-input", { text: "existing" }); await app.press("id:queue-edit-0");
  expect(app.value("id:message-input")).toBe("existing\n\n\ufffc");
  await app.keyboard.press("mod+shift+enter");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[1].content).toEqual([{ type: "text", text: "existing\n\n" }, image]);
  await app.press("id:disconnect");
}, 90000);

test("native image bridge: automatic queue delivery follows v1 completion", async () => {
  const app = await connect();
  await app.paste("id:message-input", { text: "queue-root" }); await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Running queue-root"));
  await paste(app); await app.press("id:send-message"); await app.waitFor("id:queue-entry-0");
  expect((await control(app, "images")).prompts.length).toBe(1);
  await control(app, "images", "end_turn");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[1].content).toEqual([image]);
  await app.press("id:disconnect");
}, 90000);

test("native image bridge: authentication preserves image data for explicit resend", async () => {
  const app = await connect("auth-images"); await paste(app); await app.press("id:send-message");
  await app.waitFor("id:authenticate-thread"); await app.press("id:authenticate-thread");
  await app.press("id:auth-method-browser-login"); await ready(app);
  expect(app.shows("id:draft-images")).toBe(true);
  expect((await control(app, "auth-images")).prompts.length).toBe(1);
  await app.press("id:send-message"); await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "auth-images")).prompts[1].content).toEqual([image]);
  await app.press("id:disconnect");
}, 90000);

test("native image bridge: restored history renders image bytes after view eviction", async () => {
  const token = "history-retention-images"; const app = await connect(token); await paste(app);
  await app.press("id:send-message"); await app.waitUntil(() => texts(app).includes("Received 1 images"));
  for (let index = 0; index < 6; index++) { await app.press("id:new-session"); await ready(app); }
  await app.press("id:show-sessions"); await app.press("id:history-open-new-1"); await ready(app);
  expect(app.count("id:user-image")).toBe(1);
  expect(app.shows("id:draft-images")).toBe(false);
  await app.press("id:disconnect");
}, 90000);


test("native image bridge: deletion undo and redo restore the full image source", async () => {
  const app = await connect(); await paste(app);
  await app.wait(350);
  await app.keyboard.press("mod+a"); await app.keyboard.press("backspace");
  await app.waitFor("id:draft-images", { state: "gone" });
  await app.keyboard.press("mod+z"); await app.waitFor("id:draft-images"); await app.wait(50);
  expect(app.value("id:message-input")).toBe("\ufffc ");
  await app.keyboard.press("mod+shift+z"); await app.waitFor("id:draft-images", { state: "gone" }); await app.wait(50);
  await app.keyboard.press("mod+z"); await app.waitFor("id:draft-images"); await app.wait(50);
  await app.wait(350);
  await app.press("label:Remove Image"); await app.waitFor("id:draft-images", { state: "gone" }); await app.wait(50);
  await app.keyboard.press("mod+z"); await app.waitFor("id:draft-images"); await app.wait(50);
  await app.press("id:send-message"); await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[0].content).toEqual([image]);
  await app.press("id:disconnect");
}, 90000);


test("native image bridge: external image content accepts missing or incorrect extensions", async () => {
  const chat = await connect();
  const directory = (await control(chat, "images")).imageFixtureDirectory;
  await chat.press("id:disconnect");
  const app = await open("../ImageBridgeTestApp.tsx", { width: 420, height: 700, host: { params: { directory } } });
  await app.press("id:inspect");
  await app.waitUntil(() => app.texts().some(text => text.startsWith("[{")));
  const values = JSON.parse(app.texts().find(text => text.startsWith("[{"))!);
  expect(values).toEqual([...["image-without-extension", "image-wrong.jpg"].map(name =>
    ({ ...image, uri: `zed:///agent/pasted-image?name=${name}` })), null]);
}, 90000);


test("native image bridge: adjacent identical markers retain distinct sources through undo", async () => {
  const app = await connect(); await paste(app);
  await app.paste("id:message-input", { files: ["tests/fixtures/blue.png"] });
  await app.waitFor("id:draft-images");
  expect(app.value("id:message-input")).toBe("\ufffc \ufffc ");
  await app.wait(350);
  await app.keyboard.press("backspace"); await app.keyboard.press("backspace");
  expect(app.value("id:message-input")).toBe("\ufffc ");
  await app.keyboard.press("mod+z"); await app.wait(50);
  expect(app.value("id:message-input")).toBe("\ufffc \ufffc ");
  await app.press("id:send-message"); await app.waitUntil(() => texts(app).includes("Received 2 images"));
  expect((await control(app, "images")).prompts[0].content).toEqual([
    image, { type: "text", text: " " }, { ...image, data: imageFixtures.blue.normalized },
  ]);
  await app.press("id:disconnect");
}, 90000);


test("native image bridge: ordinary marker text never sends a deleted image", async () => {
  const app = await connect(); await paste(app);
  await app.wait(350);
  await app.keyboard.press("mod+a"); await app.keyboard.press("backspace");
  await app.waitFor("id:draft-images", { state: "gone" });
  await app.paste("id:message-input", { text: "\ufffc " });
  expect(app.shows("id:draft-images")).toBe(false);
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Echo: \ufffc"));
  expect((await control(app, "images")).prompts[0].content).toEqual([{ type: "text", text: "\ufffc" }]);
  await app.press("id:disconnect");
}, 90000);


test("native image bridge: redo restores the original post-image caret after later prefix editing", async () => {
  const app = await connect(); await paste(app); await app.wait(350);
  await app.keyboard.press("mod+left"); await app.keyboard.press("x");
  expect(app.value("id:message-input")).toBe("x\ufffc ");
  await app.keyboard.press("mod+z"); await app.wait(50);
  await app.keyboard.press("mod+z"); await app.wait(50);
  await app.keyboard.press("mod+shift+z"); await app.wait(50);
  await app.keyboard.press("y");
  expect(app.value("id:message-input")).toBe("\ufffc y");
  await app.press("id:send-message"); await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[0].content).toEqual([image, { type: "text", text: " y" }]);
  await app.press("id:disconnect");
}, 90000);
