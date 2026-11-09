import { Clipboard, Image, Scroll, signal, Text, View } from "nsh";
import { Button, DiffView, TextView, type DiffHunk, type DiffViewRef } from "nsh/base";
import type { ContentBlock, PermissionOption, ToolKind } from "@agentclientprotocol/sdk";
import type { Thread, ToolCallEntry } from "../state/thread";
import {
  blockView,
  hasDiff,
  hasImage,
  rawText,
  toolKind,
  toolLabel,
  toolOutput,
  toolStatus,
  type ToolCallState,
  type ToolOutput,
} from "../state/tool-call";
import { Icon, type IconName } from "./Icon";

const kindIcons: Record<ToolKind, IconName> = {
  read: "search",
  edit: "pencil",
  delete: "file-x",
  move: "arrow-right-left",
  search: "search",
  execute: "square-terminal",
  think: "brain",
  fetch: "globe",
  switch_mode: "arrow-right-left",
  other: "hammer",
};

/** How a tool call is laid out, as Zed's `render_tool_call` decides it. */
function layout(state: ToolCallState, expanded: boolean, output: ToolOutput[]) {
  const status = toolStatus(state);
  const kind = toolKind(state);
  const needsConfirmation = status === "waiting_for_confirmation";
  const isTerminal = kind === "execute";
  const isEdit = kind === "edit" || hasDiff(state);
  const isCancelledEdit = isEdit && status === "canceled";
  const hasDiffChanges = isCancelledEdit && state.content.some((content) =>
    content.type === "diff" && (content.oldText ?? "") !== content.newText);
  const showRawInput = !isTerminal && !isEdit && !hasImage(output);
  const hasContent = output.length > 0 || (showRawInput && state.rawInput !== undefined);
  return {
    status,
    output,
    needsConfirmation,
    isTerminal,
    isEdit,
    isCancelledEdit,
    hasDiffChanges,
    failedOrCanceled: status === "rejected" || status === "canceled" || status === "failed",
    card: needsConfirmation || isEdit || isTerminal,
    showRawInput,
    collapsible: hasContent && !needsConfirmation,
    open: expanded || state.authorization !== null,
  };
}

type Layout = ReturnType<typeof layout>;

/** `floating`: the copy above the message editor, unframed, its body height-capped so it cannot crowd out the thread. */
export function ToolCallView(props: { entry: () => ToolCallEntry; thread: Thread; floating?: boolean }) {
  const state = () => props.entry().state();
  // Kept while its sources are, so output rows are not made again for other changes.
  let cached: { content: unknown; rawOutput: unknown; output: ToolOutput[] } | null = null;
  const output = () => {
    const { content, rawOutput } = state();
    if (cached?.content !== content || cached.rawOutput !== rawOutput) cached = { content, rawOutput, output: toolOutput(state()) };
    return cached.output;
  };
  const view = () => layout(state(), props.entry().expanded(), output());
  const toggle = () => props.thread.toggleToolCall(props.entry());
  return (
    <View
      testID={props.floating ? "awaiting-tool-call" : "tool-call"}
      accessibilityLabel={toolLabel(state()).text}
      class={props.floating
        ? ""
        : view().card
          ? `my-1.5 overflow-hidden rounded-md border border-border bg-background ${view().failedOrCanceled ? "border-dashed" : ""}`
          : "my-1"}
    >
      <If
        when={props.floating}
        else={<Body entry={props.entry} thread={props.thread} state={state} view={view} onToggle={toggle} />}
      >
        <Scroll class="max-h-40">
          <Body entry={props.entry} thread={props.thread} state={state} view={view} onToggle={toggle} />
        </Scroll>
      </If>
      <If when={state().authorization}>
        {(request) => (
          <PermissionButtons
            testPrefix={props.floating ? "awaiting-permission" : "permission"}
            options={request().options}
            onSelect={(optionId) => props.thread.authorize(props.entry(), optionId)}
          />
        )}
      </If>
    </View>
  );
}

function Body(props: {
  entry: () => ToolCallEntry; thread: Thread; state: () => ToolCallState; view: () => Layout; onToggle: () => void;
}) {
  return (
    <View>
      <If
        when={props.view().isTerminal}
        else={<Header state={props.state} view={props.view} onToggle={props.onToggle} />}
      >
        <CommandHeader state={props.state} view={props.view} onToggle={props.onToggle} />
      </If>
      <If when={props.view().open}>
        <Output entry={props.entry} thread={props.thread} view={props.view} onCollapse={props.onToggle} />
      </If>
    </View>
  );
}

