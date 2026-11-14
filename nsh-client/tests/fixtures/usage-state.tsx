import { mount, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { AcpClient } from "../../acp/client";
import { createThread } from "../../state/thread";
import { ContextUsageView } from "../../components/ContextUsage";
function App() {
  const thread = createThread({} as AcpClient, { agentName: () => "Mock" });
  return <View class="flex-1 items-center justify-center gap-2">
    <Text>{JSON.stringify(thread.usage())}</Text>
    <ContextUsageView thread={thread} />
    <Button testID="snapshot" onPress={() => thread.handleUpdate({ sessionUpdate: "usage_update", used: 850, size: 1000, cost: { amount: 1, currency: "credits", _meta: { retained: true } } })}><Text>Snapshot</Text></Button>
    <Button testID="no-cost" onPress={() => thread.handleUpdate({ sessionUpdate: "usage_update", used: 0, size: 0, cost: null })}><Text>No cost</Text></Button>
    <Button testID="reset" onPress={thread.reset}><Text>Reset</Text></Button>
    <Button testID="dispose" onPress={thread.dispose}><Text>Dispose</Text></Button>
  </View>;
}
mount(App);
