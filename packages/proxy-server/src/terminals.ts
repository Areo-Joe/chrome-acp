/** Client-owned ACP terminals, following Zed's headless shell execution path. */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree, ownsProcessGroup } from "./process.js";
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
  readonly ready: Promise<void>;
  private readonly exitWaiters = new Set<(status: TerminalExitStatus) => void>();

  constructor(id: string, params: CreateTerminalRequest) {
    this.id = id;
    this.sessionId = params.sessionId;
    this.command = [params.command, ...(params.args ?? [])].join(" ");
    this.cwd = params.cwd ?? process.cwd();
    // Reference: Zed keeps `output_byte_limit` as `Option<usize>`; when the
    // agent omits it, output is not truncated.
    this.outputByteLimit = params.outputByteLimit ?? null;

    const env: NodeJS.ProcessEnv = { ...process.env, PAGER: "", GIT_PAGER: "cat" };
    for (const variable of params.env ?? []) {
      env[variable.name] = variable.value;
    }

    // Zed's ShellBuilder treats a command without args as a shell expression,
    // and quotes the executable and each argument when args are supplied.
    const args = params.args ?? [];
    const quote = process.platform === "win32"
      ? (value: string) => "'" + value.replaceAll("'", "''") + "'"
      : (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const command = args.length ? [quote(params.command), ...args.map(quote)].join(" ") : params.command;
    const shell = process.platform === "win32" ? "powershell.exe"
      : existsSync("/bin/sh") ? "/bin/sh" : join(process.env.PREFIX ?? "/data/data/com.termux/files/usr", "bin/sh");
    const shellArgs = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", args.length ? `& ${command}` : command]
      : ["-c", `exec </dev/null\n${command}`];
    this.process = spawn(shell, shellArgs, {
      cwd: this.cwd,
      env,
      detached: ownsProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.ready = new Promise((resolve, reject) => {
      this.process.once("spawn", resolve);
      this.process.once("error", reject);
    });

    for (const stream of [this.process.stdout, this.process.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream?.on("data", (chunk: Buffer) => this.append(decoder.write(chunk)));
      stream?.on("end", () => this.append(decoder.end()));
    }
    this.process.on("error", (error) => {
      this.append(`\n${error.message}\n`);
      this.finish(1, null);
    });
    // Exit is independent of stdio: descendants may keep pipes open. Output
    // continues to refresh after completion, as it does in Zed's Terminal.
    this.process.on("exit", (code, signal) => this.finish(code, signal));
  }

  /** Current captured output and exit status (non-blocking). */
  currentOutput(): TerminalOutputResponse {
    return {
      output: this.truncated && this.output.includes("\n")
        ? this.output.slice(0, this.output.lastIndexOf("\n")) : this.output,
      truncated: this.truncated,
      exitStatus: this.exitStatus,
    };
  }

  /** Resolves when the command exits (immediately if it already has). */
  waitForExit(signal?: AbortSignal): Promise<TerminalExitStatus> {
    if (signal?.aborted) return Promise.reject(new RequestError(-32800, "Request cancelled"));
    if (this.exitStatus) return Promise.resolve(this.exitStatus);
    return new Promise((resolve, reject) => {
      const onExit = (status: TerminalExitStatus) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(status);
      };
      const onAbort = () => {
        this.exitWaiters.delete(onExit);
        reject(new RequestError(-32800, "Request cancelled"));
      };
      this.exitWaiters.add(onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Match Zed's process-group kill, retaining output until release. */
  kill(): void {
    log.debug("Killing terminal", { terminalId: this.id, command: this.command });
    killProcessTree(this.process);
  }

  private append(text: string): void {
    if (!text || this.truncated) return;
    this.output += text;
    if (this.outputByteLimit === null) return;
    const bytes = Buffer.from(this.output, "utf8");
    if (bytes.length <= this.outputByteLimit) return;
    let end = this.outputByteLimit;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    this.output = bytes.subarray(0, end).toString("utf8");
    this.truncated = true;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitStatus) return;
    this.exitStatus = {
      exitCode: code,
      signal: signal ?? null,
    };
    const waiters = [...this.exitWaiters];
    this.exitWaiters.clear();
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

  async create(params: CreateTerminalRequest): Promise<string> {
    const id = randomUUID();
    const terminal = new Terminal(id, params);
    this.terminals.set(id, terminal);
    try {
      await terminal.ready;
      if (this.terminals.get(id) !== terminal) {
        throw new RequestError(-32800, "Request cancelled");
      }
    } catch (error) {
      this.terminals.delete(id);
      terminal.kill();
      throw error;
    }
    log.debug("Terminal created", { terminalId: id, command: terminal.command, cwd: terminal.cwd });
    return id;
  }

  output(terminalId: string, sessionId: string): TerminalOutputResponse {
    return this.get(terminalId, sessionId).currentOutput();
  }

  async waitForExit(terminalId: string, sessionId: string, signal?: AbortSignal): Promise<TerminalExitStatus> {
    return this.get(terminalId, sessionId).waitForExit(signal);
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