function Header(props: { state: () => ToolCallState; view: () => Layout; onToggle: () => void }) {
  const label = () => toolLabel(props.state());
  const interactive = () => props.view().collapsible;
  const hasLocation = () => props.state().locations.length === 1;
  const tone = () => (props.view().card && hasLocation() ? "text-foreground" : "text-muted-foreground");
  // An edit of one file, interrupted with changes made.
  const interrupted = () => toolKind(props.state()) === "edit" && hasLocation() && props.view().isCancelledEdit && props.view().hasDiffChanges;
  return (
    <View
      role={interactive() ? "button" : undefined}
      testID="tool-call-header"
      onPress={interactive() ? props.onToggle : undefined}
      accessibilityState={interactive() ? { expanded: props.view().open } : undefined}
      class={`flex-row items-center justify-between gap-1.5 ${props.view().card ? "rounded-t-md bg-muted/50 p-0.5 px-1.5" : hasLocation() ? "px-1" : ""}`}
    >
      <View class="h-5 shrink grow flex-row items-center gap-1.5 overflow-hidden">
        <If when={interrupted()} else={<Icon name={kindIcons[toolKind(props.state())]} size={14} />}>
          <View testID="tool-call-interrupted" accessibilityLabel="Interrupted Edit">
            <Icon name="pencil" size={14} />
            <View class="absolute -left-0.5 -top-0.5">
              <Icon name="triangle" size={7} tone="warning" />
            </View>
          </View>
        </If>
        <If
          when={label().markdown}
          else={<Text style={{ numberOfLines: 1 }} class={`shrink grow text-[13px] ${tone()}`}>{label().text}</Text>}
        >
          <View class="h-5 shrink grow justify-center overflow-hidden">
            <TextView markdown={label().text} class={`text-[13px] ${tone()}`} classes={{ paragraph: "my-0" }} />
          </View>
        </If>
      </View>
      <StatusIcons view={props.view} />
    </View>
  );
}

/** A command the agent runs: its text in full, copyable. Unlike Zed, which shows a command's output in its terminal, the output opens below. */
function CommandHeader(props: { state: () => ToolCallState; view: () => Layout; onToggle: () => void }) {
  const command = () => toolLabel(props.state()).text;
  return (
    <View class="gap-0.5 bg-muted/50 p-1.5 pt-1">
      <View class="h-6 flex-row items-center justify-between">
        <Text class="font-mono text-xs text-muted-foreground">Run Command</Text>
        <View class="flex-row items-center gap-1">
          <Button
            testID="copy-command"
            accessibilityLabel="Copy Command"
            onPress={() => void Clipboard.writeText(command())}
            class="h-6 w-6 items-center justify-center rounded-md active:bg-muted"
          >
            <Icon name="copy" size={12} />
          </Button>
          <If when={props.view().collapsible}>
            <Button
              testID="tool-call-header"
              accessibilityLabel={props.view().open ? "Hide output" : "Show output"}
              onPress={props.onToggle}
              class="h-6 w-6 items-center justify-center rounded-md active:bg-muted"
            >
              <Icon name={props.view().open ? "chevron-up" : "chevron-down"} size={14} />
            </Button>
          </If>
        </View>
      </View>
      <Text style={{ userSelect: "text" }} class="font-mono text-xs leading-[17px] text-foreground">{command()}</Text>
    </View>
  );
}

function StatusIcons(props: { view: () => Layout }) {
  const view = props.view;
  return (
    <View class="flex-row items-center gap-1 pr-0.5">
      <If when={view().collapsible}>
        <Icon name={view().open ? "chevron-up" : "chevron-down"} size={14} />
      </If>
      <If when={view().failedOrCanceled && !(view().isCancelledEdit && view().hasDiffChanges)}>
        <If
          when={view().isCancelledEdit}
          else={<View testID="tool-call-failed" accessibilityLabel={view().status === "rejected" ? "Rejected" : view().status === "canceled" ? "Canceled" : "Failed"}><Icon name="x" size={14} tone="destructive" /></View>}
        >
          <View testID="tool-call-interrupted" accessibilityLabel="Interrupted Edit"><Icon name="circle-x" size={14} /></View>
        </If>
      </If>
    </View>
  );
}

