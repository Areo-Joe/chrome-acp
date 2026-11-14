import { effect, signal, untracked } from "nsh";
import type { AvailableCommand, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import type { Connection } from "./connection";
import { createOptimisticChange } from "./optimistic-change";
import { createThread } from "./thread";
import { authenticationKind, authenticationRequired } from "../acp/client";

export type Choice = { value: string | boolean; name: string; description?: string | null; group?: string };

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

export function createComposer(connection: Connection) {
  const client = connection.getClient();
  if (!client) throw new Error("Chat requires a connected ACP client");
  const phase = signal<"loading" | "ready" | "error" | "auth-required" | "authenticating">("loading");
  const error = signal<string | null>(null);
  const draft = signal("");
  const commands = signal<AvailableCommand[]>([]);
  const options = signal<SessionConfigOption[] | null>(null);
  const modes = signal<SessionModeState | null>(null);
  let disposed = false;
  let sessionId: string | null = null;
  let sessionGeneration = 0;
  let authGeneration = 0;
  const authDescription = signal<string | null>(null);
  const pendingAuthMethod = signal<string | null>(null);
  const thread = createThread(client, { agentName: () => client.agentInfo?.title ?? client.agentInfo?.name ?? "The agent" });
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

  /** Sends the draft without trailing whitespace, as Zed's message editor does; a blank draft sends nothing. */
  function submit() {
    if (disposed || phase() !== "ready" || thread.generating()) return;
    const text = draft().trimEnd();
    if (!text.trim()) return;
    const command = text.trim();
    if ((command === "/login" || command === "/logout") && client!.authMethods.length > 0
      && !(command === "/logout" && commands().some((entry) => entry.name === "logout"))) {
      draft.set("");
      requestAuthentication();
      return;
    }
    draft.set("");
    void thread.send([{ type: "text", text }]);
  }

  function stop() {
    if (disposed) return;
    thread.dismissError();
    void thread.cancel();
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
    const generation = ++sessionGeneration;
    phase.set("loading");
    error.set(null);
    // Zed v1 waits for new/load/resume to settle; history replay has no fixed deadline.
    const request = restore && sessionId ? client!.restoreSession(sessionId) : client!.createSession();
    void request.then((id) => {
      if (disposed || generation !== sessionGeneration) return;
      sessionId = id;
      error.set(null);
      phase.set("ready");
      refresh();
    }).catch((reason: unknown) => {
      if (disposed || generation !== sessionGeneration) return;
      const auth = authenticationRequired(reason);
      if (auth) requestAuthentication(auth.description);
      else fail(reason instanceof Error ? reason.message : "Cannot create session.");
    });
  }

  function requestAuthentication(description: string | null = null) {
    if (disposed || phase() === "authenticating") return;
    sessionGeneration += 1;
    change.cancel();
    authDescription.set(description);
    pendingAuthMethod.set(null);
    error.set(null);
    phase.set("auth-required");
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
      thread.reset();
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

  startSession();

  function choose(id: string, value: string | boolean, legacy = false) {
    if (disposed || phase() !== "ready" || pending()) return;
    error.set(null);
    connection.clearError();
    change.start({ id, value, legacy });
  }

  function dispose() {
    disposed = true;
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
  }

  return {
    phase, error, draft, commands, options, modes, pending, slow: change.slow, thread, submit, stop, selectedValue, choose, dispose,
    authDescription, pendingAuthMethod, authMethods: () => client!.authMethods,
    agentName: () => client!.agentInfo?.title ?? client!.agentInfo?.name ?? "the agent",
    authenticate, authenticateFailedPrompt,
  };
}

export type ComposerState = ReturnType<typeof createComposer>;
