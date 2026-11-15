import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { JsonRpcMessage } from "./types.js";

export interface AgentConfig {
  command: string; // Can be a full command string like "nvm run 22 /path/to/agent"
  args?: string[];
  cwd?: string;
}

// Parse a command string into command and args
// Handles basic quoting (single and double quotes)
function parseCommand(commandStr: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < commandStr.length; i++) {
    const char = commandStr[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }

  const [cmd, ...args] = tokens;
  return { cmd: cmd || "", args };
}

export type AgentMessageHandler = (message: JsonRpcMessage) => void;
export type AgentErrorHandler = (error: string) => void;
export type AgentCloseHandler = (code: number | null) => void;

/**
 * Spawn options for starting an agent command.
 *
 * On Windows, Node >=18.20.2/20.12.2 refuses to spawn `.cmd`/`.bat` files
 * directly (CVE-2024-27980): a bare name fails with ENOENT and a full
 * `.cmd` path fails with EINVAL. Running those through the shell fixes both.
 * Scoped to Windows + `.cmd`/`.bat` so other platforms and plain binaries
 * keep the existing behaviour (`shell: true` changes argument quoting).
 *
 * The `platform` parameter exists so the Windows branch can be tested on
 * other platforms; it defaults to the current process platform.
 */
export function getSpawnOptions(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): Pick<SpawnOptions, "shell"> {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    return { shell: true };
  }
  return {};
}

export class AgentProcess {
  private process: ChildProcess | null = null;
  private onMessage: AgentMessageHandler | null = null;
  private onError: AgentErrorHandler | null = null;
  private onClose: AgentCloseHandler | null = null;

  constructor(private config: AgentConfig) {}

  async spawn(): Promise<void> {
    const { command, args: extraArgs = [], cwd } = this.config;

    // Parse the command string to handle cases like "nvm run 22 /path/to/agent"
    const parsed = parseCommand(command);
    const fullArgs = [...parsed.args, ...extraArgs];

    console.log(
      `[Agent] Spawning: cmd: "${parsed.cmd}" args: [${fullArgs.map((a) => `"${a}"`).join(", ")}]`,
    );

    this.process = spawn(parsed.cmd, fullArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...getSpawnOptions(parsed.cmd),
    });

    // Read stdout (ACP messages from agent)
    if (this.process.stdout) {
      this.readStream(this.process.stdout, (line) => {
        this.handleLine(line);
      });
    }

    // Read stderr (logging from agent)
    if (this.process.stderr) {
      this.readStream(this.process.stderr, (line) => {
        console.log(`[Agent stderr] ${line}`);
      });
    }

    // Handle process exit
    this.process.on("close", (code) => {
      console.log(`[Agent] Process exited with code: ${code}`);
      this.onClose?.(code);
      this.process = null;
    });

    this.process.on("error", (error) => {
      console.error("[Agent] Process error:", error);
      this.onError?.(
        `Failed to spawn agent "${parsed.cmd}": ${error.message}`,
      );
    });
  }

  private readStream(
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void,
  ): void {
    let buffer = "";

    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          onLine(line);
        }
      }
    });

    stream.on("error", (error) => {
      console.error("[Agent] Stream read error:", error);
    });
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      console.log(`[Agent] Received:`, JSON.stringify(message).slice(0, 200));
      this.onMessage?.(message);
    } catch (error) {
      console.error(`[Agent] Failed to parse message: ${line}`);
      this.onError?.(`Failed to parse agent message: ${line}`);
    }
  }

  send(message: JsonRpcMessage): void {
    if (!this.process?.stdin) {
      throw new Error("Agent process not running");
    }

    const line = JSON.stringify(message) + "\n";
    console.log(`[Agent] Sending:`, JSON.stringify(message).slice(0, 200));
    this.process.stdin.write(line);
  }

  setMessageHandler(handler: AgentMessageHandler): void {
    this.onMessage = handler;
  }

  setErrorHandler(handler: AgentErrorHandler): void {
    this.onError = handler;
  }

  setCloseHandler(handler: AgentCloseHandler): void {
    this.onClose = handler;
  }

  kill(): void {
    if (this.process) {
      console.log("[Agent] Killing process");
      this.process.kill();
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
