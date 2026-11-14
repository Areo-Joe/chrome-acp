import { batch, signal, type Signal } from "nsh";
import {
  RequestError,
  type ContentBlock,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { authenticationRequired, type AcpClient } from "../acp/client";
import {
  applyToolCallPatch,
  createToolCallState,
  fromReported,
  hasDiff,
  patchFromToolCall,
  patchFromUpdate,
  permissionStatus,
  statusAfterPermissionGrant,
  toolStatus,
  withLegacyStatus,
  type PermissionRequest,
  type ToolCallPatch,
  type ToolCallState,
} from "./tool-call";

export type UserEntry = {
  kind: "user";
  key: string;
  messageId: string | null;
  optimistic: boolean;
  blocks: ContentBlock[];
  markdown: Signal<string>;
};

export type AssistantChunk = {
  key: string;
  kind: "message" | "thought";
  messageId: string | null;
  /** All text received; `markdown` reveals it gradually while it streams. */
  source: string;
  markdown: Signal<string>;
  open: Signal<boolean>;
  userToggled: boolean;
};

export type AssistantEntry = { kind: "assistant"; key: string; chunks: Signal<AssistantChunk[]> };

export type ToolCallEntry = {
  kind: "tool";
  key: string;
  id: string;
  state: Signal<ToolCallState>;
  expanded: Signal<boolean>;
  rawInputExpanded: Signal<boolean>;
};

export type ThreadEntry = UserEntry | AssistantEntry | ToolCallEntry;

/** `copy` offers to copy the message, which Zed does for refusals and agent errors. */
export type ThreadError = { title: string; message: string; copy: boolean; authentication?: boolean };

/** How often streamed text is revealed, and how long the pending text takes to show. */
const REVEAL_TICK_MS = 16;
const REVEAL_TARGET_MS = 200;
const PERMISSION_OPTION_KINDS: readonly string[] = ["allow_once", "allow_always", "reject_once", "reject_always"];

/** Structural equality where key order doesn't matter and `null` equals a missing field, as parsed blocks differ in both. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == right;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

const sameBlock = (left: ContentBlock, right: ContentBlock) => sameValue(left, right);

/** Chunks without ids merge with anything; two ids merge only when equal. */
const canMerge = (existing: string | null, incoming: string | null) =>
  existing === null || incoming === null || existing === incoming;

/** A content block as Markdown: text as is, others as links or images. */
function blockMarkdown(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `![image](${block.uri ?? `data:${block.mimeType};base64,${block.data}`})`;
    case "resource_link":
      return `[@${block.name}](${block.uri})`;
    case "resource":
      return `[@${block.resource.uri.split("/").pop() || block.resource.uri}](${block.resource.uri})`;
    default:
      return "";
  }
}

function agentError(reason: unknown): ThreadError {
  const auth = authenticationRequired(reason);
  return auth
    ? { title: "Authentication Required", message: auth.description ?? "Authentication required", copy: true, authentication: true }
    : { title: "An Error Happened", message: reason instanceof Error ? reason.message : String(reason), copy: true };
}

function appendMarkdown(existing: string, block: ContentBlock): string {
  const next = blockMarkdown(block);
  if (!next) return existing;
  if (block.type === "text" || !existing) return existing + next;
  return `${existing}\n\n${next}`;
}

/**
 * The session's conversation: the user's and the agent's messages and one
 * running turn at a time. Mirrors Zed's `AcpThread` for prompt-completion
 * (ACP v1) sessions.
 */
