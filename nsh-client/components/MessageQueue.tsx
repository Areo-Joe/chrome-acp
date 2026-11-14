import { cleanup, Clipboard, effect, keymap, platform, Scroll, signal, Text, View, type InputRef } from "nsh";
import { Button, Input } from "nsh/base";
import { queuedEditorText, type ComposerState, type QueuedMessage } from "../state/composer";
import { ImageBlockView } from "./Images";
import { isLocalFile, pastedImages } from "../state/images";
import { Icon } from "./Icon";

export function MessageQueueView(props: { state: ComposerState }) {
  const state = props.state;
  return <If when={state.queued().length > 0}>
    <View testID="message-queue" class="mx-2 overflow-hidden rounded-t-md border border-border bg-muted/30">
      <View class={state.queueExpanded() ? "flex-row items-center border-b border-border" : "flex-row items-center"}>
        <Button testID="queue-toggle" onPress={() => state.queueExpanded.set(!state.queueExpanded())}
          accessibilityLabel={state.queueExpanded() ? "Collapse Message Queue" : "Expand Message Queue"}
          class="min-w-0 flex-1 flex-row items-center gap-1 px-2 py-1.5">
          <View style={{ rotate: state.queueExpanded() ? "0deg" : "-90deg" }}><Icon name="chevron-down" size={12} /></View>
          <Text class="text-xs text-muted-foreground">{`${state.queued().length} Queued Message${state.queued().length === 1 ? "" : "s"}`}</Text>
        </Button>
        <Button testID="queue-clear" onPress={state.clearQueue} class="px-2 py-1.5">
          <Text class="text-xs text-muted-foreground">Clear All</Text>
        </Button>
      </View>
      <If when={state.queueExpanded()}>
        <Scroll testID="queue-entries" style={{ maxHeight: 160, flexShrink: 1 }} keyboardShouldPersistTaps="handled">
          <Each of={state.queued()} key={entry => entry.id}>
            {(entry) => <QueueRow entry={entry()} state={state} />}
          </Each>
        </Scroll>
      </If>
    </View>
  </If>;
}

