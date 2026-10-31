import { execFileSync } from "node:child_process";

import { isBirthEvidence, processBirth } from "../../../shared/process-tree.mjs";

const PS_LONG_START_PREFIX = /^\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}/;

export type ProcessIdentity = {
  readBirthIdentity(pid: number): string;
  probe(pid: number): void;
  sameBirthIdentity(actualIdentity: string, expectedIdentity: string): boolean;
  /** The platform whose birth format alone is evidence; without it either format is. */
  platform?: NodeJS.Platform;
};

/**
 * The OS's own reading. POSIX: `ps -o lstart=`. Windows: the process-tree
 * helper's creation time (`win32-ft:<FILETIME>`); a read that proves nothing
 * throws, as an unreadable ps does.
 */
export function createSystemProcessIdentity(
  platform: NodeJS.Platform = process.platform,
  readWindowsBirth: (pid: number) => string | null | undefined = (pid) => processBirth(pid, { platform: "win32" }),
): ProcessIdentity {
  return {
    readBirthIdentity: platform === "win32"
      ? (pid) => {
          const birth = readWindowsBirth(pid);
          if (typeof birth !== "string") throw new Error(`The birth of process ${pid} could not be read.`);
          return birth;
        }
      : (pid) => execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
        }),
    probe: (pid) => { process.kill(pid, 0); },
    sameBirthIdentity: sameProcessBirthIdentity,
    platform,
  };
}

export const systemProcessIdentity: ProcessIdentity = createSystemProcessIdentity();

/** Only hard OS evidence can retire a recorded birth; probe failure is not death. */
export function processBirthState(pid: number | null, birth: string | null, identity = systemProcessIdentity): "live" | "gone" | "unknown" {
  // The system reading accepts only its own platform's format. An injected
  // reading without a platform (a test double) accepts either.
  const evidence = (value: string | null): value is string => identity.platform
    ? isBirthEvidence(value, identity.platform)
    : isBirthEvidence(value, "darwin") || isBirthEvidence(value, "win32");
  if (!Number.isSafeInteger(pid) || pid! < 1 || !evidence(birth)) return "unknown";
  try {
    identity.probe(pid!);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
  try {
    const actual = identity.readBirthIdentity(pid!).trim();
    if (!evidence(actual)) return "unknown";
    return identity.sameBirthIdentity(actual, birth) ? "live" : "gone";
  } catch {
    // The process may have exited between kill(0) and ps. Re-probe; neither a
    // timeout nor an unreadable start time proves the recorded birth is gone.
    try { identity.probe(pid!); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    }
    return "unknown";
  }
}

/**
 * Compare the stable birth portion of a process identity. The daemon and
 * Electron both use the `ps -o lstart=` prefix as the immutable PID identity
 * (on Windows the whole `win32-ft:` creation time, compared exactly).
 */
export function sameProcessBirthIdentity(current: string, recorded: string): boolean {
  // Unexpected or malformed values fall back to exact comparison. The outer
  // kill(0) EPERM/ESRCH check remains the liveness safety net.
  const stable = (value: string) => value.trim().match(PS_LONG_START_PREFIX)?.[0].replace(/\s+/g, " ") ?? value.trim();
  return stable(current) === stable(recorded);
}
