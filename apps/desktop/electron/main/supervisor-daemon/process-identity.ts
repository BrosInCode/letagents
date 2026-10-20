import { execFileSync } from "node:child_process";
import type { DaemonIdentityInspection } from "./types.js";

const PS_DAEMON_IDENTITY = /^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/;

export function defaultInspectDaemonProcess(pid: number): DaemonIdentityInspection | null | undefined {
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "state=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const match = output.match(PS_DAEMON_IDENTITY);
    if (!match) return undefined;
    return {
      pid,
      kernelStartTime: match[1]!.replace(/\s+/g, " "),
      state: match[2]!.startsWith("Z") ? "zombie" : "live",
      command: match[3]!,
    };
  } catch {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : undefined;
    }
  }
}
