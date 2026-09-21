import type { SqliteRoutingDatabase } from './sqlite-thread-routing.mjs';
export function ensureLocalTaskRevisionSchema(db: SqliteRoutingDatabase): void;
export function readLocalTaskRevision(db: SqliteRoutingDatabase, roomId: string): number;
export function observeLocalTaskCommits<T>(db: T): T;
