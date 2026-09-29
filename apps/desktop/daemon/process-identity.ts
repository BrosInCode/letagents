import { execFileSync } from "node:child_process";

const PS_LONG_START_PREFIX = /^\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}/;
const PS_BIRTH_EVIDENCE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):[0-5]\d:[0-5]\d\s+\d{4}(?:\s|$)/;

export type ProcessIdentity = {
  readBirthIdentity(pid: number): string;
  probe(pid: number): void;
  sameBirthIdentity(actualIdentity: string, expectedIdentity: string): boolean;
};

export const systemProcessIdentity: ProcessIdentity = {
  readBirthIdentity: (pid) => execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
  }),
  probe: (pid) => { process.kill(pid, 0); },
  sameBirthIdentity: sameProcessBirthIdentity,
};

/** Only hard OS evidence can retire a recorded birth; probe failure is not death. */
export function processBirthState(pid: number | null, birth: string | null, identity = systemProcessIdentity): "live" | "gone" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid! < 1 || !birth?.trim().match(PS_BIRTH_EVIDENCE)) return "unknown";
  try {
    identity.probe(pid!);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
  try {
    const actual = identity.readBirthIdentity(pid!).trim();
    if (!actual.match(PS_BIRTH_EVIDENCE)) return "unknown";
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
 * Electron both use the `ps -o lstart=` prefix as the immutable PID identity.
 */
export function sameProcessBirthIdentity(current: string, recorded: string): boolean {
  // Unexpected or malformed values fall back to exact comparison. The outer
  // kill(0) EPERM/ESRCH check remains the liveness safety net.
  const stable = (value: string) => value.trim().match(PS_LONG_START_PREFIX)?.[0].replace(/\s+/g, " ") ?? value.trim();
  return stable(current) === stable(recorded);
}
