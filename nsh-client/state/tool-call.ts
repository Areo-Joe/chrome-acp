import type {
  ContentBlock,
  PermissionOption,
  RequestPermissionOutcome,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus as ReportedStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";

/** A tool call's status as the thread shows it: the agent's, or a decision made here. Mirrors Zed's `ToolCallStatus`. */
export type ToolStatus =
  | "pending"
  | "waiting_for_confirmation"
  | "in_progress"
  | "completed"
  | "failed"
  | "rejected"
  | "canceled";

/** An agent's `session/request_permission`, answered once. */
export type PermissionRequest = {
  id: number;
  options: PermissionOption[];
  respond: (outcome: RequestPermissionOutcome) => void;
};

export type ToolCallState = {
  title: string | null;
  name: string | null;
  kind: ToolKind | null;
  reportedStatus: ReportedStatus | null;
  /** A decision made here (a permission choice, a cancellation), until the agent reports a status. */
  localStatus: ToolStatus | null;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput: unknown;
  rawOutput: unknown;
  authorization: PermissionRequest | null;
};

/** Fields to change; a missing field keeps its value. */
export type ToolCallPatch = {
  title?: string;
  name?: string;
  kind?: ToolKind;
  status?: ReportedStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

/** Content the thread shows: the agent's, or its raw output when it sent none. */
export type ToolOutput = ToolCallContent | { type: "markdown"; markdown: string };

const field = <T>(value: T | null | undefined) => (value === null ? undefined : value);

/** A `tool_call` sets every field; ACP's defaults fill the ones it omits. */
export function patchFromToolCall(call: ToolCall): ToolCallPatch {
  return {
    title: call.title,
    name: field(call.name),
    kind: call.kind ?? "other",
    status: call.status ?? "pending",
    content: call.content ?? [],
    locations: call.locations ?? [],
    rawInput: field(call.rawInput),
    rawOutput: field(call.rawOutput),
  };
}

/** A `tool_call_update` changes only the fields it sets; v1 `null` leaves a field as it is. */
export function patchFromUpdate(update: ToolCallUpdate): ToolCallPatch {
  return {
    title: field(update.title),
    name: field(update.name),
    kind: field(update.kind),
    status: field(update.status),
    content: field(update.content),
    locations: field(update.locations),
    rawInput: field(update.rawInput),
    rawOutput: field(update.rawOutput),
  };
}

export function createToolCallState(patch: ToolCallPatch): ToolCallState {
  return applyToolCallPatch({
    title: null,
    name: null,
    kind: null,
    reportedStatus: null,
    localStatus: null,
    content: [],
    locations: [],
    rawInput: undefined,
    rawOutput: undefined,
    authorization: null,
  }, patch).state;
}

/** Applies `patch`; a finished tool call no longer waits for permission, so its request is detached to be answered as cancelled. */
export function applyToolCallPatch(state: ToolCallState, patch: ToolCallPatch): { state: ToolCallState; detached: PermissionRequest | null } {
  const next = { ...state };
  let detached: PermissionRequest | null = null;
  if (patch.status !== undefined) {
    if ((patch.status === "completed" || patch.status === "failed") && next.authorization) {
      detached = next.authorization;
      next.authorization = null;
    }
    next.reportedStatus = patch.status;
    next.localStatus = null;
  }
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.content !== undefined) next.content = patch.content;
  if (patch.locations !== undefined) next.locations = patch.locations;
  if (patch.rawInput !== undefined) next.rawInput = patch.rawInput;
  if (patch.rawOutput !== undefined) next.rawOutput = patch.rawOutput;
  return { state: next, detached };
}

export function fromReported(status: ReportedStatus | null | undefined): ToolStatus | null {
  return status ?? null;
}

function underlyingStatus(state: ToolCallState): ToolStatus {
  return state.localStatus ?? fromReported(state.reportedStatus) ?? "pending";
}

export function toolStatus(state: ToolCallState): ToolStatus {
  return state.authorization ? "waiting_for_confirmation" : underlyingStatus(state);
}

/** The status a permission request continues from; a canceled or rejected tool call has none. */
export function permissionStatus(state: ToolCallState): ReportedStatus | null {
  const status = state.localStatus ?? fromReported(state.reportedStatus);
  return status === "pending" || status === "in_progress" || status === "completed" || status === "failed" ? status : null;
}

/** Records `status` as a local decision only where it differs from the agent's. */
export function withLegacyStatus(state: ToolCallState, status: ToolStatus): ToolCallState {
  return { ...state, localStatus: status !== fromReported(state.reportedStatus) ? status : null };
}

/** The status after the user allows the tool call: one that has not started runs now. */
export function statusAfterPermissionGrant(status: ReportedStatus | null): ToolStatus {
  const current = fromReported(status) ?? "pending";
  return current === "pending" ? "in_progress" : current;
}

export function toolKind(state: ToolCallState): ToolKind {
  return state.kind ?? "other";
}

const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!|<>~^$&=]/g, "\\$&");

/** The tool call's header: its title (an edit's as written, another's first line), else its name. Plain text when it has no title or runs a command. */
export function toolLabel(state: ToolCallState): { text: string; markdown: boolean } {
  const title = state.title?.trim() ? state.title : null;
  if (!title) return { text: state.name?.trim() ? state.name : "Tool call", markdown: false };
  const kind = toolKind(state);
  if (kind === "execute") return { text: title, markdown: false };
  if (kind === "edit") return { text: escapeMarkdown(title), markdown: true };
  const newline = title.indexOf("\n");
  return { text: newline === -1 ? title : `${title.slice(0, newline)}…`, markdown: true };
}

