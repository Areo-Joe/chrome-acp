import { effect, signal, untracked } from "nsh";
import type { AvailableCommand, SessionConfigOption, SessionModeState } from "../../packages/shared/src/acp/types";
import type { Connection } from "./connection";
import { createOptimisticChange } from "./optimistic-change";

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
  const phase = signal<"loading" | "ready" | "error">("loading");
  const error = signal<string | null>(null);
  const draft = signal("");
  const commands = signal<AvailableCommand[]>([]);
  const options = signal<SessionConfigOption[] | null>(null);
  const modes = signal<SessionModeState | null>(null);
  let disposed = false;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  const change = createOptimisticChange<{ id: string; value: string | boolean; legacy: boolean }>({
    send: (target) => target.legacy
      ? client.setSessionMode(String(target.value))
      : client.setConfigOption(target.id, target.value),
    isConfirmed: (target) => target.legacy
      ? modes()?.currentModeId === target.value
      : options()?.find((option) => option.id === target.id)?.currentValue === target.value,
    timeoutMessage: "The agent did not confirm the configuration change.",
    onError: (reason) => fail(reason instanceof Error ? reason.message : "Cannot change configuration."),
  });
  const pending = () => change.target()?.id ?? null;

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
      if (sessionTimer !== undefined) clearTimeout(sessionTimer);
      phase.set("error");
    }
  }

  client.setConfigOptionsChangedHandler(refresh);
  client.setSessionModesChangedHandler(refresh);
  client.setAvailableCommandsChangedHandler(refresh);
  client.setSessionCreatedHandler(() => {
    if (disposed) return;
    if (sessionTimer !== undefined) clearTimeout(sessionTimer);
    error.set(null);
    phase.set("ready");
    refresh();
  });
  effect(() => {
    const message = connection.error();
    if (message) untracked(() => fail(message));
  });
  sessionTimer = setTimeout(() => fail("Session setup timed out. Disconnect and try again."), 30_000);
  void client.createSession().catch((reason: unknown) => fail(reason instanceof Error ? reason.message : "Cannot create session."));

  function choose(id: string, value: string | boolean, legacy = false) {
    if (disposed || phase() !== "ready" || pending()) return;
    error.set(null);
    connection.clearError();
    change.start({ id, value, legacy });
  }

  function dispose() {
    disposed = true;
    if (sessionTimer !== undefined) clearTimeout(sessionTimer);
    change.dispose();
    client!.setSessionCreatedHandler(() => {});
    client!.setConfigOptionsChangedHandler(() => {});
    client!.setSessionModesChangedHandler(() => {});
    client!.setAvailableCommandsChangedHandler(() => {});
  }

  return { phase, error, draft, commands, options, modes, pending, slow: change.slow, selectedValue, choose, dispose };
}

export type ComposerState = ReturnType<typeof createComposer>;
