import { cleanup, signal } from "nsh";

type Options<T> = {
  send: (target: T) => Promise<unknown>;
  isCurrent: (target: T) => boolean;
  onError: (reason: unknown) => void;
  loadingDelayMs?: number;
};

/** One optimistic RPC change, held until its matching response settles. */
export function createOptimisticChange<T>(options: Options<T>) {
  const target = signal<T | null>(null);
  const slow = signal(false);
  let active: { target: T } | null = null;
  let loadingTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function cancel() {
    active = null;
    if (loadingTimer !== undefined) clearTimeout(loadingTimer);
    loadingTimer = undefined;
    slow.set(false);
    target.set(null);
  }

  function reject(operation: NonNullable<typeof active>, reason: unknown) {
    // A late rejection from an earlier send must not cancel a newer change.
    if (active !== operation) return;
    cancel();
    options.onError(reason);
  }

  function start(next: T) {
    if (disposed || active || options.isCurrent(next)) return;
    const operation = { target: next };
    active = operation;
    loadingTimer = setTimeout(() => {
      if (active === operation) slow.set(true);
    }, options.loadingDelayMs ?? 300);
    target.set(next);
    try {
      // Success accepts the response's actual state, including normalized
      // values or removed options. Notifications alone do not settle this RPC.
      void options.send(next).then(() => {
        if (active === operation) cancel();
      }, (reason: unknown) => reject(operation, reason));
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
