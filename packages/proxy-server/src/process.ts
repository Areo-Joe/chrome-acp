import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./logger.js";

/** Match Zed's util::process::Child: each Unix child owns a process group. */
export const ownsProcessGroup = process.platform !== "win32";

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (ownsProcessGroup) {
      // Kill the group even if its leader already exited: descendants may
      // still own the stdio pipes, MCP servers, or terminal commands.
      process.kill(-child.pid, "SIGKILL");
    } else {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("error", (error) => {
        log.warn("Failed to kill process tree", { error: error.message });
        child.kill("SIGKILL");
      });
      killer.on("exit", (code) => {
        if (code !== 0) child.kill("SIGKILL");
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      log.warn("Failed to kill process group", { error: (error as Error).message });
      child.kill("SIGKILL");
    }
  }
}
