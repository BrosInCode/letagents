// On Windows, replacing a file fails with EPERM, EBUSY or EACCES while another
// process (Defender, an indexer, a reader) briefly holds it open. Those errors
// clear in milliseconds, so the rename is tried again a bounded number of
// times before the error is rethrown. Any other error, and any error on
// another platform (where these codes mean a lasting permission problem), is
// thrown at once, so POSIX behaviour is unchanged.
import { renameSync } from "node:fs";
import { rename as renameAsync } from "node:fs/promises";

export const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Waits between attempts: 10 attempts, 970 ms of waiting at most. */
export const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 60, 90, 130, 170, 200, 250];

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the thread; the state write is synchronous and holds the state lock. */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

export function isRetryableRenameError(error, platform = process.platform) {
  if (platform !== "win32") return false;
  const code = error?.code;
  return typeof code === "string" && RENAME_RETRY_CODES.has(code);
}

export function renameWithRetry(rename, from, to, options = {}) {
  const sleep = options.sleep ?? sleepSync;
  const delaysMs = options.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error, platform) || attempt >= delaysMs.length) throw error;
      sleep(delaysMs[attempt]);
    }
  }
}

/** The same bounded retry for an asynchronous rename; it waits without blocking the thread. */
export async function renameWithRetryAsync(from, to, options = {}) {
  const rename = options.rename ?? renameAsync;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const delaysMs = options.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error, platform) || attempt >= delaysMs.length) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}

/** `renameSync` with the bounded Windows retry. */
export function renameSyncWithRetry(from, to, options = {}) {
  renameWithRetry(options.rename ?? renameSync, from, to, options);
}
