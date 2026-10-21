import { useState, useEffect, useCallback, useRef } from "react";
import imageCompression from "browser-image-compression";
import type { ACPClient } from "../acp/client";
import type {
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus as ACPToolCallStatus,
  ToolKind,
  ToolCallLocation,
  PermissionRequestPayload,
  PermissionOption,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ImageContent,
  PlanEntry,
  Notice,
} from "../acp/types";

// Image compression options
// Claude API has a 5MB limit, so we target 2MB to be safe
const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2,           // Max output size in MB
  maxWidthOrHeight: 2048, // Max dimension (scales proportionally, no cropping)
  useWebWorker: true,     // Non-blocking compression
  fileType: "image/jpeg" as const, // Convert to JPEG for better compression
};

// Convert data URL to Blob without using fetch()
// This is critical for Chrome extensions where fetch(dataUrl) violates CSP
function dataUrlToBlob(dataUrl: string): Blob {
  // Parse the data URL: data:[<mediatype>][;base64],<data>
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid data URL: missing comma separator");
  }

  const header = dataUrl.slice(0, commaIndex);
  const base64Data = dataUrl.slice(commaIndex + 1);

  // Extract MIME type from header (e.g., "data:image/png;base64")
  const mimeMatch = header.match(/^data:([^;,]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";

  // Decode base64 to binary
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

// AI Elements components
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButtons,
  LAST_USER_MESSAGE_ATTR,
} from "./ai-elements/conversation";
import { Message, MessageContent } from "./ai-elements/message";
import { ContentBlockList } from "./ai-elements/content-blocks";
import { CodeBlock } from "./ai-elements/code-block";
import { Badge } from "./ui/badge";
import {
  PromptInput,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputHeader,
  PromptInputAttachments,
  PromptInputAttachment,
  PromptInputButton,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import { ImageIcon, Loader2, Lock, Plus } from "lucide-react";
import { ModelSelectorPopover } from "./model-selector";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";

// Reference: Zed's add_images_from_picker() - Button to open file dialog for images
// Must be inside PromptInput to access attachments context
function AddImageButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      title={
        disabled
          ? "This agent does not support image input (promptCapabilities.image is false)"
          : "Attach image"
      }
      onClick={() => attachments.openFileDialog()}
    >
      <ImageIcon className="size-4" />
      <span className="sr-only">Attach image</span>
    </PromptInputButton>
  );
}
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "./ai-elements/tool";
import { Shimmer } from "./ai-elements/shimmer";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "./ai-elements/reasoning";
import { ToolPermissionButtons } from "./ai-elements/permission-request";
import { PlanPanel, type PlanView } from "./session/PlanPanel";
import { NoticeCard } from "./session/NoticeCard";
import { SessionConfigSelectors } from "./session/SessionConfigSelectors";
import { SlashCommandMenu } from "./session/SlashCommandMenu";
import { UsageIndicator } from "./session/UsageIndicator";
import { CompactionCard, type CompactionView } from "./session/CompactionCard";
import { ElicitationCard } from "./session/ElicitationDialog";
import { useAvailableCommands } from "../hooks/useSessionConfig";

// =============================================================================
// Type Definitions - Flat Entry Structure (matching Zed's architecture)
// =============================================================================

// UI tool call status (matches Zed's UI status enum)
type ToolCallStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "waiting_for_confirmation"
  | "rejected"
  | "canceled";

// Tool call data
interface ToolCallData {
  id: string;
  title: string;
  status: ToolCallStatus;
  /** Local user decision (rejected/canceled) that survives reported-status clears. */
  localStatus?: "rejected" | "canceled";
  kind?: ToolKind;
  name?: string | null;
  locations?: ToolCallLocation[];
  content?: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Tool call _meta (Zed reads tool_name / terminal_info / terminal_output / terminal_exit). */
  meta?: Record<string, unknown> | null;
  /** Display-only terminal streamed through tool call _meta (Zed terminal_provider). */
  terminal?: {
    output: string;
    truncated?: boolean;
    exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
  };
  // Permission request data (only when status is "waiting_for_confirmation")
  permissionRequest?: {
    requestId: string;
    options: PermissionOption[];
  };
  // True if this is a standalone permission request (not attached to a real tool call)
  isStandalonePermission?: boolean;
}

// Assistant message chunk - can be regular message or thought
type AssistantChunk = {
  type: "message" | "thought";
  blocks: ContentBlock[];
  messageId?: string | null;
};

// User message entry
// Reference: Zed's UserMessage { content: ContentBlock, chunks: Vec<acp::ContentBlock> }
interface UserMessageEntry {
  type: "user_message";
  id: string;
  blocks: ContentBlock[];
  /** Reference: chunks with the same messageId belong to one message. */
  messageId?: string | null;
  /** True until the agent echoes the message back over `user_message_chunk`. */
  isOptimistic?: boolean;
}

// Assistant message entry - contains chunks (text + thoughts)
interface AssistantMessageEntry {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
}

// Tool call entry - standalone, not nested in messages
interface ToolCallEntry {
  type: "tool_call";
  toolCall: ToolCallData;
}

// Pending agent elicitation (inline in the transcript, like Zed's ElicitationCard).
interface ElicitationEntry {
  type: "elicitation";
  id: string;
  request: CreateElicitationRequest;
}

// Context compaction entry (timeline-positioned upsert).
interface CompactionEntry {
  type: "compaction";
  id: string;
  view: CompactionView;
}

// Thread entry - flat list of all entries
type ThreadEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolCallEntry
  | CompactionEntry
  | ElicitationEntry;

interface ChatInterfaceProps {
  client: ACPClient;
}

