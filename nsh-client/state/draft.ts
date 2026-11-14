import type { ContentBlock } from "@agentclientprotocol/sdk";
export type ImageBlock = Extract<ContentBlock, { type: "image" }>;

// A native Input has no GPUI creases. Each image occupies one object replacement
// character; its source block and stable identity live outside the text buffer.
export const IMAGE_MARKER = "\ufffc";
export type DraftImage = { id: number; offset: number; name: string; block: ImageBlock; pending?: Promise<ImageBlock> };
export type DraftSnapshot = { text: string; images: DraftImage[] };
export const emptyDraft = (): DraftSnapshot => ({ text: "", images: [] });
export function pastedImageUri(name: string) {
  const uri = new URL("zed:///agent/pasted-image");
  uri.searchParams.set("name", name);
  return uri.toString();
}
export const imageUrl = (image: ImageBlock) => `data:${image.mimeType};base64,${image.data}`;
export const imageName = (image: ImageBlock) => {
  try {
    const uri = new URL(image.uri ?? "");
    return uri.searchParams.get("name") ?? decodeURIComponent(uri.pathname.split("/").at(-1) || "Image");
  } catch { return "Image"; }
};

/** Mirror Zed's build_chunks_from_creases: text before each image keeps its
 * whitespace; only the outer leading/trailing text whitespace is removed. */
export function draftContent(draft: DraftSnapshot, resolved?: ReadonlyMap<number, ImageBlock>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let cursor = draft.text.length - draft.text.trimStart().length;
  let text = "";
  for (const image of draft.images) {
    text += draft.text.slice(cursor, image.offset);
    const block = resolved ? resolved.get(image.id) : image.block;
    if (block) {
      if (text) blocks.push({ type: "text", text });
      text = "";
      blocks.push(block);
    } else {
      // Zed skips creases absent from the resolved mention map, leaving
      // their underlying link text in the ordinary text chunk.
      text += imageMentionLink(image);
    }
    cursor = image.offset + 1;
  }
  const tail = (text + draft.text.slice(cursor)).trimEnd();
  if (tail) blocks.push({ type: "text", text: tail });
  return blocks;
}

function imageMentionLink(image: DraftImage) {
  return `[@${image.name.replace(/\r\n?/g, "\n")}](${image.block.uri ?? pastedImageUri(image.name)})`;
}

export function restoreDraft(blocks: ContentBlock[], nextId: () => number): DraftSnapshot | null {
  const draft = emptyDraft();
  for (const block of blocks) {
    if (block.type === "text") draft.text += block.text.replace(/\r\n?/g, "\n");
    else if (block.type === "image") {
      // Zed rebuilds editor mentions from the source and emits a new image
      // block, canonicalizing its format and supplying the default image URI.
      const mimeType = block.mimeType === "image/jpg" ? "image/jpeg" : block.mimeType === "image/tif" ? "image/tiff" : block.mimeType;
      const source: ImageBlock = { type: "image", data: block.data, mimeType, uri: block.uri ?? pastedImageUri("Image") };
      draft.images.push({ id: nextId(), offset: draft.text.length, name: imageName(source), block: source });
      draft.text += IMAGE_MARKER;
    } else return null;
  }
  return draft;
}

/** Buffer-anchor adjustment for a native text edit. Removing an image's
 * replacement character removes its attachment, as deleting a Zed crease does. */
export function editDraftRange(draft: DraftSnapshot, start: number, end: number, inserted: string): DraftSnapshot {
  const delta = inserted.length - (end - start);
  return { text: draft.text.slice(0, start) + inserted + draft.text.slice(end),
    images: draft.images.filter(image => image.offset < start || image.offset >= end)
      .map(image => image.offset >= end ? { ...image, offset: image.offset + delta } : image) };
}

export type DraftSelection = { start: number; end: number };
export type DraftEdit = { start: number; end: number; text: string };

/** Native backends that expose an edit range use editDraftRange directly.
 * This fallback serves NSH backends reporting only their resulting value. */
export function draftEdit(before: string, after: string, selection?: DraftSelection): DraftEdit | null {
  if (selection && selection.start > selection.end) selection = { start: selection.end, end: selection.start };
  if (after === before) return selection && selection.end > selection.start
    ? { ...selection, text: after.slice(selection.start, selection.end) } : null;
  if (selection) {
    const delta = after.length - before.length;
    const candidates = [selection, { start: selection.start + Math.min(delta, 0), end: selection.start },
      { start: selection.start, end: selection.start - Math.min(delta, 0) }];
    for (const range of candidates) {
      const end = range.end + delta;
      if (range.start < 0 || end < range.start || range.end > before.length) continue;
      if (after.slice(0, range.start) === before.slice(0, range.start)
        && after.slice(end) === before.slice(range.end)) {
        return { ...range, text: after.slice(range.start, end) };
      }
    }
  }
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, end = after.length;
  while (oldEnd > start && end > start && before[oldEnd - 1] === after[end - 1]) { oldEnd--; end--; }
  return { start, end: oldEnd, text: after.slice(start, end) };
}

