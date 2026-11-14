import { cleanup, Keyboard, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Composer } from "../components/Composer";
import { PlanView } from "../components/Plan";
import { MessageQueueView } from "../components/MessageQueue";
import { Authentication } from "../components/Authentication";
import { SessionHistory } from "../components/SessionHistory";
import { ThreadErrorCallout, ThreadView } from "../components/Thread";
import type { ComposerState } from "../state/composer";
import { createSessions } from "../state/sessions";
import type { Connection } from "../state/connection";

function Conversation(props: { composer: ComposerState }) {
  const composer = props.composer;
  return (
    <If when={composer.phase() === "auth-required" || composer.phase() === "authenticating"} else={
      <>
        <If when={composer.resumedWithoutHistory()}>
          <Text testID="session-resumed" class="px-3 py-2 text-xs text-muted-foreground">Session resumed. Earlier messages were not replayed by this agent.</Text>
        </If>
        <If when={composer.phase() === "deleting"}>
          <Text testID="session-deleting" class="px-3 py-2 text-xs text-muted-foreground">Deleting session…</Text>
        </If>
        <ThreadView thread={composer.thread} />
        <ThreadErrorCallout thread={composer.thread} onAuthenticate={composer.authenticateFailedPrompt} />
        <If when={composer.phase() === "error"}>
          <Button testID="session-retry" onPress={() => composer.retrySession()} class="mx-3 rounded-lg border border-border px-3 py-2">
            <Text class="text-sm text-foreground">Retry session</Text>
          </Button>
        </If>
        <PlanView thread={composer.thread} />
        <MessageQueueView state={composer} />
        <Composer state={composer} />
      </>
    }>
      <Authentication state={composer} />
    </If>
  );
}

export function ChatPage(props: { connection: Connection }) {
  const sessions = createSessions(props.connection);
  cleanup(() => sessions.dispose());
  return (
    <View testID="chat-page" class="flex-1 bg-background pb-[env(keyboard-inset-height)]">
      <View class="flex-row items-center justify-between border-b border-border px-3 py-3">
        <View class="flex-1 gap-1">
          <Text testID="chat-title" class="text-lg font-semibold text-foreground">{sessions.active()?.info.title || "Chat"}</Text>
          <Text class="text-xs text-foreground">Connected</Text>
        </View>
        <View class="flex-row gap-2">
          <Button testID="show-sessions" onPress={() => { Keyboard.dismiss(); sessions.show(); }} class="rounded-lg border border-border px-2 py-2">
            <Text class="text-xs text-foreground">Sessions</Text>
          </Button>
          <Button testID="new-session" onPress={() => { Keyboard.dismiss(); sessions.newSession(); }} class="rounded-lg border border-border px-2 py-2">
            <Text class="text-xs text-foreground">New chat</Text>
          </Button>
          <Button testID="disconnect" onPress={() => { Keyboard.dismiss(); props.connection.disconnect(); }} class="rounded-lg border border-border px-2 py-2">
            <Text class="text-xs text-foreground">Disconnect</Text>
          </Button>
        </View>
      </View>
      <If when={sessions.visible()} else={
        <Each of={sessions.active() ? [sessions.active()!] : []} key={(view) => view.key}>
          {(view) => <Conversation composer={view().composer} />}
        </Each>
      }>
        <SessionHistory state={sessions} />
      </If>
    </View>
  );
}
