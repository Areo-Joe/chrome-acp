import { cleanup, mount, Text, View } from "nsh";
import { Button } from "nsh/base";
import { createConnection } from "../../state/connection";
import { createSessions } from "../../state/sessions";
import { Composer } from "../../components/Composer";
import { ThreadView } from "../../components/Thread";
import type { Connection } from "../../state/connection";

function Sessions(props: { connection: Connection }) {
  const sessions = createSessions(props.connection, { maxIdleRetainedThreads: 0 });
  cleanup(() => sessions.dispose());
  return <View class="flex-1">
    <Text>Owners: {sessions.views().map((view) => view.key).join(",")}</Text>
    <Button testID="new" onPress={() => sessions.newSession()}><Text>New</Text></Button>
    <Each of={sessions.rows()} key={(row) => row.sessionId}>
      {(row) => <Button testID={`restore-${row().sessionId}`} onPress={() => sessions.open(row())}><Text>{row().sessionId}</Text></Button>}
    </Each>
    <Each of={sessions.active() ? [sessions.active()!] : []} key={(view) => view.key}>
      {(view) => <><ThreadView thread={view().composer.thread} /><Composer state={view().composer} /></>}
    </Each>
  </View>;
}
function App() {
  const connection = createConnection();
  cleanup(() => connection.disconnect());
  connection.connect("ws://127.0.0.1:19437/acp", "history-retention-pending", "/workspace");
  return <View class="flex-1"><If when={connection.state() === "connected"}><Sessions connection={connection} /></If></View>;
}
mount(App);