function Output(props: { entry: () => ToolCallEntry; thread: Thread; view: () => Layout; onCollapse: () => void }) {
  const view = props.view;
  const state = () => props.entry().state();
  const rawInput = () => rawText(state().rawInput);
  const contents = () => (
    <Each of={view().output}>
      {(content, index) => (
        <OutputContent
          content={content()}
          index={index}
          card={() => view().card}
          failed={() => view().failedOrCanceled}
        />
      )}
    </Each>
  );
  return (
    <If when={view().status !== "rejected"}>
      <If
        when={view().needsConfirmation}
        else={
          <View testID="tool-call-output">
            <If when={view().showRawInput}>
              <View class="ml-1.5 mt-1.5 gap-1 border-l border-border px-3.5 pb-1">
                <Text class="font-mono text-xs text-muted-foreground">Raw Input:</Text>
                <If when={rawInput()}>
                  {(input) => <TextView selectable markdown={input()} class="text-sm text-foreground" />}
                </If>
                <Text class="font-mono text-xs text-muted-foreground">Output:</Text>
              </View>
            </If>
            {contents()}
            <If when={!view().card}>
              <View class="ml-1.5 border-l border-border px-3.5 pt-2">
                <Button
                  testID="collapse-tool-call"
                  accessibilityLabel="Collapse"
                  onPress={props.onCollapse}
                  class="h-6 items-center justify-center rounded-md border border-border active:bg-muted"
                >
                  <Icon name="chevron-up" size={14} />
                </Button>
              </View>
            </If>
          </View>
        }
      >
        <View testID="tool-call-output">
          {contents()}
          <If when={view().showRawInput}>
            <View class="gap-1 border-t border-border p-2">
              <View
                role="button"
                testID="toggle-raw-input"
                onPress={() => props.thread.toggleRawInput(props.entry())}
                accessibilityState={{ expanded: props.entry().rawInputExpanded() }}
                class="flex-row items-center justify-between gap-1 rounded-sm pl-0.5 active:bg-muted"
              >
                <Text class="font-mono text-xs text-muted-foreground">
                  {props.entry().rawInputExpanded() ? "Raw Input:" : "View Raw Input"}
                </Text>
                <Icon name={props.entry().rawInputExpanded() ? "chevron-up" : "chevron-down"} size={14} />
              </View>
              <If when={props.entry().rawInputExpanded() && rawInput()}>
                {(input) => <TextView selectable markdown={input() as string} class="text-sm text-foreground" />}
              </If>
            </View>
          </If>
        </View>
      </If>
    </If>
  );
}

/** Zed's tool-output box: padded in a card, with a rule between items; indented behind a line otherwise. */
const outputBox = (card: boolean, index: number) =>
  card ? `p-2 ${index > 0 ? "border-t border-border" : ""}` : "ml-1.5 border-l border-border px-3.5";

/** One output item; its row is keyed by the item, so `content` does not change under it. */
function OutputContent(props: { content: ToolOutput; index: () => number; card: () => boolean; failed: () => boolean }) {
  const content = props.content;
  const box = () => outputBox(props.card(), props.index());
  switch (content.type) {
    case "markdown":
      return <MarkdownOutput markdown={content.markdown} box={box} />;
    case "content":
      return <BlockOutput block={content.content} box={box} card={props.card} />;
    case "diff":
      return <DiffOutput path={content.path} oldText={content.oldText ?? ""} newText={content.newText} failed={props.failed} />;
    default:
      return (
        <View class={box()}>
          <Text class="text-xs text-muted-foreground">Unsupported tool call content.</Text>
        </View>
      );
  }
}

const DIFF_CONTEXT_LINES = 2;
const DIFF_LINE_HEIGHT = 18;

const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/** Rows a unified diff shows: changed lines, the context around them, and one separator per collapsed run of unchanged lines. */
function diffRows(hunks: DiffHunk[], newLines: number): number {
  const unchanged = (gap: number, limit: number) => (gap > limit ? limit + 1 : gap);
  let rows = 0;
  let end = 0;
  hunks.forEach((hunk, index) => {
    const gap = hunk.newStart - end;
    rows += unchanged(gap, index === 0 ? DIFF_CONTEXT_LINES : DIFF_CONTEXT_LINES * 2);
    rows += hunk.oldLines + hunk.newLines;
    end = hunk.newStart + hunk.newLines;
  });
  return rows + unchanged(newLines - end, DIFF_CONTEXT_LINES);
}

