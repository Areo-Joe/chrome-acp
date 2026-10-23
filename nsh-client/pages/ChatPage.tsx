import { cleanup, Text, View } from "nsh";
import { Button, Keyboard, KeyboardAvoidingView } from "nsh/base";
import { Composer } from "../components/Composer";
import { createComposer } from "../state/composer";
import type { Connection } from "../state/connection";

export function ChatPage(props: { connection: Connection }) {
  const composer = createComposer(props.connection);
  cleanup(() => composer.dispose());

  return (
    <KeyboardAvoidingView testID="chat-page" class="flex-1 bg-background">
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
      <View class="flex-1 items-center justify-center gap-2 px-6">
        <Text class="text-xl font-semibold text-foreground">New chat</Text>
        <Text class="text-sm text-muted-foreground">Write a draft below to get started.</Text>
      </View>
      <Composer state={composer} />
    </KeyboardAvoidingView>
  );
}
