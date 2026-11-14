import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../../acp/client";
import type { Connection } from "../../state/connection";
import { createComposer } from "../../state/composer";
import { imageFixtures } from "./images";
function App() {
  const prompts = signal<ContentBlock[][]>([]);
  const conversions = signal<string[]>([]);
  const pendingImages: { complete: () => void; fail: () => void }[] = [];
  let cancelFails = false;
  const source = { type: "image" as const, data: imageFixtures.red.normalized,
    mimeType: "image/png", uri: "zed:///agent/pasted-image?name=red.png" };
  let completeRoot!: () => void;
  const client = {
    agentInfo: { name: "mock" }, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [],
    configOptions: null, sessionModes: null, availableCommands: [], resumesWithoutHistory: false,
    setSessionUpdateHandler: () => {}, setPermissionHandler: () => {}, setConfigOptionsChangedHandler: () => {},
    setSessionModesChangedHandler: () => {}, setAvailableCommandsChangedHandler: () => {}, setSessionCreatedHandler: () => {},
    createSession: async () => "s", cancel: async () => { if (cancelFails) throw new Error("Cancellation failed"); },
    prompt: (content: ContentBlock[]) => {
      prompts.update(values => [...values, content]);
      return content[0]?.type === "text" && content[0].text === "queue-root"
        ? new Promise<PromptResponse>(resolve => { completeRoot = () => resolve({ stopReason: "end_turn" }); })
        : Promise.resolve({ stopReason: "end_turn" });
    },
  } as unknown as AcpClient;
  const connection = { getClient: () => client, error: signal<string | null>(null), clearError: () => {} } as unknown as Connection;
  const state = createComposer(connection, { historyInterval: 0, imageLoader: (_source, name = "Image") => new Promise((resolve, reject) => {
    conversions.update(names => [...names, name]);
    const fixture = name === "blue.png" ? imageFixtures.blue : imageFixtures.red;
    pendingImages.push({ complete: () => resolve({ name, block: { ...source, data: fixture.normalized, uri: `zed:///agent/pasted-image?name=${name}` } }),
      fail: () => reject(new Error("Conversion failed")) });
  }) });
  return <View class="flex-1">
    <Text>{`Phase ${state.phase()}`}</Text>
    <Text>{JSON.stringify({ prompts: prompts(), conversions: conversions(), draft: state.draft(), images: state.savedInput().images.map(image => ({ id: image.id, pending: !!image.pending })),
      loading: state.queueLoading(), queue: state.queued().map(entry => entry.content), error: state.thread.error()?.message,
      reply: state.thread.entries().flatMap(entry => entry.kind === "assistant" ? entry.chunks().map(chunk => chunk.markdown()) : []) })}</Text>
    <Button testID="add" onPress={() => state.addImages([new File([], "red.png", { type: "image/png" })])}><Text>Add image</Text></Button>
    <Button testID="add-batch" onPress={() => state.addImages([new File([], "red.png"), new File([], "blue.png")])}><Text>Add image batch</Text></Button>
    <Button testID="select-start" onPress={() => state.select({ start: 0, end: 0 })}><Text>Select start</Text></Button>
    <Button testID="type-during" onPress={() => state.pasteText("during")}><Text>Type during conversion</Text></Button>
    <Button testID="native-replace-marker" onPress={() => {
      const value = state.draft();
      state.select({ start: 0, end: value.length });
      state.beginNativeEdit({ key: value });
      state.changeText(value); state.select({ start: value.length, end: value.length });
    }}><Text>Native identical replacement</Text></Button>
    <Button testID="replace-marker" onPress={() => {
      state.select({ start: 0, end: state.draft().length }); state.pasteText(state.draft());
    }}><Text>Replace with same plain text</Text></Button>
    <Button testID="paste-marker" onPress={() => state.draft.set("\ufffc ")}><Text>Paste plain marker</Text></Button>
    <Button testID="undo" onPress={state.undo}><Text>Undo</Text></Button>
    <Button testID="redo" onPress={state.redo}><Text>Redo</Text></Button>
    <Button testID="send" onPress={state.submit}><Text>Send</Text></Button>
    <Button testID="text" onPress={() => state.draft.set(`${state.draft()}describe`)}><Text>Edit text</Text></Button>
    <Button testID="remove" onPress={() => { const image = state.savedInput().images[0]; if (image) state.removeImage(image.id); }}><Text>Remove image</Text></Button>
    <Button testID="complete" onPress={() => pendingImages.shift()?.complete()}><Text>Complete conversion</Text></Button>
    <Button testID="fail" onPress={() => pendingImages.shift()?.fail()}><Text>Fail conversion</Text></Button>
    <Button testID="dispose" onPress={() => { void state.dispose(); }}><Text>Dispose</Text></Button>
    <Button testID="root" onPress={() => { state.draft.set("queue-root"); state.submit(); }}><Text>Start root</Text></Button>
    <Button testID="complete-root" onPress={() => completeRoot()}><Text>Complete root</Text></Button>
    <Button testID="send-now" onPress={() => state.sendNow(state.queued()[0].id)}><Text>Send queued</Text></Button>
    <Button testID="stage-queue" onPress={() => { state.restoreQueue([[source]]); cancelFails = true; }}><Text>Queue image with failing cancellation</Text></Button>
    <Button testID="agent-image" onPress={() => state.thread.handleUpdate({ sessionUpdate: "agent_message_chunk", content: source })}><Text>Receive agent image</Text></Button>
  </View>;
}
mount(App);
