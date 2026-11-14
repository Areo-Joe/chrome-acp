/** Zed conversation_view/message_queue.rs, for external ACP v1 queues.
 * Native-only steering lives outside this state machine's v1 integration.
 */
export class MessageQueue<Entry extends { id: number }> {
  entries: Entry[] = [];
  processing: "auto" | "paused" | "absorbing-cancel" = "auto";
  private fastTrack = false;
  private next = 0;

  nextId() { return this.next++; }
  first() { return this.entries[0]; }
  last() { return this.entries.at(-1); }
  get(id: number) { return this.entries.find(entry => entry.id === id); }
  canFastTrack() { return this.fastTrack && this.entries.length > 0; }

  enqueue(entry: Entry) {
    this.entries.push(entry);
    this.processing = "auto";
    this.fastTrack = true;
  }
  remove(id: number) {
    const index = this.entries.findIndex(entry => entry.id === id);
    return index < 0 ? undefined : this.entries.splice(index, 1)[0];
  }
  restoreAfterFailedSend(entry: Entry) {
    const index = this.entries.findIndex(queued => queued.id > entry.id);
    this.entries.splice(index < 0 ? this.entries.length : index, 0, entry);
    this.pause();
  }
  clear() { this.entries = []; this.fastTrack = false; }
  tryFastTrack(generating: boolean) {
    if (!this.fastTrack) return;
    this.fastTrack = false;
    const entry = this.entries.shift();
    if (!entry) return;
    this.processing = generating ? "absorbing-cancel" : "auto";
    return entry;
  }
  autoSendCandidate(firstEditorFocused: boolean) {
    return this.processing === "auto" && !firstEditorFocused ? this.first() : undefined;
  }
  onGenerationStopped(firstEditorFocused: boolean) {
    if (this.processing === "absorbing-cancel") { this.processing = "auto"; return; }
    return this.autoSendCandidate(firstEditorFocused) ? this.entries.shift() : undefined;
  }
  sendNow(id: number, generating: boolean) {
    const entry = this.remove(id);
    if (entry && generating) this.processing = "absorbing-cancel";
    return entry;
  }
  pause() { this.processing = "paused"; }
  resume() { this.processing = "auto"; }
}
