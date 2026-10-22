// On Windows, replacing a file fails with EPERM, EBUSY or EACCES while another
// process (Defender, an indexer, a reader) briefly holds it open. Those errors
// clear in milliseconds, so the rename is tried again a bounded number of
// times before the error is rethrown. Any other error is thrown at once.

export const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Waits between attempts: 10 attempts, 970 ms of waiting at most. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 60, 90, 130, 170, 200, 250];

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the thread; the state write is synchronous and holds the state lock. */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

export type RenameFn = (from: string, to: string) => void;

export function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && RENAME_RETRY_CODES.has(code);
}

export function renameWithRetry(
  rename: RenameFn,
  from: string,
  to: string,
  options: { sleep?: (ms: number) => void; delaysMs?: readonly number[] } = {},
): void {
  const sleep = options.sleep ?? sleepSync;
  const delaysMs = options.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= delaysMs.length) throw error;
      sleep(delaysMs[attempt]);
    }
  }
}
