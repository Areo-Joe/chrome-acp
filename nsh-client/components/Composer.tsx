import { cleanup, Input, Scroll, signal, Text, View, type YNode } from "nsh";
import { Button } from "nsh/base";
import { commandHint, commandMatches, configChoices, type ComposerState } from "../state/composer";
import { ConfigPicker } from "./ConfigPicker";
import { Icon } from "./Icon";

export function Composer(props: { state: ComposerState }) {
  const state = props.state;
  const contentHeight = signal(80);
  const composing = signal(false);
  const complete = signal(true);
  let input: YNode | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const suggestions = () => complete() && !composing() ? commandMatches(state.draft(), state.commands()) : [];
  const hint = () => composing() ? null : commandHint(state.draft(), state.commands());
  const busy = () => state.phase() !== "ready" || state.pending() !== null;
  cleanup(() => { if (focusTimer !== undefined) clearTimeout(focusTimer); });

  function chooseCommand(name: string, requiresInput: boolean) {
    const value = `/${name}${requiresInput ? " " : ""}`;
    complete.set(false);
    state.draft.set(value);
    if (focusTimer !== undefined) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      input?.focus();
      input?.setSelection(value.length, value.length);
    }, 0);
  }

  return (
    <View testID="composer" class="shrink-0 gap-2 border-t border-border bg-background p-3">
      <If when={state.phase() === "loading"}>
        <Text testID="session-loading" class="text-xs text-muted-foreground">Preparing session…</Text>
      </If>
      <If when={state.error()}>
        <Text testID="session-error" class="text-sm text-red-500">{state.error()}</Text>
      </If>
      <If when={suggestions().length > 0}>
        <Scroll class="max-h-44 rounded-xl border border-border bg-background" keyboardShouldPersistTaps="handled">
          <Each of={suggestions()}>
            {(command) => (
              <Button
                testID={`command-${command().name}`}
                onPress={() => chooseCommand(command().name, !!command().input)}
                class="gap-1 px-3 py-3 active:bg-muted"
              >
                <Text class="text-sm font-medium text-foreground">/{command().name}</Text>
                <Text class="text-xs text-muted-foreground">{command().description}</Text>
              </Button>
            )}
          </Each>
        </Scroll>
      </If>
      <View class="gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <View class="flex-row items-start gap-2">
          <Input
            testID="message-input"
            ref={(node) => { input = node; }}
            value={state.draft()}
            onChange={(value) => { state.draft.set(value); complete.set(true); }}
            onCompositionChange={({ composing: active }) => composing.set(active)}
            onContentSizeChange={({ height }) => contentHeight.set(Math.max(80, Math.ceil(height)))}
            multiline
            submitBehavior="newline"
            placeholder="Message the agent…"
            class="flex-1 text-base text-foreground placeholder:text-muted-foreground"
            style={{ height: Math.min(144, contentHeight()), paddingTop: 10, paddingBottom: 6, lineHeight: 24, textAlignVertical: "top" }}
          />
        </View>
        <If when={hint()}>
          <Text testID="command-hint" class="text-xs text-muted-foreground">{hint()}</Text>
        </If>
        <View class="flex-row items-center justify-between gap-2">
          <View class="flex-1 flex-row flex-wrap items-center gap-2">
            <Each of={state.options() ?? []}>
              {(option) => (
                <ConfigPicker
                  id={option().id}
                  name={option().name}
                  description={option().description}
                  value={option().currentValue}
                  choices={configChoices(option())}
                  disabled={busy()}
                  busy={state.pending() === option().id}
                  onSelect={(value) => state.choose(option().id, value)}
                />
              )}
            </Each>
            <If when={state.options() === null && state.modes()}>
              <ConfigPicker
                id="legacy-mode"
                name="Mode"
                value={state.modes()!.currentModeId}
                choices={state.modes()!.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description }))}
                disabled={busy()}
                busy={state.pending() === "legacy-mode"}
                onSelect={(value) => state.choose("legacy-mode", value, true)}
              />
            </If>
          </View>
          <Button
            testID="send-message"
            disabled
            accessibilityLabel="Send message (not enabled yet)"
            class="h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary disabled:opacity-30"
          >
            <Icon name="arrow-up" primaryForeground />
          </Button>
        </View>
      </View>
    </View>
  );
}
