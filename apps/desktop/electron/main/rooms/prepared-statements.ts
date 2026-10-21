import type { SqliteDatabase, SqliteStatement } from "./local-db.js";

/**
 * Per-connection prepared-statement cache for the local chat SQLite stores.
 *
 * Problem: every query site called `database.prepare(sql)` on each use, so the
 * hot polls (live metadata, message reads, room lookups, supervision checks)
 * compiled the same SQL text again and again.
 *
 * Rule: `withStatementCache(database)` returns one facade per connection.
 * Its `prepare(sql)` returns the same statement object for the same SQL text.
 * Statements finish each `get`, `all` and `run` call before they return, so
 * sharing one statement object is safe. SQLite re-prepares a statement on its
 * own when the schema changes.
 * Bound: at most `MAX_CACHED_STATEMENTS` per connection, least recently used
 * dropped first.
 * Invalidation: the cache lives in a WeakMap keyed by the connection object, so
 * a new connection starts with an empty cache.
 */
export const MAX_CACHED_STATEMENTS = 256;

const facades = new WeakMap<SqliteDatabase, SqliteDatabase>();
const rawDatabases = new WeakMap<SqliteDatabase, SqliteDatabase>();
// Counts writes made through this process's facade. `PRAGMA data_version` only
// changes for commits by OTHER connections, so the two together tell a poller
// whether anything could have changed since its last look.
const writeGenerations = new WeakMap<SqliteDatabase, number>();

function noteWrite(database: SqliteDatabase): void {
  writeGenerations.set(database, (writeGenerations.get(database) ?? 0) + 1);
}

export function withStatementCache(database: SqliteDatabase): SqliteDatabase {
  const existing = facades.get(database);
  if (existing) return existing;
  const statements = new Map<string, SqliteStatement>();
  const facade: SqliteDatabase = {
    exec: (sql) => {
      noteWrite(database);
      return database.exec(sql);
    },
    prepare: (sql) => {
      const cached = statements.get(sql);
      if (cached) {
        // Refresh the position so the least recently used entry is dropped first.
        statements.delete(sql);
        statements.set(sql, cached);
        return cached;
      }
      const prepared = database.prepare(sql);
      const statement: SqliteStatement = {
        all: (...params) => prepared.all(...params),
        get: (...params) => prepared.get(...params),
        run: (...params) => {
          noteWrite(database);
          return prepared.run(...params);
        },
      };
      statements.set(sql, statement);
      if (statements.size > MAX_CACHED_STATEMENTS) {
        const oldest = statements.keys().next().value;
        if (oldest !== undefined) statements.delete(oldest);
      }
      return statement;
    },
    close: () => {
      statements.clear();
      database.close?.();
    },
  };
  facades.set(database, facade);
  rawDatabases.set(facade, database);
  return facade;
}

/**
 * A cheap token that changes when the database may have changed: a write made
 * through this process's facade, or a commit by another connection or process.
 * Two equal tokens mean "nothing changed since the last token".
 * Cost: one cached PRAGMA statement and no table read.
 */
export function readDatabaseChangeStamp(database: SqliteDatabase): string {
  const facade = withStatementCache(rawDatabases.get(database) ?? database);
  const raw = rawDatabases.get(facade) ?? database;
  const row = facade.prepare("PRAGMA data_version").get();
  return `${writeGenerations.get(raw) ?? 0}:${String(row?.data_version)}`;
}