export function createThread(client: AcpClient, options: { agentName: () => string }) {
  const entries = signal<ThreadEntry[]>([]);
  const generating = signal(false);
  const error = signal<ThreadError | null>(null);
  let keys = 0;
  let turnId = 0;
  let running: { id: number; done: Promise<void> } | null = null;
  let reveal: { chunk: AssistantChunk; perTick: number; timer: ReturnType<typeof setInterval> } | null = null;
  let autoExpanded: AssistantChunk | null = null;
  let permissionIds = 0;
  let disposed = false;
  let submittedPrompt: ContentBlock[] | null = null;

  const nextKey = (prefix: string) => `${prefix}-${++keys}`;

  function showUpTo(chunk: AssistantChunk, length: number) {
    let end = Math.min(length, chunk.source.length);
    const code = chunk.source.charCodeAt(end - 1);
    if (end < chunk.source.length && code >= 0xd800 && code <= 0xdbff) end += 1;
    chunk.markdown.set(chunk.source.slice(0, end));
  }

  function flushStreamingText() {
    if (!reveal) return;
    clearInterval(reveal.timer);
    showUpTo(reveal.chunk, Infinity);
    reveal = null;
  }

  function bufferStreamingText(chunk: AssistantChunk) {
    const pending = chunk.source.length - chunk.markdown().length;
    const perTick = Math.ceil(pending / REVEAL_TARGET_MS * REVEAL_TICK_MS);
    if (reveal?.chunk === chunk) {
      reveal.perTick = perTick;
      return;
    }
    flushStreamingText();
    const timer = setInterval(() => {
      if (!reveal) return;
      showUpTo(reveal.chunk, reveal.chunk.markdown().length + reveal.perTick);
      if (reveal.chunk.markdown().length >= reveal.chunk.source.length) {
        clearInterval(reveal.timer);
        reveal = null;
      }
    }, REVEAL_TICK_MS);
    reveal = { chunk, perTick, timer };
  }

  function pushEntry(entry: ThreadEntry) {
    flushStreamingText();
    entries.update((list) => [...list, entry]);
  }

  function lastEntry() {
    const list = entries();
    return list[list.length - 1];
  }

  function pushUserBlock(block: ContentBlock, messageId: string | null) {
    flushStreamingText();
    const last = lastEntry();
    if (
      last?.kind === "user"
      && canMerge(last.messageId, messageId)
      && !(last.optimistic && last.messageId === null && messageId !== null)
    ) {
      last.messageId ??= messageId;
      last.blocks.push(block);
      last.markdown.set(appendMarkdown(last.markdown(), block));
      return;
    }
    pushEntry({
      kind: "user", key: nextKey("user"), messageId, optimistic: false,
      blocks: [block], markdown: signal(appendMarkdown("", block)),
    });
  }

  /** The prompt as its own message, shown before it is sent. */
  function pushOptimisticUserMessage(prompt: ContentBlock[]) {
    pushEntry({
      kind: "user", key: nextKey("user"), messageId: null, optimistic: true,
      blocks: [...prompt], markdown: signal(prompt.reduce(appendMarkdown, "")),
    });
  }

  function pushAssistantBlock(block: ContentBlock, messageId: string | null, kind: AssistantChunk["kind"]) {
    const last = lastEntry();
    if (last?.kind === "assistant") {
      const chunks = last.chunks();
      const tail = chunks[chunks.length - 1];
      if (tail?.kind === kind && canMerge(tail.messageId, messageId)) {
        tail.messageId ??= messageId;
        if (block.type === "text") {
          tail.source += block.text;
          bufferStreamingText(tail);
        } else {
          flushStreamingText();
          tail.source = appendMarkdown(tail.source, block);
          tail.markdown.set(tail.source);
        }
        return;
      }
      flushStreamingText();
      last.chunks.set([...chunks, newChunk(block, messageId, kind)]);
      return;
    }
    pushEntry({ kind: "assistant", key: nextKey("assistant"), chunks: signal([newChunk(block, messageId, kind)]) });
  }

  function newChunk(block: ContentBlock, messageId: string | null, kind: AssistantChunk["kind"]): AssistantChunk {
    const source = appendMarkdown("", block);
    return { key: nextKey(kind), kind, messageId, source, markdown: signal(source), open: signal(false), userToggled: false };
  }

  /** While a turn runs, the thought streaming last is open; it closes once the agent moves on, unless the user opened it. */
  function syncAutoExpandedThought() {
    if (!generating()) return;
    const last = lastEntry();
    const chunks = last?.kind === "assistant" ? last.chunks() : [];
    const tail = chunks[chunks.length - 1];
    const target = tail?.kind === "thought" ? tail : null;
    if (target) {
      if (autoExpanded !== target) {
        autoExpanded = target;
        target.open.set(true);
      }
    } else if (autoExpanded) {
      if (!autoExpanded.userToggled) autoExpanded.open.set(false);
      autoExpanded = null;
    }
  }

  function toggleThought(chunk: AssistantChunk) {
    const open = !chunk.open();
    chunk.open.set(open);
    chunk.userToggled = open;
  }

  function findToolCall(id: string): ToolCallEntry | undefined {
    const list = entries();
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index];
      if (entry.kind === "tool" && entry.id === id) return entry;
    }
    return undefined;
  }

  const toolCalls = () => entries().filter((entry): entry is ToolCallEntry => entry.kind === "tool");

  /** An edit's card opens when a new diff arrives: one unlike the diff it replaces, or in place of other content. */
  function setToolCall(entry: ToolCallEntry, next: ToolCallState) {
    const previous = entry.state().content;
    const opensDiff = next.content !== previous && next.content.some((content, index) => {
      if (content.type !== "diff") return false;
      const old = previous[index];
      return old?.type !== "diff" || old.path !== content.path
        || (old.oldText ?? null) !== (content.oldText ?? null) || old.newText !== content.newText;
    });
    entry.state.set(next);
    if (opensDiff) entry.expanded.set(true);
  }

  function pushToolCall(id: string, patch: ToolCallPatch): ToolCallEntry {
    const state = createToolCallState(patch);
    const entry: ToolCallEntry = {
      kind: "tool", key: nextKey("tool"), id,
      state: signal(state), expanded: signal(hasDiff(state)), rawInputExpanded: signal(false),
    };
    pushEntry(entry);
    return entry;
  }

  function patchToolCall(entry: ToolCallEntry, patch: ToolCallPatch) {
    const { state, detached } = applyToolCallPatch(entry.state(), patch);
    setToolCall(entry, state);
    detached?.respond({ outcome: "cancelled" });
  }

  /** Answers the tool call's permission request, if it has one, and forgets it. */
  function takePermission(entry: ToolCallEntry): PermissionRequest | null {
    const request = entry.state().authorization;
    if (request) entry.state.set({ ...entry.state(), authorization: null });
    return request;
  }

  function cancelPermissionRequest(id: number) {
    const entry = toolCalls().find((call) => call.state().authorization?.id === id);
    if (!entry) return;
    batch(() => {
      const request = takePermission(entry);
      entry.state.set({ ...entry.state(), localStatus: "canceled" });
      request?.respond({ outcome: "cancelled" });
    });
  }

  function cancelPermissionRequests() {
    for (const entry of toolCalls()) {
      const id = entry.state().authorization?.id;
      if (id !== undefined) cancelPermissionRequest(id);
    }
  }

  /** Tool calls still waiting or running are canceled, and their permission requests answered. */
  function markPendingToolCallsCanceled() {
    for (const entry of toolCalls()) {
      const status = toolStatus(entry.state());
      if (status !== "pending" && status !== "waiting_for_confirmation" && status !== "in_progress") continue;
      const request = takePermission(entry);
      entry.state.set({ ...entry.state(), localStatus: "canceled" });
      request?.respond({ outcome: "cancelled" });
    }
  }

  /**
   * The agent's `session/request_permission`: shows its tool call waiting for
   * a choice. A newer request for the same tool call replaces this one, and a
   * request the agent withdraws cancels the tool call.
   */
  function requestPermission(request: RequestPermissionRequest, abort: AbortSignal): Promise<RequestPermissionResponse> {
    if (disposed) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    if (request.options.some((option) => !PERMISSION_OPTION_KINDS.includes(option.kind))) {
      return Promise.reject(RequestError.invalidParams("unsupported permission option kind"));
    }
    const update = request.toolCall;
    const existing = findToolCall(update.toolCallId);
    if (!existing && update.title == null) {
      return Promise.reject(RequestError.invalidParams({ toolCall: "a new tool call needs a title" }));
    }
    const id = ++permissionIds;
    return new Promise((resolve, reject) => {
      let answered = false;
      const onAbort = () => {
        reject(abort.reason);
        cancelPermissionRequest(id);
      };
      const respond = (outcome: RequestPermissionOutcome) => {
        if (answered) return;
        answered = true;
        abort.removeEventListener("abort", onAbort);
        resolve({ outcome });
      };
      batch(() => {
        const current = fromReported((existing && permissionStatus(existing.state())) ?? update.status) ?? "pending";
        const patch = patchFromUpdate(update);
        const entry = existing ?? pushToolCall(update.toolCallId, {
          ...patch, kind: patch.kind ?? "other", status: patch.status ?? "pending",
          content: patch.content ?? [], locations: patch.locations ?? [],
        });
        if (existing) patchToolCall(existing, patch);
        entry.state.set(withLegacyStatus(entry.state(), current));
        takePermission(entry)?.respond({ outcome: "cancelled" });
        entry.state.set({ ...entry.state(), authorization: { id, options: request.options, respond } });
        syncAutoExpandedThought();
      });
      if (abort.aborted) onAbort();
      else abort.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Whether the latest turn waits on the user: a tool call since the last user message awaits permission. */
  function waitingForConfirmation(): boolean {
    const list = entries();
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index];
      if (entry.kind === "user") return false;
      if (entry.kind === "tool" && entry.state().authorization) return true;
    }
    return false;
  }

  /** The tool call waiting longest for permission, and how many wait. */
  function awaitingPermission(): { entry: ToolCallEntry; count: number } | null {
    let first: { entry: ToolCallEntry; id: number } | null = null;
    let count = 0;
    for (const entry of toolCalls()) {
      const request = entry.state().authorization;
      if (!request) continue;
      count += 1;
      if (!first || request.id < first.id) first = { entry, id: request.id };
    }
    return first ? { entry: first.entry, count } : null;
  }

  /** The user's choice for a tool call waiting for permission. */
  function authorize(entry: ToolCallEntry, optionId: string) {
    const request = entry.state().authorization;
    const option = request?.options.find((candidate) => candidate.optionId === optionId);
    if (!request || !option) return;
    batch(() => {
      const rejected = option.kind === "reject_once" || option.kind === "reject_always";
      const status = rejected ? "rejected" : statusAfterPermissionGrant(permissionStatus(entry.state()));
      takePermission(entry);
      entry.state.set({ ...entry.state(), localStatus: status });
      request.respond({ outcome: "selected", optionId });
    });
  }

  function handleUpdate(update: SessionUpdate) {
    if (disposed) return;
    batch(() => {
      switch (update.sessionUpdate) {
        case "user_message_chunk": {
          const messageId = update.messageId ?? null;
          // The prompt is shown before it is sent; some agents echo it back.
          const last = lastEntry();
          if (
            last?.kind === "user" && last.optimistic
            && last.blocks.some((block) => sameBlock(block, update.content))
            && canMerge(last.messageId, messageId)
          ) {
            last.messageId ??= messageId;
            return;
          }
          pushUserBlock(update.content, messageId);
          break;
        }
        case "agent_message_chunk":
          pushAssistantBlock(update.content, update.messageId ?? null, "message");
          break;
        case "agent_thought_chunk":
          pushAssistantBlock(update.content, update.messageId ?? null, "thought");
          break;
        case "tool_call": {
          const existing = findToolCall(update.toolCallId);
          if (existing) patchToolCall(existing, patchFromToolCall(update));
          else pushToolCall(update.toolCallId, patchFromToolCall(update));
          break;
        }
        case "tool_call_update": {
          const existing = findToolCall(update.toolCallId);
          if (existing) {
            patchToolCall(existing, patchFromUpdate(update));
            break;
          }
          pushToolCall(update.toolCallId, {
            title: "Tool call not found",
            kind: "fetch",
            status: "failed",
            content: [{ type: "content", content: { type: "text", text: "Tool call not found" } }],
          });
          break;
        }
        default:
          return;
      }
      syncAutoExpandedThought();
    });
  }

  function finishTurn(id: number) {
    if (running?.id === id) {
      running = null;
      generating.set(false);
      autoExpanded = null;
    }
  }

  /** Drops the refused prompt and what followed, unless a tool already returned output for it. */
  function removeFromLastUserMessage() {
    const list = entries();
    let index = list.length - 1;
    while (index >= 0 && list[index].kind !== "user") index -= 1;
    if (index < 0) return;
    const removed = list.slice(index);
    const hasToolOutput = removed.some((entry) =>
      entry.kind === "tool" && toolStatus(entry.state()) === "completed" && entry.state().rawOutput !== undefined);
    if (hasToolOutput) return;
    entries.set(list.slice(0, index));
    for (const entry of removed) if (entry.kind === "tool") takePermission(entry)?.respond({ outcome: "cancelled" });
  }

  function settle(id: number, outcome: { response: PromptResponse } | { failure: unknown }) {
    if (disposed) return;
    batch(() => {
      const isSameTurn = running?.id === id;
      finishTurn(id);
      // A newer turn owns the thread now.
      if (turnId !== id) return;
      flushStreamingText();
      if ("failure" in outcome) {
        if (isSameTurn) markPendingToolCallsCanceled();
        error.set(agentError(outcome.failure));
        return;
      }
      const stopReason = outcome.response.stopReason;
      if (isSameTurn && (stopReason === "cancelled" || stopReason === "max_tokens")) markPendingToolCallsCanceled();
      switch (stopReason) {
        case "max_tokens":
          error.set({
            title: "Output Limit Reached",
            message: "The model stopped because it reached its maximum output length. You can ask it to continue where it left off.",
            copy: false,
          });
          break;
        case "refusal":
          removeFromLastUserMessage();
          error.set({
            title: "Request Refused",
            message: `${options.agentName()} refused to respond to this prompt. This can happen when a model believes the prompt violates its content policy or safety guidelines, so rephrasing it can sometimes address the issue.`,
            copy: true,
          });
          break;
      }
    });
  }

  /** Stops the running turn at once; resolves once its prompt has settled. */
  function requestCancellation(): Promise<void> {
    flushStreamingText();
    const turn = running;
    if (!turn) {
      cancelPermissionRequests();
      return Promise.resolve();
    }
    const notified = client.cancel();
    batch(() => {
      markPendingToolCallsCanceled();
      running = null;
      generating.set(false);
      autoExpanded = null;
    });
    return Promise.all([notified, turn.done]).then(() => {});
  }

  function send(prompt: ContentBlock[]) {
    if (disposed || prompt.length === 0) return Promise.resolve();
    const cancelled = requestCancellation();
    const id = ++turnId;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    batch(() => {
      error.set(null);
      running = { id, done };
      generating.set(true);
    });
    return (async () => {
      try {
        await cancelled;
        if (disposed || turnId !== id) return;
        submittedPrompt = [...prompt];
        pushOptimisticUserMessage(prompt);
        const response = await client.prompt(prompt);
        settle(id, { response });
      } catch (failure) {
        settle(id, { failure });
      } finally {
        finished();
      }
    })();
  }

  function cancel() {
    if (disposed) return Promise.resolve();
    return requestCancellation().catch((reason: unknown) => {
      if (!disposed) error.set(agentError(reason));
    });
  }

  function dispose() {
    disposed = true;
    if (reveal) clearInterval(reveal.timer);
    reveal = null;
    for (const entry of toolCalls()) takePermission(entry)?.respond({ outcome: "cancelled" });
  }

  function reset() {
    flushStreamingText();
    cancelPermissionRequests();
    turnId += 1;
    running = null;
    autoExpanded = null;
    submittedPrompt = null;
    entries.set([]);
    generating.set(false);
    error.set(null);
  }

  return {
    entries, generating, error, send, cancel, handleUpdate, toggleThought, requestPermission, authorize, awaitingPermission, waitingForConfirmation,
    toggleToolCall: (entry: ToolCallEntry) => entry.expanded.set(!entry.expanded()),
    toggleRawInput: (entry: ToolCallEntry) => entry.rawInputExpanded.set(!entry.rawInputExpanded()),
    dismissError: () => error.set(null),
    failedPrompt: () => error()?.authentication ? submittedPrompt : null,
    reset,
    dispose,
  };
}

export type Thread = ReturnType<typeof createThread>;
