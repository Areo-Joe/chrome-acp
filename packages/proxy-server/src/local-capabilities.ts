import * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { readTextFile as readWorkspaceTextFile, writeTextFile as writeWorkspaceTextFile } from "./files.js";
import { TerminalManager } from "./terminals.js";
import { log } from "./logger.js";

function requestCancelled(): RequestError {
  return new RequestError(-32800, "Request cancelled");
}

function mapFsError(error: unknown, path: string): RequestError {
  if (error instanceof RequestError) return error;
  if ((error as Error)?.name === "AbortError") return requestCancelled();
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return RequestError.resourceNotFound(path);
  }
  return RequestError.internalError(undefined, (error as Error).message);
}

/** Local capabilities shared by the legacy client and the ACP relay. */
export function registerLocalCapabilities(
  app: acp.ClientApp,
  terminals: TerminalManager,
  sessionCwd: (sessionId: string) => string,
): void {
  // Reference: Zed's `handle_read_text_file`. ACP paths are absolute.
  app.onRequest(acp.methods.client.fs.readTextFile, async ({ params, signal }) => {
    sessionCwd(params.sessionId);
    log.debug("Read text file", { path: params.path, line: params.line, limit: params.limit });
    if (signal.aborted) throw requestCancelled();
    try {
      const content = await readWorkspaceTextFile(params.path, params.line, params.limit, signal);
      sessionCwd(params.sessionId);
      return { content };
    } catch (error) {
      throw mapFsError(error, params.path);
    }
  });

  // Reference: Zed's `handle_write_text_file`.
  app.onRequest(acp.methods.client.fs.writeTextFile, async ({ params, signal }) => {
    sessionCwd(params.sessionId);
    log.debug("Write text file", { path: params.path });
    if (signal.aborted) throw requestCancelled();
    try {
      await writeWorkspaceTextFile(params.path, params.content, signal);
      return {};
    } catch (error) {
      throw mapFsError(error, params.path);
    }
  });

  // Reference: Zed's `handle_create_terminal`.
  app.onRequest(acp.methods.client.terminal.create, async ({ params, signal }) => {
    if (signal.aborted) throw requestCancelled();
    const cwd = sessionCwd(params.sessionId);
    const terminalId = await terminals.create({ ...params, cwd: params.cwd ?? cwd });
    try {
      if (signal.aborted) throw requestCancelled();
      sessionCwd(params.sessionId);
      return { terminalId };
    } catch (error) {
      // Session/disconnect cleanup may already have released this terminal.
      try { terminals.release(terminalId, params.sessionId); } catch {}
      throw error;
    }
  });

  // Reference: Zed's `handle_terminal_output`.
  app.onRequest(acp.methods.client.terminal.output, ({ params }) => {
    sessionCwd(params.sessionId);
    return terminals.output(params.terminalId, params.sessionId);
  });

  // Reference: Zed's `handle_wait_for_terminal_exit`.
  app.onRequest(acp.methods.client.terminal.waitForExit, async ({ params, signal }) => {
    if (signal.aborted) return Promise.reject(requestCancelled());
    sessionCwd(params.sessionId);
    return terminals.waitForExit(params.terminalId, params.sessionId, signal);
  });

  // Reference: Zed's `handle_kill_terminal`.
  app.onRequest(acp.methods.client.terminal.kill, ({ params }) => {
    sessionCwd(params.sessionId);
    terminals.kill(params.terminalId, params.sessionId);
    return {};
  });

  // Reference: Zed's `handle_release_terminal`.
  app.onRequest(acp.methods.client.terminal.release, ({ params }) => {
    sessionCwd(params.sessionId);
    terminals.release(params.terminalId, params.sessionId);
    return {};
  });
}
