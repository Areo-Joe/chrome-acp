import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { AcpClient } from "../../acp/client";
import type { Plan, PromptResponse } from "@agentclientprotocol/sdk";
import { createThread } from "../../state/thread";

function App() {
  const error = signal("none");
  let finish: ((response: PromptResponse) => void) | undefined;
  let rejectCancellation: ((reason: Error) => void) | undefined;
  let cancellation: "sync" | "async" | "ok" = "ok";
  const calls = signal(0);
  const thread = createThread({
    prompt: () => { calls.update(value => value + 1); return new Promise<PromptResponse>(resolve => { finish = resolve; }); },
    cancel: () => {
      if (cancellation === "sync") throw new Error("Synchronous cancellation failure");
      if (cancellation === "async") return new Promise<void>((_, reject) => { rejectCancellation = reject; });
      finish?.({ stopReason: "cancelled" });
      return Promise.resolve();
    },
  } as unknown as AcpClient, { agentName: () => "Mock" });
  const plan: Plan = { entries: [
    { content: "Done", priority: "low", status: "completed", _meta: { entry: [1] } },
    { content: "Active", priority: "high", status: "in_progress", _meta: { entry: [2] } },
  ], _meta: { plan: [true, null] } };
  const update = (value: Plan) => thread.handleUpdate({ sessionUpdate: "plan", ...value });
  const send = () => {
    try { thread.send([{ type: "text", text: "go" }]).catch(reason => error.set(String(reason))); }
    catch (reason) { error.set(String(reason)); }
  };
  return <View>
    <Text testID="state">{JSON.stringify({ plan: thread.plan(), visible: thread.planVisible(), expanded: thread.planExpanded(), generating: thread.generating(), calls: calls() })}</Text>
    <Text testID="failure">{error()}</Text>
    <Button testID="snapshot" onPress={() => update(plan)}><Text>Snapshot</Text></Button>
    <Button testID="replacement" onPress={() => update({ entries: [{ content: "Other", priority: "medium", status: "pending" }] })}><Text>Replacement</Text></Button>
    <Button testID="dismiss" onPress={thread.dismissPlan}><Text>Dismiss</Text></Button>
    <Button testID="expand" onPress={thread.togglePlan}><Text>Expand</Text></Button>
    <Button testID="send" onPress={send}><Text>Send</Text></Button>
    <Button testID="sync-failure" onPress={() => { cancellation = "sync"; }}><Text>Sync failure</Text></Button>
    <Button testID="async-failure" onPress={() => { cancellation = "async"; }}><Text>Async failure</Text></Button>
    <Button testID="finish-cancellation" onPress={() => { finish?.({ stopReason: "cancelled" }); rejectCancellation?.(new Error("Async cancellation failed")); }}><Text>Finish cancellation</Text></Button>
    <Button testID="reset" onPress={thread.reset}><Text>Reset</Text></Button>
    <Button testID="dispose" onPress={thread.dispose}><Text>Dispose</Text></Button>
  </View>;
}
mount(App);