/** An edit's changes, as Zed's diff excerpts: unified, two lines of context; nothing when nothing changed. The view does not size to its rows, so its height follows them. */
function DiffOutput(props: { path: string; oldText: string; newText: string; failed: () => boolean }) {
  let ref: DiffViewRef | undefined;
  const rows = signal(props.oldText === props.newText ? 0 : Math.max(lineCount(props.newText), lineCount(props.oldText), 1));
  const measure = () => {
    void ref?.hunks().then((hunks) => rows.set(hunks.length === 0 ? 0 : diffRows(hunks, lineCount(props.newText))));
  };
  const border = () => (rows() > 0 ? `border-t border-border ${props.failed() ? "border-dashed" : ""}` : props.failed() ? "" : "border-t border-border");
  return (
    <View testID="tool-call-diff" class={border()}>
      <DiffView
        ref={(value) => { ref = value; }}
        oldValue={props.oldText}
        newValue={props.newText}
        language={props.path}
        layout="unified"
        contextLines={DIFF_CONTEXT_LINES}
        fontSize={12}
        lineHeight={DIFF_LINE_HEIGHT}
        onStatsChange={measure}
        style={{ height: rows() * DIFF_LINE_HEIGHT }}
      />
    </View>
  );
}

function MarkdownOutput(props: { markdown: string; box: () => string }) {
  return (
    <View class={`gap-2 ${props.box()}`}>
      <TextView selectable markdown={props.markdown} class="text-xs text-muted-foreground" />
    </View>
  );
}

const IMAGE_MAX_SIZE = 384;

/** An image as Zed shows tool output images: at most 384 points either way, scaled down but never up; unframed in a card. */
function ImageOutput(props: { src: string; card: () => boolean }) {
  const size = signal<{ width: number; height: number } | null>(null);
  const width = () => {
    const natural = size();
    if (!natural || natural.height === 0) return IMAGE_MAX_SIZE;
    return Math.min(natural.width, IMAGE_MAX_SIZE, IMAGE_MAX_SIZE * natural.width / natural.height);
  };
  return (
    <View class={`gap-2 ${props.card() ? "" : "ml-1.5 border-l border-border px-3.5"}`}>
      <Image
        src={props.src}
        accessibilityLabel="Image"
        onLoad={({ size: natural }) => size.set(natural)}
        style={{
          objectFit: "scale-down",
          width: width(),
          maxWidth: "100%",
          aspectRatio: size() ? size()!.width / Math.max(size()!.height, 1) : 1,
        }}
      />
    </View>
  );
}

function BlockOutput(props: { block: ContentBlock; box: () => string; card: () => boolean }) {
  const view = blockView(props.block);
  switch (view.type) {
    case "markdown":
      return <MarkdownOutput markdown={view.markdown} box={props.box} />;
    case "image":
      return <ImageOutput src={view.src} card={props.card} />;
    case "resource":
      if (view.uri === "") return null;
      return (
        <View class={props.box()}>
          <Text style={{ numberOfLines: 1 }} class="text-xs text-muted-foreground">{view.uri}</Text>
        </View>
      );
    case "link":
      return (
        <View class="ml-1.5 overflow-hidden border-l border-border pl-2.5">
          <Text style={{ numberOfLines: 1 }} class="text-sm text-muted-foreground">
            {view.uri.startsWith("file://") ? view.uri.slice("file://".length) : view.uri}
          </Text>
        </View>
      );
  }
}

function PermissionButtons(props: { testPrefix: string; options: PermissionOption[]; onSelect: (optionId: string) => void }) {
  const icon = (option: PermissionOption): { name: IconName; tone: "success" | "destructive" } => {
    switch (option.kind) {
      case "allow_once":
        return { name: "check", tone: "success" };
      case "allow_always":
        return { name: "check-check", tone: "success" };
      default:
        return { name: "x", tone: "destructive" };
    }
  };
  return (
    <View testID={`${props.testPrefix}-options`} class="w-full gap-0.5 border-t border-border p-1">
      <Each of={props.options} key={(option) => option.optionId}>
        {(option) => (
          <Button
            testID={`${props.testPrefix}-${option().optionId}`}
            accessibilityLabel={option().name}
            onPress={() => props.onSelect(option().optionId)}
            class="flex-row items-center gap-1.5 rounded-md px-2 py-1.5 active:bg-muted"
          >
            <Icon name={icon(option()).name} size={12} tone={icon(option()).tone} />
            <Text class="text-sm text-foreground">{option().name}</Text>
          </Button>
        )}
      </Each>
    </View>
  );
}
