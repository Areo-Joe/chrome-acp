import { Clipboard, effect, List, Text, View, type YNode } from "nsh";
import { Button, Collapsible, TextView } from "nsh/base";
import type { AssistantChunk, AssistantEntry, Thread, ThreadEntry, UserEntry } from "../state/thread";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

export function ThreadView(props: { thread: Thread }) {
  const thread = props.thread;
  let list: YNode | undefined;
  let count = 0;
  // Like Zed, a sent message scrolls the conversation to its end.
  effect(() => {
    const entries = thread.entries();
    const last = entries[entries.length - 1];
    if (entries.length > count && last?.kind === "user" && last.optimistic) list?.scrollToEnd({ animated: true });
    count = entries.length;
  });

  return (
    <If
      when={thread.entries().length > 0}
      else={
        <View class="flex-1 items-center justify-center gap-2 px-6">
          <Text class="text-xl font-semibold text-foreground">New chat</Text>
          <Text class="text-sm text-muted-foreground">Write a message below to get started.</Text>
        </View>
      }
    >
      <List
        testID="thread"
        ref={(node) => { list = node; }}
        each={thread.entries()}
        keyExtractor={(entry) => entry.key}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }}
        keyboardDismissMode="on-drag"
        class="flex-1"
        contentClass="gap-4 px-4 py-4"
        footer={() => (
          <If when={thread.generating()}>
            <View testID="generating" accessibilityLabel="Generating" class="flex-row items-center px-1 py-2">
              <Spinner />
            </View>
          </If>
        )}
      >
        {(entry) => <Entry entry={entry} thread={thread} />}
      </List>
    </If>
  );
}

function Entry(props: { entry: () => ThreadEntry; thread: Thread }) {
  return (
    <If
      when={props.entry().kind === "user"}
      else={<AssistantMessage entry={() => props.entry() as AssistantEntry} thread={props.thread} />}
    >
      <UserMessage entry={() => props.entry() as UserEntry} />
    </If>
  );
}

function UserMessage(props: { entry: () => UserEntry }) {
  return (
    <View testID="user-message" class="rounded-lg border border-border bg-muted/30 px-3 py-3">
      <Text selectable class="text-base text-foreground">{props.entry().markdown()}</Text>
    </View>
  );
}

function AssistantMessage(props: { entry: () => AssistantEntry; thread: Thread }) {
  const isLast = () => {
    const entries = props.thread.entries();
    return entries[entries.length - 1] === props.entry();
  };
  return (
    <View testID="assistant-message" class="gap-3">
      <Each of={props.entry().chunks()} key={(chunk) => chunk.key}>
        {(chunk, index) => {
          const streaming = () => props.thread.generating() && isLast() && index() === props.entry().chunks().length - 1;
          return (
            <If when={chunk().kind === "thought"} else={<Markdown chunk={chunk} streaming={streaming} />}>
              <Thought chunk={chunk} streaming={streaming} onToggle={() => props.thread.toggleThought(chunk())} />
            </If>
          );
        }}
      </Each>
    </View>
  );
}

function Markdown(props: { chunk: () => AssistantChunk; streaming: () => boolean; muted?: boolean }) {
  return (
    <TextView
      selectable
      markdown={props.chunk().markdown()}
      options={{ streaming: props.streaming() }}
      class={props.muted ? "text-muted-foreground" : "text-foreground"}
    />
  );
}

function Thought(props: { chunk: () => AssistantChunk; streaming: () => boolean; onToggle: () => void }) {
  return (
    <Collapsible
      open={props.chunk().open()}
      class="gap-2"
      content={
        <View class="ml-2 border-l border-border pl-4">
          <Markdown chunk={props.chunk} streaming={props.streaming} muted />
        </View>
      }
    >
      <View
        role="button"
        testID="thought-toggle"
        onPress={props.onToggle}
        accessibilityLabel="Thinking"
        accessibilityState={{ expanded: props.chunk().open() }}
        class="flex-row items-center gap-2 self-start py-1"
      >
        <Icon name="brain" size={16} />
        <Text class="text-sm text-muted-foreground">Thinking</Text>
        <Icon name={props.chunk().open() ? "chevron-up" : "chevron-down"} size={14} />
      </View>
    </Collapsible>
  );
}

export function ThreadErrorCallout(props: { thread: Thread }) {
  return (
    <If when={props.thread.error()}>
      {(error) => (
        <View testID="thread-error" class="mx-3 mb-2 flex-row items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-3">
          <Icon name="circle-x" size={16} tone="destructive" />
          <View class="shrink grow gap-1">
            <Text class="text-sm font-semibold text-foreground">{error().title}</Text>
            <TextView selectable markdown={error().message} class="text-sm text-muted-foreground" />
          </View>
          <If when={error().copy}>
            <Button
              testID="copy-thread-error"
              accessibilityLabel="Copy error message"
              onPress={() => void Clipboard.writeText(error().message)}
              class="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
            >
              <Icon name="copy" size={14} />
            </Button>
          </If>
          <Button
            testID="dismiss-thread-error"
            accessibilityLabel="Dismiss"
            onPress={() => props.thread.dismissError()}
            class="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
          >
            <Icon name="x" size={14} />
          </Button>
        </View>
      )}
    </If>
  );
}
