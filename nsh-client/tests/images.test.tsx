import { expect, open, test, type App } from "nsh/test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { fixtureBytes, imageFixtures } from "./fixtures/images";

const texts = (app: App) => app.texts().join("\n");
let sequence = 0;
type Stats = { prompts: { sessionId: string; content: ContentBlock[] }[]; cancels: string[] };
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
async function ready(app: App) {
  await app.waitFor("id:message-input");
  await app.waitFor("id:session-loading", { state: "gone" });
}
const normalizer = (value: unknown) => {
  const input = value as { data?: string; path?: string; inspect?: boolean };
  const fixture = Object.values(imageFixtures).find(fixture => fixture.raw === input.data)
    ?? (input.path?.endsWith("red.png") ? imageFixtures.red : undefined);
  if (input.inspect) return fixture ? { supported: true, data: fixture.raw } : { supported: false };
  if (!fixture) throw new Error("Failed to convert image");
  return { data: fixture.normalized, mimeType: "image/png", width: fixture.width, height: fixture.height };
};
async function connect(token = "images", normalize: (value: unknown) => unknown = normalizer) {
  const app = await open("../QueueTestApp.tsx", { width: 420, height: 1000, network: "live", clock: {}, platform: "macos",
    host: { params: { queueMockUrl: "http://127.0.0.1:19437" }, handlers: { "image.normalize": normalize } } });
  await app.clear("id:ws-address");
  await app.type("id:ws-address", "ws://127.0.0.1:19437/acp");
  await app.type("id:token", token);
  await app.type("id:working-directory", "/workspace");
  await app.press("id:connect"); await ready(app);
  return app;
}
async function pick(app: App, names: ("red" | "blue")[] = ["red"]) {
  app.onPick(() => names.map(name => ({ name: `${name}.png`, type: "image/png", data: fixtureBytes(name) })));
  await app.press("id:add-images");
  await app.waitFor("id:draft-images");
}
async function send(app: App, text: string) {
  await app.paste("id:message-input", { text });
  await app.press("id:send-message");
}
const imageBlock = (name: "red" | "blue", label = `${name}.png`) => ({ type: "image", data: imageFixtures[name].normalized,
  mimeType: "image/png", uri: `zed:///agent/pasted-image?name=${label}` });

test("v1 images: capability controls the picker and unsupported image paste never changes the draft", async () => {
  const app = await connect("images-disabled");
  expect(app.shows("id:add-images")).toBe(false);
  await app.paste("id:message-input", { files: ["tests/fixtures/red.png"] });
  expect(app.shows("id:draft-images")).toBe(false);
  expect(app.value("id:message-input")).toBe("");
  expect((await control(app, "images-disabled")).prompts).toEqual([]);
  await app.press("id:disconnect");
});

test("v1 images: image-only picker sends normalized PNG blocks in selection order and deduplicates echoes", async () => {
  const app = await connect();
  await pick(app, ["red", "blue"]);
  expect(app.picks()[0].multiple).toBe(true);
  expect(app.picks()[0].format).toBe("current");
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 2 images"));
  const stats = await control(app, "images");
  expect(stats.prompts[0].content).toEqual([imageBlock("red"), { type: "text", text: " " }, imageBlock("blue")]);
  expect(app.shows("id:draft-images")).toBe(false);
  expect(app.count("id:user-image")).toBe(2);
  await app.press("id:disconnect");
});

test("v1 images: clipboard text takes precedence over accompanying bitmap files", async () => {
  const app = await connect();
  await app.paste("id:message-input", { text: "clipboard-text", files: ["tests/fixtures/red.png"] });
  expect(app.value("id:message-input")).toBe("clipboard-text");
  expect(app.shows("id:draft-images")).toBe(false);
  await app.press("id:disconnect");
});

test("v1 images: bitmap and image paths in one paste add one Image attachment", async () => {
  const app = await connect();
  await app.paste("id:message-input", { files: ["tests/fixtures/red.png"], uris: ["file:///tmp/red.png"] });
  await app.waitFor("id:draft-images");
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[0].content).toEqual([imageBlock("red", "Image")]);
  await app.press("id:disconnect");
});

