import { List, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { SessionsState } from "../state/sessions";
import { Spinner } from "./Spinner";
import { historyTimestamp } from "../acp/client";

export function SessionHistory(props: { state: SessionsState }) {
  const state = props.state;
  return (
    <View testID="session-history" class="flex-1 gap-3 p-3">
      <View class="flex-row items-center justify-between">
        <Text class="text-lg font-semibold text-foreground">Sessions</Text>
        <Button testID="history-back" onPress={() => state.visible.set(false)} class="rounded-lg border border-border px-3 py-2">
          <Text class="text-sm text-foreground">Back to chat</Text>
        </Button>
      </View>
      <List testID="history-list" class="flex-1" contentClass="gap-2"
        each={state.rows()} keyExtractor={(row) => row.sessionId}
        header={() => <View class="gap-2">
          <Text class="text-sm font-semibold text-muted-foreground">Open chats</Text>
          <Each of={state.views()} key={(view) => view.key}>
            {(view) => (
              <Button testID={`open-chat-${view().key}`} onPress={() => state.activate(view())}
                class="gap-1 rounded-lg border border-border p-3">
                <Text class="text-sm text-foreground">{view().info.title || "New chat"}{state.active()?.key === view().key ? " · Current" : ""}</Text>
                <Text class="text-xs text-muted-foreground">{view().info.cwd}{view().composer.thread.generating() ? " · Generating" : ""}</Text>
              </Button>
            )}
          </Each>
          <View class="mt-3 flex-row items-center justify-between">
            <Text class="text-sm font-semibold text-muted-foreground">History</Text>
            <If when={state.supportsHistory}>
              <Button testID="history-refresh" onPress={() => state.refresh()} class="rounded-lg border border-border px-3 py-2">
                <Text class="text-xs text-foreground">Refresh</Text>
              </Button>
            </If>
          </View>
          <If when={!state.supportsHistory}>
            <Text testID="history-unsupported" class="text-sm text-muted-foreground">This agent does not support session history.</Text>
          </If>
          <If when={state.error()}>
            <Text testID="history-error" class="text-sm text-red-500">{state.error()}</Text>
          </If>
          <If when={state.phase() === "error"}>
            <Button testID="history-retry" onPress={() => state.retry()} class="rounded-lg border border-border px-3 py-2">
              <Text class="text-sm text-foreground">Retry</Text>
            </Button>
          </If>
          <If when={state.supportsHistory && !state.supportsRestore}>
            <Text testID="history-open-unsupported" class="text-sm text-muted-foreground">This agent can list sessions but cannot load or resume them.</Text>
          </If>
        </View>}
        footer={() => <View class="gap-2">
          <If when={state.phase() === "loading"}>
            <View testID="history-loading" class="flex-row items-center gap-2 py-3"><Spinner /><Text class="text-sm text-muted-foreground">Loading sessions…</Text></View>
          </If>
          <If when={state.phase() === "ready" && state.rows().length === 0}>
            <Text testID="history-empty" class="text-sm text-muted-foreground">No saved sessions.</Text>
          </If>
          <If when={state.cursor() !== null}>
            <Button testID="history-more" disabled={state.phase() === "loading"} onPress={() => state.more()} class="rounded-lg border border-border px-3 py-2 disabled:opacity-30">
              <Text class="text-sm text-foreground">Load more</Text>
            </Button>
          </If>
        </View>}
      >
            {(row) => (
              <View class="gap-2 rounded-lg border border-border p-3">
                <Button testID={`history-open-${row().sessionId}`} disabled={!state.canOpen(row()) || state.deleting() === row().sessionId}
                  onPress={() => state.open(row())} class="gap-1 disabled:opacity-30">
                  <Text class="text-sm font-semibold text-foreground">{row().title || "Untitled session"}</Text>
                  <Text class="text-xs text-muted-foreground">{row().cwd}</Text>
                  <If when={historyTimestamp(row().updatedAt) !== null}>
                    <Text class="text-xs text-muted-foreground">{new Date(historyTimestamp(row().updatedAt)!).toLocaleString()}</Text>
                  </If>
                </Button>
                <If when={state.supportsDelete}>
                  <If when={state.confirmDelete() === row().sessionId} else={
                    <Button testID={`history-delete-${row().sessionId}`} disabled={!state.canDelete(row()) || state.deleting() !== null}
                      onPress={() => state.confirmDelete.set(row().sessionId)} class="self-end px-2 py-1 disabled:opacity-30">
                      <Text class="text-xs text-red-500">Delete</Text>
                    </Button>
                  }>
                    <Text class="text-sm text-foreground">Delete this session permanently?</Text>
                    <View class="flex-row justify-end gap-2">
                      <Button testID="history-delete-cancel" disabled={state.deleting() !== null} onPress={() => state.confirmDelete.set(null)} class="px-3 py-2">
                        <Text class="text-sm text-foreground">Cancel</Text>
                      </Button>
                      <Button testID="history-delete-confirm" disabled={state.deleting() !== null} onPress={() => state.remove(row())} class="rounded-lg bg-red-500/15 px-3 py-2 disabled:opacity-30">
                        <Text class="text-sm text-red-500">{state.deleting() === row().sessionId ? "Deleting…" : "Delete session"}</Text>
                      </Button>
                    </View>
                  </If>
                </If>
              </View>
            )}
      </List>
    </View>
  );
}
