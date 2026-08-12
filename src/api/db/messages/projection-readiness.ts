import { pool } from "../client.js";

export async function analyzeMessageThreadProjection(): Promise<void> {
  // Reconciliation bulk-fills brand-new tables outside the migration DDL
  // transaction. Publish planner statistics before a new API binary serves
  // deep inbox pages instead of waiting for autovacuum's later analyze pass.
  await pool.query(
    `ANALYZE message_thread_summaries,
             message_thread_participants,
             message_thread_participant_aliases,
             message_thread_participant_agents,
             message_thread_projected_messages,
             message_thread_reads,
             message_room_thread_stats,
             message_account_thread_read_stats`,
  );
}

/**
 * A new API binary must never serve the materialized query while legacy rows
 * are still reconciling. `db:migrate` drains committed batches before deploy;
 * this startup gate makes that rollout ordering an enforced invariant.
 */
export async function assertMessageThreadProjectionReady(): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT rollout.completed_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM message_thread_projection_watermarks
               WHERE completed_at IS NULL
            ) AS ready
       FROM message_thread_projection_rollout AS rollout
      WHERE rollout.singleton`,
  );
  if (!result.rows[0]?.ready) {
    throw new Error(
      "message thread projection rollout is incomplete; run db:migrate before starting the API",
    );
  }
}