test("v1 images: removing a selected attachment preserves the other image and text", async () => {
  const app = await connect();
  await app.paste("id:message-input", { text: "describe " });
  await pick(app, ["red", "blue"]);
  await app.press("label:Remove red.png");
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  const content = (await control(app, "images")).prompts[0].content;
  expect(content.filter(block => block.type === "image")).toEqual([imageBlock("blue")]);
  expect(content.filter(block => block.type === "text").map(block => block.text).join("")).toContain("describe ");
  await app.press("id:disconnect");
});

test("v1 images: queue snapshots and editing preserve both image blocks and the existing draft", async () => {
  const app = await connect();
  await send(app, "queue-root");
  await app.waitUntil(() => texts(app).includes("Running queue-root"));
  await pick(app);
  await app.press("id:send-message");
  await app.waitFor("id:queue-entry-0");
  await app.paste("id:message-input", { text: "existing" });
  await app.press("id:queue-edit-0");
  expect(app.value("id:message-input")).toBe("existing\n\n\ufffc");
  expect(app.shows("id:draft-images")).toBe(true);
  await app.keyboard.press("mod+shift+enter");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  const stats = await control(app, "images");
  expect(stats.prompts[1].content).toEqual([{ type: "text", text: "existing\n\n" }, imageBlock("red")]);
  expect(stats.cancels).toEqual(["test-session"]);
  await app.press("id:disconnect");
}, 90000);

test("v1 images: queued images automatically send only after the old v1 completion", async () => {
  const app = await connect();
  await send(app, "queue-root");
  await pick(app);
  await app.press("id:send-message");
  await app.waitFor("id:queue-entry-0");
  expect((await control(app, "images")).prompts.length).toBe(1);
  await control(app, "images", "end_turn");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[1].content).toEqual([imageBlock("red")]);
  await app.press("id:disconnect");
});

test("v1 images: typing into an image queue preview restores its source without flattening it", async () => {
  const app = await connect();
  await send(app, "queue-root"); await pick(app); await app.press("id:send-message");
  await app.waitFor("id:queue-entry-0"); await app.press("id:queue-focus-0");
  await app.keyboard.press("x");
  await app.waitFor("id:message-queue", { state: "gone" });
  expect(app.shows("id:draft-images")).toBe(true);
  expect(app.value("id:message-input")!.replace("\ufffc", "")).toBe("x");
  await app.keyboard.press("mod+shift+enter");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[1].content.filter(block => block.type === "image")).toEqual([imageBlock("red")]);
  await app.press("id:disconnect");
});

test("v1 images: pasting a bitmap into a queued preview restores then inserts it at that cursor", async () => {
  const app = await connect();
  await send(app, "queue-root"); await pick(app); await app.press("id:send-message");
  await app.waitFor("id:queue-entry-0");
  await app.paste("id:queue-input-0", { files: ["tests/fixtures/blue.png"] });
  await app.waitFor("id:message-queue", { state: "gone" });
  await app.keyboard.press("mod+shift+enter");
  await app.waitUntil(() => texts(app).includes("Received 2 images"));
  expect((await control(app, "images")).prompts[1].content.filter(block => block.type === "image"))
    .toEqual([imageBlock("blue", "Image"), imageBlock("red")]);
  await app.press("id:disconnect");
});

test("v1 images: conversion failure removes its mention and allows the remaining text to send", async () => {
  const app = await connect("images", value => {
    if ((value as { inspect?: boolean }).inspect) return normalizer(value);
    throw new Error("Failed to convert image");
  });
  await app.paste("id:message-input", { text: "keep-me" });
  app.onPick(() => [{ name: "red.png", type: "image/png", data: fixtureBytes("red") }]);
  await app.press("id:add-images");
  await app.waitFor("id:thread-error");
  await app.waitFor("id:draft-images", { state: "gone" });
  expect(app.value("id:message-input")).toContain("keep-me");
  expect((await control(app, "images")).prompts).toEqual([]);
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Echo: keep-me"));
  await app.press("id:disconnect");
});

test("v1 images: authentication restores the failed image submission without automatic replay", async () => {
  const app = await connect("auth-images");
  await pick(app);
  await app.press("id:send-message");
  await app.waitFor("id:authenticate-thread");
  await app.press("id:authenticate-thread");
  await app.press("id:auth-method-browser-login");
  await ready(app);
  expect(app.shows("id:draft-images")).toBe(true);
  expect((await control(app, "auth-images")).prompts.length).toBe(1);
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "auth-images")).prompts[1].content).toEqual([imageBlock("red")]);
  await app.press("id:disconnect");
}, 90000);