export function changeDraft(draft: DraftSnapshot, text: string, selection?: DraftSelection): DraftSnapshot {
  const edit = draftEdit(draft.text, text, selection);
  return edit ? editDraftRange(draft, edit.start, edit.end, edit.text) : draft;
}

export function appendDraft(current: DraftSnapshot, next: DraftSnapshot): { draft: DraftSnapshot; offset: number } {
  if (!current.text.trim()) return { draft: next, offset: 0 };
  const offset = current.text.length + 2;
  return { draft: { text: `${current.text}\n\n${next.text}`, images: [...current.images,
    ...next.images.map(image => ({ ...image, offset: image.offset + offset }))] }, offset };
}

export function insertDraftImages(draft: DraftSnapshot, images: Omit<DraftImage, "offset">[], start: number, end: number) {
  const insertion = images.map(() => `${IMAGE_MARKER} `).join("");
  const updated = editDraftRange(draft, start, end, insertion);
  updated.images.push(...images.map((image, index) => ({ ...image, offset: start + index * 2 })));
  updated.images.sort((a, b) => a.offset - b.offset);
  return { draft: updated, offset: start + insertion.length };
}

/** MessageEditor::clear_mentions removes creases and their sources while the
 * underlying editor's link text remains undoable. Expand our UI-only markers
 * into that same link text when their mention registrations are released. */
export function withoutImageMentions(draft: DraftSnapshot, selection: DraftSelection, id?: number) {
  if (!draft.images.length) return { draft, selection: { ...selection } };
  let text = "", cursor = 0;
  const images: DraftImage[] = [];
  let start = selection.start, end = selection.end;
  for (const image of draft.images) {
    if (id !== undefined && image.id !== id) {
      images.push({ ...image, offset: text.length + image.offset - cursor });
      continue;
    }
    const link = imageMentionLink(image);
    text += draft.text.slice(cursor, image.offset) + link;
    cursor = image.offset + 1;
    if (selection.start > image.offset) start += link.length - 1;
    if (selection.end > image.offset) end += link.length - 1;
  }
  return { draft: { text: text + draft.text.slice(cursor), images } as DraftSnapshot, selection: { start, end } };
}

type DraftTransaction = {
  before: DraftSnapshot; after: DraftSnapshot;
  undoSelection: DraftSelection; redoSelection: DraftSelection;
  lastEdit: number;
};

/** Zed editor::TransactionSelections: each transaction owns independent undo
 * and redo selections. Caret movement never mutates transaction history. */
export class DraftHistory {
  private transactions: DraftTransaction[] = [];
  private cursor = 0;
  private canGroup = false;
  private interval: number;
  constructor(_initial = emptyDraft(), interval = 300) { this.interval = interval; }
  reset(_input: DraftSnapshot) { this.transactions = []; this.cursor = 0; this.canGroup = false; }
  record(before: DraftSnapshot, after: DraftSnapshot, separate = false, now = Date.now(),
    beforeSelection = { start: before.text.length, end: before.text.length },
    afterSelection = { start: after.text.length, end: after.text.length }) {
    if (before === after) return;
    this.transactions.length = this.cursor;
    const previous = this.transactions[this.cursor - 1];
    // text::History::group keeps the first transaction's undo state and the
    // final transaction's redo state; edits are grouped for 300 ms.
    if (!separate && this.canGroup && previous && now - previous.lastEdit < this.interval) {
      previous.after = after;
      previous.redoSelection = { ...afterSelection };
      previous.lastEdit = now;
    } else {
      this.transactions.push({ before, after, undoSelection: { ...beforeSelection },
        redoSelection: { ...afterSelection }, lastEdit: now });
      this.cursor++;
    }
    this.canGroup = !separate;
  }
  undo() {
    this.canGroup = false;
    const transaction = this.transactions[this.cursor - 1];
    if (!transaction) return null;
    this.cursor--;
    return { draft: transaction.before, selection: { ...transaction.undoSelection } };
  }
  redo() {
    this.canGroup = false;
    const transaction = this.transactions[this.cursor];
    if (!transaction) return null;
    this.cursor++;
    return { draft: transaction.after, selection: { ...transaction.redoSelection } };
  }
  clearMentions(id?: number) {
    this.transactions = this.transactions.map(transaction => {
      const before = withoutImageMentions(transaction.before, transaction.undoSelection, id);
      const after = withoutImageMentions(transaction.after, transaction.redoSelection, id);
      return { ...transaction, before: before.draft, after: after.draft,
        undoSelection: before.selection, redoSelection: after.selection };
    });
  }
  updateImage(id: number, update: Partial<DraftImage>) {
    const patch = (draft: DraftSnapshot): DraftSnapshot => ({ ...draft,
      images: draft.images.map(image => image.id === id ? { ...image, ...update } : image) });
    this.transactions = this.transactions.map(transaction => ({ ...transaction,
      before: patch(transaction.before), after: patch(transaction.after) }));
  }
}
