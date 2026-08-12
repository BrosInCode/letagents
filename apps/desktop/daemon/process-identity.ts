const PS_LONG_START_PREFIX = /^\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}/;

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
