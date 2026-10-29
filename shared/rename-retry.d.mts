export declare const RENAME_RETRY_CODES: ReadonlySet<string>;
/** Waits between attempts: 10 attempts, 970 ms of waiting at most. */
export declare const RENAME_RETRY_DELAYS_MS: readonly number[];
/** Blocks the thread; the state write is synchronous and holds the state lock. */
export declare function sleepSync(ms: number): void;
export type RenameFn = (from: string, to: string) => void;
export type RenameRetryOptions = { sleep?: (ms: number) => void; delaysMs?: readonly number[]; platform?: NodeJS.Platform };
export declare function isRetryableRenameError(error: unknown, platform?: NodeJS.Platform): boolean;
export declare function renameWithRetry(rename: RenameFn, from: string, to: string, options?: RenameRetryOptions): void;
/** The same bounded retry for an asynchronous rename; it waits without blocking the thread. */
export declare function renameWithRetryAsync(from: string, to: string, options?: {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
  platform?: NodeJS.Platform;
}): Promise<void>;
/** `renameSync` with the bounded Windows retry. */
export declare function renameSyncWithRetry(from: string, to: string, options?: RenameRetryOptions & { rename?: RenameFn }): void;
