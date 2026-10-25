import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { registerLocalCapabilities } from "./local-capabilities.js";
import { TerminalManager } from "./terminals.js";
import { log } from "./logger.js";
import { LocalSessions } from "./local-sessions.js";
import { killProcessTree, ownsProcessGroup } from "./process.js";

interface RelayConfig {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  send: (message: acp.AnyMessage) => void;
  close: (reason: string) => void;
}

const LOCAL_METHODS = new Set<string>([
  acp.methods.client.fs.readTextFile,
  acp.methods.client.fs.writeTextFile,
  acp.methods.client.terminal.create,
  acp.methods.client.terminal.output,
  acp.methods.client.terminal.waitForExit,
  acp.methods.client.terminal.kill,
  acp.methods.client.terminal.release,
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is acp.AnyMessage {
  if (!isObject(value) || value.jsonrpc !== "2.0") return false;
  const hasId = "id" in value;
  if (hasId && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") return false;
  if ("method" in value) {
    return typeof value.method === "string" && !("result" in value) && !("error" in value);
  }
  return hasId && (("result" in value) !== ("error" in value));
}

/** A transport bridge. Only local OS capabilities terminate at this proxy. */
export class AcpRelay {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly writer: WritableStreamDefaultWriter<acp.AnyMessage>;
  private readonly localInput: ReadableStreamDefaultController<acp.AnyMessage>;
  private readonly terminals = new TerminalManager();
  private readonly localRequests = new Set<acp.JsonRpcId>();
  private readonly sessions: LocalSessions;
  private readonly reader: ReadableStreamDefaultReader<acp.AnyMessage>;
  private exitTimer?: ReturnType<typeof setTimeout>;
  private exited = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private disposed = false;

  constructor(private readonly config: RelayConfig) {
    this.sessions = new LocalSessions(config.cwd, (id) => this.terminals.disposeSession(id));
    this.process = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: config.env,
      detached: ownsProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.process.stderr.once("end", () => {
      this.stderrEnded = true;
      this.finishExitIfDrained();
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>,
    );
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();
    // A separate SDK client validates and serves local requests without parsing
    // or filtering the rest of the ACP protocol through SDK method schemas.
    let input!: ReadableStreamDefaultController<acp.AnyMessage>;
    const readable = new ReadableStream<acp.AnyMessage>({ start(controller) { input = controller; } });
    this.localInput = input;
    const app = acp.client({ name: "chrome-acp-local" });
    registerLocalCapabilities(app, this.terminals, (id) => this.sessions.require(id));
    app.connect({
      readable,
      writable: new WritableStream<acp.AnyMessage>({
        write: async (message) => {
          if ("id" in message && !("method" in message)) this.localRequests.delete(message.id);
          if (!this.disposed) await this.writer.write(message);
        },
      }),
    });
    this.writer.closed.catch((error: unknown) => this.fail(error));
    this.process.on("error", (error) => this.fail(error));
    this.process.once("exit", (code, signal) => {
      if (this.disposed) return;
      this.exited = true;
      log.info("Agent process exited", { code, signal });
      // Zed's EXIT_DRAIN_TIMEOUT: preserve final messages, but descendants
      // holding inherited pipes must not keep the connection alive forever.
      this.exitTimer = setTimeout(() => this.fail(new Error("Agent output drain timed out")), 250);
      this.finishExitIfDrained();
    });
    void this.forwardAgent();
  }

  async receive(data: string): Promise<void> {
    if (this.disposed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.config.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!isMessage(parsed)) {
      this.config.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    let message: acp.AnyMessage = parsed;
    // Advertise the OS capabilities this proxy serves, preserving every other
    // client capability, extension field, and protocol version unchanged.
    if ("method" in message && message.method === acp.methods.agent.initialize && "id" in message) {
      const params = isObject(message.params) ? message.params : {};
      const capabilities = isObject(params.clientCapabilities) ? params.clientCapabilities : {};
      message = {
        ...message,
        params: {
          ...params,
          clientCapabilities: {
            ...capabilities,
            fs: { ...(isObject(capabilities.fs) ? capabilities.fs : {}), readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        },
      };
    }
    this.sessions.sent(message);
    try {
      await this.writer.write(message);
    } catch (error) {
      this.fail(error);
    }
  }

  private async forwardAgent(): Promise<void> {
    try {
      while (!this.disposed) {
        const { value: message, done } = await this.reader.read();
        if (done || this.disposed) break;
        // Apply session ownership before later messages can access local OS
        // capabilities, preserving wire ordering like Zed's ordered responses.
        this.sessions.received(message);
        if ("method" in message && "id" in message && LOCAL_METHODS.has(message.method)) {
          this.localRequests.add(message.id);
          this.localInput.enqueue(message);
        } else if ("method" in message && message.method === acp.PROTOCOL_METHODS.cancel_request &&
                   isObject(message.params) && this.localRequests.has(message.params.requestId as acp.JsonRpcId)) {
          this.localInput.enqueue(message);
        } else {
          this.config.send(message);
        }
      }
      this.stdoutEnded = true;
      this.finishExitIfDrained();
      // EOF may precede delivery of the process exit event by one turn.
      setImmediate(() => {
        if (!this.exited && !this.disposed) this.fail(new Error("Agent stdout closed"));
      });
    } catch (error) {
      this.fail(error);
    }
  }

  private finishExitIfDrained(): void {
    if (this.exited && this.stdoutEnded && this.stderrEnded) {
      this.fail(new Error("Agent process exited"));
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    log.error("ACP relay closed", { error: error instanceof Error ? error.message : String(error) });
    this.dispose();
    this.config.close("Agent connection closed");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.exitTimer);
    this.terminals.dispose();
    try { this.localInput.close(); } catch { /* The SDK may already have closed its reader. */ }
    this.localRequests.clear();
    this.sessions.clear();
    killProcessTree(this.process);
    void this.reader.cancel().catch(() => {});
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    void this.writer.abort().catch(() => {});
  }
}
