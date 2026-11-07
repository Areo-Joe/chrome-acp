import { batch, signal, type Signal } from "nsh";
import type { ContentBlock, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../acp/client";

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

export type ThreadEntry = UserEntry | AssistantEntry;

/** `copy` offers to copy the message, which Zed does for refusals and agent errors. */
export type ThreadError = { title: string; message: string; copy: boolean };

/** How often streamed text is revealed, and how long the pending text takes to show. */
const REVEAL_TICK_MS = 16;
const REVEAL_TARGET_MS = 200;

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

const agentError = (reason: unknown): ThreadError => ({
  title: "An Error Happened",
  message: reason instanceof Error ? reason.message : String(reason),
  copy: true,
});

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
  let disposed = false;

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

  function removeFromLastUserMessage() {
    const list = entries();
    let index = list.length - 1;
    while (index >= 0 && list[index].kind !== "user") index -= 1;
    if (index >= 0) entries.set(list.slice(0, index));
  }

  function settle(id: number, outcome: { response: PromptResponse } | { failure: unknown }) {
    if (disposed) return;
    batch(() => {
      finishTurn(id);
      // A newer turn owns the thread now.
      if (turnId !== id) return;
      flushStreamingText();
      if ("failure" in outcome) {
        const reason = outcome.failure;
        error.set(agentError(reason));
        return;
      }
      switch (outcome.response.stopReason) {
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
    if (!turn) return Promise.resolve();
    const notified = client.cancel();
    batch(() => {
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
  }

  return {
    entries, generating, error, send, cancel, handleUpdate, toggleThought,
    dismissError: () => error.set(null),
    dispose,
  };
}

export type Thread = ReturnType<typeof createThread>;
