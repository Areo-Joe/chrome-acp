import { batch, effect, signal, untracked } from "nsh";
import type { AvailableCommand, ContentBlock, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import type { Connection } from "./connection";
import { createOptimisticChange } from "./optimistic-change";
import { createThread } from "./thread";
import { MessageQueue } from "./message-queue";
import { authenticationKind, authenticationRequired, type AcpClient, type HistorySession } from "../acp/client";

export type Choice = { value: string | boolean; name: string; description?: string | null; group?: string };
export type QueuedMessage = { id: number; content: ContentBlock[] };
export const queuedText = (content: ContentBlock[]): string | null => content.every(block => block.type === "text")
  ? content.map(block => block.type === "text" ? block.text : "").join("") : null;

export function configChoices(option: SessionConfigOption): Choice[] {
  if (option.type === "boolean") return [{ value: true, name: "On" }, { value: false, name: "Off" }];
  return option.options.flatMap((entry) => "options" in entry
    ? entry.options.map((choice) => ({ ...choice, group: entry.name }))
    : [entry]);
}

export function commandMatches(text: string, commands: AvailableCommand[]): AvailableCommand[] {
  const match = /^\/([^\s]*)$/.exec(text);
  if (!match) return [];
  const prefix = match[1].toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
}

export function commandHint(text: string, commands: AvailableCommand[]): string | null {
  const match = /^\/([^\s]+)\s*$/.exec(text);
  return match ? commands.find((command) => command.name === match[1])?.input?.hint ?? null : null;
}

export function createComposer(connection: Connection, settings: {
  client?: AcpClient; session?: HistorySession; onReady?: (id: string) => void;
} = {}) {
  const client = settings.client ?? connection.getClient();
  if (!client) throw new Error("Chat requires a connected ACP client");
  const phase = signal<"loading" | "ready" | "error" | "deleting" | "auth-required" | "authenticating">("loading");
  const error = signal<string | null>(null);
  const draft = signal("");
  const commands = signal<AvailableCommand[]>([]);
  const options = signal<SessionConfigOption[] | null>(null);
  const modes = signal<SessionModeState | null>(null);
  let disposed = false;
  const hasThread = signal(false);
  let finishDisposed!: () => void;
  const disposedView = new Promise<null>((resolve) => { finishDisposed = () => resolve(null); });
  let sessionId: string | null = settings.session?.sessionId ?? null;
  const sessionKey = signal(sessionId);
  const resumedWithoutHistory = signal(false);
  let sessionGeneration = 0;
  let authGeneration = 0;
  const authDescription = signal<string | null>(null);
  const pendingAuthMethod = signal<string | null>(null);
  let messageQueue = new MessageQueue<QueuedMessage>();
  const queued = signal<QueuedMessage[]>([]);
  const queueExpanded = signal(true);
  const queueFocused = signal<number | null>(null);
  const queueLoading = signal(false);
  const canFastTrack = signal(false);
  const recoveringQueue = signal(false);
  const focusRequest = signal<{ version: number; offset?: number }>({ version: 0 });
  let dispatchGeneration = 0;
  let dispatchEntry: QueuedMessage | null = null;
  const thread = createThread(client, {
    agentName: () => client.agentInfo?.title ?? client.agentInfo?.name ?? "The agent",
    onStopped: handleQueueStopped,
  });
  client.setSessionUpdateHandler(thread.handleUpdate);
  client.setPermissionHandler(thread.requestPermission);
  const change = createOptimisticChange<{ id: string; value: string | boolean; legacy: boolean }>({
    send: (target) => target.legacy
      ? client.setSessionMode(String(target.value))
      : client.setConfigOption(target.id, target.value),
    isCurrent: (target) => target.legacy
      ? modes()?.currentModeId === target.value
      : options()?.find((option) => option.id === target.id)?.currentValue === target.value,
    onError: (reason) => fail(reason instanceof Error ? reason.message : "Cannot change configuration."),
  });
  const pending = () => change.target()?.id ?? null;
  let previousDraft = draft();
  effect(() => {
    const next = draft();
    if (next !== previousDraft) { previousDraft = next; untracked(thread.touch); }
  });

  function publishQueue(touch = true) {
    if (!messageQueue.entries.length) recoveringQueue.set(false);
    queued.set([...messageQueue.entries]);
    canFastTrack.set(messageQueue.canFastTrack());
    if (touch) thread.touch();
  }

  function focusMain(offset?: number) {
    queueFocused.set(null);
    focusRequest.set({ version: focusRequest().version + 1, offset });
  }

  function validateQueued(entry: QueuedMessage) {
    // The local composer currently creates text blocks only. Retain a future
    // unsupported source rather than dequeueing it and silently losing data.
    const known = new Set(["text", "image", "audio", "resource", "resource_link"]);
    if (!entry.content.every(block => known.has(block.type))) {
      thread.reportError(new Error("This queued message contains unsupported content and cannot be sent."));
      return false;
    }
    return true;
  }

  function dispatchQueued(entry: QueuedMessage) {
    const generation = ++dispatchGeneration;
    dispatchEntry = entry;
    queueLoading.set(true);
    focusMain();
    publishQueue();
    void (async () => {
      try {
        // Zed's dispatch_queued_entry cancels and waits before actually sending.
        // Keep the old turn current until its completion has been absorbed.
        await thread.cancelForQueue();
        if (disposed || generation !== dispatchGeneration) return;
        batch(() => {
          dispatchEntry = null;
          queueLoading.set(false);
          void thread.send(entry.content);
        });
      } catch (reason) {
        if (disposed || generation !== dispatchGeneration) return;
        batch(() => {
          dispatchEntry = null;
          messageQueue.restoreAfterFailedSend(entry);
          queueLoading.set(false);
          publishQueue();
          thread.reportError(reason);
        });
      }
    })();
  }

  function handleQueueStopped() {
    if (disposed || phase() !== "ready" || thread.generating()) return;
    // JS waits for the v1 prompt's completion in cancelForQueue. Absorb that
    // old completion while loading, without dispatching a second queue entry.
    if (queueLoading()) {
      if (messageQueue.processing === "absorbing-cancel") {
        messageQueue.onGenerationStopped(queueFocused() === messageQueue.first()?.id);
        publishQueue(false);
      }
      return;
    }
    const focused = queueFocused() !== null && queueFocused() === messageQueue.first()?.id;
    const candidate = messageQueue.autoSendCandidate(focused);
    if (candidate && !validateQueued(candidate)) messageQueue.pause();
    const entry = messageQueue.onGenerationStopped(focused);
    if (entry) dispatchQueued(entry);
    else publishQueue(false);
  }

  /** Zed's send: a nonempty generating draft queues; an empty editor may fast-track. */
  function submit() {
    if (disposed || phase() !== "ready" || queueLoading()) return;
    const text = draft().trimEnd();
    if (!text.trim()) {
      const first = messageQueue.first();
      if (messageQueue.canFastTrack() && first && !validateQueued(first)) return;
      const entry = messageQueue.tryFastTrack(thread.generating());
      if (entry) dispatchQueued(entry);
      else publishQueue(false);
      return;
    }
    if (thread.generating()) {
      batch(() => {
        messageQueue.enqueue({ id: messageQueue.nextId(), content: [{ type: "text", text }] });
        draft.set("");
        publishQueue();
      });
      return;
    }
    const command = text.trim();
    if ((command === "/login" || command === "/logout") && client!.authMethods.length > 0
      && !(command === "/logout" && commands().some((entry) => entry.name === "logout"))) {
      draft.set("");
      requestAuthentication();
      return;
    }
    sendDraftDirect();
  }

  // Zed's send_impl is also used by Send Immediately. It does not fast-track
  // an empty editor or run the main send action's local /login interception.
  function sendDraftDirect() {
    messageQueue.resume();
    thread.dismissError();
    const text = draft().trimEnd();
    if (!text.trim()) return;
    batch(() => { draft.set(""); void thread.send([{ type: "text", text }]); });
  }

  function stop() {
    if (disposed) return;
    messageQueue.pause();
    thread.dismissError();
    void thread.cancel();
  }

  function sendNow(id: number) {
    if (disposed || phase() !== "ready" || queueLoading()) return;
    const candidate = messageQueue.get(id);
    if (!candidate || !validateQueued(candidate)) return;
    const entry = messageQueue.sendNow(id, thread.generating());
    if (entry) dispatchQueued(entry);
  }

  function sendImmediately() {
    if (disposed || phase() !== "ready" || queueLoading()) return;
    if (!thread.generating()) { sendDraftDirect(); return; }
    messageQueue.pause();
    const generation = ++dispatchGeneration;
    queueLoading.set(true);
    void (async () => {
      try {
        await thread.cancelForQueue();
        if (disposed || generation !== dispatchGeneration) return;
        batch(() => { queueLoading.set(false); sendDraftDirect(); });
      } catch (reason) {
        if (disposed || generation !== dispatchGeneration) return;
        queueLoading.set(false);
        thread.reportError(reason);
      }
    })();
  }

  function removeQueued(id: number) {
    if (disposed) return;
    batch(() => {
      messageQueue.remove(id);
      if (queueFocused() === id) queueFocused.set(null);
      publishQueue();
    });
  }

  function editQueued(id: number, attempt?: { text: string; offset: number }) {
    if (disposed) return false;
    const entry = messageQueue.get(id);
    if (!entry) return false;
    const text = queuedText(entry.content);
    if (text === null) {
      thread.reportError(new Error("This queued message contains unsupported content and cannot be edited."));
      return false;
    }
    batch(() => {
      const prefix = draft().trim().length ? `${draft()}\n\n` : "";
      let value = prefix + text;
      let offset = value.length;
      if (attempt) {
        // Zed restores a collapsed cursor at the preview's selection head,
        // then inserts the attempt; it preserves the selected source text.
        const cursor = prefix.length + Math.max(0, Math.min(attempt.offset, text.length));
        value = value.slice(0, cursor) + attempt.text + value.slice(cursor);
        offset = cursor + attempt.text.length;
      }
      messageQueue.remove(id);
      draft.set(value);
      publishQueue();
      focusMain(offset);
    });
    return true;
  }

  function restoreQueue(content: ContentBlock[][]) {
    batch(() => {
      messageQueue = new MessageQueue();
      for (const blocks of content) messageQueue.enqueue({ id: messageQueue.nextId(), content: blocks });
      messageQueue.pause();
      queueFocused.set(null);
      queueExpanded.set(true);
      recoveringQueue.set(content.length > 0 && phase() !== "ready");
      publishQueue(false);
    });
  }

  function selectedValue(id: string, confirmed: string | boolean) {
    const target = change.target();
    return target?.id === id ? target.value : confirmed;
  }

  function refresh() {
    if (disposed) return;
    options.set(client!.configOptions);
    modes.set(client!.sessionModes);
    commands.set(client!.availableCommands);
    if (phase() === "ready") thread.touch();
  }

  function fail(message: string) {
    if (disposed) return;
    error.set(message);
    change.cancel();
    if (phase() === "loading") {
      phase.set("error");
    }
  }

  client.setConfigOptionsChangedHandler(refresh);
  client.setSessionModesChangedHandler(refresh);
  client.setAvailableCommandsChangedHandler(refresh);
  effect(() => {
    const message = connection.error();
    if (message) untracked(() => fail(message));
  });
  function startSession(restore = false) {
    if (disposed) return;
    const generation = ++sessionGeneration;
    hasThread.set(false);
    phase.set("loading");
    error.set(null);
    // Zed v1 waits for new/load/resume to settle; history replay has no fixed deadline.
    const request = restore && sessionId !== null ? client!.restoreSession(sessionId) : client!.createSession();
    // Drop the view's continuation promptly; the connection retains only its
    // wire operation and release barrier until an abandoned load/new settles.
    void Promise.race([request, disposedView]).then((id) => {
      if (disposed || generation !== sessionGeneration || id === null) return;
      sessionId = id;
      sessionKey.set(id);
      resumedWithoutHistory.set(restore && client!.resumesWithoutHistory);
      thread.clearActivity();
      error.set(null);
      hasThread.set(true);
      phase.set("ready");
      recoveringQueue.set(false);
      refresh();
      settings.onReady?.(id);
    }).catch((reason: unknown) => {
      if (disposed || generation !== sessionGeneration) return;
      // Zed drops the failed load's thread; partial replay is not a usable chat.
      thread.reset();
      refresh();
      const auth = authenticationRequired(reason);
      if (auth) requestAuthentication(auth.description);
      else fail(reason instanceof Error ? reason.message : "Cannot create session.");
    });
  }

  function requestAuthentication(description: string | null = null) {
    if (disposed || phase() === "authenticating") return;
    batch(() => {
      dispatchGeneration += 1;
      if (dispatchEntry) messageQueue.restoreAfterFailedSend(dispatchEntry);
      dispatchEntry = null;
      queueLoading.set(false);
      messageQueue.pause();
      recoveringQueue.set(messageQueue.entries.length > 0);
      publishQueue(false);
      sessionGeneration += 1;
      change.cancel();
      authDescription.set(description);
      pendingAuthMethod.set(null);
      error.set(null);
      phase.set("auth-required");
    });
  }

  function authenticate(methodId: string) {
    if (disposed || phase() !== "auth-required") return;
    const method = client!.authMethods.find((entry) => entry.id === methodId);
    if (!method || authenticationKind(method) !== "agent") return;
    const generation = ++authGeneration;
    pendingAuthMethod.set(methodId);
    phase.set("authenticating");
    void client!.authenticate(methodId).then(() => {
      if (disposed || generation !== authGeneration) return;
      pendingAuthMethod.set(null);
      authDescription.set(null);
      const recovery = messageQueue.entries.map(entry => entry.content);
      thread.reset();
      restoreQueue(recovery);
      // Zed v1 resets the conversation view after login. Existing sessions are
      // loaded/resumed, never replaced with a new session or a replayed prompt.
      startSession(sessionId !== null);
    }).catch((reason: unknown) => {
      if (disposed || generation !== authGeneration) return;
      pendingAuthMethod.set(null);
      authDescription.set(`Sign-in did not complete: ${reason instanceof Error ? reason.message : String(reason)}`);
      phase.set("auth-required");
    });
  }

  function authenticateFailedPrompt() {
    if (disposed || phase() !== "ready" || !thread.error()?.authentication) return;
    const prompt = thread.failedPrompt();
    if (prompt && !prompt.every((block) => block.type === "text")) {
      fail("This saved submission cannot be restored into the composer. The original submission and draft have been kept.");
      return;
    }
    if (prompt?.every((block) => block.type === "text")) {
      draft.set(prompt.map((block) => block.type === "text" ? block.text : "").join(""));
    }
    thread.dismissError();
    requestAuthentication();
  }

  startSession(sessionId !== null);

  function choose(id: string, value: string | boolean, legacy = false) {
    if (disposed || phase() !== "ready" || pending()) return;
    error.set(null);
    connection.clearError();
    change.start({ id, value, legacy });
  }

  function dispose(release = false) {
    if (disposed) return Promise.resolve();
    disposed = true;
    dispatchGeneration += 1;
    finishDisposed();
    authGeneration += 1;
    sessionGeneration += 1;
    change.dispose();
    thread.dispose();
    client!.setSessionUpdateHandler(undefined);
    client!.setPermissionHandler(undefined);
    client!.setSessionCreatedHandler(() => {});
    client!.setConfigOptionsChangedHandler(() => {});
    client!.setSessionModesChangedHandler(() => {});
    client!.setAvailableCommandsChangedHandler(() => {});
    if (settings.client) {
      if (release) return client!.releaseSession();
      client!.forgetSession();
    }
    return Promise.resolve();
  }

  return {
    phase, error, draft, commands, options, modes, pending, slow: change.slow, thread, submit, stop, selectedValue, choose, dispose,
    authDescription, pendingAuthMethod, authMethods: () => client!.authMethods,
    agentName: () => client!.agentInfo?.title ?? client!.agentInfo?.name ?? "the agent",
    authenticate, authenticateFailedPrompt, id: sessionKey, resumedWithoutHistory, hasThread,
    queued, queueExpanded, queueFocused, queueLoading, canFastTrack, recoveringQueue, focusRequest,
    sendNow, sendImmediately, removeQueued, editQueued, restoreQueue, focusMain,
    editLastQueued: () => { const last = messageQueue.last(); if (last && !draft().trim().length) editQueued(last.id); },
    clearQueue: () => { if (!disposed) batch(() => { messageQueue.clear(); queueFocused.set(null); publishQueue(); }); },
    retrySession: () => {
      if (disposed || phase() !== "error") return;
      thread.reset();
      change.cancel();
      startSession(sessionId !== null);
    },
  };
}

export type ComposerState = ReturnType<typeof createComposer>;
