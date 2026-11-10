import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DB_URL;

  if (!databaseUrl) {
    throw new Error(
      "DB_URL is required. Set it to a PostgreSQL connection string, for example " +
        "'postgresql://postgres:postgres@localhost:5432/letagents'."
    );
  }

  return databaseUrl;
}

/**
 * One pool serves every request, sweep and broker publish, and the LISTEN
 * clients (room events, conversation changes) each hold one connection for
 * the life of the process. node-postgres defaults to 10. 20 leaves a stock
 * PostgreSQL (max_connections 100) room for a second API process during a
 * deploy, the migrator and an operator's psql.
 */
export const DEFAULT_DB_POOL_MAX = 20;
/** No single API process should hold more than this many connections. */
export const DB_POOL_MAX_LIMIT = 200;

export function resolveDbPoolMax(
  value = process.env.DB_POOL_MAX,
  warn: (line: string) => void = (line) => console.warn(line),
): number {
  const text = value?.trim() ?? "";
  if (!text) return DEFAULT_DB_POOL_MAX;
  if (!/^[1-9]\d*$/.test(text)) {
    warn(`[db] DB_POOL_MAX must be a whole number from 1 to ${DB_POOL_MAX_LIMIT}; using ${DEFAULT_DB_POOL_MAX}`);
    return DEFAULT_DB_POOL_MAX;
  }
  const parsed = Number(text);
  if (parsed > DB_POOL_MAX_LIMIT) {
    warn(`[db] DB_POOL_MAX ${text} is above ${DB_POOL_MAX_LIMIT}; using ${DB_POOL_MAX_LIMIT}`);
    return DB_POOL_MAX_LIMIT;
  }
  return parsed;
}

export const pool = new Pool({
  connectionString: getDatabaseUrl(),
  max: resolveDbPoolMax(),
  // Shutdown and broker publication must never wait forever for a new socket.
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });
