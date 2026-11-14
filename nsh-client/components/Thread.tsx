import { Clipboard, effect, List, signal, Text, View, type ListRef } from "nsh";
import { Button, Collapsible, TextView } from "nsh/base";
import type { AssistantChunk, AssistantEntry, Thread, ThreadEntry, ToolCallEntry, UserEntry } from "../state/thread";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { isHiddenToolCall } from "../state/tool-call";
import { ToolCallView } from "./ToolCall";

export function ThreadView(props: { thread: Thread }) {
  const thread = props.thread;
  let list: ListRef | undefined;
  let count = 0;
  // Like Zed, a sent message scrolls the conversation to its end.
  effect(() => {
    const entries = thread.entries();
    const last = entries[entries.length - 1];
    if (entries.length > count && last?.kind === "user" && last.optimistic) list?.scrollToEnd({ animated: true });
    count = entries.length;
  });

  const shown = () => thread.entries().filter((entry) => entry.kind !== "tool" || !isHiddenToolCall(entry.state()));
  const viewable = signal<{ keys: Set<string>; first: number } | null>(null);
  /** Where the tool call awaiting permission is, when it is out of view. */
  const awaiting = () => {
    const pending = thread.awaitingPermission();
    const seen = viewable();
    if (!pending || !seen || seen.keys.has(pending.entry.key)) return null;
    const index = shown().indexOf(pending.entry);
    if (index === -1) return null;
    return { ...pending, index, above: index < seen.first };
  };

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
      <>
      <List
        testID="thread"
        ref={(node) => { list = node; }}
        each={shown()}
        keyExtractor={(entry) => entry.key}
        onViewableItemsChange={({ viewableItems }) => {
          const items = viewableItems.filter((token) => token.isViewable);
          viewable.set({
            keys: new Set(items.map((token) => token.key)),
            first: items.reduce((first, token) => Math.min(first, token.index), Infinity),
          });
        }}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }}
        keyboardDismissMode="on-drag"
        class="flex-1"
        contentClass="gap-4 px-4 py-4"
        footer={() => (
          <If when={thread.generating()}>
            <If
              when={thread.waitingForConfirmation()}
              else={
                <View testID="generating" accessibilityLabel="Generating" class="flex-row items-center px-1 py-2">
                  <Spinner />
                </View>
              }
            >
              <View testID="generating" accessibilityLabel="Awaiting Confirmation" class="flex-row items-center gap-2 px-1 py-2">
                <View class="w-2 items-center"><Spinner size={8} /></View>
                <Text style={{ numberOfLines: 1 }} class="text-sm text-muted-foreground">Awaiting Confirmation</Text>
              </View>
            </If>
          </If>
        )}
      >
        {(entry) => <Entry entry={entry} thread={thread} />}
      </List>
      <If when={awaiting()}>
        {(pending) => (
          <View testID="awaiting-permission" class="mx-2 overflow-hidden rounded-t-md border border-b-0 border-border bg-muted/30">
            <View class="w-full flex-row items-center justify-between gap-1.5 border-b border-border p-1.5 pl-2">
              <View class="flex-row items-center gap-1.5">
                <View class="w-2 items-center"><Spinner size={8} /></View>
                <Text class="text-sm text-muted-foreground">
                  {pending().count > 1 ? `Awaiting Confirmation (${pending().count})` : "Awaiting Confirmation"}
                </Text>
              </View>
              <Button
                testID="scroll-to-permission"
                accessibilityLabel="Scroll"
                onPress={() => list?.scrollToIndex({ index: pending().index, animated: true, viewPosition: 0 })}
                class="flex-row items-center gap-1 rounded-md px-2 py-1 active:bg-muted"
              >
                <Text class="text-sm text-foreground">Scroll</Text>
                <Icon name={pending().above ? "arrow-up" : "arrow-down"} size={12} tone="foreground" />
              </Button>
            </View>
            <ToolCallView entry={() => pending().entry} thread={thread} floating />
          </View>
        )}
      </If>
      </>
    </If>
  );
}

/** A row can be given another entry, so the view follows the entry's kind. */
function Entry(props: { entry: () => ThreadEntry; thread: Thread }) {
  const entryOf = <K extends ThreadEntry["kind"]>(kind: K) => {
    const entry = props.entry();
    return entry.kind === kind ? (entry as Extract<ThreadEntry, { kind: K }>) : null;
  };
  return (
    <>
      <If when={entryOf("user")}>{(entry) => <UserMessage entry={entry} />}</If>
      <If when={entryOf("assistant")}>{(entry) => <AssistantMessage entry={entry} thread={props.thread} />}</If>
      <If when={entryOf("tool")}>{(entry) => <ToolCallView entry={entry} thread={props.thread} />}</If>
    </>
  );
}

function UserMessage(props: { entry: () => UserEntry }) {
  return (
    <View testID="user-message" class="rounded-lg border border-border bg-muted/30 px-3 py-3">
      <Text style={{ userSelect: "text" }} class="text-base text-foreground">{props.entry().markdown()}</Text>
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

export function ThreadErrorCallout(props: { thread: Thread; onAuthenticate?: () => void }) {
  return (
    <If when={props.thread.error()}>
      {(error) => (
        <View testID="thread-error" class="mx-3 mb-2 flex-row items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-3">
          <Icon name="circle-x" size={16} tone="destructive" />
          <View class="shrink grow gap-1">
            <Text class="text-sm font-semibold text-foreground">{error().title}</Text>
            <TextView selectable markdown={error().message} class="text-sm text-muted-foreground" />
          </View>
          <If when={error().authentication && props.onAuthenticate}>
            <Button testID="authenticate-thread" onPress={() => props.onAuthenticate?.()} class="rounded-md bg-primary px-3 py-2">
              <Text class="text-sm text-primary-foreground">Authenticate</Text>
            </Button>
          </If>
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
