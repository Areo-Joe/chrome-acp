import { signal } from "nsh";
import { AcpClient, type ConnectionState } from "../acp/client";

const CONNECT_TIMEOUT_MS = 30_000;

export function workingDirectory(value: string): string | null {
  const path = value.trim();
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) ? path : null;
}

export function connectionUrl(address: string): string | null {
  try {
    const url = new URL(address.trim());
    if (!(["ws:", "wss:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function createConnection() {
  const state = signal<ConnectionState>("disconnected");
  const error = signal<string | null>(null);
  let client: AcpClient | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function clearTimeoutHandle() {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  }

  function finish(next: "disconnected" | "error", message: string | null = null) {
    const previous = client;
    // Invalidate first: disconnect() emits state and rejects a pending connect.
    client = null;
    clearTimeoutHandle();
    // The SDK client may still be dispatching a state/close callback. Close after
    // that dispatch completes so its pending connect callbacks are not re-entered.
    if (previous) void Promise.resolve().then(() => previous.disconnect());
    state.set(next);
    error.set(message);
  }

  function connect(address: string, token: string, directory: string) {
    if (client || state() === "connecting" || state() === "connected") return;
    const url = connectionUrl(address);
    const cwd = workingDirectory(directory);
    if (!url || !cwd) {
      finish("error", !url ? "Enter a valid ws:// or wss:// address." : "Enter an absolute working directory on the server machine.");
      return;
    }
    error.set(null);
    state.set("connecting");
    const attempt = new AcpClient({ url, cwd, token: token.trim() || undefined });
    client = attempt;
    attempt.setConnectionStateHandler((next, message) => {
      if (client !== attempt) return;
      if (next === "connected") {
        clearTimeoutHandle();
        state.set("connected");
      } else if (next === "error") {
        finish("error", message || "Connection failed.");
      } else if (next === "disconnected") {
        if (state() === "connecting") finish("error", "The server did not connect to an agent.");
        else finish("disconnected");
      }
    });
    attempt.setErrorHandler((message) => {
      if (client !== attempt) return;
      if (state() === "connecting") finish("error", message);
      else error.set(message); // Session/config errors do not close a healthy transport.
    });
    timeout = setTimeout(() => {
      if (client === attempt) finish("error", "Connection timed out. Check the address, token and server.");
    }, CONNECT_TIMEOUT_MS);
    void attempt.connect().catch((reason: unknown) => {
      if (client === attempt) finish("error", reason instanceof Error ? reason.message : "Connection failed.");
    });
  }

  return {
    state, error, connect,
    getClient: () => client,
    clearError: () => error.set(null),
    disconnect: () => finish("disconnected"),
  };
}

export type Connection = ReturnType<typeof createConnection>;