// Helper to format tool call content for display.
// Reference: Zed renders content/diff/terminal variants; unknown variants are
// surfaced instead of dropped.
function formatToolOutput(tool: ToolCallData): string | null {
  const { content, rawOutput } = tool;
  if (content && content.length > 0) {
    const results: string[] = [];

    for (const item of content) {
      if (item.type === "content") {
        if (item.content.type === "text" && item.content.text) {
          results.push(item.content.text);
        }
      } else if (item.type === "diff") {
        const oldLines = (item.oldText ?? "").split("\n");
        const newLines = item.newText.split("\n");
        results.push(
          `📝 ${item.path}\n${[
            ...oldLines.map((line) => `- ${line}`),
            ...newLines.map((line) => `+ ${line}`),
          ].join("\n")}`,
        );
      } else if (item.type === "terminal") {
        results.push(
          tool.terminal
            ? `🖥️ Terminal output (${item.terminalId})`
            : `🖥️ Terminal: ${item.terminalId}`,
        );
      } else {
        results.push(`Unsupported tool call content: ${JSON.stringify(item)}`);
      }
    }

    if (results.length > 0) {
      return results.join("\n\n");
    }
  }

  if (tool.terminal?.output) {
    return tool.terminal.output;
  }

  // Fall back to rawOutput if content didn't produce results
  if (rawOutput && typeof rawOutput === "object" && Object.keys(rawOutput).length > 0) {
    return JSON.stringify(rawOutput, null, 2);
  }

  return null;
}

// =============================================================================
// Helper Functions
// =============================================================================

// Map ACP status to our status type.
// Reference: Zed's `underlying_status()` — an absent/cleared reported status
// falls back to Pending (not InProgress).
function mapToolStatus(status: ACPToolCallStatus | null | undefined): ToolCallStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  if (status === "in_progress") return "running";
  return "pending";
}

// Find tool call index in entries (search from end, like Zed)
function findToolCallIndex(entries: ThreadEntry[], toolCallId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.type === "tool_call" && entry.toolCall.id === toolCallId) {
      return i;
    }
  }
  return -1;
}

// Append a message/thought chunk to the trailing assistant message (Zed's
// `push_assistant_content_block_with_message_id`).
// Reference: Zed's `can_merge_message_chunks` — merge iff the ids are equal,
// or either side has no id.
function canMergeMessageChunks(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return true;
  return left === right;
}

/** Append blocks, merging adjacent text blocks (Zed appends Markdown chunks). */
function appendBlocks(
  existing: ContentBlock[],
  incoming: ContentBlock[],
): ContentBlock[] {
  const next = [...existing];
  for (const block of incoming) {
    const last = next[next.length - 1];
    if (block.type === "text" && last?.type === "text") {
      next[next.length - 1] = { ...last, text: last.text + block.text };
    } else {
      next.push(block);
    }
  }
  return next;
}

function appendAssistantChunk(
  entries: ThreadEntry[],
  kind: "message" | "thought",
  block: ContentBlock,
  messageId?: string | null,
): ThreadEntry[] {
  const lastEntry = entries[entries.length - 1];
  if (lastEntry?.type === "assistant_message") {
    const lastChunk = lastEntry.chunks[lastEntry.chunks.length - 1];
    if (lastChunk?.type === kind && canMergeMessageChunks(lastChunk.messageId, messageId)) {
      return [
        ...entries.slice(0, -1),
        {
          ...lastEntry,
          chunks: [
            ...lastEntry.chunks.slice(0, -1),
            { ...lastChunk, blocks: appendBlocks(lastChunk.blocks, [block]), messageId },
          ],
        },
      ];
    }
    return [
      ...entries.slice(0, -1),
      {
        ...lastEntry,
        chunks: [...lastEntry.chunks, { type: kind, blocks: [block], messageId }],
      },
    ];
  }
  return [
    ...entries,
    {
      type: "assistant_message",
      id: `assistant-${Date.now()}`,
      chunks: [{ type: kind, blocks: [block], messageId }],
    },
  ];
}

function metaObject(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = meta?.[key];
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// Reference: Zed's `handle_session_notification` pre/post-handles
// `_meta.terminal_info`, `_meta.terminal_output`, and `_meta.terminal_exit`.
function applyToolMeta(tool: ToolCallData): void {
  const info = metaObject(tool.meta, "terminal_info");
  if (info && typeof info.terminal_id === "string" && !tool.terminal) {
    tool.terminal = { output: "" };
  }

  const output = metaObject(tool.meta, "terminal_output");
  if (output && typeof output.data === "string") {
    tool.terminal = {
      ...(tool.terminal ?? { output: "" }),
      output: (tool.terminal?.output ?? "") + output.data,
    };
  }

  const exit = metaObject(tool.meta, "terminal_exit");
  if (exit) {
    tool.terminal = {
      ...(tool.terminal ?? { output: "" }),
      exitStatus: {
        exitCode: typeof exit.exit_code === "number" ? exit.exit_code : null,
        signal: typeof exit.signal === "string" ? exit.signal : null,
      },
    };
  }

  const toolName = tool.meta?.tool_name;
  if (!tool.name && typeof toolName === "string") {
    tool.name = toolName;
  }
}

function fallbackTitle(tool: ToolCallData): string {
  // Reference: Zed treats an empty/whitespace title as absent.
  const title = tool.title?.trim();
  if (title) return title;
  const name = tool.name?.trim();
  return name || "Tool call";
}

// A full `tool_call` update is a wholesale snapshot (Zed's `upsert_tool_call`).
function upsertToolCall(entries: ThreadEntry[], snapshot: ToolCallData): ThreadEntry[] {
  const normalized: ToolCallData = { ...snapshot };
  applyToolMeta(normalized);
  normalized.title = fallbackTitle(normalized);

  const index = findToolCallIndex(entries, normalized.id);
  if (index < 0) {
    return [...entries, { type: "tool_call", toolCall: normalized }];
  }
  return entries.map((entry, entryIndex) => {
    if (entryIndex !== index || entry.type !== "tool_call") return entry;
    const terminal = normalized.status === "complete" || normalized.status === "error";
    const hasPendingPermission = !terminal && entry.toolCall.permissionRequest != null;
    // A full snapshot should not drop terminal output streamed via _meta.
    const terminalState = normalized.terminal ?? entry.toolCall.terminal;
    const keepLocal =
      entry.toolCall.localStatus != null &&
      (normalized.status === "pending" || normalized.status === "running");
    return {
      type: "tool_call",
      toolCall: {
        ...normalized,
        // Reference: a pending authorization takes precedence over the
        // reported status; local decisions survive non-terminal updates.
        status: hasPendingPermission
          ? "waiting_for_confirmation"
          : keepLocal
            ? (entry.toolCall.localStatus ?? normalized.status)
            : normalized.status,
        localStatus: keepLocal ? entry.toolCall.localStatus : undefined,
        terminal: terminalState,
        permissionRequest: terminal ? undefined : entry.toolCall.permissionRequest,
        isStandalonePermission: terminal ? undefined : entry.toolCall.isStandalonePermission,
      },
    };
  });
}

// Partial update: absent field = unchanged, null = clear, value = set.
// Reference: Zed's `ToolCall::apply_patch` (content/locations/title/... replace
// wholesale when present; terminal statuses close a pending permission prompt).
function applyToolCallUpdate(
  entries: ThreadEntry[],
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>,
): ThreadEntry[] {
  const index = findToolCallIndex(entries, update.toolCallId);
  if (index < 0) {
    // Reference: Zed inserts a synthetic failed "Tool call not found" row and
    // discards the payload.
    console.warn(`[ChatInterface] Tool call not found for update: ${update.toolCallId}`);
    return [
      ...entries,
      {
        type: "tool_call",
        toolCall: {
          id: update.toolCallId,
          title: "Tool call not found",
          status: "error",
          content: [{ type: "content", content: { type: "text", text: "Tool call not found" } }],
        },
      },
    ];
  }

  return entries.map((entry, entryIndex) => {
    if (entryIndex !== index || entry.type !== "tool_call") return entry;
    const current = entry.toolCall;
    const next: ToolCallData = { ...current };

    // Reference: a cleared title falls back to tool_name / "Tool call".
    if (update.title !== undefined) next.title = update.title ?? "";
    if (update.name !== undefined) next.name = update.name;
    if (update.kind !== undefined) next.kind = update.kind ?? undefined;
    if (update.status !== undefined) {
      const terminal = update.status === "completed" || update.status === "failed";
      if (update.status === null) {
        // Reference: clearing reported status keeps an explicit local decision.
        if (!current.permissionRequest) {
          next.status = current.localStatus ?? "pending";
        }
      } else if (!current.permissionRequest || terminal) {
        next.status = mapToolStatus(update.status);
        next.localStatus = undefined;
      }
      if (terminal) {
        next.permissionRequest = undefined;
        next.isStandalonePermission = undefined;
      }
    }
    if (update.content !== undefined) next.content = update.content ?? [];
    if (update.locations !== undefined) next.locations = update.locations ?? [];
    if (update.rawInput !== undefined) next.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) next.rawOutput = update.rawOutput;
    // Reference: legacy v1 `_meta` is sticky/replaced when present.
    if (update._meta !== undefined) next.meta = update._meta;
    applyToolMeta(next);
    next.title = fallbackTitle(next);

    return { type: "tool_call", toolCall: next };
  });
}

