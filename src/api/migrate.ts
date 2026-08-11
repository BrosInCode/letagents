import path from "path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db, pool } from "./db/client.js";
import {
  runBoundedProjectionBatch,
  runProjectionBatchWithRetry,
} from "./db/messages/projection-retry.js";
import { analyzeMessageThreadProjection } from "./db/messages/projection-readiness.js";

const THREAD_PROJECTION_BATCH_SIZE = 500;

export async function reconcileMessageThreadProjection(): Promise<number> {
  let workUnits = 0;
  while (true) {
    // Bound both lock acquisition and function execution. Each batch commits
    // independently so a busy room cannot wedge the migration process.
    const result = await runProjectionBatchWithRetry(() =>
      runBoundedProjectionBatch(pool, THREAD_PROJECTION_BATCH_SIZE));
    const batchCount = Number(result.rows[0]?.processed) || 0;
    workUnits += batchCount;
    if (batchCount === 0) return workUnits;
  }
}

async function main(): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder });
  const workUnits = await reconcileMessageThreadProjection();
  await analyzeMessageThreadProjection();
  console.log(`Applied migrations from ${migrationsFolder}; reconciled ${workUnits} thread rollout records`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
