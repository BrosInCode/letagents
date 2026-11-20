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

/**
 * node-postgres closes an idle connection after 10 seconds. The API polls
 * often enough that it then reopens about one connection a second, and each
 * new connection costs a network round trip plus the password exchange.
 */
export const DEFAULT_DB_IDLE_TIMEOUT_MS = 60_000;
export const DB_IDLE_TIMEOUT_MIN_MS = 1_000;
export const DB_IDLE_TIMEOUT_MAX_MS = 3_600_000;

export function resolveDbIdleTimeoutMs(
  value = process.env.DB_POOL_IDLE_TIMEOUT_MS,
  warn: (line: string) => void = (line) => console.warn(line),
): number {
  const text = value?.trim() ?? "";
  if (!text) return DEFAULT_DB_IDLE_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(text)) {
    warn(`[db] DB_POOL_IDLE_TIMEOUT_MS must be a whole number of milliseconds from ${DB_IDLE_TIMEOUT_MIN_MS} to ${DB_IDLE_TIMEOUT_MAX_MS}; using ${DEFAULT_DB_IDLE_TIMEOUT_MS}`);
    return DEFAULT_DB_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(text);
  if (parsed < DB_IDLE_TIMEOUT_MIN_MS) {
    warn(`[db] DB_POOL_IDLE_TIMEOUT_MS ${text} is below ${DB_IDLE_TIMEOUT_MIN_MS}; using ${DB_IDLE_TIMEOUT_MIN_MS}`);
    return DB_IDLE_TIMEOUT_MIN_MS;
  }
  if (parsed > DB_IDLE_TIMEOUT_MAX_MS) {
    warn(`[db] DB_POOL_IDLE_TIMEOUT_MS ${text} is above ${DB_IDLE_TIMEOUT_MAX_MS}; using ${DB_IDLE_TIMEOUT_MAX_MS}`);
    return DB_IDLE_TIMEOUT_MAX_MS;
  }
  return parsed;
}

export const pool = new Pool({
  connectionString: getDatabaseUrl(),
  max: resolveDbPoolMax(),
  // Shutdown and broker publication must never wait forever for a new socket.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: resolveDbIdleTimeoutMs(),
  // A script or a test that leaves the pool open must not wait a minute for
  // its idle connections before it can exit. The server always has work.
  allowExitOnIdle: true,
  // A long-idle connection to a dead peer is found by the operating system, not at the next query.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// An idle client that errors (the server restarts, a VPN drops) emits "error"
// on the pool; with no listener that event would crash the process.
pool.on("error", (error) => {
  console.error("[db] idle pool client error:", error.message);
});

export const db = drizzle(pool, { schema });