// =============================================================================
// ChatInterface Component
// =============================================================================

export function ChatInterface({ client }: ChatInterfaceProps) {
  // Flat list of entries (like Zed's entries: Vec<AgentThreadEntry>)
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  // Reference: Zed's supports_images() checks prompt_capabilities.image
  const [supportsImages, setSupportsImages] = useState(false);
  // Plans: legacy `plan` updates plus ID-addressed `plan_update`/`plan_removed`.
  const [planState, setPlanState] = useState<{
    plans: Record<string, PlanView>;
    visiblePlanId: string | null;
  }>({ plans: {}, visiblePlanId: null });
  // Notices are live, dismissible events — not part of the transcript
  // (Reference: Zed's `notices: Vec<(usize, Notice)>`).
  const [notices, setNotices] = useState<Array<{ id: number; notice: Notice }>>([]);
  const nextNoticeIdRef = useRef(0);
  // Auth-required state (ACP error -32000 / -32002).
  const [authRequired, setAuthRequired] = useState<{ message: string } | null>(null);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  // Used by the error handler registered once in the setup effect.
  const isLoadingRef = useRef(false);
  const sessionReadyRef = useRef(false);
  // The client optimistically adds the user message; agents may echo it back
  // via `user_message_chunk`. Ignore those echoed chunks (Zed does the same).
  const ignoreUserEchoRef = useRef(false);
  const lastSentTextRef = useRef("");
  const echoedTextRef = useRef("");
  const pendingEchoBlocksRef = useRef<ContentBlock[]>([]);
  // Slash commands advertised by the agent.
  const availableCommands = useAvailableCommands(client);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    sessionReadyRef.current = sessionReady;
  }, [sessionReady]);

  const resetThreadState = useCallback(() => {
    setEntries([]);
    setIsLoading(false);
    setSessionReady(false);
    setPlanState({ plans: {}, visiblePlanId: null });
    setNotices([]);
    nextNoticeIdRef.current = 0;
    setAuthRequired(null);
    ignoreUserEchoRef.current = false;
    lastSentTextRef.current = "";
    echoedTextRef.current = "";
    pendingEchoBlocksRef.current = [];
  }, []);

  const pushNotice = useCallback((notice: Notice) => {
    const id = nextNoticeIdRef.current++;
    setNotices((prev) => [...prev, { id, notice }]);
  }, []);

  const activateSession = useCallback((sessionId: string, options?: { resetEntries?: boolean }) => {
    const shouldResetEntries = options?.resetEntries ?? true;
    if (shouldResetEntries) {
      setEntries([]);
      setIsLoading(false);
      setPlanState({ plans: {}, visiblePlanId: null });
      setNotices([]);
      nextNoticeIdRef.current = 0;
      setAuthRequired(null);
    }
    setActiveSessionId(sessionId);
    setSessionReady(true);
    setSupportsImages(client.supportsImages);
    console.log("[ChatInterface] Active session:", sessionId, "supportsImages:", client.supportsImages);
  }, [client]);

  // =============================================================================
  // Permission Request Handler
  // =============================================================================
  const handlePermissionRequest = useCallback((request: PermissionRequestPayload) => {
    if (activeSessionIdRef.current && request.sessionId !== activeSessionIdRef.current) {
      return;
    }
    console.log("[ChatInterface] Permission request:", request);

    setEntries((prev) => {
      // Find matching tool call (search from end)
      const toolCallIndex = findToolCallIndex(prev, request.toolCall.toolCallId);

      if (toolCallIndex >= 0) {
        // Update existing tool call's status
        return prev.map((entry, index) => {
          if (index !== toolCallIndex) return entry;
          if (entry.type !== "tool_call") return entry;
          if (
            entry.toolCall.status !== "running" &&
            entry.toolCall.status !== "pending"
          ) {
            return entry;
          }

          return {
            type: "tool_call",
            toolCall: {
              ...entry.toolCall,
              status: "waiting_for_confirmation" as const,
              permissionRequest: {
                requestId: request.requestId,
                options: request.options,
              },
            },
          };
        });
      } else {
        // No matching tool call - create standalone permission request as new entry
        console.log("[ChatInterface] No matching tool call, creating standalone permission request");

        const permissionToolCall: ToolCallEntry = {
          type: "tool_call",
          toolCall: {
            id: request.toolCall.toolCallId,
            title: request.toolCall.title || "Permission Request",
            status: "waiting_for_confirmation",
            permissionRequest: {
              requestId: request.requestId,
              options: request.options,
            },
            isStandalonePermission: true,
          },
        };

        return [...prev, permissionToolCall];
      }
    });
  }, []);

  // =============================================================================
  // Session Update Handler (Zed-style: append-only entries, tri-state updates)
  // =============================================================================
  const handleSessionUpdate = useCallback((sessionId: string, update: SessionUpdate) => {
    if (activeSessionIdRef.current && sessionId !== activeSessionIdRef.current) {
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        setEntries((prev) =>
          appendAssistantChunk(prev, "message", update.content, update.messageId),
        );
        return;

      case "agent_thought_chunk":
        setEntries((prev) =>
          appendAssistantChunk(prev, "thought", update.content, update.messageId),
        );
        return;

      case "user_message_chunk": {
        const block = update.content;
        let blocksToAdd: ContentBlock[] = [block];

        if (block.type === "text") {
          if (!block.text) return;
          // Skip chunks echoing the optimistic user message (Zed's optimistic
          // echo suppression). Chunks may be split, so compare the accumulated
          // echo against the text we sent.
          if (ignoreUserEchoRef.current && lastSentTextRef.current) {
            echoedTextRef.current += block.text;
            if (lastSentTextRef.current.startsWith(echoedTextRef.current)) {
              if (echoedTextRef.current.length >= lastSentTextRef.current.length) {
                ignoreUserEchoRef.current = false;
              }
              return;
            }
            // Not an echo after all: keep what already arrived and append it.
            ignoreUserEchoRef.current = false;
            blocksToAdd = [{ type: "text", text: echoedTextRef.current }];
          }
        } else if (ignoreUserEchoRef.current) {
          // Drop an echoed attachment that matches the optimistic message.
          const encoded = JSON.stringify(block);
          const index = pendingEchoBlocksRef.current.findIndex(
            (candidate) => JSON.stringify(candidate) === encoded,
          );
          if (index >= 0) {
            pendingEchoBlocksRef.current.splice(index, 1);
            if (pendingEchoBlocksRef.current.length === 0) {
              ignoreUserEchoRef.current = false;
            }
            return;
          }
        }

        setEntries((prev) => {
          const lastEntry = prev[prev.length - 1];
          // Reference: Zed merges user chunks by messageId (equal, or either
          // side missing).
          if (
            lastEntry?.type === "user_message" &&
            canMergeMessageChunks(lastEntry.messageId, update.messageId)
          ) {
            return [
              ...prev.slice(0, -1),
              {
                ...lastEntry,
                blocks: appendBlocks(lastEntry.blocks, blocksToAdd),
                messageId: lastEntry.messageId ?? update.messageId,
              },
            ];
          }
          return [
            ...prev,
            {
              type: "user_message",
              id: `user-${Date.now()}-${prev.length}`,
              blocks: blocksToAdd,
              messageId: update.messageId,
            },
          ];
        });
        return;
      }

      // A full tool call is a wholesale snapshot (Zed replaces all fields).
      case "tool_call": {
        const snapshot: ToolCallData = {
          id: update.toolCallId,
          title: update.title,
          status: mapToolStatus(update.status),
          kind: update.kind,
          name: update.name,
          locations: update.locations ?? [],
          content: update.content ?? [],
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          meta: update._meta,
        };
        setEntries((prev) => upsertToolCall(prev, snapshot));
        return;
      }

      // Partial update: absent field = unchanged, null = clear, value = set.
      case "tool_call_update": {
        setEntries((prev) => applyToolCallUpdate(prev, update));
        return;
      }

      case "plan": {
        const view: PlanView = { id: "legacy", entries: update.entries };
        setPlanState((prev) => ({
          plans: { ...prev.plans, legacy: view },
          visiblePlanId: "legacy",
        }));
        return;
      }

      case "plan_update": {
        const content = update.plan;
        const view: PlanView = { id: content.planId };
        if (content.type === "items") view.entries = content.entries;
        else if (content.type === "markdown") view.markdown = content.content;
        else if (content.type === "file") view.uri = content.uri;
        setPlanState((prev) => ({
          plans: { ...prev.plans, [content.planId]: view },
          visiblePlanId: content.planId,
        }));
        return;
      }

      case "plan_removed": {
        setPlanState((prev) => {
          const plans = { ...prev.plans };
          delete plans[update.planId];
          // Reference: pick another visible plan if the current one is removed.
          const remaining = Object.keys(plans);
          return {
            plans,
            visiblePlanId:
              prev.visiblePlanId === update.planId
                ? (remaining[remaining.length - 1] ?? null)
                : prev.visiblePlanId,
          };
        });
        return;
      }

      case "notice": {
        const notice: Notice = update;
        const id = nextNoticeIdRef.current++;
        setNotices((prev) => [...prev, { id, notice }]);
        return;
      }

      // Reference: Zed upserts compactions by id; the first update fixes the
      // timeline position and later updates patch the same entry.
      case "compaction_update": {
        setEntries((prev) => {
          const index = prev.findIndex(
            (entry) =>
              entry.type === "compaction" && entry.view.id === update.compactionId,
          );
          const existing =
            index >= 0 && prev[index]?.type === "compaction"
              ? prev[index].view
              : null;
          const view: CompactionView = {
            id: update.compactionId,
            status: update.status,
            summary:
              update.summary !== undefined
                ? (update.summary ?? [])
                : (existing?.summary ?? []),
            error:
              update.error !== undefined ? update.error : (existing?.error ?? null),
          };
          if (index < 0) {
            return [
              ...prev,
              { type: "compaction", id: update.compactionId, view },
            ];
          }
          return prev.map((entry, entryIndex) =>
            entryIndex === index ? { type: "compaction", id: view.id, view } : entry,
          );
        });
        return;
      }

      case "compaction_summary_chunk": {
        setEntries((prev) => {
          const index = prev.findIndex(
            (entry) =>
              entry.type === "compaction" && entry.view.id === update.compactionId,
          );
          if (index < 0) {
            return [
              ...prev,
              {
                type: "compaction",
                id: update.compactionId,
                view: {
                  id: update.compactionId,
                  status: "in_progress",
                  summary: [update.content],
                },
              },
            ];
          }
          return prev.map((entry, entryIndex) => {
            if (entryIndex !== index || entry.type !== "compaction") return entry;
            return {
              type: "compaction",
              id: entry.view.id,
              view: {
                ...entry.view,
                summary: appendBlocks(entry.view.summary, [update.content]),
              },
            };
          });
        });
        return;
      }

      // Usage, commands, modes, config options, and session info are tracked by
      // ACPClient and exposed through their dedicated handlers/hooks.
      default:
        return;
    }
  }, []);

  // =============================================================================
  // Setup Effect
  // =============================================================================
  useEffect(() => {
    client.setSessionCreatedHandler((sessionId) => {
      console.log("[ChatInterface] Session created:", sessionId);
      setAuthRequired(null);
      activateSession(sessionId);
    });

    client.setSessionLoadedHandler((sessionId) => {
      console.log("[ChatInterface] Session loaded/resumed:", sessionId);
      setAuthRequired(null);
      activateSession(sessionId, { resetEntries: false });
      if (client.lastSessionLoadMode === "resume") {
        // Reference: ACP `session/resume` does not replay history (only
        // `session/load` does); make that explicit instead of showing an
        // empty thread.
        pushNotice({
          severity: "info",
          title: "Session resumed",
          description:
            "This agent does not support history replay (session/load). The conversation continues without previous messages.",
        });
      }
    });

    client.setSessionSwitchingHandler((sessionId) => {
      console.log("[ChatInterface] Switching to session:", sessionId);
      setActiveSessionId(sessionId);
      resetThreadState();
    });

    client.setSessionUpdateHandler((sessionId: string, update: SessionUpdate) => {
      handleSessionUpdate(sessionId, update);
    });

    client.setPromptCompleteHandler((stopReason) => {
      console.log("[ChatInterface] Prompt complete:", stopReason);
      ignoreUserEchoRef.current = false;
      lastSentTextRef.current = "";
      echoedTextRef.current = "";
      pendingEchoBlocksRef.current = [];
      setIsLoading(false);
    });

    client.setPermissionRequestHandler(handlePermissionRequest);
    client.setElicitationRequestHandler((payload) => {
      setEntries((prev) => [
        ...prev,
        {
          type: "elicitation",
          id: payload.requestId,
          request: payload.request,
        },
      ]);
    });
    client.setElicitationCompleteHandler((elicitationId) => {
      setEntries((prev) =>
        prev.filter(
          (entry) =>
            !(
              entry.type === "elicitation" &&
              entry.request.mode === "url" &&
              entry.request.elicitationId === elicitationId
            ),
        ),
      );
    });
    client.setElicitationCancelledHandler(() => {
      setEntries((prev) => prev.filter((entry) => entry.type !== "elicitation"));
    });

    // Surface proxy errors (e.g. a failed prompt) in the transcript and stop
    // the loading indicator.
    client.setErrorHandler((message, code) => {
      // Reference: Zed maps JSON-RPC -32000 to AuthRequired and surfaces the
      // agent's auth methods.
      if (code === -32000 || code === -32002) {
        isLoadingRef.current = false;
        setIsLoading(false);
        setAuthRequired({ message });
        return;
      }
      // Surface prompt failures and session-creation errors in the transcript;
      // other errors are already handled by their callers (e.g. thread list).
      if (!isLoadingRef.current && sessionReadyRef.current) return;
      isLoadingRef.current = false;
      setIsLoading(false);
      pushNotice({
        severity: "error",
        title: "Request failed",
        description: message,
      });
    });

    // Create session
    client.createSession();
    return () => {
      client.setSessionCreatedHandler(() => {});
      client.setSessionLoadedHandler(() => {});
      client.setSessionSwitchingHandler(null);
      client.setSessionUpdateHandler(() => {});
      client.setPromptCompleteHandler(() => {});
      client.setPermissionRequestHandler(() => {});
      client.setElicitationRequestHandler(() => {});
      client.setElicitationCompleteHandler(() => {});
      client.setElicitationCancelledHandler(() => {});
      client.setErrorHandler(() => {});
    };
  }, [activateSession, client, handlePermissionRequest, handleSessionUpdate, pushNotice, resetThreadState]);

  // =============================================================================
  // User Actions
  // =============================================================================

  // Reference: Zed's ConnectionView.reset() + set_server_state() + _external_thread()
  // Creates a new session by clearing current state and calling new_session
  // This is the core of Zed's NewThread action
  const handleNewSession = useCallback(() => {
    console.log("[ChatInterface] Creating new session...");

    // Reference: Zed's set_server_state() calls close_all_sessions() before setting new state
    // Cancel any ongoing request before creating new session
    if (isLoading) {
      client.cancel();
    }

    // 1. Clear all entries (like Zed's set_server_state which creates new view)
    resetThreadState();
    setActiveSessionId(null);

    // 3. Create new session (like Zed's initial_state -> connection.new_session())
    // The session_created handler will set sessionReady=true when ready
    client.createSession();
  }, [client, isLoading, resetThreadState]);

  const agentAuthMethods = client.authMethods.filter(
    (method) => !("type" in method && method.type === "terminal"),
  );

  const retrySession = useCallback(() => {
    // Reference: Zed resets the conversation (new thread) after login.
    resetThreadState();
    setActiveSessionId(null);
    client.createSession();
  }, [client, resetThreadState]);

  const handleAuthenticate = useCallback(
    async (methodId: string) => {
      setAuthBusy(methodId);
      try {
        await client.authenticate(methodId);
        setAuthRequired(null);
        retrySession();
      } catch (error) {
        pushNotice({
          severity: "error",
          title: "Authentication failed",
          description: (error as Error).message,
        });
      } finally {
        setAuthBusy(null);
      }
    },
    [client, pushNotice, retrySession],
  );

  const handleElicitationResponse = useCallback(
    (requestId: string, response: CreateElicitationResponse) => {
      client.respondToElicitation(requestId, response);
      setEntries((prev) =>
        prev.filter(
          (entry) => !(entry.type === "elicitation" && entry.id === requestId),
        ),
      );
    },
    [client],
  );

  const handleLogout = useCallback(async () => {
    try {
      await client.logout();
      pushNotice({ severity: "info", title: "Logged out" });
    } catch (error) {
      pushNotice({
        severity: "error",
        title: "Logout failed",
        description: (error as Error).message,
      });
    }
  }, [client, pushNotice]);

  // Reference: Zed's MessageEditor.contents() builds Vec<acp::ContentBlock>
  // from text and attached images. We do the same here.
  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    const files = message.files || [];

    // Allow sending if there's text OR images (like Zed)
    if ((!text && files.length === 0) || isLoading || !sessionReady) return;

    // Reference: Zed clears completed entries from the legacy plan at the start
    // of each turn (`clear_completed_plan_entries`).
    setPlanState((prev) => {
      const legacy = prev.plans.legacy;
      if (!legacy?.entries) return prev;
      const entries = legacy.entries.filter((entry) => entry.status !== "completed");
      if (entries.length === legacy.entries.length) return prev;
      return {
        ...prev,
        plans: { ...prev.plans, legacy: { ...legacy, entries } },
      };
    });

    // Build ContentBlock[] from text and files
    // Reference: Zed's contents() method builds text chunks and image chunks
    const contentBlocks: ContentBlock[] = [];

    // Add text content if present
    if (text) {
      contentBlocks.push({ type: "text", text });
    }

    // Convert image files to ImageContent blocks
    // Reference: Zed's MentionImage stores base64 data + format
    for (const file of files) {
      if (file.mediaType?.startsWith("image/") && file.url) {
        try {
          console.log("[ChatInterface] Processing image:", {
            filename: file.filename,
            mediaType: file.mediaType,
            urlType: file.url.startsWith("data:") ? "data URL" : file.url.startsWith("blob:") ? "blob URL" : "other",
            urlLength: file.url.length,
          });

          // Step 1: Get the image as a Blob/File for compression
          let originalBlob: Blob;
          if (file.url.startsWith("data:")) {
            // Convert data URL to Blob without using fetch()
            // This is critical for Chrome extensions where fetch(dataUrl) violates CSP
            console.log("[ChatInterface] Converting data URL to Blob...");
            originalBlob = dataUrlToBlob(file.url);
          } else {
            // Object URL - fetch directly
            console.log("[ChatInterface] Fetching blob URL...");
            const response = await fetch(file.url);
            if (!response.ok) {
              throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
            }
            originalBlob = await response.blob();
          }

          const originalSizeKB = Math.round(originalBlob.size / 1024);
          console.log("[ChatInterface] Original image size:", originalSizeKB, "KB");

          // Step 2: Compress the image if it's larger than 2MB
          let finalBlob: Blob;
          let finalMimeType: string;

          if (originalBlob.size > 2 * 1024 * 1024) {
            console.log("[ChatInterface] Compressing image...");
            const imageFile = new File([originalBlob], file.filename || "image.jpg", {
              type: originalBlob.type,
            });
            finalBlob = await imageCompression(imageFile, IMAGE_COMPRESSION_OPTIONS);
            finalMimeType = "image/jpeg"; // Compressed images are JPEG
            const compressedSizeKB = Math.round(finalBlob.size / 1024);
            console.log("[ChatInterface] Compressed:", originalSizeKB, "KB ->", compressedSizeKB, "KB");
          } else {
            // Image is already small enough, use as-is
            finalBlob = originalBlob;
            finalMimeType = file.mediaType;
            console.log("[ChatInterface] Image under 2MB, no compression needed");
          }

          // Step 3: Convert to base64
          const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result;
              if (typeof result !== "string") {
                reject(new Error("FileReader returned a non-string result"));
                return;
              }
              const commaIndex = result.indexOf(",");
              resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
            };
            reader.onerror = () => reject(new Error("FileReader error: " + reader.error?.message));
            reader.readAsDataURL(finalBlob);
          });
          console.log("[ChatInterface] Base64 conversion complete, length:", base64Data.length);

          const imageContent: ImageContent = {
            type: "image",
            mimeType: finalMimeType,
            data: base64Data,
          };
          contentBlocks.push(imageContent);
        } catch (error) {
          console.error("[ChatInterface] Failed to process image:", {
            filename: file.filename,
            mediaType: file.mediaType,
            url: file.url?.substring(0, 100),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (contentBlocks.length === 0) return;

    // Add the optimistic user message (Zed stores the sent ContentBlocks).
    const userEntry: UserMessageEntry = {
      type: "user_message",
      id: `user-${Date.now()}`,
      blocks: contentBlocks,
      isOptimistic: true,
    };
    ignoreUserEchoRef.current = true;
    lastSentTextRef.current = text;
    echoedTextRef.current = "";
    pendingEchoBlocksRef.current = contentBlocks.filter(
      (block) => block.type !== "text",
    );
    setEntries((prev) => [...prev, userEntry]);
    setIsLoading(true);

    try {
      // Reference: Zed's AcpThread.send() forwards Vec<acp::ContentBlock>
      await client.sendPrompt(contentBlocks);
    } catch (error) {
      console.error("[ChatInterface] Failed to send prompt:", error);
      ignoreUserEchoRef.current = false;
      lastSentTextRef.current = "";
      echoedTextRef.current = "";
      pendingEchoBlocksRef.current = [];
      setIsLoading(false);
    }
  };

  // Cancel handler - matches Zed's cancel() logic in acp_thread.rs
  // 1. Mark all pending/running/waiting_for_confirmation tool calls as canceled
  // 2. Send cancel notification to agent
  // 3. Do NOT set isLoading=false here - wait for prompt_complete with stopReason="cancelled"
  const handleCancel = () => {
    console.log("[ChatInterface] Cancel requested");

    // Like Zed: iterate all entries, mark Pending/WaitingForConfirmation/InProgress tool calls as Canceled
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.type !== "tool_call") return entry;

        // Check if status should be canceled (matches Zed's logic)
        const shouldCancel =
          entry.toolCall.status === "pending" ||
          entry.toolCall.status === "running" ||
          entry.toolCall.status === "waiting_for_confirmation";

        if (!shouldCancel) return entry;

        console.log("[ChatInterface] Marking tool call as canceled:", entry.toolCall.id);
        return {
          type: "tool_call",
          toolCall: {
            ...entry.toolCall,
            status: "canceled" as ToolCallStatus,
            localStatus: "canceled",
            permissionRequest: undefined, // Clear any pending permission request
          },
        };
      }),
    );

    // Send cancel notification to server (which forwards to agent)
    client.cancel();
    // Note: Do NOT set isLoading=false here!
    // Wait for prompt_complete with stopReason="cancelled" from the agent
  };

  const handlePermissionResponse = useCallback((requestId: string, optionId: string | null, optionKind: PermissionOption["kind"] | null) => {
    console.log("[ChatInterface] Permission response:", { requestId, optionId, optionKind });
    client.respondToPermission(requestId, optionId);

    // Determine new status based on option kind
    const isRejected = optionKind === "reject_once" || optionKind === "reject_always" || optionId === null;

    // Update the tool call status in entries
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.type !== "tool_call") return entry;
        if (entry.toolCall.permissionRequest?.requestId !== requestId) return entry;

        // For standalone permission requests, mark as complete immediately when approved
        // For regular tool calls, mark as running (agent will update to complete later)
        let newStatus: ToolCallStatus;
        if (isRejected) {
          newStatus = "rejected";
        } else if (entry.toolCall.isStandalonePermission) {
          newStatus = "complete";
        } else {
          newStatus = "running";
        }

        return {
          type: "tool_call",
          toolCall: {
            ...entry.toolCall,
            status: newStatus,
            localStatus: isRejected ? "rejected" : undefined,
            permissionRequest: undefined,
            isStandalonePermission: undefined,
          },
        };
      }),
    );
  }, [client]);

  // =============================================================================
  // Render Helpers
  // =============================================================================

  // Map tool status to UI state
  const getToolState = (status: ToolCallStatus) => {
    switch (status) {
      case "error":
        return "output-error" as const;
      case "pending":
        return "input-streaming" as const;
      case "running":
        return "input-available" as const;
      case "waiting_for_confirmation":
        return "waiting-for-confirmation" as const;
      case "rejected":
        return "rejected" as const;
      case "canceled":
        return "output-error" as const; // Show canceled as error state
      case "complete":
      default:
        return "output-available" as const;
    }
  };

  // Render a tool call entry
  const renderToolCall = (entry: ToolCallEntry) => {
    const tool = entry.toolCall;
    const toolOutput = formatToolOutput(tool);
    const hasOutput =
      tool.status !== "pending" &&
      tool.status !== "running" &&
      tool.status !== "waiting_for_confirmation" &&
      toolOutput !== null;

    return (
      <Tool
        key={tool.id}
        defaultOpen={hasOutput || tool.status === "waiting_for_confirmation"}
        className={tool.status === "rejected" ? "border-dashed border-orange-500/50" : undefined}
      >
        <ToolHeader
          title={tool.title}
          type="tool-invocation"
          state={getToolState(tool.status)}
        />
        <ToolContent>
          {tool.kind && (
            <div className="px-4 pt-3">
              <Badge variant="secondary" className="text-[10px] uppercase">
                {tool.kind}
              </Badge>
            </div>
          )}
          {tool.locations && tool.locations.length > 0 && (
            <div className="flex flex-wrap gap-1 px-4 pt-3">
              {tool.locations.map((location, index) => (
                <span
                  key={`${location.path}-${index}`}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {location.path}
                  {location.line != null ? `:${location.line}` : ""}
                </span>
              ))}
            </div>
          )}
          {tool.rawInput != null && (
            <ToolInput input={tool.rawInput} />
          )}
          {tool.terminal && (
            <div className="space-y-2 p-4">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Terminal
              </h4>
              <CodeBlock
                code={tool.terminal.output || "(no output)"}
                language="shell"
              />
              {tool.terminal.exitStatus && (
                <div className="text-xs text-muted-foreground">
                  {tool.terminal.exitStatus.exitCode != null
                    ? `Exited with code ${tool.terminal.exitStatus.exitCode}`
                    : `Terminated by ${tool.terminal.exitStatus.signal ?? "signal"}`}
                </div>
              )}
            </div>
          )}
          {/* Show permission buttons when waiting for confirmation */}
          {tool.status === "waiting_for_confirmation" && tool.permissionRequest && (
            <ToolPermissionButtons
              requestId={tool.permissionRequest.requestId}
              options={tool.permissionRequest.options}
              onRespond={handlePermissionResponse}
            />
          )}
          {/* Show output for completed/error states */}
          {tool.status !== "waiting_for_confirmation" && tool.status !== "rejected" && (
            <ToolOutput
              output={toolOutput}
              errorText={tool.status === "error" ? "Tool execution failed" : undefined}
            />
          )}
        </ToolContent>
      </Tool>
    );
  };

  // Check if we should show thinking indicator
  const showThinkingIndicator = isLoading && entries.length > 0 &&
    entries[entries.length - 1]?.type === "user_message";

  const chatStatus = isLoading ? "streaming" : "ready";

  // Find the index of the last user message for scroll-to-last-user-message feature
  // Reference: Issue #3 - Provide a feature to locate the last human message
  const lastUserMessageIndex = entries.reduce((lastIndex, entry, index) => {
    return entry.type === "user_message" ? index : lastIndex;
  }, -1);

  // =============================================================================
  // Render
  // =============================================================================
  const hasMessages = entries.length > 0;
  const visiblePlan = planState.visiblePlanId
    ? (planState.plans[planState.visiblePlanId] ?? null)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Plan card (full replacement on every plan/plan_update) */}
      {sessionReady && <PlanPanel plan={visiblePlan} />}
      {/* Live notices (dismissible, not part of the transcript) */}
      {notices.length > 0 && (
        <div className="mx-2 mt-2 flex flex-col gap-2">
          {notices.map(({ id, notice }) => (
            <NoticeCard
              key={id}
              notice={notice}
              onDismiss={() =>
                setNotices((prev) => prev.filter((entry) => entry.id !== id))
              }
            />
          ))}
        </div>
      )}
      {/* Messages area */}
      <Conversation className="flex-1">
        <ConversationContent>
          {!sessionReady && entries.length === 0 && notices.length === 0 ? (
            <div className="flex items-center justify-center p-4">
              <Shimmer>Creating session...</Shimmer>
            </div>
          ) : entries.length === 0 ? (
            notices.length === 0 ? (
              <ConversationEmptyState
                title="Start a conversation"
                description="Type a message below to chat with the ACP agent"
              />
            ) : null
          ) : (
            <>
              {entries.map((entry, index) => {
                // Render UserMessage
                // Reference: Zed's render_image_output() displays images in user messages
                if (entry.type === "user_message") {
                  // Mark the last user message with data attribute for scroll-to feature
                  // Reference: Issue #3 - Provide a feature to locate the last human message
                  const isLastUserMessage = index === lastUserMessageIndex;
                  return (
                    <Message
                      key={entry.id}
                      from="user"
                      {...(isLastUserMessage && { [LAST_USER_MESSAGE_ATTR]: "true" })}
                    >
                      <MessageContent>
                        <ContentBlockList blocks={entry.blocks} />
                      </MessageContent>
                    </Message>
                  );
                }

                // Render AssistantMessage (with chunks)
                if (entry.type === "assistant_message") {
                  return (
                    <Message key={entry.id} from="assistant">
                      <MessageContent>
                        {entry.chunks.map((chunk, chunkIndex) => {
                          if (chunk.type === "thought") {
                            // Determine if this thought chunk is still streaming
                            const isLastChunk = chunkIndex === entry.chunks.length - 1;
                            const isThoughtStreaming = isLoading && isLastChunk;
                            return (
                              <Reasoning
                                key={chunkIndex}
                                isStreaming={isThoughtStreaming}
                              >
                                <ReasoningTrigger />
                                <ReasoningContent>
                                  <ContentBlockList blocks={chunk.blocks} />
                                </ReasoningContent>
                              </Reasoning>
                            );
                          }
                          // Regular message chunk
                          return (
                            <ContentBlockList
                              key={chunkIndex}
                              blocks={chunk.blocks}
                            />
                          );
                        })}
                      </MessageContent>
                    </Message>
                  );
                }

                // Render ToolCall (standalone entry)
                if (entry.type === "tool_call") {
                  return (
                    <Message key={entry.toolCall.id} from="assistant">
                      <MessageContent>
                        {renderToolCall(entry)}
                      </MessageContent>
                    </Message>
                  );
                }

                if (entry.type === "compaction") {
                  return <CompactionCard key={entry.id} view={entry.view} />;
                }

                if (entry.type === "elicitation") {
                  return (
                    <ElicitationCard
                      key={entry.id}
                      request={entry.request}
                      onRespond={(response) =>
                        handleElicitationResponse(entry.id, response)
                      }
                    />
                  );
                }

                return null;
              })}

              {/* Thinking indicator - show when loading after user message */}
              {showThinkingIndicator && (
                <Message from="assistant">
                  <MessageContent>
                    <Shimmer>Thinking...</Shimmer>
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        {/* Scroll navigation buttons */}
        <ConversationScrollButtons hasUserMessages={lastUserMessageIndex >= 0} />
      </Conversation>

      {/* Input area */}
      <div className="border-t p-4">
        {authRequired && (
          <div className="mb-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Lock className="size-4 text-orange-500" />
              Authentication required
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {authRequired.message}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {agentAuthMethods.map((method) => (
                <Button
                  key={method.id}
                  size="sm"
                  disabled={authBusy !== null}
                  title={method.description ?? undefined}
                  onClick={() => void handleAuthenticate(method.id)}
                >
                  {authBusy === method.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    method.name
                  )}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={authBusy !== null}
                onClick={() => {
                  setAuthRequired(null);
                  retrySession();
                }}
              >
                Retry
              </Button>
              {client.supportsLogout && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={authBusy !== null}
                  onClick={() => void handleLogout()}
                >
                  Log out
                </Button>
              )}
            </div>
            {agentAuthMethods.length === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                This agent requires an interactive terminal login, which this
                client does not provide.
              </p>
            )}
          </div>
        )}
        {/* Reference: Zed's MessageEditor conditionally shows attachment UI based on supports_images() */}
        <PromptInputProvider attachmentsEnabled={supportsImages}>
          <PromptInput
            onSubmit={handleSubmit}
            accept={supportsImages ? "image/*" : undefined}
            multiple={supportsImages}
          >
            {/* Slash-command suggestions from `available_commands_update` */}
            <SlashCommandMenu commands={availableCommands} />
            {/* Show attachments header when images are supported */}
            {supportsImages && (
              <PromptInputHeader>
                <PromptInputAttachments>
                  {/* children is called per-file, not with array */}
                  {(file) => <PromptInputAttachment data={file} />}
                </PromptInputAttachments>
              </PromptInputHeader>
            )}
            <PromptInputTextarea
              placeholder={sessionReady ? "Type a message..." : "Waiting for session..."}
              disabled={!sessionReady}
            />
            <PromptInputFooter>
              {/* Left side: session config (modes/options), model selector, usage, image button */}
              <div className="flex items-center gap-1">
                {/* Reference: Zed's ConfigOptionsView precedes the legacy mode/model selectors */}
                <SessionConfigSelectors client={client} />
                {/* Reference: Zed's AcpModelSelectorPopover in message editor footer */}
                <ModelSelectorPopover client={client} />
                <UsageIndicator client={client} />
                {/* Reference: Zed's add_images_from_picker() shows image picker button only when supported */}
                {/* Always visible so unsupported agents are discoverable; disabled + tooltip otherwise. */}
                <AddImageButton disabled={!supportsImages} />
              </div>
              {/* Right side: New thread button (when has messages) and submit */}
              <div className="flex items-center gap-1">
                {/* New Thread button - only show when there are messages */}
                {/* Reference: Zed's new_thread_menu in agent_panel.rs */}
                {hasMessages && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={handleNewSession}
                      >
                        <Plus className="h-4 w-4" />
                        <span className="sr-only">New Thread</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New Thread</TooltipContent>
                  </Tooltip>
                )}
                <PromptInputSubmit
                  status={chatStatus}
                  disabled={!sessionReady}
                  onClick={isLoading ? handleCancel : undefined}
                />
              </div>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>
    </div>
  );
}
