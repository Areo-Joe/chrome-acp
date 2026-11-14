import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../../acp/client";
import type { Connection } from "../../state/connection";
import { createComposer } from "../../state/composer";
function App() {
  const prompts = signal<string[]>([]);
  const cancels = signal(0);
  let mode: "sync" | "async" | "hold" = "hold";
  const pending: { resolve: (response: PromptResponse) => void; done: boolean }[] = [];
  const client = {
    agentInfo: { name: "mock" }, agentCapabilities: {}, authMethods: [],
    configOptions: null, sessionModes: null, availableCommands: [], resumesWithoutHistory: false,
    setSessionUpdateHandler: () => {}, setPermissionHandler: () => {}, setConfigOptionsChangedHandler: () => {},
    setSessionModesChangedHandler: () => {}, setAvailableCommandsChangedHandler: () => {}, setSessionCreatedHandler: () => {},
    createSession: async () => "s",
    prompt: (content: ContentBlock[]) => {
      prompts.update(values => [...values, content.map(block => block.type === "text" ? block.text : "other").join("")]);
      return new Promise<PromptResponse>(resolve => pending.push({ resolve, done: false }));
    },
    cancel: () => {
      cancels.update(value => value + 1);
      if (mode === "sync") throw new Error("Cancel failed synchronously");
      if (mode === "async") return Promise.reject(new Error("Cancel failed asynchronously"));
      return Promise.resolve();
    },
  } as unknown as AcpClient;
  const connection = { getClient: () => client, error: signal<string | null>(null), clearError: () => {} } as unknown as Connection;
  const state = createComposer(connection);
  const submit = (text: string) => { state.draft.set(text); state.submit(); };
  const finish = (index: number, stopReason: PromptResponse["stopReason"] = "end_turn") => {
    const turn = pending[index]; if (turn && !turn.done) { turn.done = true; turn.resolve({ stopReason }); }
  };
  return <View class="flex-1">
    <Text>{`Phase ${state.phase()}`}</Text>
    <Text>{JSON.stringify({ prompts: prompts(), cancels: cancels(), queue: state.queued().map(entry => ({ id: entry.id, content: entry.content })), loading: state.queueLoading(), generating: state.thread.generating(), draft: state.draft(), fast: state.canFastTrack() })}</Text>
    <Text>{state.thread.error()?.message ?? "No error"}</Text>
    <Button testID="first" onPress={() => submit("root")}><Text>First</Text></Button>
    <Button testID="a" onPress={() => submit("a")}><Text>Queue a</Text></Button>
    <Button testID="b" onPress={() => submit("b")}><Text>Queue b</Text></Button>
    <Button testID="now" onPress={() => state.sendNow(1)}><Text>Send second now</Text></Button>
    <Button testID="fast" onPress={state.submit}><Text>Fast track</Text></Button>
    <Button testID="immediate" onPress={state.sendImmediately}><Text>Send immediately</Text></Button>
    <Button testID="stage" onPress={() => state.draft.set("interrupt draft")}><Text>Stage draft</Text></Button>
    <Button testID="cursor" onPress={() => {
      state.restoreQueue([[{ type: "text", text: "你🙂好" }]]);
      state.draft.set("prefix");
      state.editQueued(0, { text: "X", offset: 3 });
    }}><Text>Insert at restored cursor</Text></Button>
    <Button testID="sync" onPress={() => { mode = "sync"; }}><Text>Sync failure</Text></Button>
    <Button testID="async" onPress={() => { mode = "async"; }}><Text>Async failure</Text></Button>
    <Button testID="finish" onPress={() => finish(0)}><Text>Finish root</Text></Button>
    <Button testID="finish-cancel" onPress={() => finish(0, "cancelled")}><Text>Confirm cancellation</Text></Button>
    <Button testID="finish-second" onPress={() => finish(1)}><Text>Finish second</Text></Button>
    <Button testID="focus" onPress={() => state.queueFocused.set(0)}><Text>Focus first</Text></Button>
    <Button testID="blur" onPress={() => state.queueFocused.set(null)}><Text>Blur first</Text></Button>
    <Button testID="dispose" onPress={() => state.dispose()}><Text>Dispose</Text></Button>
    <Button testID="unsupported" onPress={() => state.restoreQueue([[{ type: "_future", source: { opaque: true } }] as unknown as ContentBlock[]])}><Text>Restore unsupported</Text></Button>
    <Button testID="unsupported-now" onPress={() => state.sendNow(0)}><Text>Send unsupported now</Text></Button>
    <Button testID="unsupported-edit" onPress={() => state.editQueued(0)}><Text>Edit unsupported</Text></Button>
  </View>;
}
mount(App);
