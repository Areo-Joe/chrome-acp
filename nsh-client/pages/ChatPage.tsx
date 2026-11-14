import { cleanup, Keyboard, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Composer } from "../components/Composer";
import { Authentication } from "../components/Authentication";
import { ThreadErrorCallout, ThreadView } from "../components/Thread";
import { createComposer } from "../state/composer";
import type { Connection } from "../state/connection";

export function ChatPage(props: { connection: Connection }) {
  const composer = createComposer(props.connection);
  cleanup(() => composer.dispose());

  return (
    <View testID="chat-page" class="flex-1 bg-background pb-[env(keyboard-inset-height)]">
      <View class="flex-row items-center justify-between border-b border-border px-4 py-3">
        <View class="gap-1">
          <Text class="text-lg font-semibold text-foreground">Chat</Text>
          <Text class="text-xs text-muted-foreground">Connected</Text>
        </View>
        <Button
          testID="disconnect"
          onPress={() => { Keyboard.dismiss(); props.connection.disconnect(); }}
          class="rounded-lg border border-border px-3 py-2 active:bg-muted"
        >
          <Text class="text-xs text-foreground">Disconnect</Text>
        </Button>
      </View>
      <If when={composer.phase() === "auth-required" || composer.phase() === "authenticating"} else={
        <>
          <ThreadView thread={composer.thread} />
          <ThreadErrorCallout thread={composer.thread} onAuthenticate={composer.authenticateFailedPrompt} />
          <Composer state={composer} />
        </>
      }>
        <Authentication state={composer} />
      </If>
    </View>
  );
}
