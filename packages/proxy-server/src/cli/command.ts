import { buildCommand, numberParser } from "@stricli/core";
import type { LocalContext } from "./context.js";

export const command = buildCommand({
  docs: {
    brief: "Start the ACP proxy server",
    fullDescription:
      "Starts a WebSocket proxy server that bridges Chrome extensions to ACP agents. " +
      "The agent command is spawned as a subprocess and communicates via stdin/stdout.\n\n" +
      "Use -- to pass arguments to the agent:\n" +
      "  acp-proxy /path/to/agent -- --verbose --model gpt-4",
  },
  parameters: {
    flags: {
      port: {
        kind: "parsed",
        parse: numberParser,
        brief: "Port to listen on",
        default: "9315",
      },
      debug: {
        kind: "boolean",
        brief: "Enable debug logging to file",
        default: false,
      },
      termux: {
        kind: "boolean",
        brief: "Auto-launch PWA via Termux (finds and opens the ACP WebAPK)",
        default: false,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Agent command and arguments (use -- before agent flags)",
        parse: String,
        placeholder: "command",
      },
      minimum: 1,
    },
  },
  func: async function (
    this: LocalContext,
    flags: { port: number; debug: boolean; termux: boolean },
    ...args: readonly string[]
  ) {
    const port = flags.port;
    const debug = flags.debug;
    const termux = flags.termux;
    const [command, ...agentArgs] = args;
    const cwd = process.cwd();

    // Initialize logger
    const { initLogger } = await import("../logger.js");
    initLogger({ debug });

    // Import and run the server
    const { startServer } = await import("../server.js");
    await startServer({ port, command: command!, args: [...agentArgs], cwd, debug, termux });
  },
});