function QueueRow(props: { entry: QueuedMessage; state: ComposerState }) {
  const state = props.state;
  const id = props.entry.id;
  let input: InputRef | undefined;
  let selection = { start: 0, end: 0 };
  let composing = false;
  let compositionCursor = 0;
  let nativeValue = "";
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const editorVersion = signal(0);
  const height = signal(24);
  const text = () => queuedEditorText(props.entry.content);
  const first = () => state.queued()[0]?.id === id;
  cleanup(() => {
    if (focusTimer !== undefined) clearTimeout(focusTimer);
    if (state.queueFocused() === id) state.queueFocused.set(null);
  });
  function nativeEdit(value: string, cursor?: number) {
    const source = text();
    if (source === null || source === value || !state.queued().some(entry => entry.id === id)) return;
    // AppKit's noneditable NSTextView suppresses input attempts. Let its
    // editable preview report them, while the queued source stays immutable.
    // Code-point diffing also covers committed IME/autocorrect input.
    const before = [...source];
    const after = [...value];
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start
      && before[before.length - end - 1] === after[after.length - end - 1]) end++;
    const inserted = after.slice(start, after.length - end).join("");
    if (inserted) state.editQueued(id, { text: inserted, offset: cursor ?? before.slice(0, start).join("").length });
    else editorVersion.update(version => version + 1); // Reject deletion, including menu Cut/Undo.
  }
  effect(() => {
    if (state.queueFocused() !== id) return;
    // Native read-only inputs do not receive the system paste action. Handle
    // the shortcut as Zed's InputAttempted event, preserving the selection.
    cleanup(keymap.bind("mod+v", () => {
      const offset = selection.end;
      void Clipboard.readText().then(async value => {
        if (state.queueFocused() !== id) return;
        if (value.length) { state.editQueued(id, { text: value, offset }); return; }
        const bitmap = await Clipboard.hasImage() ? await Clipboard.readImage() : null;
        const sources = bitmap ? [bitmap.url] : (await Clipboard.readFiles()).filter(isLocalFile);
        if (state.queueFocused() === id && sources.length && state.editQueued(id, { text: "", offset })) {
          state.addImages(sources, bitmap !== null);
        }
      }).catch(state.thread.reportError);
    }, { when: "always" }));
  });
  return <View testID={`queue-entry-${id}`} class="flex-row flex-wrap items-center gap-1 border-border bg-background p-1.5"
    style={{ borderBottomWidth: state.queued().at(-1)?.id === id ? 0 : 1 }}>
    <View tooltip={<Text class="rounded bg-muted px-2 py-1 text-xs text-foreground">{first() ? "Next in Queue" : "In Queue"}</Text>}>
      <Icon name="circle" size={12} tone={first() ? "accent" : "muted"} />
    </View>
    <View testID={`queue-focus-${id}`} onPress={() => { input?.focus(); state.queueFocused.set(id); }} class="flex-1" style={{ minWidth: 120 }}>
      <View class="flex-row flex-wrap gap-1">
        <Each of={props.entry.content.filter(block => block.type === "image")}>
          {image => <ImageBlockView image={image()} compact />}
        </Each>
      </View>
      <Each of={[editorVersion()]} key={version => version}>{version => <Input testID={`queue-input-${id}`} ref={node => {
        input = node;
        if (state.queueFocused() === id) {
          const range = { ...selection };
          if (focusTimer !== undefined) clearTimeout(focusTimer);
          focusTimer = setTimeout(() => { node.focus(); node.setSelection(range.start, range.end); }, 0);
        }
      }}
        value={text() ?? "Queued message contains attachments"} readonly={platform.os !== "macos" || text() === null} multiline
        submitBehavior="submit" pasteBehavior="report"
        onFocus={() => state.queueFocused.set(id)}
        onBlur={() => { if (editorVersion() === version() && state.queueFocused() === id) state.queueFocused.set(null); }}
        onSelectionChange={range => { if (editorVersion() === version()) selection = range; }}
        onContentSizeChange={({ size }) => height.set(Math.max(24, Math.min(200, Math.ceil(size.height))))}
        onSubmit={() => state.focusMain()}
        onKeyPress={({ key }) => {
          if (composing) return;
          if (key === "Enter" || key === "Escape") state.focusMain();
          else if (key !== "Backspace" && key !== "Delete") state.editQueued(id, { text: key, offset: selection.end });
        }}
        onChange={({ value }) => { nativeValue = value; if (!composing) nativeEdit(value); }}
        onCompositionChange={({ composing: active }) => {
          if (active && !composing) { compositionCursor = selection.end; nativeValue = text() ?? ""; }
          const committed = composing && !active;
          composing = active;
          if (committed) nativeEdit(nativeValue, compositionCursor);
        }}
        onPaste={event => {
          if (event.text.length) { state.editQueued(id, { text: event.text, offset: selection.end }); return; }
          const images = pastedImages(event);
          if (images.sources.length && state.editQueued(id, { text: "", offset: selection.end })) state.addImages(images.sources, images.clipboard);
        }}
        class="text-sm text-muted-foreground" style={{ height: height(), padding: 0, lineHeight: 20 }} />}</Each>
    </View>
    <View class="ml-auto flex-row items-center gap-1">
      <If when={state.queueFocused() !== id}>
        <Button testID={`queue-remove-${id}`} accessibilityLabel="Remove Message from Queue" onPress={() => state.removeQueued(id)} class="p-1">
          <Icon name="trash-2" size={14} />
        </Button>
      </If>
      <Button testID={`queue-edit-${id}`} accessibilityLabel="Edit Queued Message" onPress={() => state.editQueued(id)} class="p-1">
        <Icon name="pencil" size={14} />
      </Button>
      <Button testID={`queue-send-${id}`} disabled={state.phase() !== "ready" || state.queueLoading()}
        onPress={() => state.sendNow(id)} class="rounded border-border px-2 py-1"
        style={{ borderWidth: first() || state.queueFocused() === id ? 1 : 0 }}>
        <Text class="text-xs text-foreground">Send Now</Text>
      </Button>
    </View>
  </View>;
}
