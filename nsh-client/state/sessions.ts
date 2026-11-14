import { batch, effect, signal, untracked } from "nsh";
import { historyInfoPatch, historyTimestamp, type HistorySession } from "../acp/client";
import type { Connection } from "./connection";
import { createComposer, type ComposerState } from "./composer";
import type { ContentBlock } from "@agentclientprotocol/sdk";

export type OpenSession = { key: number; info: HistorySession; composer: ComposerState };

/** Mirrors Zed's retained conversation views: switching selects an owner; it
 * does not cancel a turn, reload an already-open ID, or move its draft. */
export const DEFAULT_MAX_IDLE_RETAINED_THREADS = 5;

export function createSessions(connection: Connection, settings: { maxIdleRetainedThreads?: number } = {}) {
  const maxIdle = settings.maxIdleRetainedThreads ?? DEFAULT_MAX_IDLE_RETAINED_THREADS;
  if (!Number.isSafeInteger(maxIdle) || maxIdle < 0) throw new Error("maxIdleRetainedThreads must be a non-negative integer");
  const client = connection.getClient();
  if (!client) throw new Error("Session history requires a connection");
  const views = signal<OpenSession[]>([]);
  const active = signal<OpenSession | null>(null);
  const visible = signal(false);
  const rows = signal<HistorySession[]>([]);
  const phase = signal<"idle" | "loading" | "ready" | "error">("idle");
  const error = signal<string | null>(null);
  const cursor = signal<string | null>(null);
  const deleting = signal<string | null>(null);
  const confirmDelete = signal<string | null>(null);
  const patches = new Map<string, Map<keyof HistorySession, { revision: number; value: unknown }>>();
  // Like Zed's draft/metadata stores, these survive a view without retaining its thread.
  const savedDrafts = new Map<string, string>();
  const savedQueues = new Map<string, ContentBlock[][]>();
  const releasedInfo = new Map<string, HistorySession>();
  let revision = 0;
  let generation = 0;
  let keys = 0;
  let disposed = false;
  let loaded = false;
  let lastMore = false;

  const timestamp = (row: HistorySession) => historyTimestamp(row.updatedAt) ?? 0;
  const sort = (items: HistorySession[]) => items.sort((a, b) => timestamp(b) - timestamp(a));
  function patch(row: HistorySession, since = -1) {
    let result = row;
    for (const [field, change] of patches.get(row.sessionId) ?? []) {
      if (change.revision > since) result = { ...result, [field]: change.value };
    }
    return result;
  }

  function updateViews(id: string, changes: Partial<HistorySession>) {
    views.set(views().map((view) => view.composer.id() === id ? { ...view, info: { ...view.info, ...changes } } : view));
    const current = active();
    if (current?.composer.id() === id) active.set(views().find((view) => view.key === current.key)!);
  }

  async function load(more = false) {
    if (disposed || !client!.supportsHistory || (more && (phase() === "loading" || cursor() === null))) return;
    const request = ++generation;
    lastMore = more;
    const next = more ? cursor()! : undefined;
    const startedAt = revision;
    loaded = true;
    phase.set("loading");
    error.set(null);
    try {
      const page = await client!.listSessions(next !== undefined ? { cursor: next } : {});
      if (disposed || request !== generation) return;
      const merged = new Map([...releasedInfo.values(), ...(more ? rows() : [])].map((row) => [row.sessionId, row]));
      for (const row of page.sessions) {
        const latest = patches.get(row.sessionId);
        const current = patch(row, startedAt);
        merged.set(row.sessionId, current);
        if (releasedInfo.has(row.sessionId)) releasedInfo.set(row.sessionId, current);
        updateViews(row.sessionId, { title: current.title, updatedAt: current.updatedAt, _meta: current._meta });
        if (latest) {
          for (const [field, change] of latest) if (change.revision <= startedAt) latest.delete(field);
          if (latest.size === 0) patches.delete(row.sessionId);
        }
      }
      rows.set(sort([...merged.values()]));
      cursor.set(page.nextCursor !== undefined && page.nextCursor !== next ? page.nextCursor : null);
      phase.set("ready");
    } catch (reason) {
      if (disposed || request !== generation) return;
      error.set(reason instanceof Error ? reason.message : "Cannot list sessions.");
      phase.set("error");
    }
  }

  const unwatch = client.watchHistory((id, update) => {
    if (disposed) return;
    if (id !== undefined && update?.sessionUpdate === "session_info_update") {
      const changes = historyInfoPatch(update);
      const fields = patches.get(id) ?? new Map();
      const currentRevision = ++revision;
      for (const [field, value] of Object.entries(changes)) fields.set(field as keyof HistorySession, { revision: currentRevision, value });
      patches.set(id, fields);
      rows.set(sort(rows().map((row) => row.sessionId === id ? patch(row) : row)));
      const released = releasedInfo.get(id);
      if (released) releasedInfo.set(id, { ...released, ...changes });
      updateViews(id, changes);
    } else if (loaded) void load();
  });

  function create(info?: HistorySession) {
    if (disposed) return;
    const existing = info && views().find((view) => view.composer.id() === info.sessionId);
    if (existing) { active.set(existing); visible.set(false); return; }
    if (info && !client!.supportsRestore) return;
    const details = info ?? { sessionId: "", cwd: client!.workingDirectory, additionalDirectories: [] };
    const sessionClient = client!.forkSession(details.cwd, details.additionalDirectories);
    const key = ++keys;
    const composer = createComposer(connection, { client: sessionClient, session: info, onReady: (id) => {
      if (disposed) return;
      views.set(views().map((view) => view.key === key ? { ...view, info: patch({ ...view.info, sessionId: id }) } : view));
      if (active()?.key === key) active.set(views().find((view) => view.key === key)!);
      if (loaded) void load();
    } });
    if (info) {
      composer.draft.set(savedDrafts.get(info.sessionId) ?? "");
      composer.restoreQueue(savedQueues.get(info.sessionId) ?? []);
    }
    const view = { key, info: details, composer };
    // Zed swaps base_view before retaining the old one. Do not expose a newly
    // added loading view as an inactive retention candidate between these writes.
    batch(() => {
      views.set([...views(), view]);
      active.set(view);
      visible.set(false);
    });
  }

  async function remove(row: HistorySession) {
    if (disposed || deleting() !== null || !client!.supportsDelete) return;
    const open = views().find((view) => view.composer.id() === row.sessionId);
    if (open && (open.composer.thread.generating() || open.composer.queueLoading() || open.composer.phase() !== "ready")) return;
    deleting.set(row.sessionId);
    open?.composer.phase.set("deleting");
    error.set(null);
    try {
      await client!.deleteSession(row.sessionId);
      if (disposed) return;
      open?.composer.dispose();
      batch(() => {
        views.set(views().filter((view) => view.key !== open?.key));
        rows.set(rows().filter((entry) => entry.sessionId !== row.sessionId));
        patches.delete(row.sessionId);
        savedDrafts.delete(row.sessionId);
        savedQueues.delete(row.sessionId);
        releasedInfo.delete(row.sessionId);
        if (open && active()?.key === open.key) {
          active.set(views().at(-1) ?? null);
          if (!active()) create();
        }
        confirmDelete.set(null);
      });
    } catch (reason) {
      if (!disposed) {
        open?.composer.phase.set("ready");
        error.set(reason instanceof Error ? reason.message : "Cannot delete session.");
      }
    } finally {
      if (!disposed) deleting.set(null);
    }
  }

  effect(() => {
    const selected = active()?.key;
    const snapshot = views().map((view) => ({
      view, id: view.composer.id(), hasThread: view.composer.hasThread(),
      draft: view.composer.draft(), idle: view.composer.thread.idleForRetention(),
      queued: view.composer.queued().map(entry => entry.content),
      sending: view.composer.queueLoading(), recovering: view.composer.recoveringQueue(),
      updatedAt: view.composer.thread.activity(),
    }));
    untracked(() => {
      if (disposed) return;
      for (const entry of snapshot) {
        if (entry.id === null) continue;
        if (entry.draft.length) savedDrafts.set(entry.id, entry.draft);
        else savedDrafts.delete(entry.id);
        if (entry.queued.length) savedQueues.set(entry.id, entry.queued);
        else savedQueues.delete(entry.id);
      }
      const candidates = snapshot.filter((entry) => {
        if (entry.view.key === selected) return false;
        // Like Zed's saved-input/loading guards, keep a pending dispatch or
        // recovery owner alive. Settled queues can live in the input store.
        if (entry.sending || entry.recovering) return false;
        // Saved input without a session ID has no independent draft-store key.
        if (entry.id === null && (entry.draft.length > 0 || entry.queued.length > 0)) return false;
        // Zed checks the root thread first: an absent root does not require load.
        if (!entry.hasThread) return true;
        return client!.agentCapabilities?.loadSession === true && entry.idle;
      });
      candidates.sort((a, b) => (a.updatedAt ?? -Infinity) - (b.updatedAt ?? -Infinity) || a.view.key - b.view.key);
      const expired = candidates.slice(0, Math.max(0, candidates.length - maxIdle));
      if (!expired.length) return;
      const keys = new Set(expired.map((entry) => entry.view.key));
      views.set(views().filter((view) => !keys.has(view.key)));
      const known = new Map(rows().map((row) => [row.sessionId, row]));
      for (const entry of expired) {
        if (entry.id !== null) {
          const info = { ...entry.view.info, sessionId: entry.id };
          releasedInfo.set(entry.id, info);
          if (!known.has(entry.id)) known.set(entry.id, info);
        }
        // Start release immediately so opening the same ID observes its pending barrier.
        void entry.view.composer.dispose(true);
      }
      rows.set(sort([...known.values()]));
    });
  });

  create();
  return {
    views, active, visible, rows, phase, error, cursor, deleting, confirmDelete,
    supportsHistory: client.supportsHistory, supportsRestore: client.supportsRestore, supportsDelete: client.supportsDelete,
    show: () => { visible.set(true); confirmDelete.set(null); if (!loaded) void load(); },
    canOpen: (row: HistorySession) => client!.supportsRestore || views().some((view) => view.composer.id() === row.sessionId),
    canDelete: (row: HistorySession) => !views().some((view) => view.composer.id() === row.sessionId && (view.composer.thread.generating() || view.composer.queueLoading() || view.composer.phase() !== "ready")),
    retry: () => { void load(lastMore); },
    refresh: () => { void load(); }, more: () => { void load(true); },
    activate: (view: OpenSession) => { active.set(view); visible.set(false); },
    open: (row: HistorySession) => create(row), newSession: () => create(),
    remove: (row: HistorySession) => { void remove(row); },
    dispose: () => { disposed = true; generation++; unwatch(); for (const view of views()) view.composer.dispose(); },
  };
}
export type SessionsState = ReturnType<typeof createSessions>;
