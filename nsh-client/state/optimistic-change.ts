import { cleanup, effect, signal, untracked } from "nsh";

type Options<T> = {
  send: (target: T) => void | Promise<unknown>;
  isConfirmed: (target: T) => boolean;
  onError: (reason: unknown) => void;
  timeoutMs?: number;
  loadingDelayMs?: number;
  timeoutMessage?: string;
};

/** One optimistic change, held until authoritative state confirms it. */
export function createOptimisticChange<T>(options: Options<T>) {
  const target = signal<T | null>(null);
  const slow = signal(false);
  let active: { target: T } | null = null;
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function cancel() {
    active = null;
    if (loadingTimer !== undefined) clearTimeout(loadingTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    loadingTimer = timeoutTimer = undefined;
    slow.set(false);
    target.set(null);
  }

  function reject(operation: NonNullable<typeof active>, reason: unknown) {
    // A late rejection from an earlier send must not cancel a newer change.
    if (active !== operation) return;
    cancel();
    options.onError(reason);
  }

  effect(() => {
    const next = target();
    if (next !== null && options.isConfirmed(next)) untracked(cancel);
  });

  function start(next: T) {
    if (disposed || active || options.isConfirmed(next)) return;
    const operation = { target: next };
    active = operation;
    loadingTimer = setTimeout(() => {
      if (active === operation) slow.set(true);
    }, options.loadingDelayMs ?? 300);
    timeoutTimer = setTimeout(() => reject(operation,
      new Error(options.timeoutMessage ?? "The change was not confirmed.")), options.timeoutMs ?? 15_000);
    target.set(next);
    try {
      // Send completion is not confirmation for sockets/subscriptions.
      void Promise.resolve(options.send(next)).catch((reason: unknown) => reject(operation, reason));
    } catch (reason) {
      reject(operation, reason);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
  }
  cleanup(dispose);

  return { target, slow, start, cancel, dispose };
}