test("v1 images: file URI paste normalizes the local image through the host", async () => {
  const app = await connect();
  await app.paste("id:message-input", { uris: ["file:///tmp/red.png"] });
  await app.waitFor("id:draft-images");
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  expect((await control(app, "images")).prompts[0].content).toEqual([imageBlock("red")]);
  await app.press("id:disconnect");
});

test("v1 images: draft and paused queue survive idle eviction and reopen with independent image sources", async () => {
  const token = "history-retention-images";
  const app = await connect(token);
  await send(app, "queue-root");
  await pick(app, ["red"]);
  await app.press("id:send-message");
  await app.waitFor("id:queue-entry-0");
  await app.press("id:stop-generation");
  await app.waitUntil(() => texts(app).includes("Finished queue-root"));
  await pick(app, ["blue"]);
  for (let index = 0; index < 6; index++) { await app.press("id:new-session"); await ready(app); }
  await app.press("id:show-sessions");
  expect(app.shows("id:open-chat-1")).toBe(false);
  await app.press("id:history-open-new-1"); await ready(app);
  expect(app.shows("id:draft-images")).toBe(true);
  expect(app.shows("id:queue-entry-0")).toBe(true);
  expect((await control(app, token, undefined, "new-1")).prompts.length).toBe(1);
  await app.press("id:queue-edit-0");
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 2 images"));
  const blocks = (await control(app, token, undefined, "new-1")).prompts[1].content;
  expect(blocks.filter(block => block.type === "image")).toEqual([imageBlock("blue"), imageBlock("red")]);
  await app.press("id:disconnect");
}, 90000);

test("v1 images: loaded history renders image blocks as images", async () => {
  const token = "history-retention-images";
  const app = await connect(token);
  await pick(app);
  await app.press("id:send-message");
  await app.waitUntil(() => texts(app).includes("Received 1 images"));
  for (let index = 0; index < 6; index++) { await app.press("id:new-session"); await ready(app); }
  await app.press("id:show-sessions");
  await app.press("id:history-open-new-1"); await ready(app);
  expect(app.count("id:user-image")).toBe(1);
  expect(app.shows("id:draft-images")).toBe(false);
  await app.press("id:disconnect");
}, 90000);

const modelState = (app: App) => JSON.parse(app.texts().find(text => text.startsWith('{"prompts":'))!);
async function model() {
  const app = await open("fixtures/images-state.tsx");
  await app.waitFor("text:Phase ready");
  return app;
}

test("v1 images: submission waits for conversion and resolves the current editor text", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:send");
  expect(modelState(app).loading).toBe(true);
  expect(modelState(app).prompts).toEqual([]);
  await app.press("id:text"); await app.press("id:complete");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("red"), { type: "text", text: " describe" }]);
});

test("v1 images: a removed pending image never reappears when conversion completes", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:complete");
  expect(modelState(app).images).toEqual([]);
  await app.press("id:text"); await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "describe" }]);
});

test("v1 images: conversion rejection cancels the pending send and releases the source", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:send"); await app.press("id:fail");
  await app.waitUntil(() => !modelState(app).loading);
  expect(modelState(app).images).toEqual([]);
  expect(modelState(app).error).toBe("Conversion failed");
  expect(modelState(app).prompts).toEqual([]);
});

test("v1 images: disposed views cannot send after their pending conversion completes", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:send"); await app.press("id:dispose"); await app.press("id:complete");
  expect(modelState(app).prompts).toEqual([]);
});

test("v1 images: queue intent survives a turn completing while content resolves, as Zed queue_message does", async () => {
  const app = await model();
  await app.press("id:root");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  await app.press("id:add"); await app.press("id:send"); await app.press("id:complete-root"); await app.press("id:complete");
  await app.waitUntil(() => modelState(app).queue.length === 1);
  expect(modelState(app).prompts.length).toBe(1);
  expect(modelState(app).queue[0]).toEqual([imageBlock("red")]);
  await app.press("id:send-now");
  await app.waitUntil(() => modelState(app).prompts.length === 2);
  expect(modelState(app).prompts[1]).toEqual([imageBlock("red")]);
});

test("v1 images: sending resolves its captured sources and renders later mentions as text", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:send"); await app.press("id:add"); await app.press("id:complete");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).loading).toBe(false);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("red"), { type: "text", text: " [@red.png](zed:///agent/pasted-image?name=red.png)" }]);
  await app.press("id:complete");
  expect(modelState(app).prompts.length).toBe(1);
});

