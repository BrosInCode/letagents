// Removal of the disposable profile folder of a Cursor inspection.

import { rmSync } from "node:fs";

/**
 * How long a Windows inspection folder may stay in use after its inspection
 * ended. A killed Electron-as-Node process was seen to take up to 9 s to
 * finish its exit in a loaded Windows VM, and 4.9 s on x64 hardware.
 */
export const CURSOR_PROBE_ROOT_REMOVAL_TIMEOUT_MS = 20_000;

// What Windows answers while another process still has the folder, or a file
// in it, open: a sharing violation, a file whose delete is pending, or a
// folder that still lists such a file.
const IN_USE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

export interface CursorProbeRootRemovalOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  remove?: (root: string) => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Remove an inspection's profile folder. It resolves only when the folder is
 * gone, so a caller that awaits it keeps the rule that the next inspection
 * starts after this one's folder was removed.
 *
 * Windows: a process keeps its current directory and its open files until its
 * exit is complete, and that can be seconds after the process-tree helper
 * reported the inspection's job empty: the job stops listing a process as
 * soon as it starts to exit. Such a process runs no more code. So removal is
 * tried again until the folder is free, for at most `timeoutMs`; a folder
 * still in use then fails the removal. Elsewhere nothing holds a folder
 * against removal, and it is removed once, as before.
 */
export async function removeCursorProbeRoot(
  root: string,
  options: CursorProbeRootRemovalOptions = {},
): Promise<void> {
  const remove = options.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  if ((options.platform ?? process.platform) !== "win32") {
    remove(root);
    return;
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? CURSOR_PROBE_ROOT_REMOVAL_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  for (let delayMs = 25; ; delayMs = Math.min(delayMs * 2, 250)) {
    try {
      remove(root);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !IN_USE_CODES.has(code)) throw error;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new Error(
          `Cursor's inspection folder ${root} was still in use ${Math.round(timeoutMs / 1000)} s after the inspection ended (${code}).`,
          { cause: error },
        );
      }
      await wait(Math.min(delayMs, remainingMs));
    }
  }
}

/**
 * Remove an inspection's folder after the inspection itself failed. The
 * inspection's error is the one to report, so a folder that cannot be removed
 * is left: it is private to this account and nothing reads it again.
 */
export async function discardCursorProbeRoot(
  root: string,
  remove: (root: string) => Promise<void> = removeCursorProbeRoot,
): Promise<void> {
  try {
    await remove(root);
  } catch {
    // The inspection's own error is the cause to report.
  }
}
