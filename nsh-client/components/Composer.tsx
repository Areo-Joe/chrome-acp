import { cleanup, effect, keymap, Picker, platform, Scroll, signal, Text, View, type InputRef } from "nsh";
import { Button, Input } from "nsh/base";
import { commandHint, commandMatches, configChoices, type ComposerState } from "../state/composer";
import { ConfigPicker } from "./ConfigPicker";
import { Icon } from "./Icon";
import { ContextUsageView } from "./ContextUsage";
import { Spinner } from "./Spinner";
import { DraftImages } from "./Images";
import { isLocalFile, pastedImages } from "../state/images";

export function Composer(props: { state: ComposerState }) {
  const state = props.state;
  const contentHeight = signal(80);
  const composing = signal(false);
  const complete = signal(true);
  const focused = signal(false);
  let input: InputRef | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const suggestions = () => complete() && !composing() ? commandMatches(state.draft(), state.commands()) : [];
  const hint = () => composing() ? null : commandHint(state.draft(), state.commands());
  const busy = () => state.phase() !== "ready" || state.pending() !== null;
  const picking = signal(false);
  async function pickImages() {
    if (picking() || !state.supportsImages()) return;
    picking.set(true);
    try {
      const images = await Picker.pickImages({ multiple: true, format: "current" });
      state.addImages(images.map(image => image.file));
    } catch (reason) { state.thread.reportError(reason); }
    finally { picking.set(false); }
  }
  cleanup(() => { if (focusTimer !== undefined) clearTimeout(focusTimer); });
  let focusVersion = state.focusRequest().version;
  effect(() => {
    const request = state.focusRequest();
    if (request.version === focusVersion) return;
    focusVersion = request.version;
    if (focusTimer !== undefined) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      input?.focus();
      if (request.offset !== undefined) input?.setSelection(request.offset, request.end ?? request.offset);
    }, 0);
  });
  effect(() => {
    if (!focused() && state.queueFocused() === null) return;
    cleanup(keymap.bind("mod+enter", () => {
      if (composing()) return;
      if (state.queueFocused() !== null) state.focusMain();
      else state.submit();
    }, { when: "always" }));
    cleanup(keymap.bind("mod+shift+enter", () => {
      if (composing()) return;
      const queued = state.queueFocused();
      if (queued !== null) state.sendNow(queued);
      else if (state.draft().trim()) state.sendImmediately();
    }, { when: "always" }));
  });
  effect(() => {
    if (!focused()) return;
    cleanup(keymap.bind("mod+z", () => { if (!composing()) state.undo(); }, { when: "always" }));
    if (platform.os !== "macos") cleanup(keymap.bind("ctrl+y", () => { if (!composing()) state.redo(); }, { when: "always" }));
    cleanup(keymap.bind("mod+shift+z", () => { if (!composing()) state.redo(); }, { when: "always" }));
  });
  effect(() => {
    if (!focused() || state.draft().trim().length || !state.queued().length) return;
    cleanup(keymap.bind("up", state.editLastQueued, { when: "always" }));
  });
  effect(() => {
    if (state.queueFocused() === null) return;
    cleanup(keymap.bind("escape", () => state.focusMain(), { when: "always" }));
    // Zed's editor::Newline returns immediately in a read-only queue editor.
    // Consume this before AppKit's editable preview can insert a newline.
    cleanup(keymap.bind("shift+enter", () => {}, { when: "always" }));
  });

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
      <View class="gap-2 rounded-xl border border-border bg-muted/30 p-3"
        onFileDrop={({ uris }) => state.addImages(uris.filter(isLocalFile))}>
        <View class="flex-row items-start gap-2">
          <Input
            testID="message-input"
            ref={(node) => { input = node; }}
            value={state.draft()}
            onChange={({ value }) => { state.changeText(value); complete.set(true); }}
            onKeyPress={state.beginNativeEdit}
            pasteBehavior="report"
            onCompositionChange={({ composing: active }) => composing.set(active)}
            onFocus={() => { focused.set(true); state.queueFocused.set(null); }}
            onBlur={() => focused.set(false)}
            onSelectionChange={state.select}
            onPaste={event => {
              if (event.text.length) { state.pasteText(event.text); complete.set(true); return; }
              const images = pastedImages(event);
              state.addImages(images.sources, images.clipboard);
            }}
            onContentSizeChange={({ size }) => contentHeight.set(Math.max(80, Math.ceil(size.height)))}
            multiline
            submitBehavior={platform.desktop ? "submit" : "newline"}
            onSubmit={() => { if (!composing()) state.submit(); }}
            placeholder="Message the agent…"
            class="flex-1 text-base text-foreground placeholder:text-muted-foreground"
            style={{ height: Math.min(144, contentHeight()), paddingTop: 10, paddingBottom: 6, lineHeight: 24, textAlignVertical: "top" }}
          />
        </View>
        <DraftImages images={state.savedInput().images} remove={state.removeImage} />
        <If when={hint()}>
          <Text testID="command-hint" class="text-xs text-muted-foreground">{hint()}</Text>
        </If>
        <View class="flex-row items-center justify-between gap-2">
          <View class="flex-1 flex-row flex-wrap items-center gap-2">
            <If when={state.supportsImages()}>
              <Button testID="add-images" accessibilityLabel="Add Images" onPress={() => { void pickImages(); }}
                disabled={picking() || state.phase() !== "ready" || state.queueLoading()} class="rounded border border-border px-2 py-1">
                <Text class="text-xs text-foreground">{picking() ? "Choosing images…" : "Add Images"}</Text>
              </Button>
            </If>
            <Each of={state.options() ?? []}>
              {(option) => (
                <ConfigPicker
                  id={option().id}
                  name={option().name}
                  description={option().description}
                  value={state.selectedValue(option().id, option().currentValue)}
                  choices={configChoices(option())}
                  disabled={busy()}
                  busy={state.slow() && state.pending() === option().id}
                  onSelect={(value) => state.choose(option().id, value)}
                />
              )}
            </Each>
            <If when={state.options() === null && state.modes()}>
              <ConfigPicker
                id="legacy-mode"
                name="Mode"
                value={state.selectedValue("legacy-mode", state.modes()!.currentModeId)}
                choices={state.modes()!.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description }))}
                disabled={busy()}
                busy={state.slow() && state.pending() === "legacy-mode"}
                onSelect={(value) => state.choose("legacy-mode", value, true)}
              />
            </If>
          </View>
          <ContextUsageView thread={state.thread} />
          <If when={state.queueLoading()} else={<If
            when={state.thread.generating() && !state.draft().trim()}
            else={
              <Button
                testID="send-message"
                disabled={state.phase() !== "ready" || !state.draft().trim()}
                accessibilityLabel={state.thread.generating() ? "Queue and Send" : "Send message"}
                onPress={() => state.submit()}
                class="h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary disabled:opacity-30"
              >
                <Icon name={state.thread.generating() ? "list-plus" : "arrow-up"} tone="primary-foreground" />
              </Button>
            }
          >
            <Button
              testID="stop-generation"
              accessibilityLabel="Stop generation"
              onPress={() => state.stop()}
              class="h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/15 active:bg-red-500/25"
            >
              <Icon name="square" size={16} tone="destructive" />
            </Button>
          </If>}>
            <View testID="queue-loading" accessibilityLabel="Loading Message Content" class="px-1"><Spinner /></View>
          </If>
        </View>
      </View>
    </View>
  );
}
