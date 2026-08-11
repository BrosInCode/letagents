import type { RoutingIdentityLike } from "./routing-aliases.mjs";

export type SqliteRoutingDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  };
};

export const LOCAL_THREAD_ROUTING_BACKFILL_BATCH_SIZE: number;
export const LOCAL_THREAD_ROUTING_LOOKUP_BATCH_SIZE: number;
export const LOCAL_THREAD_ROUTING_BACKFILL_TIME_BUDGET_MS: number;
export class LocalThreadRoutingProjectionUnavailableError extends Error {}
export function ensureLocalThreadRoutingProjectionSchema(database: SqliteRoutingDatabase): void;
export function ensureLocalThreadRoutingProjectionSchemaAsync(
  database: SqliteRoutingDatabase,
  options?: { maxWaitMs?: number; random?: () => number },
): Promise<void>;
export function runLocalSqliteWriteTransactionAsync<T>(
  database: SqliteRoutingDatabase,
  work: () => T,
  options?: { maxWaitMs?: number; random?: () => number },
): Promise<T>;
export function projectLocalThreadRoutingMessage(
  database: SqliteRoutingDatabase,
  row: {
    room_id: string;
    number: number;
    thread_root_number?: number | null;
    reply_to_number?: number | null;
    sender: string;
    text?: string;
    source?: string | null;
    timestamp?: string;
    [key: string]: unknown;
  },
): void;
export function runLocalThreadRoutingBackfillBatch(
  database: SqliteRoutingDatabase,
  batchSize?: number,
): { processed: number; completed: boolean };
export function scheduleLocalThreadRoutingBackfill(
  database: SqliteRoutingDatabase,
  options?: {
    onError?: (error: unknown, delayMs: number | null) => void;
    setImmediate?: (callback: () => void) => { unref?(): void } | unknown;
    setTimeout?: (callback: () => void, delayMs: number) => { unref?(): void } | unknown;
  },
): void;
export function scheduleLocalThreadRoutingRootsRepair(
  database: SqliteRoutingDatabase,
  roomId: string,
  rootNumbers: readonly number[],
): void;
export function invalidateLocalThreadRoutingRoots(
  database: SqliteRoutingDatabase,
  roomId: string,
  rootNumbers: readonly number[],
): void;
export function getLocalThreadRoutingAgentKeysForRoots(
  database: SqliteRoutingDatabase,
  roomId: string,
  rootNumbers: readonly number[],
  identities: readonly RoutingIdentityLike[],
  options?: {
    foregroundTimeBudgetMs?: number;
    scheduleOnTimeout?: boolean;
    signal?: AbortSignal;
  },
): Promise<Map<number, Set<string>>>;
