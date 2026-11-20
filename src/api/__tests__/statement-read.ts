// Test helpers for a statement the code under test sends: its text and rows,
// and what PostgreSQL read to answer it.
import type { Pool } from "pg";

export type CapturedStatement = { text: string; values: unknown[]; rows: Record<string, unknown>[] };

/** Records the last statement matching `match` that `run` sends through the pool, with its rows. */
export async function captureStatement<T>(
  pool: Pool,
  match: RegExp,
  run: () => Promise<T>,
): Promise<{ result: T; read: CapturedStatement | null }> {
  const original = pool.query;
  let read: CapturedStatement | null = null;
  pool.query = (async function (...args: unknown[]) {
    const query = args[0] as string | { text: string };
    const text = typeof query === "string" ? query : query.text;
    const result = await (original as (...a: unknown[]) => Promise<{ rows: unknown[]; fields: { name: string }[] }>)
      .apply(pool, args);
    if (match.test(text)) {
      const names = result.fields.map((field) => field.name);
      read = {
        text,
        values: (args[1] as unknown[]) ?? [],
        rows: result.rows.map((row) => Array.isArray(row)
          ? Object.fromEntries(names.map((name, index) => [name, (row as unknown[])[index]]))
          : row as Record<string, unknown>),
      };
    }
    return result;
  }) as typeof pool.query;
  try {
    return { result: await run(), read };
  } finally {
    pool.query = original;
  }
}

/**
 * What a statement read, taken from EXPLAIN ANALYZE and not from a clock: for
 * a table, the rows its scans returned or discarded, times each scan's loops;
 * for the statement, the pages it touched. EXPLAIN reports rows as a rounded
 * mean per loop, so the count is exact for one loop and close for many.
 * The time limit only turns a runaway statement into a failure.
 */
export async function explainRead(pool: Pool, text: string, values: unknown[], timeoutMs = 60_000) {
  const connection = await pool.connect();
  try {
    await connection.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
    const explained = await connection.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values);
    const root = explained.rows[0]["QUERY PLAN"][0].Plan;
    const flatten = (plan: any): any[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
    const nodes = flatten(root);
    const scans = (table: string) => nodes.filter((node) => node["Relation Name"] === table);
    const rowsRead = (table: string) => scans(table).reduce((sum, node) => sum + (node["Actual Loops"] ?? 0)
      * ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0)), 0);
    return { scans, rowsRead, pages: (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0) };
  } finally {
    await connection.query("RESET statement_timeout").catch(() => undefined);
    connection.release();
  }
}
