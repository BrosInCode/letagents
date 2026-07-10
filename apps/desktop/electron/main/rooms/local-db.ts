import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { localChatDatabasePath } from "../chat-storage/settings.js";

export type SqliteStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => unknown;
};

export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

const require = createRequire(import.meta.url);
let sharedDb: SqliteDatabase | null = null;

/**
 * Single shared DatabaseSync connection for all local chat SQLite stores
 * (rooms / messages / artifacts). Callers still run their own schema init.
 */
export async function getLocalChatDatabase(): Promise<SqliteDatabase> {
  if (sharedDb) return sharedDb;
  await mkdir(dirname(localChatDatabasePath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  sharedDb = new DatabaseSync(localChatDatabasePath);
  sharedDb.exec("PRAGMA journal_mode = WAL");
  sharedDb.exec("PRAGMA foreign_keys = ON");
  sharedDb.exec("PRAGMA busy_timeout = 5000");
  return sharedDb;
}

export function addColumnIfMissing(
  database: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  try {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

export function beginImmediate(database: SqliteDatabase): void {
  database.exec("BEGIN IMMEDIATE");
}

export function rollback(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // SQLite may already have closed the transaction after an error.
  }
}
