/**
 * Client-managed terminals for the ACP `terminal/*` methods.
 *
 * Reference: Zed's `crates/acp_thread/src/terminal.rs`
 * - commands are spawned in the session working directory
 * - stdout/stderr are captured into a byte-limited buffer (oldest bytes are
 *   dropped at a character boundary, matching ACP's `outputByteLimit`)
 * - `terminal/output` returns the current output plus the exit status once the
 *   command has finished
 * - `terminal/kill` stops the command but keeps the terminal alive so the final
 *   output can still be read
 * - `terminal/release` kills (if needed) and forgets the terminal
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RequestError, type CreateTerminalRequest, type TerminalExitStatus, type TerminalOutputResponse } from "@agentclientprotocol/sdk";
import { log } from "./logger.js";

export class Terminal {
  readonly id: string;
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;

  private readonly process: ChildProcess;
  private readonly outputByteLimit: number | null;
  private output = "";
  private truncated = false;
  private exitStatus: TerminalExitStatus | null = null;
  private exitWaiters: Array<(status: TerminalExitStatus) => void> = [];

  constructor(id: string, params: CreateTerminalRequest) {
    this.id = id;
    this.sessionId = params.sessionId;
    this.command = [params.command, ...(params.args ?? [])].join(" ");
    this.cwd = params.cwd ?? process.cwd();
    // Reference: Zed keeps `output_byte_limit` as `Option<usize>`; when the
    // agent omits it, output is not truncated.
    this.outputByteLimit = params.outputByteLimit ?? null;

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const variable of params.env ?? []) {
      env[variable.name] = variable.value;
    }

    this.process = spawn(params.command, params.args ?? [], {
      cwd: this.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.append(chunk.toString("utf-8"));
    });
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.append(chunk.toString("utf-8"));
    });
    this.process.on("error", (error) => {
      // Spawn failures (e.g. command not found) surface as terminal output.
      this.append(`\n${error.message}\n`);
      this.finish(null, null);
    });
    this.process.on("close", (code, signal) => {
      this.finish(code, signal);
    });
  }

  /** Current captured output and exit status (non-blocking). */
  currentOutput(): TerminalOutputResponse {
    return {
      output: this.output,
      truncated: this.truncated,
      exitStatus: this.exitStatus,
    };
  }

  /** Resolves when the command exits (immediately if it already has). */
  waitForExit(): Promise<TerminalExitStatus> {
    if (this.exitStatus) {
      return Promise.resolve(this.exitStatus);
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  /** Sends SIGTERM without forgetting the terminal (ACP `terminal/kill`). */
  kill(): void {
    if (this.exitStatus) return;
    log.debug("Killing terminal", { terminalId: this.id, command: this.command });
    this.process.kill();
  }

  private append(text: string): void {
    this.output += text;
    if (this.outputByteLimit === null) return;

    const excess = Buffer.byteLength(this.output, "utf-8") - this.outputByteLimit;
    if (excess <= 0) return;

    // Drop the oldest characters until the retained output fits the limit,
    // never splitting a surrogate pair.
    let start = 0;
    let remaining = excess;
    while (remaining > 0 && start < this.output.length) {
      const codePoint = this.output.codePointAt(start);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      remaining -= Buffer.byteLength(this.output.slice(start, start + width), "utf-8");
      start += width;
    }
    this.output = this.output.slice(start);
    this.truncated = true;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitStatus) return;
    this.exitStatus = {
      exitCode: code,
      signal: signal ?? null,
    };
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const resolve of waiters) {
      resolve(this.exitStatus);
    }
  }
}

/**
 * Owns the terminals created for a single ACP client connection.
 * Terminal IDs are opaque to the agent; we use UUIDs.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  create(params: CreateTerminalRequest): string {
    const id = randomUUID();
    const terminal = new Terminal(id, params);
    this.terminals.set(id, terminal);
    log.debug("Terminal created", { terminalId: id, command: terminal.command, cwd: terminal.cwd });
    return id;
  }

  output(terminalId: string, sessionId: string): TerminalOutputResponse {
    return this.get(terminalId, sessionId).currentOutput();
  }

  async waitForExit(terminalId: string, sessionId: string): Promise<TerminalExitStatus> {
    return this.get(terminalId, sessionId).waitForExit();
  }

  kill(terminalId: string, sessionId: string): void {
    this.get(terminalId, sessionId).kill();
  }

  release(terminalId: string, sessionId: string): void {
    const terminal = this.get(terminalId, sessionId);
    terminal.kill();
    this.terminals.delete(terminalId);
    log.debug("Terminal released", { terminalId });
  }

  /** Kill and forget the terminals belonging to one session. */
  disposeSession(sessionId: string): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.sessionId !== sessionId) continue;
      terminal.kill();
      this.terminals.delete(id);
    }
  }

  /** Kill and forget every terminal (called when the client disconnects). */
  dispose(): void {
    for (const terminal of this.terminals.values()) {
      terminal.kill();
    }
    this.terminals.clear();
  }

  private get(terminalId: string, sessionId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw RequestError.resourceNotFound(terminalId);
    }
    if (terminal.sessionId !== sessionId) {
      throw RequestError.invalidParams(
        undefined,
        `Terminal ${terminalId} does not belong to session ${sessionId}`,
      );
    }
    return terminal;
  }
}