test("v1 images: failed Send Now cancellation restores the exact queued image source", async () => {
  const app = await model();
  await app.press("id:root"); await app.waitUntil(() => modelState(app).prompts.length === 1);
  await app.press("id:stage-queue"); await app.press("id:send-now");
  await app.waitUntil(() => !modelState(app).loading);
  expect(modelState(app).queue).toEqual([[imageBlock("red")]]);
  expect(modelState(app).prompts.length).toBe(1);
  expect(modelState(app).error).toBe("Cancellation failed");
});

test("v1 images: an incoming image renders its data rather than fetching its source URI", async () => {
  const app = await model();
  await app.press("id:agent-image");
  expect(modelState(app).reply).toEqual([`![image](data:image/png;base64,${imageFixtures.red.normalized})`]);
});


test("v1 images: undo restores a removed source after conversion completed while absent", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:complete");
  await app.press("id:undo");
  expect(modelState(app).images.length).toBe(1);
  expect(modelState(app).images[0].pending).toBe(false);
  await app.press("id:redo"); expect(modelState(app).images).toEqual([]);
  await app.press("id:undo"); await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("red")]);
});
test("v1 images: failure while removed releases the source from undo and redo", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:fail");
  await app.waitUntil(() => modelState(app).error === "Conversion failed");
  await app.press("id:undo");
  expect(modelState(app).images).toEqual([]);
  expect(modelState(app).draft).toBe("[@red.png](zed:///agent/pasted-image?name=red.png) ");
  await app.press("id:redo");
  expect(modelState(app).images).toEqual([]);
  expect(modelState(app).draft).toBe(" ");
});

test("v1 images: failure removes only its own mention and preserves text and other images", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:add"); await app.press("id:text");
  const survivingId = modelState(app).images[1].id;
  await app.press("id:fail");
  await app.waitUntil(() => modelState(app).images.length === 1);
  expect(modelState(app).images[0].id).toBe(survivingId);
  expect(modelState(app).draft).toBe(" \ufffc describe");
  await app.press("id:undo");
  expect(modelState(app).images.length).toBe(1);
  expect(modelState(app).draft).toBe("[@red.png](zed:///agent/pasted-image?name=red.png) \ufffc describe");
  await app.press("id:redo"); await app.press("id:complete"); await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("red"), { type: "text", text: " describe" }]);
});
test("v1 images: undo restores a pending source and waits for its conversion", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:undo");
  await app.press("id:send"); expect(modelState(app).loading).toBe(true);
  await app.press("id:complete");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("red")]);
});


test("v1 images: external non-images are filtered before inserting a placeholder", async () => {
  const app = await connect("images", () => ({ supported: false }));
  await app.paste("id:message-input", { uris: ["file:///tmp/readme"] });
  await app.wait(100);
  expect(app.value("id:message-input")).toBe("");
  expect(app.shows("id:draft-images")).toBe(false);
  expect(app.shows("id:thread-error")).toBe(false);
  await app.press("id:disconnect");
});


test("v1 images: plain marker paste never restores a deleted attachment", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:complete");
  await app.press("id:paste-marker");
  expect(modelState(app).images).toEqual([]);
  await app.press("id:undo"); expect(modelState(app).images).toEqual([]);
  await app.press("id:undo"); expect(modelState(app).images.length).toBe(1);
  await app.press("id:redo"); await app.press("id:redo");
  expect(modelState(app).images).toEqual([]);
  await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "\ufffc" }]);
});


test("v1 images: selected image replaced by identical plain text loses its source identity", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:complete");
  await app.press("id:replace-marker");
  expect(modelState(app).draft).toBe("\ufffc ");
  expect(modelState(app).images).toEqual([]);
  await app.press("id:undo"); expect(modelState(app).images.length).toBe(1);
  await app.press("id:redo"); expect(modelState(app).images).toEqual([]);
  await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "\ufffc" }]);
});


test("v1 images: same-value change with a selected image remains undoable", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:complete");
  await app.press("id:native-replace-marker");
  expect(modelState(app).images).toEqual([]);
  await app.press("id:undo"); expect(modelState(app).images.length).toBe(1);
  await app.press("id:redo"); expect(modelState(app).images).toEqual([]);
  await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "\ufffc" }]);
});


