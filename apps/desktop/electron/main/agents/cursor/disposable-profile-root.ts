// Removal of the disposable Cursor profile roots that turn preparation creates
// for MCP inspection, bridge attestation, and identity attestation.

import { rm } from "node:fs/promises";

/**
 * How long removal keeps trying while the folder is still in use. It covers
 * the process-tree helper's own wait for an ended job to empty (5 s) with room
 * for a loaded machine.
 */
export const DISPOSABLE_PROFILE_ROOT_REMOVAL_BOUND_MS = 30_000;

/**
 * Codes that mean "still in use" while a process tree that ran in the root is
 * ending. On Windows a folder cannot be removed while a process still has it
 * as its working directory or holds a handle in it: rmdir fails EBUSY, a held
 * file fails EPERM, and a delete-pending file leaves its folder ENOTEMPTY.
 */
const IN_USE_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export interface DisposableProfileRootRemovalOptions {
  remove?: (root: string) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  boundMs?: number;
}

/**
 * Remove a disposable profile root completely, or throw. An inspection that
 * was stopped can return before its process tree is gone: the caller's wait
 * for the tree is bounded, and on Windows ending a job is asynchronous. So a
 * removal right after the inspection can find the root still in use for a
 * short time. Try again until the root is gone or the bound is spent, then
 * fail closed with the last error. The caller must not start the next pass
 * until this resolves.
 */
export async function removeDisposableProfileRoot(
  root: string,
  options: DisposableProfileRootRemovalOptions = {},
): Promise<void> {
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.boundMs ?? DISPOSABLE_PROFILE_ROOT_REMOVAL_BOUND_MS);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(root);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (typeof code !== "string" || !IN_USE_CODES.has(code) || now() >= deadline) throw error;
    }
    await wait(Math.min(25 * 2 ** attempt, 500));
  }
}
