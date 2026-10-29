import { execFileSync } from "node:child_process";
import { parseWindowsCommandLine, signalTree, windowsProcessInfo, WINDOWS_BIRTH_PREFIX } from "../../../../../shared/process-tree.mjs";
import type { DaemonIdentityInspection } from "./types.js";

const PS_DAEMON_IDENTITY = /^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/;

export function defaultInspectDaemonProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readWindowsProcess: typeof windowsProcessInfo = windowsProcessInfo,
): DaemonIdentityInspection | null | undefined {
  if (platform === "win32") return inspectWindowsDaemonProcess(pid, readWindowsProcess);
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
    return probeAbsence(pid);
  }
}

/**
 * Windows: the process-tree helper's reading. The birth is the creation
 * time; an exited process that a handle still holds is the zombie; the
 * command is the argv joined with spaces, as `ps -o command=` shows it, so
 * the daemon-script check reads it the same way.
 */
function inspectWindowsDaemonProcess(
  pid: number,
  readWindowsProcess: typeof windowsProcessInfo,
): DaemonIdentityInspection | null | undefined {
  const info = readWindowsProcess(pid);
  if (info === null) return null;
  if (info === undefined || info.commandLine === null) return probeAbsence(pid);
  return {
    pid,
    kernelStartTime: `${WINDOWS_BIRTH_PREFIX}${info.creationTime}`,
    state: info.exited ? "zombie" : "live",
    command: parseWindowsCommandLine(info.commandLine).join(" "),
  };
}

/**
 * Signal the exact daemon pid (never a group). POSIX: process.kill, as
 * before. Windows: only through the process-tree helper, which ends the pid
 * after checking its creation time against `identity` (the recorded
 * kernelStartTime) while it holds the process, so a reused pid is never
 * ended; no match, or no helper, is reported as ESRCH.
 */
export function signalDaemonProcess(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  identity?: string,
  platform: NodeJS.Platform = process.platform,
  signalWindowsProcess: typeof signalTree = signalTree,
): void {
  if (platform !== "win32") {
    process.kill(pid, signal);
    return;
  }
  if (!signalWindowsProcess(pid, signal, { platform, identity, liveTrees: new Map() })) {
    throw Object.assign(new Error(`No process ${pid} with the recorded daemon birth was ended.`), { code: "ESRCH" });
  }
}

function probeAbsence(pid: number): null | undefined {
  try {
    process.kill(pid, 0);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? null : undefined;
  }
}