/** Raw input or output as Markdown: text as it is, other JSON as a code block. */
export function rawText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function toolOutput(state: ToolCallState): ToolOutput[] {
  if (state.content.length > 0) return state.content;
  const text = rawText(state.rawOutput);
  return text === null ? [] : [{ type: "markdown", markdown: text }];
}

export function hasDiff(state: ToolCallState): boolean {
  return state.content.some((content) => content.type === "diff");
}

/** How a content block shows in a tool call's output: Markdown, an image, a resource's URI, or a link. */
export type BlockView =
  | { type: "markdown"; markdown: string }
  | { type: "image"; src: string }
  | { type: "resource"; uri: string }
  | { type: "link"; uri: string };

const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml",
  "image/bmp", "image/tiff", "image/tif", "image/ico", "image/x-portable-anymap",
]);

const isBase64 = (data: string) => data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);

/** A data URI for base64 `data` in an image format that displays, else null. */
function imageSource(data: string, mimeType: string | null | undefined): string | null {
  return mimeType && IMAGE_MIME_TYPES.has(mimeType) && isBase64(data) ? `data:${mimeType};base64,${data}` : null;
}

/** `text` in a code fence longer than any backtick run inside it. */
function fencedCodeBlock(text: string, language: string | null): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1));
  const fence = "`".repeat(Math.max(3, longest));
  return `${fence}${language ?? ""}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** A text resource as Markdown: Markdown as it is, anything else as code, highlighted by its MIME type. */
function textResourceMarkdown(text: string, mimeType: string | null | undefined): string {
  const mime = mimeType?.split(";")[0].trim().toLowerCase() ?? "";
  const slash = mime.indexOf("/");
  if (slash <= 0) return fencedCodeBlock(text, null);
  const type = mime.slice(0, slash);
  const full = mime.slice(slash + 1);
  const plus = full.lastIndexOf("+");
  const subtype = plus === -1 ? full : full.slice(0, plus);
  const suffix = plus === -1 ? null : full.slice(plus + 1);
  if (type === "text" && (subtype === "markdown" || subtype === "x-markdown")) return text;
  const language = (() => {
    if (subtype === "json" || suffix === "json") return "json";
    if (subtype === "xml" || suffix === "xml") return "xml";
    if (type === "text") {
      const languages: Record<string, string> = {
        html: "html", css: "css", csv: "csv", "tab-separated-values": "tsv", javascript: "javascript",
        typescript: "typescript", "x-shellscript": "sh", "x-python": "python", "x-rust": "rust",
        "x-go": "go", "x-ruby": "ruby", "x-c": "c",
      };
      if (subtype === "x-c+" && suffix === "") return "cpp";
      return languages[subtype] ?? null;
    }
    if (type === "application") {
      const languages: Record<string, string> = {
        javascript: "javascript", "x-javascript": "javascript", typescript: "typescript",
        "x-shellscript": "sh", "x-sh": "sh", graphql: "graphql", toml: "toml", yaml: "yaml", "x-yaml": "yaml",
      };
      if (languages[subtype]) return languages[subtype];
    }
    return suffix === "yaml" || suffix === "yml" ? "yaml" : null;
  })();
  return fencedCodeBlock(text, language);
}

/** Mirrors Zed's `ContentBlock::render_from_source`. */
export function blockView(block: ContentBlock): BlockView {
  switch (block.type) {
    case "text":
      return { type: "markdown", markdown: block.text };
    case "image": {
      const src = imageSource(block.data, block.mimeType);
      return src ? { type: "image", src } : { type: "markdown", markdown: "Image content could not be displayed." };
    }
    case "resource": {
      const resource = block.resource;
      if ("blob" in resource) {
        const src = imageSource(resource.blob, resource.mimeType);
        return src ? { type: "image", src } : { type: "resource", uri: resource.uri };
      }
      return { type: "markdown", markdown: textResourceMarkdown(resource.text, resource.mimeType) };
    }
    case "resource_link":
      return { type: "link", uri: block.uri };
    case "audio":
      return { type: "markdown", markdown: "Audio content is not supported." };
    default:
      return { type: "markdown", markdown: "Unknown content type is not supported." };
  }
}

export function hasImage(output: ToolOutput[]): boolean {
  return output.some((content) => content.type === "content" && blockView(content.content).type === "image");
}

/** Whether a canceled tool call has anything worth showing: text that is not blank, or anything else. */
export function hasVisibleOutput(state: ToolCallState): boolean {
  return toolOutput(state).some((content) => {
    if (content.type === "markdown") return content.markdown.trim().length > 0;
    if (content.type !== "content") return true;
    const view = blockView(content.content);
    if (view.type === "markdown") return view.markdown.trim().length > 0;
    if (view.type === "resource") return view.uri.trim().length > 0;
    return true;
  });
}

/** Zed hides a canceled tool call that never showed anything. */
export function isHiddenToolCall(state: ToolCallState): boolean {
  return toolStatus(state) === "canceled" && !hasVisibleOutput(state);
}
