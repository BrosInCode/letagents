const TRANSIENT_PROJECTION_SQLSTATES = new Set(["40P01", "40001", "55P03", "57014"]);
const PROJECTION_BATCH_MAX_ATTEMPTS = 3;

type ProjectionClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};

type ProjectionPool = { connect(): Promise<ProjectionClient> };

export async function runBoundedProjectionBatch(
  pool: ProjectionPool,
  batchSize: number,
): Promise<{ rows: Array<{ processed: number }> }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await client.query<{ processed: number }>(
      `SELECT reconcile_message_thread_projection($1)::int AS processed`,
      [batchSize],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection already failed */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function runProjectionBatchWithRetry<T>(
  query: () => Promise<T>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 1; attempt <= PROJECTION_BATCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await query();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!code || !TRANSIENT_PROJECTION_SQLSTATES.has(code) || attempt === PROJECTION_BATCH_MAX_ATTEMPTS) {
        throw error;
      }
      const jitterMs = Math.floor(Math.max(0, Math.min(0.999, random())) * 25);
      await wait(attempt * 25 + jitterMs);
    }
  }
  throw new Error("unreachable projection retry state");
}