test("v1 images: batch insertion awaits each conversion and uses the current selection", async () => {
  const app = await model();
  await app.press("id:add-batch");
  expect(modelState(app).conversions).toEqual(["red.png"]);
  expect(modelState(app).images.length).toBe(1);
  await app.press("id:select-start"); await app.press("id:type-during");
  await app.press("id:complete");
  await app.waitUntil(() => modelState(app).conversions.length === 2);
  expect(modelState(app).draft).toBe("during\ufffc \ufffc ");
  expect(modelState(app).images.map((image: { pending: boolean }) => image.pending)).toEqual([true, false]);
  // Test history uses Zed's zero grouping interval: the second insertion owns
  // its own transaction, after the intervening text edit.
  await app.press("id:undo");
  expect(modelState(app).draft).toBe("during\ufffc ");
  expect(modelState(app).images.length).toBe(1);
  await app.press("id:redo"); await app.press("id:complete"); await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "during" }, imageBlock("blue"), { type: "text", text: " " }, imageBlock("red")]);
});

test("v1 images: batch failure cleans up before inserting the next image", async () => {
  const app = await model();
  await app.press("id:add-batch"); await app.press("id:fail");
  await app.waitUntil(() => modelState(app).conversions.length === 2);
  expect(modelState(app).error).toBe("Conversion failed");
  expect(modelState(app).draft).toBe(" \ufffc ");
  expect(modelState(app).images.length).toBe(1);
  await app.press("id:complete"); await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("blue")]);
});

test("v1 images: disposal during a batch prevents later conversions and insertions", async () => {
  const app = await model();
  await app.press("id:add-batch"); await app.press("id:dispose"); await app.press("id:complete");
  expect(modelState(app).conversions).toEqual(["red.png"]);
  expect(modelState(app).images.length).toBe(1);
  expect(modelState(app).prompts).toEqual([]);
});


test("v1 images: sending during a batch never serializes the next pending placeholder", async () => {
  const app = await model();
  await app.press("id:add-batch"); await app.press("id:send"); await app.press("id:complete");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).conversions).toEqual(["red.png", "blue.png"]);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("red"), { type: "text", text: " [@blue.png](zed:///agent/pasted-image?name=blue.png)" }]);
  expect(modelState(app).draft).toBe("");
  await app.press("id:complete");
  expect(modelState(app).prompts.length).toBe(1);
  expect(modelState(app).images).toEqual([]);
});

test("v1 images: queue resolution uses the same captured source map during a batch", async () => {
  const app = await model();
  await app.press("id:root"); await app.waitUntil(() => modelState(app).prompts.length === 1);
  await app.press("id:add-batch"); await app.press("id:send"); await app.press("id:complete");
  await app.waitUntil(() => modelState(app).queue.length === 1);
  const content = [imageBlock("red"), { type: "text", text: " [@blue.png](zed:///agent/pasted-image?name=blue.png)" }];
  expect(modelState(app).queue[0]).toEqual(content);
  await app.press("id:complete"); await app.press("id:complete-root");
  await app.waitUntil(() => modelState(app).prompts.length === 2);
  expect(modelState(app).prompts[1]).toEqual(content);
});

test("v1 images: captured source failure aborts sending even as the batch continues", async () => {
  const app = await model();
  await app.press("id:add-batch"); await app.press("id:send"); await app.press("id:fail");
  await app.waitUntil(() => !modelState(app).loading && modelState(app).conversions.length === 2);
  expect(modelState(app).prompts).toEqual([]);
  expect(modelState(app).images.length).toBe(1);
  await app.press("id:complete");
  expect(modelState(app).prompts).toEqual([]);
  await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([imageBlock("blue")]);
});


test("v1 images: removed registrations are resolved before building current editor contents", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:text"); await app.press("id:send");
  expect(modelState(app).loading).toBe(true);
  expect(modelState(app).prompts).toEqual([]);
  await app.press("id:complete");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "describe" }]);
});

test("v1 images: rejecting a captured removed registration aborts the send without clearing text", async () => {
  const app = await model();
  await app.press("id:add"); await app.press("id:remove"); await app.press("id:text"); await app.press("id:send");
  await app.press("id:fail");
  await app.waitUntil(() => !modelState(app).loading);
  expect(modelState(app).prompts).toEqual([]);
  expect(modelState(app).draft).toBe(" describe");
  await app.press("id:send");
  await app.waitUntil(() => modelState(app).prompts.length === 1);
  expect(modelState(app).prompts[0]).toEqual([{ type: "text", text: "describe" }]);
});
