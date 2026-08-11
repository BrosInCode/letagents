// Thread-inbox parity suite — Postgres engine (Phase B / PR 4, part 2).
//
// This is the Postgres half of the parity safety net. It asserts the SAME
// golden expectations as the desktop-SQLite spec
// (apps/desktop/electron/__tests__/thread-inbox-parity-sqlite.test.ts), so the
// two engines are provably in parity and the PR-5 SQL-aggregate rewrite of
// getMessageThreads can be proven behaviour-preserving.
//
// KEEP IN SYNC with thread-inbox-parity-sqlite.test.ts: the scenarios and
// expected values below are the shared contract. If you change one engine's
// expectations, change the other (or the parity guarantee is void).
//
// Runs only when TEST_DB_URL is set (CI's integration-tests job provisions a
// Postgres service). Skips cleanly otherwise — importing the db client without
// DB_URL throws, so all db imports are gated behind the TEST_DB_URL check.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { decideAgentMessageActivation } from "../../shared/activation-routing.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const receiptActivationModule = testDatabaseUrl
  ? await import("../routes/rooms/messages/receipt-activation.js")
  : null;
const routingMembershipModule = testDatabaseUrl
  ? await import("../db/messages/thread-routing-membership.js")
  : null;
const accountAgentRoutingModule = testDatabaseUrl
  ? await import("../db/messages/account-agent-routing.js")
  : null;
const projectionRetryModule = testDatabaseUrl
  ? await import("../db/messages/projection-retry.js")
  : null;
const projectionReadinessModule = testDatabaseUrl
  ? await import("../db/messages/projection-readiness.js")
  : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const addMessage = dbModule?.addMessage;
const addMessageWithCreateStatus = dbModule?.addMessageWithCreateStatus;
const createProjectWithName = dbModule?.createProjectWithName;
const upsertAccount = dbModule?.upsertAccount;
const registerAgentIdentity = dbModule?.registerAgentIdentity;
const getMessageThread = dbModule?.getMessageThread;
const getMessageThreads = dbModule?.getMessageThreads;
const getMessageById = dbModule?.getMessageById;
const getMessages = dbModule?.getMessages;
const getMessageThreadReadOverlays = dbModule?.getMessageThreadReadOverlays;
const markMessageThreadRead = dbModule?.markMessageThreadRead;
const attachReceiptAuthorityActivations = receiptActivationModule?.attachReceiptAuthorityActivations;
const getGlobalMessageThreadRoutingMembers = routingMembershipModule?.getGlobalMessageThreadRoutingMembers;
const getMessageAccountAgentRouting = accountAgentRoutingModule?.getMessageAccountAgentRouting;
const getMessageAccountAgentRoutings = accountAgentRoutingModule?.getMessageAccountAgentRoutings;
const runBoundedProjectionBatch = projectionRetryModule?.runBoundedProjectionBatch;
const analyzeMessageThreadProjection = projectionReadinessModule?.analyzeMessageThreadProjection;

async function drainThreadProjection(batchSize = 500): Promise<number> {
  let processed = 0;
  while (true) {
    const batch = await pool!.query<{ processed: number }>(
      `SELECT reconcile_message_thread_projection($1)::int AS processed`,
      [batchSize],
    );
    const count = Number(batch.rows[0]?.processed) || 0;
    processed += count;
    if (count === 0) return processed;
  }
}

const dropThreadProjectionSql = `
  DROP TRIGGER IF EXISTS messages_thread_projection_after_insert ON messages;
  DROP TRIGGER IF EXISTS messages_prompt_projection_before_delete ON messages;
  DROP TRIGGER IF EXISTS messages_thread_projection_guard_before_delete ON messages;
  DROP TRIGGER IF EXISTS messages_thread_projection_guard_before_update ON messages;
  DROP TRIGGER IF EXISTS message_thread_reads_position_before_write ON message_thread_reads;
  DROP TRIGGER IF EXISTS message_thread_reads_stats_after_write ON message_thread_reads;
  DROP TRIGGER IF EXISTS rooms_thread_rollout_rename_fence_before_update ON rooms;
  DROP TRIGGER IF EXISTS rooms_thread_rollout_delete_fence_before_delete ON rooms;
  DROP TRIGGER IF EXISTS rooms_thread_rollout_after_rename ON rooms;
  DROP FUNCTION IF EXISTS maintain_message_thread_projection();
  DROP FUNCTION IF EXISTS remove_prompt_thread_projection();
  DROP FUNCTION IF EXISTS guard_message_thread_projection_mutation();
  DROP FUNCTION IF EXISTS maintain_message_thread_read_position();
  DROP FUNCTION IF EXISTS maintain_message_account_thread_read_stat();
  DROP FUNCTION IF EXISTS fence_message_thread_rollout_room_mutation();
  DROP FUNCTION IF EXISTS maintain_message_thread_rollout_room_rename();
  DROP FUNCTION IF EXISTS reconcile_message_thread_projection(integer);
  DROP FUNCTION IF EXISTS project_message_thread_message(text, integer);
  DROP FUNCTION IF EXISTS upsert_message_thread_participant_agent(text, integer, integer, text, text);
  DROP FUNCTION IF EXISTS upsert_message_thread_participant(text, integer, text, text, integer, boolean);
  DROP INDEX IF EXISTS agents_routing_canonical_key_idx;
  DROP FUNCTION IF EXISTS normalize_message_thread_routing_alias(text, boolean);
  DROP TABLE IF EXISTS message_thread_projection_watermarks;
  DROP TABLE IF EXISTS message_thread_projection_rollout;
  DROP TABLE IF EXISTS message_room_thread_stats;
  DROP TABLE IF EXISTS message_account_thread_read_stats;
  DROP TABLE IF EXISTS message_thread_projected_messages;
  DROP TABLE IF EXISTS message_thread_participant_agents;
  DROP TABLE IF EXISTS message_thread_participant_aliases;
  DROP TABLE IF EXISTS message_thread_participants;
  DROP TABLE IF EXISTS message_thread_summaries;
  ALTER TABLE message_thread_reads DROP COLUMN IF EXISTS last_read_reply_count;
`;

async function applyThreadProjectionMigration(executor: { query(sql: string): Promise<unknown> }): Promise<void> {
  const migrationSql = await readFile(
    path.resolve(process.cwd(), "drizzle/0078_materialized_thread_summaries.sql"),
    "utf8",
  );
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    if (statement.trim()) await executor.query(statement);
  }
}

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed thread-inbox parity tests require TEST_DB_URL");
  }
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  await drainThreadProjection();
}

test.beforeEach(async () => {
  if (!requiresDatabase) {
    await resetDatabase();
  }
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

const runOptions = {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run the Postgres thread-inbox parity suite" : false,
};

interface ExplainNode {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  Plans?: ExplainNode[];
}

test("PG thread projection migration: analyzes the exact materialized table set", runOptions, async () => {
  assert.ok(analyzeMessageThreadProjection);
  await analyzeMessageThreadProjection();
});

function flattenExplainPlan(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenExplainPlan)];
}

let accountSeq = 0;
async function newReader(): Promise<string> {
  if (!upsertAccount) throw new Error("requires TEST_DB_URL");
  accountSeq += 1;
  const account = await upsertAccount({
    provider: "test",
    provider_user_id: `parity-reader-${accountSeq}`,
    login: `parity-reader-${accountSeq}`,
  });
  return account.id;
}

/**
 * Mirror of the SQLite spec's seedRoom, creation order fixes ascending numbers:
 *   rootA + replyA1 + replyA2            -> thread A (2 replies)
 *   rootB + replyB1(empty text, visible) -> thread B (1 reply)
 *   promptOnly (auto, empty, no thread)  -> excluded everywhere
 *   loner (no replies)                   -> not a thread
 */
async function seedRoom(roomId: string) {
  if (!addMessage) throw new Error("requires TEST_DB_URL");
  const rootA = await addMessage(roomId, "Human", "root A", { source: "browser" });
  const replyA1 = await addMessage(roomId, "Agent", "A reply 1", {
    source: "agent", reply_to_message_id: rootA.id, thread_root_message_id: rootA.id,
  });
  const replyA2 = await addMessage(roomId, "Agent", "A reply 2", {
    source: "agent", reply_to_message_id: replyA1.id, thread_root_message_id: rootA.id,
  });
  const rootB = await addMessage(roomId, "Human", "root B", { source: "browser" });
  // Empty text but NOT an auto prompt -> visible (the empty-text-visible case the
  // task_1 P0 fix restored; visible because agent_prompt_kind is null).
  const replyB1 = await addMessage(roomId, "Agent", "", {
    source: "agent", reply_to_message_id: rootB.id, thread_root_message_id: rootB.id,
  });
  const promptOnly = await addMessage(roomId, "Agent", "", {
    source: "agent", agent_prompt_kind: "auto",
  });
  const loner = await addMessage(roomId, "Human", "no replies here", { source: "browser" });
  return { rootA, replyA1, replyA2, rootB, replyB1, promptOnly, loner };
}

test("PG thread projection migration: backfills legacy replies, participants, and reads", runOptions, async () => {
  const room = await createProjectWithName!("parity_migration_backfill");
  const root = await addMessage!(room.id, "Same sender", "legacy root");
  const replyWithNullSource = await addMessage!(room.id, "Same sender", "legacy reply 1", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const replyWithEmptySource = await addMessage!(room.id, "Same sender", "legacy reply 2", {
    source: "",
    reply_to_message_id: replyWithNullSource.id,
    thread_root_message_id: root.id,
  });
  const reader = await newReader();
  await markMessageThreadRead!(room.id, root.id, reader, { message_id: replyWithNullSource.id });

  // Reconstruct the exact pre-0078 database state while retaining the legacy
  // messages and read cursor that the migration must backfill.
  await pool!.query(dropThreadProjectionSql);
  const migrationClient = await pool!.connect();
  await migrationClient.query("BEGIN");
  try {
    await applyThreadProjectionMigration(migrationClient);
    await migrationClient.query("COMMIT");
  } catch (error) {
    await migrationClient.query("ROLLBACK");
    throw error;
  } finally {
    migrationClient.release();
  }

  await drainThreadProjection(1);

  const projection = await pool!.query<{
    reply_count: number;
    latest_reply_number: number;
    last_read_reply_count: number;
  }>(
    `SELECT summary.reply_count, summary.latest_reply_number, thread_read.last_read_reply_count
       FROM message_thread_summaries AS summary
       JOIN message_thread_reads AS thread_read
         ON thread_read.room_id = summary.room_id
        AND thread_read.thread_root_number = summary.thread_root_number
      WHERE summary.room_id = $1 AND summary.thread_root_number = $2`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.deepEqual(projection.rows[0], {
    reply_count: 2,
    latest_reply_number: Number(replyWithEmptySource.id.slice(4)),
    last_read_reply_count: 1,
  });

  const participants = await pool!.query<{
    source: string | null;
    message_count: number;
    latest_message_number: number;
  }>(
    `SELECT source, message_count, latest_message_number
       FROM message_thread_participants
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.deepEqual(participants.rows, [{
    source: null,
    message_count: 3,
    latest_message_number: Number(replyWithEmptySource.id.slice(4)),
  }]);

  await addMessage!(room.id, "Same sender", "post-migration reply", {
    reply_to_message_id: replyWithEmptySource.id,
    thread_root_message_id: root.id,
  });
  const afterRollout = await pool!.query<{ reply_count: number }>(
    `SELECT reply_count FROM message_thread_summaries
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.equal(afterRollout.rows[0]?.reply_count, 3);
});

test("PG thread projection migration: hot-table contention is bounded and retryable", runOptions, async () => {
  const room = await createProjectWithName!("parity_migration_lock");
  const root = await addMessage!(room.id, "Human", "legacy root");
  const reply = await addMessage!(room.id, "Agent", "legacy reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const reader = await newReader();
  await markMessageThreadRead!(room.id, root.id, reader, { message_id: reply.id });
  await pool!.query(dropThreadProjectionSql);

  const oldReader = await pool!.connect();
  const oldMessageWriter = await pool!.connect();
  let oldReaderReleased = false;
  let oldMessageWriterReleased = false;
  try {
  await oldReader.query("BEGIN");
  await oldReader.query(
    `UPDATE message_thread_reads SET read_at = NOW()
      WHERE room_id = $1 AND thread_root_number = $2 AND account_id = $3`,
    [room.id, Number(root.id.slice(4)), reader],
  );
  await oldMessageWriter.query("BEGIN");
  await oldMessageWriter.query(
    `UPDATE messages SET timestamp = timestamp WHERE room_id = $1 AND number = $2`,
    [room.id, Number(root.id.slice(4))],
  );

  async function attemptCutover(): Promise<{ elapsedMs: number; code: string | undefined }> {
    const migrationClient = await pool!.connect();
    const startedAt = Date.now();
    await migrationClient.query("BEGIN");
    await migrationClient.query("SET LOCAL lock_timeout = '100ms'");
    try {
      await applyThreadProjectionMigration(migrationClient);
      await migrationClient.query("COMMIT");
      return { elapsedMs: Date.now() - startedAt, code: undefined };
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      return {
        elapsedMs: Date.now() - startedAt,
        code: (error as { code?: string }).code,
      };
    } finally {
      migrationClient.release();
    }
  }

  const readBlocked = await attemptCutover();
  assert.equal(readBlocked.code, "55P03");
  assert.ok(readBlocked.elapsedMs < 1_500, `read lock wait was unbounded: ${readBlocked.elapsedMs}ms`);
  const oldRead = await oldReader.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM message_thread_reads WHERE room_id = $1`,
    [room.id],
  );
  assert.equal(oldRead.rows[0]?.count, 1, "the old binary remains usable in its transaction");
  await oldReader.query("COMMIT");
  oldReader.release();
  oldReaderReleased = true;

  const messageBlocked = await attemptCutover();
  assert.equal(messageBlocked.code, "55P03");
  assert.ok(messageBlocked.elapsedMs < 1_500, `message lock wait was unbounded: ${messageBlocked.elapsedMs}ms`);

  // A failed cutover rolls back its queued DDL, so legacy writers recover
  // immediately rather than remaining trapped behind a waiting migration.
  const liveLegacyReplyNumber = Number(reply.id.slice(4)) + 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, $3, $4, 'Agent', 'legacy while retrying', 1, NOW())`,
    [room.id, liveLegacyReplyNumber, Number(reply.id.slice(4)), Number(root.id.slice(4))],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2)
      WHERE name = 'messages:' || $1`,
    [room.id, liveLegacyReplyNumber],
  );
  await oldMessageWriter.query("COMMIT");
  oldMessageWriter.release();
  oldMessageWriterReleased = true;

  for (const table of ["rooms", "accounts", "agents"] as const) {
    const legacyWriter = await pool!.connect();
    try {
      await legacyWriter.query("BEGIN");
      await legacyWriter.query(`LOCK TABLE ${table} IN ROW EXCLUSIVE MODE`);
      const blocked = await attemptCutover();
      assert.equal(blocked.code, "55P03", `${table} cutover lock was not deadline-bounded`);
      assert.ok(blocked.elapsedMs < 1_500, `${table} lock wait was unbounded: ${blocked.elapsedMs}ms`);
      await legacyWriter.query("ROLLBACK");
    } finally {
      legacyWriter.release();
    }
  }

  const migrationClient = await pool!.connect();
  await migrationClient.query("BEGIN");
  try {
    await applyThreadProjectionMigration(migrationClient);
    await migrationClient.query("COMMIT");
  } catch (error) {
    await migrationClient.query("ROLLBACK");
    throw error;
  } finally {
    migrationClient.release();
  }

  await drainThreadProjection(10);
  const projection = await pool!.query<{
    reply_count: number;
    latest_reply_number: number;
    last_read_reply_count: number;
    unvalidated_constraints: number;
  }>(
    `SELECT summary.reply_count, summary.latest_reply_number, thread_read.last_read_reply_count,
            (SELECT COUNT(*)::int FROM pg_constraint
              WHERE conname LIKE 'message_thread_%_fk' AND NOT convalidated) AS unvalidated_constraints
       FROM message_thread_summaries AS summary
       JOIN message_thread_reads AS thread_read
         ON thread_read.room_id = summary.room_id
        AND thread_read.thread_root_number = summary.thread_root_number
      WHERE summary.room_id = $1`,
    [room.id],
  );
  assert.deepEqual(projection.rows[0], {
    reply_count: 2,
    latest_reply_number: liveLegacyReplyNumber,
    last_read_reply_count: 1,
    unvalidated_constraints: 0,
  });
  } finally {
    if (!oldReaderReleased) {
      await oldReader.query("ROLLBACK").catch(() => undefined);
      oldReader.release();
    }
    if (!oldMessageWriterReleased) {
      await oldMessageWriter.query("ROLLBACK").catch(() => undefined);
      oldMessageWriter.release();
    }
  }
});

test("PG thread projection rollout batch has a bounded singleton lock wait", runOptions, async () => {
  assert.ok(runBoundedProjectionBatch);
  await pool!.query(`UPDATE message_thread_projection_rollout SET completed_at = NULL WHERE singleton`);
  const blocker = await pool!.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM message_thread_projection_rollout WHERE singleton FOR UPDATE");
    const startedAt = Date.now();
    await assert.rejects(
      runBoundedProjectionBatch!(pool!, 1),
      (error: unknown) => (error as { code?: string }).code === "55P03",
    );
    assert.ok(Date.now() - startedAt < 2_000, "rollout lock wait exceeded its one-second budget");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

test("PG thread projection rollout: cursor repair serializes with a legacy advance", runOptions, async () => {
  const room = await createProjectWithName!("parity_read_reconcile_race");
  const root = await addMessage!(room.id, "Human", "root");
  const firstReply = await addMessage!(room.id, "Agent", "first", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const secondReply = await addMessage!(room.id, "Agent", "second", {
    reply_to_message_id: firstReply.id,
    thread_root_message_id: root.id,
  });
  const reader = await newReader();
  await markMessageThreadRead!(room.id, root.id, reader, { message_id: firstReply.id });
  const rootNumber = Number(root.id.slice(4));
  const secondReplyNumber = Number(secondReply.id.slice(4));

  await pool!.query(
    `UPDATE message_thread_projection_rollout
        SET watermarks_created = true, completed_at = NULL
      WHERE singleton`,
  );
  await pool!.query(
    `INSERT INTO message_thread_projection_watermarks (
       room_id, through_message_number, message_cursor,
       read_thread_root_cursor, read_account_cursor, reads_completed, completed_at
     ) VALUES ($1, $2, $2, 0, '', false, NULL)
     ON CONFLICT (room_id) DO UPDATE SET
       through_message_number = EXCLUDED.through_message_number,
       message_cursor = EXCLUDED.message_cursor,
       read_thread_root_cursor = 0,
       read_account_cursor = '',
       reads_completed = false,
       completed_at = NULL`,
    [room.id, secondReplyNumber],
  );

  const blocker = await pool!.connect();
  const legacyWriter = await pool!.connect();
  const reconciler = await pool!.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 7880078))`,
      [room.id, rootNumber],
    );

    await legacyWriter.query("BEGIN");
    await legacyWriter.query("SET LOCAL application_name = 'thread-read-race-writer'");
    const legacyAdvance = legacyWriter.query(
      `UPDATE message_thread_reads
          SET last_read_message_number = $1, read_at = NOW()
        WHERE room_id = $2 AND thread_root_number = $3 AND account_id = $4`,
      [secondReplyNumber, room.id, rootNumber, reader],
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool!.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'thread-read-race-writer'
              AND wait_event_type = 'Lock' AND lower(wait_event) = 'advisory'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) break;
      if (attempt === 99) assert.fail("legacy writer did not pause in the advisory-lock trigger");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await reconciler.query("SET application_name = 'thread-read-race-reconciler'");
    const reconcile = reconciler.query("SELECT reconcile_message_thread_projection(10)");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query("COMMIT");
    await legacyAdvance;
    await legacyWriter.query("COMMIT");
    await reconcile;
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await legacyWriter.query("ROLLBACK").catch(() => undefined);
    await reconciler.query("RESET application_name").catch(() => undefined);
    blocker.release();
    legacyWriter.release();
    reconciler.release();
  }

  const exact = await pool!.query<{
    last_read_message_number: number;
    last_read_reply_count: number;
  }>(
    `SELECT thread_read.last_read_message_number, thread_read.last_read_reply_count
       FROM message_thread_reads AS thread_read
      WHERE thread_read.room_id = $1
        AND thread_read.thread_root_number = $2
        AND thread_read.account_id = $3`,
    [room.id, rootNumber, reader],
  );
  assert.deepEqual(exact.rows[0], {
    last_read_message_number: secondReplyNumber,
    last_read_reply_count: 2,
  });
});

test("PG thread reads: unchanged cursors do not serialize different accounts", runOptions, async () => {
  const room = await createProjectWithName!("parity_unchanged_reader_lock");
  const root = await addMessage!(room.id, "Human", "root");
  const reply = await addMessage!(room.id, "Agent", "reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const readers = [await newReader(), await newReader()];
  for (const reader of readers) {
    await markMessageThreadRead!(room.id, root.id, reader, { message_id: reply.id });
  }
  const rootNumber = Number(root.id.slice(4));
  const replyNumber = Number(reply.id.slice(4));
  const first = await pool!.connect();
  const second = await pool!.connect();
  try {
    await first.query("BEGIN");
    await first.query(
      `UPDATE message_thread_reads
          SET last_read_message_number = $1, read_at = NOW()
        WHERE room_id = $2 AND thread_root_number = $3 AND account_id = $4`,
      [replyNumber, room.id, rootNumber, readers[0]],
    );

    await second.query("BEGIN");
    await second.query("SET LOCAL statement_timeout = '300ms'");
    await second.query(
      `UPDATE message_thread_reads
          SET last_read_message_number = $1, read_at = NOW()
        WHERE room_id = $2 AND thread_root_number = $3 AND account_id = $4`,
      [replyNumber, room.id, rootNumber, readers[1]],
    );
    await second.query("COMMIT");
    await first.query("COMMIT");
  } finally {
    await first.query("ROLLBACK").catch(() => undefined);
    await second.query("ROLLBACK").catch(() => undefined);
    first.release();
    second.release();
  }
});

test("PG thread projection rollout: read repair never retains a cross-reader advisory", runOptions, async () => {
  const room = await createProjectWithName!("parity_multi_reader_reconcile_race");
  const root = await addMessage!(room.id, "Human", "root");
  const firstReply = await addMessage!(room.id, "Agent", "first", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const secondReply = await addMessage!(room.id, "Agent", "second", {
    reply_to_message_id: firstReply.id,
    thread_root_message_id: root.id,
  });
  const readers = [await newReader(), await newReader()].sort();
  for (const reader of readers) {
    await markMessageThreadRead!(room.id, root.id, reader, { message_id: firstReply.id });
  }
  const rootNumber = Number(root.id.slice(4));
  const latestNumber = Number(secondReply.id.slice(4));
  await pool!.query(
    `UPDATE message_thread_reads
        SET last_read_reply_count = 0
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, rootNumber],
  );
  await pool!.query(
    `UPDATE message_thread_projection_rollout
        SET watermarks_created = true, completed_at = NULL
      WHERE singleton`,
  );
  await pool!.query(
    `INSERT INTO message_thread_projection_watermarks (
       room_id, through_message_number, message_cursor,
       read_thread_root_cursor, read_account_cursor, reads_completed, completed_at
     ) VALUES ($1, $2, $2, 0, '', false, NULL)
     ON CONFLICT (room_id) DO UPDATE SET
       through_message_number = EXCLUDED.through_message_number,
       message_cursor = EXCLUDED.message_cursor,
       read_thread_root_cursor = 0,
       read_account_cursor = '',
       reads_completed = false,
       completed_at = NULL`,
    [room.id, latestNumber],
  );

  const writer = await pool!.connect();
  const reconciler = await pool!.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      `SELECT 1 FROM message_thread_reads
        WHERE room_id = $1 AND thread_root_number = $2 AND account_id = $3
        FOR UPDATE`,
      [room.id, rootNumber, readers[1]],
    );

    await reconciler.query("SET application_name = 'thread-multi-reader-reconciler'");
    const reconcile = reconciler.query("SELECT reconcile_message_thread_projection(10)");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool!.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'thread-multi-reader-reconciler'
              AND wait_event_type = 'Lock'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) break;
      if (attempt === 99) assert.fail("reconciler did not reach the second reader tuple");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The writer already owns reader B's tuple. Its BEFORE trigger takes the
    // thread advisory; this must complete while reconcile retains reader A.
    await writer.query(
      `UPDATE message_thread_reads
          SET last_read_message_number = $1, read_at = NOW()
        WHERE room_id = $2 AND thread_root_number = $3 AND account_id = $4`,
      [latestNumber, room.id, rootNumber, readers[1]],
    );
    await writer.query("COMMIT");
    await reconcile;
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    await reconciler.query("RESET application_name").catch(() => undefined);
    writer.release();
    reconciler.release();
  }

  const repaired = await pool!.query<{
    account_id: string;
    last_read_message_number: number;
    last_read_reply_count: number;
  }>(
    `SELECT account_id, last_read_message_number, last_read_reply_count
       FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2
      ORDER BY account_id`,
    [room.id, rootNumber],
  );
  assert.deepEqual(repaired.rows, [
    {
      account_id: readers[0],
      last_read_message_number: Number(firstReply.id.slice(4)),
      last_read_reply_count: 1,
    },
    {
      account_id: readers[1],
      last_read_message_number: latestNumber,
      last_read_reply_count: 2,
    },
  ]);
});

test("PG thread projection rollout: rename and late live write cannot escape keyset backfill", runOptions, async () => {
  const room = await createProjectWithName!("zz_rollout_room");
  const root = await addMessage!(room.id, "Human", "legacy root");
  let latest = root;
  for (let index = 0; index < 50; index += 1) {
    latest = await addMessage!(room.id, "Agent", `legacy ${index}`, {
      reply_to_message_id: latest.id,
      thread_root_message_id: root.id,
    });
  }

  await pool!.query(`
    DELETE FROM message_thread_projected_messages WHERE room_id = '${room.id}';
    DELETE FROM message_thread_participants WHERE room_id = '${room.id}';
    DELETE FROM message_thread_summaries WHERE room_id = '${room.id}';
    UPDATE message_room_thread_stats SET thread_count = 0 WHERE room_id = '${room.id}';
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET room_cursor = 'm', watermarks_created = false, completed_at = NULL
     WHERE singleton;
  `);

  const renamedRoomId = "aa_rollout_room";
  const renameClient = await pool!.connect();
  await renameClient.query("BEGIN");
  try {
    await renameClient.query("UPDATE rooms SET id = $1 WHERE id = $2", [renamedRoomId, room.id]);
    await renameClient.query(
      `UPDATE id_sequences SET name = 'messages:' || $1 WHERE name = 'messages:' || $2`,
      [renamedRoomId, room.id],
    );
    await renameClient.query("COMMIT");
  } catch (error) {
    await renameClient.query("ROLLBACK");
    throw error;
  } finally {
    renameClient.release();
  }

  const renamedWatermark = await pool!.query<{ through_message_number: number }>(
    `SELECT through_message_number FROM message_thread_projection_watermarks WHERE room_id = $1`,
    [renamedRoomId],
  );
  assert.equal(renamedWatermark.rows[0]?.through_message_number, 51);

  // Finish room enumeration (the renamed id is behind cursor) and consume one
  // bounded message batch. The rename trigger's explicit watermark keeps it.
  await pool!.query("SELECT reconcile_message_thread_projection(10)");
  await pool!.query("SELECT reconcile_message_thread_projection(10)");
  const cursor = await pool!.query<{ message_cursor: number }>(
    `SELECT message_cursor FROM message_thread_projection_watermarks WHERE room_id = $1`,
    [renamedRoomId],
  );
  assert.equal(cursor.rows[0]?.message_cursor, 10);

  const latePlan = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, FORMAT JSON)
     SELECT number FROM messages
      WHERE room_id = $1 AND number > $2 AND number <= $3
      ORDER BY number LIMIT 10`,
    [renamedRoomId, 10, 51],
  );
  const messageNode = flattenExplainPlan(latePlan.rows[0]!["QUERY PLAN"][0]!.Plan)
    .find((node) => node["Relation Name"] === "messages");
  assert.ok((messageNode?.["Actual Rows"] ?? Number.POSITIVE_INFINITY) <= 10);

  const [, liveReply] = await Promise.all([
    pool!.query("SELECT reconcile_message_thread_projection(10)"),
    addMessage!(renamedRoomId, "Live agent", "post-watermark", {
      reply_to_message_id: latest.id,
      thread_root_message_id: root.id,
    }),
  ]);
  await drainThreadProjection(10);
  const exact = await pool!.query<{ reply_count: number; positions: number; rollout_ready: boolean }>(
    `SELECT summary.reply_count,
            (SELECT COUNT(*)::int FROM message_thread_projected_messages AS projected
              WHERE projected.room_id = summary.room_id
                AND projected.thread_root_number = summary.thread_root_number
                AND projected.reply_ordinal IS NOT NULL) AS positions,
            (SELECT completed_at IS NOT NULL FROM message_thread_projection_rollout
              WHERE singleton) AS rollout_ready
       FROM message_thread_summaries AS summary
      WHERE summary.room_id = $1 AND summary.thread_root_number = $2`,
    [renamedRoomId, Number(root.id.slice(4))],
  );
  assert.deepEqual(exact.rows[0], { reply_count: 51, positions: 51, rollout_ready: true });
  assert.equal(liveReply.id, "msg_52");
});

test("PG thread projection rollout: room deletion commit/rollback is enumeration-safe", runOptions, async () => {
  async function resetEnumeration(): Promise<void> {
    await pool!.query(`
      DELETE FROM message_thread_projection_watermarks;
      UPDATE message_thread_projection_rollout
         SET room_cursor = '', watermarks_created = false, completed_at = NULL
       WHERE singleton;
    `);
  }

  const committedRoom = await createProjectWithName!("rollout_delete_commit");
  await resetEnumeration();
  const committingDelete = await pool!.connect();
  const committingReconcile = await pool!.connect();
  await committingDelete.query("BEGIN");
  await committingDelete.query("DELETE FROM rooms WHERE id = $1", [committedRoom.id]);
  const afterCommit = committingReconcile.query("SELECT reconcile_message_thread_projection(10)");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await committingDelete.query("COMMIT");
  await afterCommit;
  committingDelete.release();
  committingReconcile.release();
  const committedWatermark = await pool!.query(
    "SELECT 1 FROM message_thread_projection_watermarks WHERE room_id = $1",
    [committedRoom.id],
  );
  assert.equal(committedWatermark.rowCount, 0);

  const rolledBackRoom = await createProjectWithName!("rollout_delete_rollback");
  await resetEnumeration();
  const rollingBackDelete = await pool!.connect();
  const rollingBackReconcile = await pool!.connect();
  await rollingBackDelete.query("BEGIN");
  await rollingBackDelete.query("DELETE FROM rooms WHERE id = $1", [rolledBackRoom.id]);
  const afterRollback = rollingBackReconcile.query("SELECT reconcile_message_thread_projection(10)");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rollingBackDelete.query("ROLLBACK");
  await afterRollback;
  rollingBackDelete.release();
  rollingBackReconcile.release();
  const rollbackWatermark = await pool!.query(
    "SELECT 1 FROM message_thread_projection_watermarks WHERE room_id = $1",
    [rolledBackRoom.id],
  );
  assert.equal(rollbackWatermark.rowCount, 1);
});

test("PG thread projection rollout: projection drain and room deletion share one lock order", runOptions, async () => {
  const room = await createProjectWithName!("rollout_projection_delete_order");
  const root = await addMessage!(room.id, "Human", "root");
  const reply = await addMessage!(room.id, "Agent", "reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  await pool!.query(
    `UPDATE message_thread_projection_rollout
        SET watermarks_created = true, completed_at = NULL
      WHERE singleton`,
  );
  await pool!.query(
    `INSERT INTO message_thread_projection_watermarks (
       room_id, through_message_number, message_cursor, reads_completed, completed_at
     ) VALUES ($1, $2, 0, false, NULL)
     ON CONFLICT (room_id) DO UPDATE SET
       through_message_number = EXCLUDED.through_message_number,
       message_cursor = 0,
       reads_completed = false,
       completed_at = NULL`,
    [room.id, Number(reply.id.slice(4))],
  );

  const roomBlocker = await pool!.connect();
  const reconciler = await pool!.connect();
  const deleter = await pool!.connect();
  try {
    await roomBlocker.query("BEGIN");
    await roomBlocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 7880079))",
      [room.id],
    );

    await reconciler.query("SET application_name = 'thread-delete-order-reconciler'");
    await reconciler.query("SET statement_timeout = '3s'");
    const reconciliation = reconciler.query("SELECT reconcile_message_thread_projection(10)");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool!.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'thread-delete-order-reconciler'
              AND wait_event_type = 'Lock'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) break;
      if (attempt === 99) assert.fail("reconciler did not hold rollout while waiting for the room");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await deleter.query("SET application_name = 'thread-delete-order-deleter'");
    await deleter.query("SET statement_timeout = '3s'");
    const deletion = deleter.query("DELETE FROM rooms WHERE id = $1", [room.id]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool!.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'thread-delete-order-deleter'
              AND wait_event_type = 'Lock'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) break;
      if (attempt === 99) assert.fail("delete did not pause at the pre-room rollout fence");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await roomBlocker.query("COMMIT");
    await Promise.all([reconciliation, deletion]);
  } finally {
    await roomBlocker.query("ROLLBACK").catch(() => undefined);
    await reconciler.query("RESET application_name; RESET statement_timeout").catch(() => undefined);
    await deleter.query("RESET application_name; RESET statement_timeout").catch(() => undefined);
    roomBlocker.release();
    reconciler.release();
    deleter.release();
  }

  const remaining = await pool!.query("SELECT 1 FROM rooms WHERE id = $1", [room.id]);
  assert.equal(remaining.rowCount, 0);
});

test("PG thread projection rollout: enumeration and rename share one global-to-room order", runOptions, async () => {
  const room = await createProjectWithName!("rollout_order_old");
  await pool!.query(`
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET room_cursor = '', watermarks_created = false, completed_at = NULL
     WHERE singleton;
  `);

  const roomBlocker = await pool!.connect();
  const reconciler = await pool!.connect();
  const renamer = await pool!.connect();
  const renamedRoomId = "rollout_order_new";
  try {
    await roomBlocker.query("BEGIN");
    await roomBlocker.query("SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE", [room.id]);

    await reconciler.query("SET application_name = 'thread-order-reconciler'");
    await reconciler.query("SET statement_timeout = '3s'");
    const reconciliation = reconciler.query("SELECT reconcile_message_thread_projection(10)");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool!.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'thread-order-reconciler'
              AND wait_event_type = 'Lock'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) break;
      if (attempt === 99) assert.fail("reconciler did not hold rollout while waiting for the room");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await renamer.query("SET application_name = 'thread-order-renamer'");
    await renamer.query("SET statement_timeout = '3s'");
    const rename = renamer.query("UPDATE rooms SET id = $1 WHERE id = $2", [renamedRoomId, room.id]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool!.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'thread-order-renamer'
              AND wait_event_type = 'Lock'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) break;
      if (attempt === 99) assert.fail("rename did not pause at the pre-room rollout fence");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await roomBlocker.query("COMMIT");
    await Promise.all([reconciliation, rename]);
  } finally {
    await roomBlocker.query("ROLLBACK").catch(() => undefined);
    await reconciler.query("RESET application_name; RESET statement_timeout").catch(() => undefined);
    await renamer.query("RESET application_name; RESET statement_timeout").catch(() => undefined);
    roomBlocker.release();
    reconciler.release();
    renamer.release();
  }

  const exact = await pool!.query<{ room_exists: boolean; watermark_exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS room_exists,
            EXISTS (SELECT 1 FROM message_thread_projection_watermarks WHERE room_id = $1)
              AS watermark_exists`,
    [renamedRoomId],
  );
  assert.deepEqual(exact.rows[0], { room_exists: true, watermark_exists: true });
});

test("PG thread projection rollout: held rename cannot race the ready transition", runOptions, async () => {
  const room = await createProjectWithName!("rollout_rename_ready_old");
  const root = await addMessage!(room.id, "Human", "legacy root");
  await addMessage!(room.id, "Agent", "legacy reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  await pool!.query(`
    DELETE FROM message_thread_projected_messages WHERE room_id = '${room.id}';
    DELETE FROM message_thread_participants WHERE room_id = '${room.id}';
    DELETE FROM message_thread_summaries WHERE room_id = '${room.id}';
    UPDATE message_room_thread_stats SET thread_count = 0 WHERE room_id = '${room.id}';
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET watermarks_created = true, completed_at = NULL
     WHERE singleton;
  `);

  const rename = await pool!.connect();
  const reconcile = await pool!.connect();
  await rename.query("BEGIN");
  const renamedRoomId = "rollout_rename_ready_new";
  await rename.query("UPDATE rooms SET id = $1 WHERE id = $2", [renamedRoomId, room.id]);

  let reconcileSettled = false;
  const reconciliation = reconcile.query("SELECT reconcile_message_thread_projection(10)")
    .finally(() => { reconcileSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reconcileSettled, false, "ready transition must wait behind the rename's rollout share lock");
  await rename.query("COMMIT");
  await reconciliation;
  rename.release();
  reconcile.release();

  const state = await pool!.query<{ ready: boolean; pending: number }>(
    `SELECT rollout.completed_at IS NOT NULL AS ready,
            (SELECT COUNT(*)::int FROM message_thread_projection_watermarks
              WHERE completed_at IS NULL) AS pending
       FROM message_thread_projection_rollout AS rollout WHERE singleton`,
  );
  assert.deepEqual(state.rows[0], { ready: false, pending: 1 });
  await drainThreadProjection(10);
});

test("PG thread projection rollout: missing/lagging sequences use indexed message maxima", runOptions, async () => {
  const missing = await createProjectWithName!("rollout_missing_sequence");
  const missingRoot = await addMessage!(missing.id, "Human", "root");
  const missingReply = await addMessage!(missing.id, "Agent", "reply", {
    reply_to_message_id: missingRoot.id,
    thread_root_message_id: missingRoot.id,
  });
  const lagging = await createProjectWithName!("rollout_lagging_sequence");
  const laggingRoot = await addMessage!(lagging.id, "Human", "root");
  const laggingReply = await addMessage!(lagging.id, "Agent", "reply", {
    reply_to_message_id: laggingRoot.id,
    thread_root_message_id: laggingRoot.id,
  });
  await pool!.query("DELETE FROM id_sequences WHERE name = 'messages:' || $1", [missing.id]);
  await pool!.query(
    "UPDATE id_sequences SET value = 0 WHERE name = 'messages:' || $1",
    [lagging.id],
  );
  await pool!.query(`
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET room_cursor = '', watermarks_created = false, completed_at = NULL
     WHERE singleton;
  `);
  await pool!.query("SELECT reconcile_message_thread_projection(10)");
  const watermarks = await pool!.query<{ room_id: string; through_message_number: number }>(
    `SELECT room_id, through_message_number FROM message_thread_projection_watermarks
      WHERE room_id = ANY($1::text[]) ORDER BY room_id`,
    [[missing.id, lagging.id]],
  );
  assert.deepEqual(watermarks.rows, [
    { room_id: lagging.id, through_message_number: Number(laggingReply.id.slice(4)) },
    { room_id: missing.id, through_message_number: Number(missingReply.id.slice(4)) },
  ].sort((left, right) => left.room_id.localeCompare(right.room_id)));
});

test("PG thread projection rollout: batch limits clamp null, zero, and huge inputs", runOptions, async () => {
  const room = await createProjectWithName!("rollout_batch_clamp");
  await pool!.query(
    `INSERT INTO messages (room_id, number, sender, text, routing_snapshot_version, timestamp)
     SELECT $1, value, 'Human', 'root ' || value, 1, NOW()
       FROM generate_series(1, 2100) AS value`,
    [room.id],
  );
  await pool!.query(`
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET room_cursor = '', watermarks_created = true, completed_at = NULL
     WHERE singleton;
  `);
  await pool!.query(
    `INSERT INTO message_thread_projection_watermarks (
       room_id, through_message_number, message_cursor, completed_at
     ) VALUES ($1, 2100, 0, NULL)`,
    [room.id],
  );
  const nullBatch = await pool!.query<{ processed: number }>(
    "SELECT reconcile_message_thread_projection(NULL)::int AS processed",
  );
  const zeroBatch = await pool!.query<{ processed: number }>(
    "SELECT reconcile_message_thread_projection(0)::int AS processed",
  );
  const hugeBatch = await pool!.query<{ processed: number }>(
    "SELECT reconcile_message_thread_projection(1000000)::int AS processed",
  );
  assert.deepEqual(
    [nullBatch.rows[0]?.processed, zeroBatch.rows[0]?.processed, hugeBatch.rows[0]?.processed],
    [500, 1, 1599],
  );
});

test("PG thread projection rollout: only the first post-watermark reply reconstructs its ordinal", runOptions, async () => {
  const room = await createProjectWithName!("rollout_live_ordinals");
  const root = await addMessage!(room.id, "Human", "legacy root");
  let latest = root;
  for (let index = 0; index < 100; index += 1) {
    latest = await addMessage!(room.id, "Agent", `legacy ${index}`, {
      reply_to_message_id: latest.id,
      thread_root_message_id: root.id,
    });
  }
  const watermark = Number(latest.id.slice(4));
  await pool!.query(`
    DELETE FROM message_thread_projected_messages WHERE room_id = '${room.id}';
    DELETE FROM message_thread_participants WHERE room_id = '${room.id}';
    DELETE FROM message_thread_summaries WHERE room_id = '${room.id}';
    UPDATE message_room_thread_stats SET thread_count = 0 WHERE room_id = '${room.id}';
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET watermarks_created = true, completed_at = NULL
     WHERE singleton;
  `);
  await pool!.query(
    `INSERT INTO message_thread_projection_watermarks (
       room_id, through_message_number, message_cursor, completed_at
     ) VALUES ($1, $2, 0, NULL)`,
    [room.id, watermark],
  );

  const firstLive = await addMessage!(room.id, "Live", "first live", {
    reply_to_message_id: latest.id,
    thread_root_message_id: root.id,
  });
  const secondLive = await addMessage!(room.id, "Live", "second live", {
    reply_to_message_id: firstLive.id,
    thread_root_message_id: root.id,
  });
  const ordinals = await pool!.query<{ message_number: number; reply_ordinal: number }>(
    `SELECT message_number, reply_ordinal
       FROM message_thread_projected_messages
      WHERE room_id = $1 AND message_number = ANY($2::integer[])
      ORDER BY message_number`,
    [room.id, [Number(firstLive.id.slice(4)), Number(secondLive.id.slice(4))]],
  );
  assert.deepEqual(ordinals.rows, [
    { message_number: Number(firstLive.id.slice(4)), reply_ordinal: 101 },
    { message_number: Number(secondLive.id.slice(4)), reply_ordinal: 102 },
  ]);
});

test("PG thread projection rollout: concurrent first replies share one room lock order", runOptions, async () => {
  const room = await createProjectWithName!("rollout_room_lock_order");
  const rootA = await addMessage!(room.id, "Human", "root A");
  const rootB = await addMessage!(room.id, "Human", "root B");
  await pool!.query(`
    DELETE FROM message_thread_projection_watermarks;
    UPDATE message_thread_projection_rollout
       SET watermarks_created = false, room_cursor = '', completed_at = NULL
     WHERE singleton;
  `);

  const [replyA, replyB] = await Promise.all([
    addMessage!(room.id, "Agent A", "reply A", {
      reply_to_message_id: rootA.id,
      thread_root_message_id: rootA.id,
    }),
    addMessage!(room.id, "Agent B", "reply B", {
      reply_to_message_id: rootB.id,
      thread_root_message_id: rootB.id,
    }),
  ]);
  assert.ok(replyA.id && replyB.id);
  const stats = await pool!.query<{ thread_count: number; summaries: number }>(
    `SELECT stats.thread_count,
            (SELECT COUNT(*)::int FROM message_thread_summaries WHERE room_id = $1) AS summaries
       FROM message_room_thread_stats AS stats WHERE stats.room_id = $1`,
    [room.id],
  );
  assert.deepEqual(stats.rows[0], { thread_count: 2, summaries: 2 });
});

test("PG thread inbox: ordering, reply counts, prompt-only exclusion, unread count", runOptions, async () => {
  const room = await createProjectWithName!("parity_all");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const page = await getMessageThreads!(room.id, { account_id: reader });

  assert.deepEqual(page.threads.map((t) => t.root.id), [s.rootB.id, s.rootA.id]);
  assert.equal(page.has_more, false);

  const byRoot = new Map(page.threads.map((t) => [t.root.id, t.summary]));
  assert.equal(byRoot.get(s.rootA.id)?.reply_count, 2);
  assert.equal(byRoot.get(s.rootB.id)?.reply_count, 1);
  assert.equal(byRoot.get(s.rootA.id)?.unread_count, 2);
  assert.equal(byRoot.get(s.rootB.id)?.unread_count, 1);
  assert.equal(page.unread_thread_count, 2);
});

test("PG thread inbox: reader-scoped unread at none / partial / latest", runOptions, async () => {
  const room = await createProjectWithName!("parity_reads");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  let thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.unread_count, 2);
  assert.equal(thread?.summary.last_read_message_id, null);

  await markMessageThreadRead!(room.id, s.rootA.id, reader, { message_id: s.replyA1.id });
  thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.unread_count, 1);
  assert.equal(thread?.summary.last_read_message_id, s.replyA1.id);

  await markMessageThreadRead!(room.id, s.rootA.id, reader, { message_id: s.replyA2.id });
  thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.unread_count, 0);
  assert.equal(thread?.summary.has_unread, false);

  // A different reader is unaffected (reads are per-account).
  const other = await newReader();
  const otherThread = await getMessageThread!(room.id, s.rootA.id, { account_id: other });
  assert.equal(otherThread?.summary.unread_count, 2);
});

test("PG thread inbox: unread filter and global-vs-page unread_thread_count", runOptions, async () => {
  const room = await createProjectWithName!("parity_filter");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  await markMessageThreadRead!(room.id, s.rootB.id, reader, { message_id: s.replyB1.id });

  const unread = await getMessageThreads!(room.id, { filter: "unread", account_id: reader });
  assert.deepEqual(unread.threads.map((t) => t.root.id), [s.rootA.id]);
  assert.equal(unread.unread_thread_count, 1);

  const all = await getMessageThreads!(room.id, { filter: "all", account_id: reader });
  assert.deepEqual(all.threads.map((t) => t.root.id), [s.rootB.id, s.rootA.id]);
  assert.equal(all.unread_thread_count, 1);
});

test("PG thread inbox: root-only read cursors cannot hide never-read threads", runOptions, async () => {
  const room = await createProjectWithName!("parity_sparse_unread_cursor");
  const reader = await newReader();
  const rootOnly = await addMessage!(room.id, "Human", "root only");
  await markMessageThreadRead!(room.id, rootOnly.id, reader);

  const unreadRoot = await addMessage!(room.id, "Human", "unread root");
  await addMessage!(room.id, "Agent", "unread reply", {
    reply_to_message_id: unreadRoot.id,
    thread_root_message_id: unreadRoot.id,
  });
  const unread = await getMessageThreads!(room.id, { filter: "unread", account_id: reader });
  assert.equal(unread.unread_thread_count, 1);
  assert.deepEqual(unread.threads.map((thread) => thread.root.id), [unreadRoot.id]);
});

test("PG thread inbox: prompt-only (auto/empty) replies are excluded from thread aggregation", runOptions, async () => {
  const room = await createProjectWithName!("parity_promptonly_reply");
  const reader = await newReader();
  const rootC = await addMessage!(room.id, "Human", "root C", { source: "browser" });
  const visibleReply = await addMessage!(room.id, "Agent", "real reply", {
    source: "agent", reply_to_message_id: rootC.id, thread_root_message_id: rootC.id,
  });
  await addMessage!(room.id, "Agent", "", {
    source: "agent", agent_prompt_kind: "auto",
    reply_to_message_id: visibleReply.id, thread_root_message_id: rootC.id,
  });

  const thread = await getMessageThread!(room.id, rootC.id, { account_id: reader });
  assert.equal(thread?.summary.reply_count, 1);
  assert.equal(thread?.summary.latest_reply?.id, visibleReply.id);
  assert.equal(thread?.summary.unread_count, 1);

  const rootD = await addMessage!(room.id, "Human", "root D", { source: "browser" });
  const firstPromptOnlyReply = await addMessage!(room.id, "Prompt-only agent", "", {
    source: "agent", agent_prompt_kind: "auto",
    reply_to_message_id: rootD.id, thread_root_message_id: rootD.id,
  });
  assert.deepEqual(firstPromptOnlyReply.thread, {
    root_message_id: rootD.id,
    reply_count: 0,
    unread_count: 0,
    has_unread: false,
    latest_reply: null,
    participants: [{
      sender: "Human",
      source: "browser",
      message_count: 1,
      latest_message_id: rootD.id,
    }],
    participant_count: 1,
    participants_truncated: false,
    last_read_message_id: null,
  });
  const fetchedPromptOnlyReply = await getMessageById!(room.id, firstPromptOnlyReply.id, {
    include_prompt_only: true,
    account_id: reader,
  });
  assert.deepEqual(fetchedPromptOnlyReply?.thread, firstPromptOnlyReply.thread);

  const topLevelPrompt = await addMessage!(room.id, "Different prompt agent", "", {
    source: "agent", agent_prompt_kind: "auto",
  });
  assert.equal(topLevelPrompt.thread, null, "top-level prompt rows must not synthesize a thread");
  const page = await getMessageThreads!(room.id, { account_id: reader });
  assert.deepEqual(page.threads.map((t) => t.root.id), [rootC.id]);
});

test("PG thread projection: visible child cannot expose a prompt-only root", runOptions, async () => {
  const room = await createProjectWithName!("parity_prompt_root");
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, sender, text, agent_prompt_kind, routing_snapshot_version, timestamp
     ) VALUES ($1, 1, 'Prompt root', '', 'auto', 1, NOW())`,
    [room.id],
  );
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, routing_snapshot_version, timestamp
     ) VALUES ($1, 2, 1, 1, 'Visible child', 'must remain hidden', 1, NOW())`,
    [room.id],
  );
  const projection = await pool!.query<{ summaries: number; visible_participants: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM message_thread_summaries WHERE room_id = $1) AS summaries,
       (SELECT COUNT(*)::int FROM message_thread_participants
         WHERE room_id = $1 AND message_count > 0) AS visible_participants`,
    [room.id],
  );
  assert.deepEqual(projection.rows[0], { summaries: 0, visible_participants: 0 });
  assert.deepEqual((await getMessageThreads!(room.id)).threads, []);
});

test("PG thread inbox: participant aggregation (dedup, counts, latest-first)", runOptions, async () => {
  const room = await createProjectWithName!("parity_participants");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  const participants = thread?.summary.participants ?? [];
  assert.deepEqual(
    participants.map((p) => ({ sender: p.sender, source: p.source, count: p.message_count })),
    [
      { sender: "Agent", source: "agent", count: 2 },
      { sender: "Human", source: "browser", count: 1 },
    ],
  );
  assert.equal(participants[0]?.latest_message_id, s.replyA2.id);
  assert.equal(participants[1]?.latest_message_id, s.rootA.id);
});

test("PG thread inbox: high-cardinality participants are explicitly capped newest-first", runOptions, async () => {
  const room = await createProjectWithName!("parity_participant_cap");
  const root = await addMessage!(room.id, "Root sender", "root", { source: "browser" });
  let previous = root;
  for (let index = 0; index < 75; index += 1) {
    previous = await addMessage!(room.id, `Agent ${index}`, `reply ${index}`, {
      source: `agent-${index}`,
      reply_to_message_id: previous.id,
      thread_root_message_id: root.id,
    });
  }

  const thread = await getMessageThread!(room.id, root.id);
  assert.equal(thread?.summary.participant_count, 76);
  assert.equal(thread?.summary.participants.length, 50);
  assert.equal(thread?.summary.participants_truncated, true);
  assert.equal(thread?.summary.participants[0]?.sender, "Agent 74");
  assert.equal(thread?.summary.participants.at(-1)?.sender, "Agent 25");
});

test("PG send-time routing resolves aliases globally before account filtering", runOptions, async () => {
  const room = await createProjectWithName!("parity_global_receipt_aliases");
  const aliceAccount = await newReader();
  const bobAccount = await newReader();
  const aliceLabel = "Oak | Alice | Codex";
  const bobLabel = "Oak | Bob | Cursor";
  const root = await addMessage!(room.id, aliceLabel, "root", { source: "agent" });
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES
       ('global_oak_alice', $1, 'global_oak_alice_hash', 'worker', 'test', $2,
        'test/alice-oak', 'global-oak-alice', 'Oak', $4,
        'Alice', 'Codex', NOW(), NOW(), NOW()),
       ('global_oak_bob', $1, 'global_oak_bob_hash', 'worker', 'test', $3,
        'test/bob-oak', 'global-oak-bob', 'Oak', $5,
        'Bob', 'Cursor', NOW(), NOW(), NOW())`,
    [room.id, aliceLabel, bobLabel, aliceAccount, bobAccount],
  );

  const quoted = await addMessage!(room.id, "Human", "replying", {
    source: "browser",
    reply_to_message_id: root.id,
  });
  const quotedReceipts = await pool!.query<{ agent_key: string; activation_reason: string }>(
    `SELECT agent_key, activation_reason FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2 ORDER BY agent_key`,
    [room.id, Number(quoted.id.slice(4))],
  );
  assert.deepEqual(quotedReceipts.rows, [
    { agent_key: "test/alice-oak", activation_reason: "reply_target" },
  ], "the unique full reply label wins before the ambiguous Oak segment");

  const ambiguousMention = await addMessage!(room.id, "Human", "@Oak please inspect", {
    source: "browser",
  });
  const ambiguousCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(ambiguousMention.id.slice(4))],
  );
  assert.equal(ambiguousCount.rows[0]?.count, 0, "same alias across accounts fails closed globally");

  const exactMention = await addMessage!(room.id, "Human", "@test/alice-oak please inspect", {
    source: "browser",
    account_id: aliceAccount,
  });
  const aliceOverlay = await getMessageById!(room.id, exactMention.id, {
    account_id: aliceAccount,
    account_agent_routing: true,
  });
  const bobOverlay = await getMessageById!(room.id, exactMention.id, {
    account_id: bobAccount,
    account_agent_routing: true,
  });
  assert.deepEqual(aliceOverlay?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["test/alice-oak"],
    recipient_agent_sessions: [{
      agent_key: "test/alice-oak",
      agent_session_id: "global_oak_alice",
    }],
    control_authorized: true,
  });
  assert.deepEqual(bobOverlay?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: [],
    recipient_agent_sessions: [],
    control_authorized: false,
  });

  const workerStop = await addMessage!(room.id, aliceLabel, "/stop-codex-room", {
    source: "agent",
    publisher_agent_key: "test/alice-oak",
    publisher_agent_session_id: "global_oak_alice",
    account_id: aliceAccount,
  });
  const workerStopOverlay = await getMessageById!(room.id, workerStop.id, {
    account_id: aliceAccount,
    account_agent_routing: true,
  });
  assert.equal(
    workerStopOverlay?.account_agent_routing?.control_authorized,
    false,
    "an account-owned worker publication is not human stop-control authority",
  );

  const legacyNumber = Number(workerStop.id.slice(4)) + 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, $3, $4, 'Human', 'legacy continuation', 'browser', NULL, NOW())`,
    [room.id, legacyNumber, Number(quoted.id.slice(4)), Number(root.id.slice(4))],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2)
      WHERE name = 'messages:' || $1`,
    [room.id, legacyNumber],
  );
  const legacyAlice = await getMessageById!(room.id, `msg_${legacyNumber}`, {
    account_id: aliceAccount,
    account_agent_routing: true,
  });
  const legacyBob = await getMessageById!(room.id, `msg_${legacyNumber}`, {
    account_id: bobAccount,
    account_agent_routing: true,
  });
  assert.deepEqual(legacyAlice?.account_agent_routing, {
    version: 1,
    authority: "legacy",
    recipient_agent_keys: ["test/alice-oak"],
    recipient_agent_sessions: [{
      agent_key: "test/alice-oak",
      agent_session_id: "global_oak_alice",
      activation_reason: "thread_participant",
    }],
    control_authorized: false,
  });
  assert.deepEqual(legacyBob?.account_agent_routing, {
    version: 1,
    authority: "legacy",
    recipient_agent_keys: [],
    recipient_agent_sessions: [],
    control_authorized: false,
  }, "legacy routing resolves the unique full label globally before the shared Oak segment");

  const aliceIdentity = {
    actor_label: aliceLabel,
    agent_key: "test/alice-oak",
    agent_instance_id: "global-oak-alice",
    agent_session_id: "global_oak_alice",
    display_name: "Oak",
    session_kind: "worker",
  };
  const bobIdentity = {
    actor_label: bobLabel,
    agent_key: "test/bob-oak",
    agent_instance_id: "global-oak-bob",
    agent_session_id: "global_oak_bob",
    display_name: "Oak",
    session_kind: "worker",
  };
  const legacyMessage = await getMessageById!(room.id, `msg_${legacyNumber}`);
  const [legacyAliceActivation, legacyBobActivation] = await Promise.all([
    attachReceiptAuthorityActivations!(room.id, aliceIdentity, [legacyMessage!]),
    attachReceiptAuthorityActivations!(room.id, bobIdentity, [legacyMessage!]),
  ]);
  assert.equal((legacyAliceActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "the unique full historical label wins for the matching worker");
  assert.notEqual((legacyBobActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "the globally ambiguous Oak segment cannot re-promote the other account");

  const ambiguousLegacyNumber = legacyNumber + 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, sender, text, source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, 'Human', '@Oak inspect', 'browser', NULL, NOW())`,
    [room.id, ambiguousLegacyNumber],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2)
      WHERE name = 'messages:' || $1`,
    [room.id, ambiguousLegacyNumber],
  );
  const ambiguousLegacy = await getMessageById!(room.id, `msg_${ambiguousLegacyNumber}`);
  const [ambiguousAlice, ambiguousBob] = await Promise.all([
    attachReceiptAuthorityActivations!(room.id, aliceIdentity, [ambiguousLegacy!]),
    attachReceiptAuthorityActivations!(room.id, bobIdentity, [ambiguousLegacy!]),
  ]);
  for (const activation of [ambiguousAlice[0], ambiguousBob[0]]) {
    assert.notEqual((activation as { activation?: { for_current_agent?: { decision?: string } } })
      .activation?.for_current_agent?.decision, "activate",
    "separate worker reads must share one global ambiguity authority");
  }
});

test("PG legacy routing keeps multi-owner aliases in the global ambiguity set", runOptions, async () => {
  const room = await createProjectWithName!("parity_legacy_multi_owner_ambiguity");
  const ownerA = await newReader();
  const ownerB = await newReader();
  const validOwner = await newReader();
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES
       ('legacy_pine_shared_a', $1, 'legacy_pine_shared_a_hash', 'worker', 'test', 'SharedPineA',
        'test/shared-pine', 'legacy-pine-a', 'Pine', $2, 'A', 'Codex', NOW(), NOW(), NOW()),
       ('legacy_pine_shared_b', $1, 'legacy_pine_shared_b_hash', 'worker', 'test', 'SharedPineB',
        'test/shared-pine', 'legacy-pine-b', 'Pine', $3, 'B', 'Cursor', NOW(), NOW(), NOW()),
       ('legacy_pine_valid', $1, 'legacy_pine_valid_hash', 'worker', 'test', 'ValidPine',
        'test/valid-pine', 'legacy-pine-valid', 'Pine', $4, 'C', 'Codex', NOW(), NOW(), NOW())`,
    [room.id, ownerA, ownerB, validOwner],
  );
  const mentionNumber = 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, sender, text, source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, 'Human', '@Pine inspect', 'browser', NULL, NOW())`,
    [room.id, mentionNumber],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2) WHERE name = 'messages:' || $1`,
    [room.id, mentionNumber],
  );
  const message = await getMessageById!(room.id, `msg_${mentionNumber}`);
  const validIdentity = {
    actor_label: "ValidPine",
    agent_key: "test/valid-pine",
    agent_instance_id: "legacy-pine-valid",
    agent_session_id: "legacy_pine_valid",
    display_name: "Pine",
    session_kind: "worker",
  };
  const [activation] = await attachReceiptAuthorityActivations!(room.id, validIdentity, [message!]);
  assert.notEqual((activation as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "excluding an invalid multi-owner key must not manufacture a unique alias");
  const overlay = await getMessageById!(room.id, `msg_${mentionNumber}`, {
    account_id: validOwner,
    account_agent_routing: true,
  });
  assert.deepEqual(overlay?.account_agent_routing, {
    version: 1,
    authority: "legacy",
    recipient_agent_keys: [],
    recipient_agent_sessions: [],
    control_authorized: false,
  });
});

test("PG quote routing prefers durable publisher authority and never promotes a browser alias", runOptions, async () => {
  const room = await createProjectWithName!("parity_exact_quote_publisher");
  const owner = await newReader();
  const otherOwner = await newReader();
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES
       ('quote_old', $1, 'quote_old_hash', 'worker', 'test', 'Old Oak | Owner | Codex',
        'test/quote-oak', 'quote-old', 'Oak', $2,
        'Owner', 'Codex', NOW() - INTERVAL '1 minute', NOW(), NOW()),
       ('quote_exact', $1, 'quote_exact_hash', 'worker', 'test', 'New Oak | Owner | Cursor',
        'test/quote-oak', 'quote-exact', 'Oak', $2,
        'Owner', 'Cursor', NOW(), NOW(), NOW()),
       ('quote_other', $1, 'quote_other_hash', 'worker', 'test', 'Oak | Other | Codex',
        'test/quote-other', 'quote-other', 'Oak', $3,
        'Other', 'Codex', NOW(), NOW(), NOW())`,
    [room.id, owner, otherOwner],
  );

  const agentMessage = await addMessage!(room.id, "Oak", "agent-authored", {
    source: "agent",
    publisher_agent_key: "test/quote-oak",
    publisher_agent_session_id: "quote_exact",
    account_id: owner,
  });
  const exactQuote = await addMessage!(room.id, "Human", "following up", {
    source: "browser",
    reply_to_message_id: agentMessage.id,
  });
  const exactReceipts = await pool!.query<{
    agent_key: string;
    agent_session_id: string;
    activation_reason: string;
  }>(
    `SELECT agent_key, agent_session_id, activation_reason
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(exactQuote.id.slice(4))],
  );
  assert.deepEqual(exactReceipts.rows, [{
    agent_key: "test/quote-oak",
    agent_session_id: "quote_exact",
    activation_reason: "reply_target",
  }], "the quoted authenticated session wins over identical labels and rotation overlap");

  const humanMessage = await addMessage!(room.id, "Oak", "@everyone human-authored", {
    source: "browser",
  });
  const browserBroadcastReceipts = await pool!.query<{ agent_key: string }>(
    `SELECT agent_key
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2
      ORDER BY agent_key`,
    [room.id, Number(humanMessage.id.slice(4))],
  );
  assert.deepEqual(browserBroadcastReceipts.rows, [
    { agent_key: "test/quote-oak" },
    { agent_key: "test/quote-other" },
  ], "a browser sender named Oak cannot self-suppress either worker key");
  const humanQuote = await addMessage!(room.id, "Human", "following up again", {
    source: "browser",
    reply_to_message_id: humanMessage.id,
    thread_root_message_id: humanMessage.id,
  });
  const humanReceiptCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(humanQuote.id.slice(4))],
  );
  assert.equal(humanReceiptCount.rows[0]?.count, 0,
    "a browser sender equal to an agent label is not a reply authority");
});

test("PG send-time routing unions rotation aliases before choosing one durable receipt", runOptions, async () => {
  const room = await createProjectWithName!("parity_rotation_alias_union");
  const owner = await newReader();
  const conflictingOwner = await newReader();
  const oldAlias = "RotatedOld | Owner | Codex";
  const newAlias = "RotatedNew | Owner | Codex";
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES
       ('rotation_old', $1, 'rotation_old_hash', 'worker', 'test', $2,
        'test/rotated', 'rotation-old', 'RotatedOld', $4,
        'Owner', 'Codex', NOW() - INTERVAL '1 minute', NOW(), NOW()),
       ('rotation_new', $1, 'rotation_new_hash', 'worker', 'test', $3,
        'test/rotated', 'rotation-new', 'RotatedNew', $4,
        'Owner', 'Codex', NOW(), NOW(), NOW()),
       ('conflict_old', $1, 'conflict_old_hash', 'worker', 'test', 'ConflictOld',
        'test/conflicted', 'conflict-old', 'ConflictOld', $4,
        'Owner', 'Codex', NOW() - INTERVAL '1 minute', NOW(), NOW()),
       ('conflict_new', $1, 'conflict_new_hash', 'worker', 'test', 'ConflictNew',
        'test/conflicted', 'conflict-new', 'ConflictNew', $5,
        'Other', 'Cursor', NOW(), NOW(), NOW())`,
    [room.id, oldAlias, newAlias, owner, conflictingOwner],
  );

  const assertSingleRotatedReceipt = async (messageId: string, reason: string) => {
    const receipts = await pool!.query<{ agent_key: string; agent_session_id: string; activation_reason: string }>(
      `SELECT agent_key, agent_session_id, activation_reason
         FROM message_agent_receipts
        WHERE message_room_id = $1 AND message_number = $2`,
      [room.id, Number(messageId.slice(4))],
    );
    assert.deepEqual(receipts.rows, [{
      agent_key: "test/rotated",
      agent_session_id: "rotation_old",
      activation_reason: reason,
    }]);
  };

  const explicit = await addMessage!(room.id, "Human", "@RotatedNew please inspect", { source: "browser" });
  await assertSingleRotatedReceipt(explicit.id, "explicit_mention");
  const rotationOverlay = await getMessageById!(room.id, explicit.id, {
    account_id: owner,
    account_agent_routing: true,
  });
  assert.deepEqual(rotationOverlay?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["test/rotated"],
    recipient_agent_sessions: [{
      agent_key: "test/rotated",
      agent_session_id: "rotation_old",
    }],
    control_authorized: false,
  });

  const root = await addMessage!(room.id, newAlias, "agent root", { source: "agent" });
  const quoted = await addMessage!(room.id, "Human", "replying", {
    source: "browser",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  await assertSingleRotatedReceipt(quoted.id, "reply_target");

  const prompt = await addMessage!(room.id, newAlias, "", {
    source: "agent",
    agent_prompt_kind: "auto",
    reply_to_message_id: quoted.id,
    thread_root_message_id: root.id,
  });
  const continuation = await addMessage!(room.id, "Human", "continuing", {
    source: "browser",
    reply_to_message_id: quoted.id,
    thread_root_message_id: root.id,
  });
  await assertSingleRotatedReceipt(continuation.id, "thread_participant");

  const continuationSnapshot = await getMessageById!(room.id, continuation.id);
  const rotationIdentity = (session: "rotation_old" | "rotation_new", displayName: string) => ({
    actor_label: session === "rotation_old" ? oldAlias : newAlias,
    agent_key: "test/rotated",
    agent_instance_id: session === "rotation_old" ? "rotation-old" : "rotation-new",
    agent_session_id: session,
    display_name: displayName,
    session_kind: "worker",
  });
  const [oldActivation, overlappingNewActivation] = await Promise.all([
    attachReceiptAuthorityActivations!(room.id, rotationIdentity("rotation_old", "RotatedOld"), [continuationSnapshot!]),
    attachReceiptAuthorityActivations!(room.id, rotationIdentity("rotation_new", "RotatedNew"), [continuationSnapshot!]),
  ]);
  assert.equal((oldActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.equal((overlappingNewActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "silent");
  const legacyRotationNumber = Number(continuation.id.slice(4)) + 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, $3, $4, 'Human', 'legacy overlap continuation', 'browser', NULL, NOW())`,
    [room.id, legacyRotationNumber, Number(continuation.id.slice(4)), Number(root.id.slice(4))],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2)
      WHERE name = 'messages:' || $1`,
    [room.id, legacyRotationNumber],
  );
  const legacyRotation = await getMessageById!(room.id, `msg_${legacyRotationNumber}`);
  const [oldLegacyActivation, newLegacyActivation] = await Promise.all([
    attachReceiptAuthorityActivations!(room.id, rotationIdentity("rotation_old", "RotatedOld"), [legacyRotation!]),
    attachReceiptAuthorityActivations!(room.id, rotationIdentity("rotation_new", "RotatedNew"), [legacyRotation!]),
  ]);
  assert.equal((oldLegacyActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((newLegacyActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "same-key legacy rotation overlap has one deterministic recipient");
  const legacyBroadcastNumber = legacyRotationNumber + 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, sender, text, source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, 'Human', '@everyone continue', 'browser', NULL, NOW())`,
    [room.id, legacyBroadcastNumber],
  );
  const legacyBroadcast = await getMessageById!(room.id, `msg_${legacyBroadcastNumber}`);
  const [oldBroadcastActivation, newBroadcastActivation] = await Promise.all([
    attachReceiptAuthorityActivations!(room.id, rotationIdentity("rotation_old", "RotatedOld"), [legacyBroadcast!]),
    attachReceiptAuthorityActivations!(room.id, rotationIdentity("rotation_new", "RotatedNew"), [legacyBroadcast!]),
  ]);
  assert.equal((oldBroadcastActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  assert.notEqual((newBroadcastActivation[0] as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate",
  "broadcasts must obey the same exact representative authority as thread membership");
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2)
      WHERE name = 'messages:' || $1`,
    [room.id, legacyBroadcastNumber],
  );
  await pool!.query("UPDATE room_agent_sessions SET ended_at = NOW() WHERE session_id = 'rotation_old'");
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'rotation_foreign', $1, 'rotation_foreign_hash', 'worker', 'test', 'ForeignRotated',
       'test/rotated', 'rotation-foreign', 'ForeignRotated', $2,
       'Other', 'Cursor', NOW(), NOW(), NOW()
     )`,
    [room.id, conflictingOwner],
  );
  const [ambiguousSuccessorActivation] = await attachReceiptAuthorityActivations!(
    room.id,
    rotationIdentity("rotation_new", "RotatedNew"),
    [continuationSnapshot!],
  );
  assert.equal((ambiguousSuccessorActivation as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "silent");
  const ambiguousSuccessorOverlay = await getMessageById!(room.id, continuation.id, {
    account_id: owner,
    account_agent_routing: true,
  });
  assert.deepEqual(ambiguousSuccessorOverlay?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["test/rotated"],
    recipient_agent_sessions: [{
      agent_key: "test/rotated",
      agent_session_id: "rotation_old",
    }],
    control_authorized: false,
  }, "an ended capture with ambiguous live successors has no inferred desktop target");
  await pool!.query("UPDATE room_agent_sessions SET ended_at = NOW() WHERE session_id = 'rotation_foreign'");
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at, ended_at
     )
     SELECT 'rotation_history_' || value, $1, 'rotation_history_hash_' || value,
            'worker', 'test', 'Historical rotation ' || value,
            'test/rotated', 'rotation-history-' || value, 'Historical rotation ' || value, $2,
            'Owner', 'Codex', NOW() - INTERVAL '1 day', NOW(), NOW(), NOW()
       FROM generate_series(1, 2000) AS value`,
    [room.id, owner],
  );
  const boundedSuccessorPlan = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     WITH selected_session AS (
       SELECT session.session_id, session.owner_account_id, session.ended_at
         FROM room_agent_sessions AS session
         JOIN (VALUES ('rotation_old'), ('rotation_new')) AS requested(session_id)
           ON requested.session_id = session.session_id
        WHERE session.room_id = $1
          AND session.agent_key = 'test/rotated'
          AND session.session_kind = 'worker'
     ), live_summary AS (
       SELECT COUNT(*)::int AS live_count,
              CASE WHEN COUNT(*) = 1 THEN MIN(session.session_id) ELSE NULL END AS sole_live_session_id
         FROM room_agent_sessions AS session
        WHERE session.room_id = $1
          AND session.agent_key = 'test/rotated'
          AND session.session_kind = 'worker'
          AND session.ended_at IS NULL
     )
     SELECT * FROM selected_session CROSS JOIN live_summary`,
    [room.id],
  );
  const successorSessionNodes = flattenExplainPlan(
    boundedSuccessorPlan.rows[0]!["QUERY PLAN"][0]!.Plan,
  ).filter((node) => node["Relation Name"] === "room_agent_sessions");
  assert.ok(successorSessionNodes.length > 0);
  assert.equal(
    successorSessionNodes.some((node) => node["Node Type"] === "Seq Scan"),
    false,
    "successor authority must not scan historical rotations",
  );
  const [successorActivation] = await attachReceiptAuthorityActivations!(
    room.id,
    rotationIdentity("rotation_new", "RotatedNew"),
    [continuationSnapshot!],
  );
  assert.equal((successorActivation as { activation?: { for_current_agent?: { decision?: string } } })
    .activation?.for_current_agent?.decision, "activate");
  const successorOverlay = await getMessageById!(room.id, continuation.id, {
    account_id: owner,
    account_agent_routing: true,
  });
  assert.deepEqual(successorOverlay?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["test/rotated"],
    recipient_agent_sessions: [{
      agent_key: "test/rotated",
      agent_session_id: "rotation_old",
      successor_agent_session_id: "rotation_new",
    }],
    control_authorized: false,
  }, "the server names the exact same-owner successor only after the capture ends");

  const conflicted = await addMessage!(room.id, "Human", "@ConflictNew inspect", { source: "browser" });
  const conflictCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(conflicted.id.slice(4))],
  );
  assert.equal(conflictCount.rows[0]?.count, 0, "a durable key with multiple owners fails closed");
});

test("PG send-time task-owner routing ignores expired leases and preserves the exact holder", runOptions, async () => {
  const room = await createProjectWithName!("parity_task_owner_lease_authority");
  const owner = await newReader();
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES
       ('task_owner_old', $1, 'task_owner_old_hash', 'worker', 'test', 'Old task worker',
        'owner/task-worker', 'task-owner-old', 'Old task worker', $2,
        'Owner', 'Codex', NOW() - INTERVAL '1 minute', NOW(), NOW()),
       ('task_owner_new', $1, 'task_owner_new_hash', 'worker', 'test', 'New task worker',
        'owner/task-worker', 'task-owner-new', 'New task worker', $2,
        'Owner', 'Cursor', NOW(), NOW(), NOW())`,
    [room.id, owner],
  );
  await pool!.query(
    `INSERT INTO task_leases (
       id, room_id, task_id, kind, status, agent_key, agent_instance_id,
       agent_session_id, actor_label, expires_at, created_by, created_at, updated_at
     ) VALUES (
       'lease_expired_task_owner', $1, 'task_expired_owner', 'work', 'active',
       'owner/task-worker', 'task-owner-new', 'task_owner_new', 'New task worker',
       NOW() - INTERVAL '1 hour', $2, NOW(), NOW()
     )`,
    [room.id, owner],
  );

  const expiredFollowUp = await addMessage!(room.id, "Human", "continue", { source: "browser" });
  const expiredReceipts = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(expiredFollowUp.id.slice(4))],
  );
  assert.equal(expiredReceipts.rows[0]?.count, 0, "an unswept expired lease has no routing authority");

  await pool!.query(
    `UPDATE task_leases SET expires_at = NOW() + INTERVAL '1 hour', updated_at = NOW()
      WHERE id = 'lease_expired_task_owner'`,
  );
  const activeFollowUp = await addMessage!(room.id, "Human", "continue", { source: "browser" });
  const activeReceipt = await pool!.query<{
    agent_key: string;
    agent_session_id: string;
    activation_reason: string;
  }>(
    `SELECT agent_key, agent_session_id, activation_reason FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(activeFollowUp.id.slice(4))],
  );
  assert.deepEqual(activeReceipt.rows, [{
    agent_key: "owner/task-worker",
    agent_session_id: "task_owner_new",
    activation_reason: "task_owner",
  }], "an exact lease session outranks the older durable-key representative");
});

test("PG send-time routing persists a 6,000-recipient broadcast in bounded chunks", runOptions, async () => {
  const room = await createProjectWithName!("parity_large_broadcast_receipts");
  const owner = await newReader();
  const unrelatedOwner = await newReader();
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     )
     SELECT 'broadcast_6000_' || value, $1, 'broadcast_hash_' || value,
            'worker', 'test', 'Broadcast agent ' || value,
            'test/broadcast-agent-' || value, 'broadcast-instance-' || value,
            'Broadcast agent ' || value, $2, 'Owner', 'Codex', NOW(), NOW(), NOW()
       FROM generate_series(1, 6000) AS value`,
    [room.id, owner],
  );
  const broadcast = await addMessage!(room.id, "Human", "@everyone status", {
    source: "browser",
    account_id: owner,
  });
  const receiptCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(broadcast.id.slice(4))],
  );
  assert.equal(receiptCount.rows[0]?.count, 6_000);
  const overlayStartedAt = performance.now();
  const broadcastOverlay = await getMessageById!(room.id, broadcast.id, {
    account_id: owner,
    account_agent_routing: true,
  });
  const overlayMs = performance.now() - overlayStartedAt;
  assert.equal(broadcastOverlay?.account_agent_routing?.authority, "receipts");
  if (broadcastOverlay?.account_agent_routing?.authority === "receipts") {
    assert.equal(broadcastOverlay.account_agent_routing.recipient_agent_keys.length, 6_000);
    assert.equal(broadcastOverlay.account_agent_routing.recipient_agent_sessions?.length, 6_000);
  }
  assert.ok(overlayMs < 2_000, `6,000-recipient overlay took ${overlayMs.toFixed(1)}ms`);
  const batchedOverlays = await getMessageAccountAgentRoutings!(
    db!,
    room.id,
    [owner, unrelatedOwner],
    [{
      number: Number(broadcast.id.slice(4)),
      thread_root_number: null,
      routing_snapshot_version: 1,
      publisher_account_id: owner,
      publisher_agent_key: null,
      reply_to_number: null,
      sender: "Human",
      source: "browser",
      text: "@everyone status",
    }],
  );
  assert.equal(
    batchedOverlays.get(owner)?.get(Number(broadcast.id.slice(4)))?.recipient_agent_keys.length,
    6_000,
  );
  assert.deepEqual(
    batchedOverlays.get(unrelatedOwner)?.get(Number(broadcast.id.slice(4))),
    {
      version: 1,
      authority: "receipts",
      recipient_agent_keys: [],
      recipient_agent_sessions: [],
      control_authorized: false,
    },
    "the broker batch slices one receipt query without leaking another account's workers",
  );

  const supportedFanoutMessages = [broadcast];
  for (let index = 2; index <= 5; index += 1) {
    supportedFanoutMessages.push(await addMessage!(room.id, "Human", `@everyone status ${index}`, {
      source: "browser",
      account_id: owner,
    }));
  }
  const fanoutHistory = await getMessages!(room.id, {
    limit: 200,
    account_id: owner,
    account_agent_routing: true,
  });
  for (const message of supportedFanoutMessages) {
    const hydrated = fanoutHistory.messages.find((candidate) => candidate.id === message.id);
    assert.equal(hydrated?.account_agent_routing?.authority, "receipts");
    assert.equal(
      hydrated?.account_agent_routing?.recipient_agent_keys.length,
      6_000,
      "a history page can represent several individually supported large fanouts",
    );
  }

  const root = await addMessage!(room.id, "Broadcast agent 1", "thread root", { source: "agent" });
  const continuationStartedAt = performance.now();
  const continuation = await addMessage!(room.id, "Human", "continue", {
    source: "browser",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const continuationMs = performance.now() - continuationStartedAt;
  const continuationReceipts = await pool!.query<{ agent_key: string }>(
    `SELECT agent_key FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(continuation.id.slice(4))],
  );
  assert.deepEqual(continuationReceipts.rows, [{ agent_key: "test/broadcast-agent-1" }]);
  assert.ok(continuationMs < 750, `6,000-worker thread reply took ${continuationMs.toFixed(1)}ms`);
  let membershipQueries = 0;
  const countedMembershipExecutor = {
    execute: ((query: Parameters<typeof db.execute>[0]) => {
      membershipQueries += 1;
      return db!.execute(query);
    }) as typeof db.execute,
  };
  const globalMembers = await getGlobalMessageThreadRoutingMembers!(
    countedMembershipExecutor,
    room.id,
    [Number(root.id.slice(4))],
  );
  assert.equal(membershipQueries, 1, "6,000 workers resolve one thread root in one set-based statement");
  assert.deepEqual(
    globalMembers.get(Number(root.id.slice(4)))?.map((member) => member.agent_key),
    ["test/broadcast-agent-1"],
  );
});

test("PG legacy desktop routing resolves 500 roots against 1,004 workers in constant indexed queries", runOptions, async () => {
  assert.ok(getMessageAccountAgentRouting);
  const room = await createProjectWithName!("parity_large_legacy_desktop_routing");
  const owner = await newReader();

  // Bulk SQL keeps this a query-shape regression instead of spending the test
  // budget in the public create route. The ordinary projection trigger still
  // materializes each visible reply exactly as it does for live writes.
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, sender, text, source, routing_snapshot_version, timestamp
     )
     SELECT $1, value * 2 - 1, 'Legacy agent ' || value,
            'root ' || value, 'agent', NULL, NOW()
       FROM generate_series(1, 500) AS value`,
    [room.id],
  );
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, source, routing_snapshot_version, timestamp
     )
     SELECT $1, value * 2, value * 2 - 1, value * 2 - 1,
            'Human', 'legacy reply ' || value, 'browser', NULL, NOW()
       FROM generate_series(1, 500) AS value`,
    [room.id],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, 1000)
      WHERE name = 'messages:' || $1`,
    [room.id],
  );
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     )
     SELECT 'legacy_scale_' || value, $1, 'legacy_scale_hash_' || value,
            'worker', 'test', 'Legacy agent ' || value,
            'test/legacy-agent-' || value, 'legacy-scale-instance-' || value,
            'Legacy agent ' || value, $2, 'Owner', 'Codex', NOW(), NOW(), NOW()
       FROM generate_series(1, 1004) AS value`,
    [room.id, owner],
  );

  const messageRows = Array.from({ length: 500 }, (_, index) => ({
    number: (index + 1) * 2,
    thread_root_number: (index + 1) * 2 - 1,
    routing_snapshot_version: null,
    publisher_account_id: null,
  }));
  let executeCount = 0;
  const countedExecutor = {
    execute: ((query: Parameters<typeof db.execute>[0]) => {
      executeCount += 1;
      return db!.execute(query);
    }) as typeof db.execute,
    select: db!.select.bind(db),
  } as Parameters<NonNullable<typeof getMessageAccountAgentRouting>>[0];
  const startedAt = performance.now();
  const overlays = await getMessageAccountAgentRouting(
    countedExecutor,
    room.id,
    owner,
    messageRows,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.ok(executeCount <= 6, "legacy dispatch must use fixed-size bounded root batches");
  assert.ok(elapsedMs < 5_000, `legacy overlay exceeded its 5s budget (${elapsedMs.toFixed(0)}ms)`);
  assert.equal(overlays.size, 500);
  for (let value = 1; value <= 500; value += 1) {
    assert.deepEqual(overlays.get(value * 2), {
      version: 1,
      authority: "legacy",
      recipient_agent_keys: [`test/legacy-agent-${value}`],
      recipient_agent_sessions: [{
        agent_key: `test/legacy-agent-${value}`,
        agent_session_id: `legacy_scale_${value}`,
        activation_reason: "thread_participant",
      }],
      control_authorized: false,
    });
  }

  const aliasPlan = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     WITH active_alias AS (
       SELECT normalize_message_thread_routing_alias('Legacy agent ' || value, false) AS alias_text
         FROM generate_series(1, 1004) AS value
     )
     SELECT matched.thread_root_number
       FROM active_alias
       CROSS JOIN LATERAL (
         SELECT candidate.thread_root_number
           FROM message_thread_participant_aliases AS candidate
          WHERE candidate.room_id = $1
            AND candidate.alias_hash = MD5(active_alias.alias_text)
            AND candidate.alias_text = active_alias.alias_text
            AND candidate.thread_root_number <= 999
          OFFSET 0
       ) AS matched`,
    [room.id],
  );
  const aliasNodes = flattenExplainPlan(aliasPlan.rows[0]!["QUERY PLAN"][0]!.Plan)
    .filter((node) => node["Relation Name"] === "message_thread_participant_aliases");
  assert.ok(aliasNodes.length > 0);
  assert.equal(
    aliasNodes.some((node) => String((node as Record<string, unknown>)["Node Type"]).includes("Seq Scan")),
    false,
    "the account overlay shape must drive fixed-width routing-alias index probes",
  );
});

test("PG legacy desktop routing slices unrelated accounts before its bounded member result", runOptions, async () => {
  assert.ok(getMessageAccountAgentRouting);
  const room = await createProjectWithName!("parity_cross_account_legacy_member_bound");
  const globalOwner = await newReader();
  const unrelatedOwner = await newReader();

  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     )
     SELECT 'cross_account_member_' || worker, $1, 'cross_account_hash_' || worker,
            'worker', 'test', 'Cross account agent ' || worker,
            'test/cross-account-' || worker, 'cross-account-instance-' || worker,
            'Cross account agent ' || worker, $2, 'Other owner', 'Codex', NOW(), NOW(), NOW()
       FROM generate_series(1, 201) AS worker`,
    [room.id, globalOwner],
  );
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, sender, text, source, routing_snapshot_version, timestamp
     )
     SELECT $1, root, 'Human', 'legacy root ' || root, 'browser', NULL, NOW()
       FROM generate_series(1, 500) AS root`,
    [room.id],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, 500)
      WHERE name = 'messages:' || $1`,
    [room.id],
  );
  await pool!.query(
    `INSERT INTO message_thread_participants (
       room_id, thread_root_number, participant_number, identity_hash,
       sender, source, message_count, latest_message_number, routing_message_count
     )
     SELECT $1, root, worker,
            MD5('Cross account agent ' || worker),
            'Cross account agent ' || worker, 'agent', 0, NULL, 1
       FROM generate_series(1, 500) AS root
       CROSS JOIN generate_series(1, 201) AS worker`,
    [room.id],
  );
  await pool!.query(
    `INSERT INTO message_thread_participant_aliases (
       room_id, thread_root_number, participant_number, alias_number,
       alias_hash, alias_text, is_full
     )
     SELECT $1, root, worker, 1,
            MD5(normalize_message_thread_routing_alias('Cross account agent ' || worker, false)),
            normalize_message_thread_routing_alias('Cross account agent ' || worker, false),
            true
       FROM generate_series(1, 500) AS root
       CROSS JOIN generate_series(1, 201) AS worker`,
    [room.id],
  );

  const messageRows = Array.from({ length: 500 }, (_, index) => ({
    number: index + 1,
    thread_root_number: index + 1,
    routing_snapshot_version: null,
    publisher_account_id: null,
  }));
  let executeCount = 0;
  const countedExecutor = {
    execute: ((query: Parameters<typeof db.execute>[0]) => {
      executeCount += 1;
      return db!.execute(query);
    }) as typeof db.execute,
    select: db!.select.bind(db),
  } as Parameters<NonNullable<typeof getMessageAccountAgentRouting>>[0];
  const startedAt = performance.now();
  const overlays = await getMessageAccountAgentRouting(
    countedExecutor,
    room.id,
    unrelatedOwner,
    messageRows,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.ok(executeCount <= 2, `account slicing rescanned the active population (${executeCount} queries)`);
  assert.ok(elapsedMs < 750, `cross-account legacy slicing rebuilt foreign results (${elapsedMs.toFixed(0)}ms)`);
  assert.equal(overlays.size, 500);
  for (const routing of overlays.values()) {
    assert.deepEqual(routing, {
      version: 1,
      authority: "legacy",
      recipient_agent_keys: [],
      recipient_agent_sessions: [],
      control_authorized: false,
    });
  }
});

test("PG thread routing: high-cardinality membership stays indexed beyond the display cap", runOptions, async () => {
  const room = await createProjectWithName!("parity_routing_membership");
  const ownerAccount = await newReader();
  const oldActor = "Old agent | Test owner | Codex";
  const promptActor = "Prompt agent | Test owner | Codex";
  const root = await addMessage!(room.id, oldActor, "root", { source: "agent" });
  let previous = root;
  for (let index = 0; index < 120; index += 1) {
    previous = await addMessage!(room.id, `Agent ${index}`, `reply ${index}`, {
      source: "agent",
      reply_to_message_id: previous.id,
      thread_root_message_id: root.id,
    });
  }
  await addMessage!(room.id, promptActor, "", {
    source: "agent",
    agent_prompt_kind: "auto",
    reply_to_message_id: previous.id,
    thread_root_message_id: root.id,
  });
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES
       ('routing_old', $1, 'routing_old_hash', 'worker', 'test', $2,
        'test/old-agent', 'routing-old-instance', 'Old agent', $4,
        'Test owner', 'Codex', NOW(), NOW(), NOW()),
       ('routing_prompt', $1, 'routing_prompt_hash', 'worker', 'test', $3,
        'test/prompt-agent', 'routing-prompt-instance', 'Prompt agent', $4,
        'Test owner', 'Codex', NOW(), NOW(), NOW())`,
    [room.id, oldActor, promptActor, ownerAccount],
  );
  await pool!.query(
    `WITH participant AS (
       SELECT room_id, thread_root_number, participant_number, sender
         FROM message_thread_participants
        WHERE room_id = $1 AND thread_root_number = $2
          AND sender <> 'Agent 0'
     )
     INSERT INTO message_thread_participant_agents (
       room_id, thread_root_number, participant_number, agent_number,
       agent_key_hash, agent_key, owner_account_id, message_count
     )
     SELECT participant.room_id, participant.thread_root_number,
            participant.participant_number, 1000 + value,
            MD5('historical/inactive-' || participant.participant_number || '-' || value),
            'historical/inactive-' || participant.participant_number || '-' || value,
            $3, 1
       FROM participant
       CROSS JOIN generate_series(1, 120) AS value`,
    [room.id, Number(root.id.slice(4)), ownerAccount],
  );
  await pool!.query(
    `INSERT INTO message_thread_participant_agents (
       room_id, thread_root_number, participant_number, agent_number,
       agent_key_hash, agent_key, owner_account_id, message_count
     )
     SELECT participant.room_id, participant.thread_root_number,
            participant.participant_number,
            CASE participant.sender WHEN $3 THEN 1 ELSE 2 END,
            MD5(CASE participant.sender WHEN $3 THEN 'test/old-agent' ELSE 'test/prompt-agent' END),
            CASE participant.sender WHEN $3 THEN 'test/old-agent' ELSE 'test/prompt-agent' END,
            $5, 1
       FROM message_thread_participants AS participant
      WHERE participant.room_id = $1
        AND participant.thread_root_number = $2
        AND participant.sender IN ($3, $4)`,
    [room.id, Number(root.id.slice(4)), oldActor, promptActor, ownerAccount],
  );
  await pool!.query("ANALYZE message_thread_participant_agents, room_agent_sessions");

  const exactMembershipPlan = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     WITH input_root AS MATERIALIZED (
       SELECT value.thread_root_number
         FROM (VALUES ($2::integer)) AS value(thread_root_number)
     ), input_identity AS MATERIALIZED (
       SELECT value.agent_key, value.owner_account_id
         FROM jsonb_to_recordset($3::jsonb)
           AS value(agent_key text, owner_account_id text)
     ), exact_member AS (
       SELECT DISTINCT participant.thread_root_number, participant.participant_number,
              participant.agent_key, participant.owner_account_id
         FROM input_root
         CROSS JOIN input_identity
         CROSS JOIN LATERAL (
           SELECT candidate.thread_root_number, candidate.participant_number,
                  candidate.agent_key, candidate.owner_account_id
             FROM message_thread_participant_agents AS candidate
            WHERE candidate.room_id = $1
              AND candidate.thread_root_number = input_root.thread_root_number
              AND candidate.agent_key_hash = MD5(input_identity.agent_key)
              AND candidate.agent_key = input_identity.agent_key
              AND candidate.owner_account_id = input_identity.owner_account_id
            OFFSET 0
         ) AS participant
     )
     SELECT exact_member.* FROM exact_member`,
    [
      room.id,
      Number(root.id.slice(4)),
      JSON.stringify([
        { agent_key: "test/old-agent", owner_account_id: ownerAccount },
        { agent_key: "test/prompt-agent", owner_account_id: ownerAccount },
      ]),
    ],
  );
  const exactAgentNodes = flattenExplainPlan(
    exactMembershipPlan.rows[0]!["QUERY PLAN"][0]!.Plan,
  ).filter((node) => node["Relation Name"] === "message_thread_participant_agents");
  assert.ok(exactAgentNodes.length > 0);
  assert.equal(
    exactAgentNodes.some((node) => node["Node Type"] === "Seq Scan"),
    false,
    "durable membership must probe fixed-width projection indexes rather than scan room history",
  );
  assert.equal(
    exactAgentNodes.some((node) => String(node["Index Cond"] ?? "").includes("thread_root_number")),
    true,
    "durable membership must constrain projected identities to the requested roots before matching",
  );

  const hotReply = await addMessage!(room.id, "Human", "continuing", {
    source: "browser",
    reply_to_message_id: previous.id,
    thread_root_message_id: root.id,
  });
  const receipts = await pool!.query<{ agent_key: string; activation_reason: string }>(
    `SELECT agent_key, activation_reason
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2
      ORDER BY agent_key`,
    [room.id, Number(hotReply.id.slice(4))],
  );
  assert.deepEqual(receipts.rows, [
    { agent_key: "test/old-agent", activation_reason: "thread_participant" },
    { agent_key: "test/prompt-agent", activation_reason: "thread_participant" },
  ]);
  const snapshotForOwner = await getMessageById!(room.id, hotReply.id, {
    account_id: ownerAccount,
    account_agent_routing: true,
  });
  assert.deepEqual(snapshotForOwner?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["test/old-agent", "test/prompt-agent"],
    recipient_agent_sessions: [
      { agent_key: "test/old-agent", agent_session_id: "routing_old" },
      { agent_key: "test/prompt-agent", agent_session_id: "routing_prompt" },
    ],
    control_authorized: false,
  });
  const unrelatedAccount = await newReader();
  const snapshotForOtherAccount = await getMessageById!(room.id, hotReply.id, {
    account_id: unrelatedAccount,
    account_agent_routing: true,
  });
  assert.deepEqual(snapshotForOtherAccount?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: [],
    recipient_agent_sessions: [],
    control_authorized: false,
  });
  await pool!.query(
    `UPDATE room_agent_sessions SET ended_at = NOW() WHERE session_id = 'routing_old'`,
  );
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'routing_old_rotated', $1, 'routing_old_rotated_hash', 'worker', 'test', $2,
       'test/old-agent', 'routing-old-rotated-instance', 'Old agent', $3,
       'Test owner', 'Codex', NOW(), NOW(), NOW()
     )`,
    [room.id, oldActor, ownerAccount],
  );
  const snapshotAfterRotation = await getMessageById!(room.id, hotReply.id, {
    account_id: ownerAccount,
    account_agent_routing: true,
  });
  assert.deepEqual(snapshotAfterRotation?.account_agent_routing, {
    version: 1,
    authority: "receipts",
    recipient_agent_keys: ["test/old-agent", "test/prompt-agent"],
    recipient_agent_sessions: [
      {
        agent_key: "test/old-agent",
        agent_session_id: "routing_old",
        successor_agent_session_id: "routing_old_rotated",
      },
      { agent_key: "test/prompt-agent", agent_session_id: "routing_prompt" },
    ],
    control_authorized: false,
  }, "the server explicitly names the sole same-owner successor after capture end");
  const historyForOwner = await getMessages!(room.id, {
    after: root.id,
    limit: 500,
    account_id: ownerAccount,
    account_agent_routing: true,
    include_prompt_only: true,
  });
  assert.deepEqual(
    historyForOwner.messages.find((message) => message.id === hotReply.id)?.account_agent_routing,
    snapshotAfterRotation?.account_agent_routing,
    "history/poll hydration and by-id/SSE hydration share one routing wrapper",
  );

  const membershipPlan = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT alias_text
       FROM message_thread_participant_aliases
      WHERE room_id = $1 AND thread_root_number = $2
        AND alias_hash = MD5(normalize_message_thread_routing_alias($3, false))
        AND alias_text = normalize_message_thread_routing_alias($3, false)
      LIMIT 1`,
    [room.id, Number(root.id.slice(4)), oldActor],
  );
  const aliasNode = flattenExplainPlan(membershipPlan.rows[0]!["QUERY PLAN"][0]!.Plan)
    .find((node) => node["Relation Name"] === "message_thread_participant_aliases");
  assert.match(String((aliasNode as Record<string, unknown> | undefined)?.["Node Type"]), /Index/);
  assert.ok((aliasNode?.["Actual Rows"] ?? Number.POSITIVE_INFINITY) <= 1);

  // A pre-snapshot message still uses lazy activation. Its oldest participant
  // is outside the 50-row display payload but remains routable by exact
  // identity membership.
  const legacyNumber = Number(hotReply.id.slice(4)) + 1;
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, $3, $4, 'Human', 'legacy continuation', 'browser', NULL, NOW())`,
    [room.id, legacyNumber, Number(hotReply.id.slice(4)), Number(root.id.slice(4))],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2)
      WHERE name = 'messages:' || $1`,
    [room.id, legacyNumber],
  );
  const legacy = await getMessageById!(room.id, `msg_${legacyNumber}`);
  const legacyForOwner = await getMessageById!(room.id, `msg_${legacyNumber}`, {
    account_id: ownerAccount,
    account_agent_routing: true,
  });
  assert.deepEqual(legacyForOwner?.account_agent_routing, {
    version: 1,
    authority: "legacy",
    recipient_agent_keys: ["test/old-agent", "test/prompt-agent"],
    recipient_agent_sessions: [
      {
        agent_key: "test/old-agent",
        agent_session_id: "routing_old_rotated",
        activation_reason: "thread_participant",
      },
      {
        agent_key: "test/prompt-agent",
        agent_session_id: "routing_prompt",
        activation_reason: "thread_participant",
      },
    ],
    control_authorized: false,
  });
  assert.ok(legacy?.thread?.participants_truncated);
  assert.equal(
    legacy?.thread?.participants.some((participant) => participant.sender === oldActor),
    false,
    "the oldest participant should be outside the display payload",
  );
  const [activatedLegacy] = await attachReceiptAuthorityActivations!(
    room.id,
    {
      actor_label: oldActor,
      agent_key: "test/old-agent",
      agent_instance_id: "routing-old-rotated-instance",
      agent_session_id: "routing_old_rotated",
      display_name: "Old agent",
      session_kind: "worker",
    },
    [legacy!],
    { includeTaskOwnerLeases: false },
  );
  assert.deepEqual((activatedLegacy as typeof legacy & { activation: unknown }).activation, {
    for_current_agent: {
      decision: "activate",
      reason: "thread_participant",
      addressed: true,
    },
  });

  const unicodeSender = `İpek\u00a0Agent | Test owner | Codex`;
  const unicodeIdentity = {
    actor_label: "İPEK  AGENT",
    agent_key: "test/ipek-agent",
    agent_instance_id: "routing-ipek-instance",
    agent_session_id: "routing_ipek",
    display_name: "İpek Agent",
    session_kind: "worker",
  };
  const pureDecision = decideAgentMessageActivation({
    id: "msg_unicode",
    sender: "Human",
    text: "continuing",
    source: "browser",
    thread_root_id: root.id,
    thread: {
      root_message_id: root.id,
      participants: [{ sender: unicodeSender }],
    },
  }, unicodeIdentity);
  assert.equal(pureDecision.reason, "thread_participant");

  const stableFold = await pool!.query<{
    turkish: string;
    greek_upper: string;
    greek_final: string;
    greek_normal: string;
    circled_upper: string;
    unusual_upper: string;
  }>(
    `SELECT normalize_message_thread_routing_alias('İPEK' || U&'\\00A0' || ' AGENT', false) AS turkish,
            normalize_message_thread_routing_alias('ΟΣ', false) AS greek_upper,
            normalize_message_thread_routing_alias('ος', false) AS greek_final,
            normalize_message_thread_routing_alias('οσ', false) AS greek_normal,
            normalize_message_thread_routing_alias('ⒶGENT', false) AS circled_upper,
            normalize_message_thread_routing_alias('ꟋGENT', false) AS unusual_upper`,
  );
  assert.deepEqual(stableFold.rows[0], {
    turkish: "İpek agent",
    greek_upper: "ΟΣ",
    greek_final: "ος",
    greek_normal: "οσ",
    circled_upper: "Ⓐgent",
    unusual_upper: "Ɤgent",
  }, "Postgres uses the same version-independent ASCII fold as Node and SQLite");

  const compactIdentity = {
    actor_label: "ab",
    agent_key: "test/ab",
    agent_instance_id: "routing-ab-instance",
    agent_session_id: "routing_ab",
    display_name: "ab",
    session_kind: "worker",
  };
  const pureCompactDecision = decideAgentMessageActivation({
    id: "msg_compact",
    sender: "Human",
    text: "continuing",
    source: "browser",
    thread_root_id: root.id,
    thread: {
      root_message_id: root.id,
      participants: [{ sender: "A B" }],
    },
  }, compactIdentity);
  assert.notEqual(pureCompactDecision.reason, "thread_participant");

  // The digest is only an index accelerator. Force a synthetic collision and
  // prove raw normalized alias equality remains the authorization boundary.
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'routing_collision', $1, 'routing_collision_hash', 'worker', 'test', 'Agent 0',
       'test/collision-agent', 'routing-collision-instance', 'Agent 0', $2,
       'Test owner', 'Codex', NOW(), NOW(), NOW()
     )`,
    [room.id, ownerAccount],
  );
  await pool!.query(
    `DELETE FROM message_thread_participant_aliases AS alias
      USING message_thread_participants AS participant
      WHERE alias.room_id = participant.room_id
        AND alias.thread_root_number = participant.thread_root_number
        AND alias.participant_number = participant.participant_number
        AND participant.room_id = $1 AND participant.thread_root_number = $2
        AND participant.sender = 'Agent 0'`,
    [room.id, Number(root.id.slice(4))],
  );
  await pool!.query(
    `UPDATE message_thread_participant_aliases
        SET alias_hash = MD5(normalize_message_thread_routing_alias('Agent 0', false))
      WHERE (room_id, thread_root_number, participant_number, alias_number) = (
        SELECT room_id, thread_root_number, participant_number, alias_number
          FROM message_thread_participant_aliases
         WHERE room_id = $1 AND thread_root_number = $2
         LIMIT 1
      )`,
    [room.id, Number(root.id.slice(4))],
  );
  const collision = await getGlobalMessageThreadRoutingMembers!(
    db!,
    room.id,
    [Number(root.id.slice(4))],
  );
  assert.equal(
    (collision.get(Number(root.id.slice(4))) ?? [])
      .some((member) => member.agent_key === "test/collision-agent"),
    false,
    "the live global resolver compares normalized text after its digest probe",
  );

  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     )
     SELECT 'routing_bulk_' || value, $1, 'routing_bulk_hash_' || value,
            'worker', 'test', 'Bulk agent ' || value, 'test/bulk-agent-' || value,
            'bulk-instance-' || value, 'Bulk agent ' || value, $2,
            'Test owner', 'Codex', NOW(), NOW(), NOW()
       FROM generate_series(1, 1001) AS value`,
    [room.id, ownerAccount],
  );
  const bulkSessionMessage = await addMessage!(room.id, "Human", "1001-session continuation", {
    source: "browser",
    reply_to_message_id: hotReply.id,
    thread_root_message_id: root.id,
  });
  assert.match(bulkSessionMessage.id, /^msg_\d+$/);
});

test("PG thread routing excludes browser and source-null participant aliases", runOptions, async () => {
  const room = await createProjectWithName!("parity_non_worker_participant_alias");
  const owner = await newReader();
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'non_worker_alias_oak', $1, 'non_worker_alias_oak_hash', 'worker', 'test', 'Oak',
       'owner/oak', 'non-worker-alias-oak', 'Oak', $2,
       'Owner', 'Codex', NOW(), NOW(), NOW()
     )`,
    [room.id, owner],
  );
  const root = await addMessage!(room.id, "Oak", "human root", { source: "browser" });
  await addMessage!(room.id, "Oak", "historical anonymous reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const aliasCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM message_thread_participant_aliases
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.equal(aliasCount.rows[0]?.count, 0);

  const continuation = await addMessage!(room.id, "Human", "continue", {
    source: "browser",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const receipts = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(continuation.id.slice(4))],
  );
  assert.equal(receipts.rows[0]?.count, 0, "human labels never become durable worker participation");
});

test("PG send-time durable candidates stay below the PostgreSQL bind ceiling", runOptions, async () => {
  const room = await createProjectWithName!("parity_candidate_bind_ceiling");
  const owner = await newReader();
  const root = await addMessage!(room.id, "Human", "root", { source: "browser" });
  const rootNumber = Number(root.id.slice(4));
  await pool!.query(
    `INSERT INTO message_thread_participants (
       room_id, thread_root_number, participant_number, identity_hash,
       sender, source, message_count, latest_message_number, routing_message_count
     ) VALUES ($1, $2, 100000, MD5('candidate-participant'),
               'Historical workers', 'agent', 0, NULL, 1)`,
    [room.id, rootNumber],
  );
  await pool!.query(
    `INSERT INTO message_thread_participant_agents (
       room_id, thread_root_number, participant_number, agent_number,
       agent_key_hash, agent_key, owner_account_id, message_count
     )
     SELECT $1, $2, 100000, value,
            MD5('historical/candidate-' || value),
            'historical/candidate-' || value, $3, 1
       FROM generate_series(1, 65536) AS value`,
    [room.id, rootNumber, owner],
  );
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     )
     SELECT 'candidate_active_' || value, $1, 'candidate_active_hash_' || value,
            'worker', 'test', 'Unrelated active ' || value,
            'active/unrelated-' || value, 'candidate-active-instance-' || value,
            'Unrelated active ' || value, $2, 'Owner', 'Codex', NOW(), NOW(), NOW()
       FROM generate_series(1, 1000) AS value`,
    [room.id, owner],
  );
  // The rollout explicitly analyzes the freshly materialized projection;
  // model that production planner contract after this synthetic bulk load.
  await pool!.query("ANALYZE message_thread_participant_agents");
  await pool!.query("ANALYZE room_agent_sessions");

  const continuationStartedAt = performance.now();
  const continuation = await addMessage!(room.id, "Human", "continue", {
    source: "browser",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const continuationMs = performance.now() - continuationStartedAt;
  assert.match(continuation.id, /^msg_\d+$/);
  const receiptCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(continuation.id.slice(4))],
  );
  assert.equal(receiptCount.rows[0]?.count, 0);
  assert.ok(
    continuationMs < 500,
    `inactive history was scanned instead of probing from active identities (${continuationMs.toFixed(1)}ms)`,
  );
});

test("PG thread routing preserves authenticated durable membership across a label rename", runOptions, async () => {
  const room = await createProjectWithName!("parity_durable_publisher_membership");
  const owner = await newReader();
  const foreignOwner = await newReader();
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'durable_old', $1, 'durable_old_hash', 'worker', 'test', 'Old Unshared Label',
       'test/stable-key', 'durable-old', 'OldName', $2,
       'Owner', 'Codex', NOW() - INTERVAL '1 minute', NOW(), NOW()
     )`,
    [room.id, owner],
  );
  const root = await addMessage!(room.id, "Old Unshared Label", "agent root", {
    source: "agent",
    publisher_agent_key: "test/stable-key",
    publisher_agent_session_id: "durable_old",
    account_id: owner,
  });
  await pool!.query("UPDATE room_agent_sessions SET ended_at = NOW() WHERE session_id = 'durable_old'");
  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'durable_new', $1, 'durable_new_hash', 'worker', 'test', 'New Unshared Label',
       'test/stable-key', 'durable-new', 'NewName', $2,
       'Owner', 'Cursor', NOW(), NOW(), NOW()
     )`,
    [room.id, owner],
  );

  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'durable_same_label_other', $1, 'durable_same_label_other_hash', 'worker', 'test',
       'Completely New Label', 'test/other-key', 'durable-other', 'Completely New Label', $2,
       'Foreign', 'Codex', NOW(), NOW(), NOW()
     )`,
    [room.id, foreignOwner],
  );

  const selfBroadcast = await addMessage!(room.id, "Completely New Label", "@everyone update", {
    source: "agent",
    publisher_agent_key: "test/stable-key",
    publisher_agent_session_id: "durable_new",
    account_id: owner,
  });
  const selfReceipts = await pool!.query<{ agent_key: string }>(
    `SELECT agent_key
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(selfBroadcast.id.slice(4))],
  );
  assert.deepEqual(selfReceipts.rows, [{ agent_key: "test/other-key" }],
    "exact publisher identity suppresses only its own key, not another same-label worker");

  const continuation = await addMessage!(room.id, "Human", "continue", {
    source: "browser",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const receipts = await pool!.query<{ agent_key: string; agent_session_id: string }>(
    `SELECT agent_key, agent_session_id
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(continuation.id.slice(4))],
  );
  assert.deepEqual(receipts.rows, [{ agent_key: "test/stable-key", agent_session_id: "durable_new" }]);
  const projectedIdentity = await pool!.query<{
    agent_key: string;
    owner_account_id: string;
  }>(
    `SELECT agent_key, owner_account_id
       FROM message_thread_participant_agents
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.deepEqual(projectedIdentity.rows, [{ agent_key: "test/stable-key", owner_account_id: owner }]);

  await pool!.query(
    `INSERT INTO room_agent_sessions (
       session_id, room_id, token_hash, session_kind, runtime, actor_label,
       agent_key, agent_instance_id, display_name, owner_account_id,
       owner_label, ide_label, created_at, updated_at, last_seen_at
     ) VALUES (
       'durable_foreign', $1, 'durable_foreign_hash', 'worker', 'test', 'Foreign Label',
       'test/stable-key', 'durable-foreign', 'Foreign', $2,
       'Foreign', 'Codex', NOW(), NOW(), NOW()
     )`,
    [room.id, foreignOwner],
  );
  const ambiguous = await addMessage!(room.id, "Human", "continue again", {
    source: "browser",
    reply_to_message_id: continuation.id,
    thread_root_message_id: root.id,
  });
  const ambiguousCount = await pool!.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM message_agent_receipts
      WHERE message_room_id = $1 AND message_number = $2`,
    [room.id, Number(ambiguous.id.slice(4))],
  );
  assert.equal(ambiguousCount.rows[0]?.count, 0, "a durable key with multiple owners stays fail-closed");
});

test("PG agent identities enforce the desktop routing key equivalence contract", runOptions, async () => {
  const owner = await newReader();
  const otherOwner = await newReader();
  const created = await registerAgentIdentity!({
    owner_account_id: owner,
    owner_login: "CaseOwner",
    owner_label: "Case Owner",
    name: "OakWorker",
    display_name: "Oak",
  });
  const reused = await registerAgentIdentity!({
    owner_account_id: owner,
    owner_login: "caseowner",
    owner_label: "Case Owner",
    name: "oakworker",
    display_name: "Oak renamed",
  });
  assert.equal(reused.id, created.id);
  assert.equal(reused.canonical_key, created.canonical_key);
  await assert.rejects(
    registerAgentIdentity!({
      owner_account_id: otherOwner,
      owner_login: "caseowner",
      owner_label: "Other Owner",
      name: "oakworker",
      display_name: "Collision",
    }),
    /conflicts with an existing owner identity/,
  );
  const count = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM agents
      WHERE normalize_message_thread_routing_alias(canonical_key, true)
          = normalize_message_thread_routing_alias($1, true)`,
    [created.canonical_key],
  );
  assert.equal(count.rows[0]?.count, "1");

  const concurrentOwner = await newReader();
  const [concurrentUpper, concurrentLower] = await Promise.all([
    registerAgentIdentity!({
      owner_account_id: concurrentOwner,
      owner_login: "RaceOwner",
      owner_label: "Race Owner",
      name: "MapleWorker",
      display_name: "Maple upper",
    }),
    registerAgentIdentity!({
      owner_account_id: concurrentOwner,
      owner_login: "raceowner",
      owner_label: "Race Owner",
      name: "mapleworker",
      display_name: "Maple lower",
    }),
  ]);
  assert.equal(
    concurrentUpper.id,
    concurrentLower.id,
    "concurrent routing-equivalent registrations converge on one durable identity",
  );
  const concurrentCount = await pool!.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM agents
      WHERE normalize_message_thread_routing_alias(canonical_key, true)
          = normalize_message_thread_routing_alias($1, true)`,
    [concurrentUpper.canonical_key],
  );
  assert.equal(concurrentCount.rows[0]?.count, "1");
});

test("PG thread inbox: a reply id resolves to its thread root for read + fetch", runOptions, async () => {
  const room = await createProjectWithName!("parity_root_resolution");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const viaReply = await getMessageThread!(room.id, s.replyA1.id, { account_id: reader });
  assert.equal(viaReply?.root.id, s.rootA.id);
  assert.equal(viaReply?.summary.reply_count, 2);

  await markMessageThreadRead!(room.id, s.replyA1.id, reader, { message_id: s.replyA2.id });
  const afterRead = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(afterRead?.summary.unread_count, 0);
});

test("PG thread inbox: cursor pagination across a page boundary", runOptions, async () => {
  const room = await createProjectWithName!("parity_cursor");
  const reader = await newReader();
  const s = await seedRoom(room.id);

  const first = await getMessageThreads!(room.id, { limit: 1, account_id: reader });
  assert.deepEqual(first.threads.map((t) => t.root.id), [s.rootB.id]);
  assert.equal(first.has_more, true);

  const cursor = first.threads[0]?.summary.latest_reply?.id ?? null;
  assert.ok(cursor, "expected a latest_reply cursor");
  const second = await getMessageThreads!(room.id, { limit: 1, before: cursor!, account_id: reader });
  assert.deepEqual(second.threads.map((t) => t.root.id), [s.rootA.id]);
  assert.equal(second.has_more, false);
});

test("PG thread projection: trigger is atomic, idempotent, and concurrency-safe", runOptions, async () => {
  if (!addMessageWithCreateStatus) throw new Error("requires TEST_DB_URL");
  const room = await createProjectWithName!("parity_projection");
  const root = await addMessage!(room.id, "Human", "root", { source: "browser" });

  const first = await addMessageWithCreateStatus(room.id, "Agent", "first", {
    source: "agent",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
    client_message_id: "projection-first",
  });
  const replay = await addMessageWithCreateStatus(room.id, "Agent", "first", {
    source: "agent",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
    client_message_id: "projection-first",
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.message.id, first.message.id);

  const concurrentReplies = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    addMessageWithCreateStatus(room.id, "Agent", `parallel ${index}`, {
      source: "agent",
      reply_to_message_id: root.id,
      thread_root_message_id: root.id,
      client_message_id: `projection-parallel-${index}`,
    })));
  assert.equal(concurrentReplies.every((reply) => reply.created), true);

  await assert.rejects(
    addMessageWithCreateStatus(room.id, "Agent", "must roll back", {
      source: "agent",
      reply_to_message_id: root.id,
      thread_root_message_id: root.id,
      client_message_id: "projection-rollback",
      with_created_message_in_transaction: async () => {
        throw new Error("force transaction rollback");
      },
    }),
    /force transaction rollback/,
  );

  const projection = await pool!.query<{
    reply_count: number;
    latest_reply_number: number;
    participant_count: number;
  }>(
    `SELECT reply_count, latest_reply_number, participant_count
       FROM message_thread_summaries
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.equal(projection.rows[0]?.reply_count, 13);

  const latestReply = concurrentReplies
    .map((reply) => reply.message)
    .reduce((latest, candidate) => Number(candidate.id.slice(4)) > Number(latest.id.slice(4)) ? candidate : latest);
  assert.equal(projection.rows[0]?.latest_reply_number, Number(latestReply.id.slice(4)));
  assert.equal(projection.rows[0]?.participant_count, 2);

  const participants = await pool!.query<{
    sender: string;
    source: string | null;
    message_count: number;
    latest_message_number: number;
  }>(
    `SELECT sender, source, message_count, latest_message_number
       FROM message_thread_participants
      WHERE room_id = $1 AND thread_root_number = $2
      ORDER BY sender`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.deepEqual(
    participants.rows.map((row) => ({ ...row, latest_message_number: Number(row.latest_message_number) })),
    [
      {
        sender: "Agent",
        source: "agent",
        message_count: 13,
        latest_message_number: Number(latestReply.id.slice(4)),
      },
      {
        sender: "Human",
        source: "browser",
        message_count: 1,
        latest_message_number: Number(root.id.slice(4)),
      },
    ],
  );

  const rolledBack = await pool!.query(
    `SELECT 1 FROM messages WHERE room_id = $1 AND client_message_id = $2`,
    [room.id, "projection-rollback"],
  );
  assert.equal(rolledBack.rowCount, 0);
});

test("PG thread projection: projected message mutations are explicitly immutable", runOptions, async () => {
  const room = await createProjectWithName!("parity_projection_immutable");
  const standalone = await addMessage!(room.id, "Human", "standalone");
  const root = await addMessage!(room.id, "Human", "root");
  const reply = await addMessage!(room.id, "Agent", "reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const rootNumber = Number(root.id.slice(4));
  const replyNumber = Number(reply.id.slice(4));

  await assert.rejects(
    pool!.query("DELETE FROM messages WHERE room_id = $1 AND number = $2", [room.id, replyNumber]),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    pool!.query(
      "UPDATE messages SET sender = 'changed' WHERE room_id = $1 AND number = $2",
      [room.id, rootNumber],
    ),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  await assert.rejects(
    pool!.query(
      "UPDATE messages SET number = number + 1000 WHERE room_id = $1 AND number = $2",
      [room.id, Number(standalone.id.slice(4))],
    ),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );

  const visibilityUpdate = await pool!.query(
    `UPDATE messages SET visibility = 'rental_visible'
      WHERE room_id = $1 AND number = $2 RETURNING number`,
    [room.id, replyNumber],
  );
  assert.equal(visibilityUpdate.rowCount, 1);
  await pool!.query("DELETE FROM rooms WHERE id = $1", [room.id]);
  const remaining = await pool!.query(
    `SELECT 1 FROM message_thread_summaries WHERE room_id = $1`,
    [room.id],
  );
  assert.equal(remaining.rowCount, 0, "room cascades remain allowed");
});

test("PG thread projection: read cursor stores reply position", runOptions, async () => {
  const room = await createProjectWithName!("parity_read_projection");
  const reader = await newReader();
  const otherReader = await newReader();
  const s = await seedRoom(room.id);

  await markMessageThreadRead!(room.id, s.rootA.id, reader, { message_id: s.replyA1.id });
  const cursor = await pool!.query<{
    last_read_message_number: number;
    last_read_reply_count: number;
  }>(
    `SELECT last_read_message_number, last_read_reply_count
       FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2 AND account_id = $3`,
    [room.id, Number(s.rootA.id.slice(4)), reader],
  );
  assert.equal(cursor.rows[0]?.last_read_message_number, Number(s.replyA1.id.slice(4)));
  assert.equal(cursor.rows[0]?.last_read_reply_count, 1);

  await addMessage!(room.id, "Agent", "new unread reply", {
    source: "agent",
    reply_to_message_id: s.replyA2.id,
    thread_root_message_id: s.rootA.id,
  });
  const thread = await getMessageThread!(room.id, s.rootA.id, { account_id: reader });
  assert.equal(thread?.summary.reply_count, 3);
  assert.equal(thread?.summary.unread_count, 2);

  const overlays = await getMessageThreadReadOverlays!(
    room.id,
    [{ root_message_id: s.rootA.id, reply_count: 3 }],
    [reader, otherReader],
  );
  assert.deepEqual(overlays.get(reader)?.get(s.rootA.id), {
    last_read_message_id: s.replyA1.id,
    unread_count: 2,
    has_unread: true,
  });
  assert.deepEqual(overlays.get(otherReader)?.get(s.rootA.id), {
    last_read_message_id: null,
    unread_count: 3,
    has_unread: true,
  });

  // Simulate an older application instance that only advances the legacy
  // message-number cursor. The database trigger must still repair the new
  // reply-position projection during a rolling deploy.
  await pool!.query(
    `UPDATE message_thread_reads
        SET last_read_message_number = $1, read_at = NOW()
      WHERE room_id = $2 AND thread_root_number = $3 AND account_id = $4`,
    [Number(s.replyA2.id.slice(4)), room.id, Number(s.rootA.id.slice(4)), reader],
  );
  const repairedCursor = await pool!.query<{ last_read_reply_count: number }>(
    `SELECT last_read_reply_count
       FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2 AND account_id = $3`,
    [room.id, Number(s.rootA.id.slice(4)), reader],
  );
  assert.equal(repairedCursor.rows[0]?.last_read_reply_count, 2);
});

test("PG thread projection: prompt-only cursors retain the preceding visible ordinal", runOptions, async () => {
  const room = await createProjectWithName!("parity_prompt_cursor");
  const root = await addMessage!(room.id, "Human", "root");
  const visible = await addMessage!(room.id, "Agent", "visible", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const prompt = await addMessage!(room.id, "Agent prompt", "", {
    agent_prompt_kind: "auto",
    reply_to_message_id: visible.id,
    thread_root_message_id: root.id,
  });
  const steadyReader = await newReader();
  const backfillReader = await newReader();
  const rootNumber = Number(root.id.slice(4));
  const promptNumber = Number(prompt.id.slice(4));

  await pool!.query(
    `INSERT INTO message_thread_reads (
       room_id, thread_root_number, account_id, last_read_message_number, read_at
     ) VALUES ($1, $2, $3, $4, NOW())`,
    [room.id, rootNumber, steadyReader, promptNumber],
  );
  await pool!.query("ALTER TABLE message_thread_reads DISABLE TRIGGER message_thread_reads_position_before_write");
  try {
    await pool!.query(
      `INSERT INTO message_thread_reads (
         room_id, thread_root_number, account_id,
         last_read_message_number, last_read_reply_count, read_at
       ) VALUES ($1, $2, $3, $4, 0, NOW())`,
      [room.id, rootNumber, backfillReader, promptNumber],
    );
  } finally {
    await pool!.query("ALTER TABLE message_thread_reads ENABLE TRIGGER message_thread_reads_position_before_write");
  }
  await pool!.query(
    `UPDATE message_thread_projection_rollout
        SET watermarks_created = true, completed_at = NULL WHERE singleton`,
  );
  await pool!.query(
    `INSERT INTO message_thread_projection_watermarks (
       room_id, through_message_number, message_cursor,
       read_thread_root_cursor, read_account_cursor, reads_completed, completed_at
     ) VALUES ($1, $2, $2, 0, '', false, NULL)
     ON CONFLICT (room_id) DO UPDATE SET
       through_message_number = EXCLUDED.through_message_number,
       message_cursor = EXCLUDED.message_cursor,
       read_thread_root_cursor = 0,
       read_account_cursor = '', reads_completed = false, completed_at = NULL`,
    [room.id, promptNumber],
  );
  await pool!.query("SELECT reconcile_message_thread_projection(10)");

  const cursors = await pool!.query<{ account_id: string; last_read_reply_count: number }>(
    `SELECT account_id, last_read_reply_count FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2 ORDER BY account_id`,
    [room.id, rootNumber],
  );
  assert.deepEqual(cursors.rows.map((row) => row.last_read_reply_count), [1, 1]);
});

test("PG thread projection: bounds new senders while historical oversized identities remain migration-safe", runOptions, async () => {
  const room = await createProjectWithName!("parity_large_participant");
  const sender = `large|${Array.from({ length: 40 }, (_, index) => `segment-${index}`).join("|")}|${"x".repeat(4096)}`;
  const source = `source-${"y".repeat(4096)}`;
  await assert.rejects(
    addMessage!(room.id, sender, "new write", { source }),
    /sender must not exceed 512 characters or 2048 UTF-8 bytes/,
  );
  await assert.rejects(
    addMessage!(room.id, "😀".repeat(513), "new multi-byte write", { source: "agent" }),
    /sender must not exceed 512 characters or 2048 UTF-8 bytes/,
  );

  const root = await addMessage!(room.id, "Historical root", "root", { source: "browser" });
  const rootNumber = Number(root.id.slice(4));
  const historicalReplyNumber = rootNumber + 1;
  // Direct SQL models a pre-validation row being encountered during rollout.
  // Projection identity uses a fixed digest plus raw equality, never raw text
  // as a btree key, so historical data remains safe.
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number, sender, text,
       source, routing_snapshot_version, timestamp
     ) VALUES ($1, $2, $3, $3, $4, 'historical reply', $5, NULL, NOW())`,
    [room.id, historicalReplyNumber, rootNumber, sender, "agent"],
  );
  await pool!.query(
    `UPDATE id_sequences SET value = GREATEST(value, $2) WHERE name = 'messages:' || $1`,
    [room.id, historicalReplyNumber],
  );

  const participant = await pool!.query<{ sender_size: number; source_size: number }>(
    `SELECT length(sender)::int AS sender_size, length(source)::int AS source_size
       FROM message_thread_participants
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, rootNumber],
  );
  assert.equal(participant.rows[0]?.sender_size, sender.length);
  assert.equal(participant.rows[0]?.source_size, "agent".length);

  const aliases = await pool!.query<{
    alias_count: number;
    full_sender_count: number;
  }>(
    `SELECT COUNT(*)::int AS alias_count,
            COUNT(*) FILTER (
              WHERE alias_text = normalize_message_thread_routing_alias($3, false)
            )::int AS full_sender_count
       FROM message_thread_participant_aliases
      WHERE room_id = $1 AND thread_root_number = $2
        AND participant_number = $4`,
    [room.id, rootNumber, sender, historicalReplyNumber],
  );
  assert.equal(
    aliases.rows[0]?.alias_count,
    17,
    "the full sender plus its first 16 segments stay bounded",
  );
  assert.equal(aliases.rows[0]?.full_sender_count, 1, "the full actor label remains an exact routing alias");
});

test("PG thread projection: prompt-only multi-sender routing stays materialized but hidden", runOptions, async () => {
  const room = await createProjectWithName!("parity_prompt_routing");
  const promptOwner = await newReader();
  const root = await addMessage!(room.id, "Human", "root", { source: "browser" });
  const visible = await addMessage!(room.id, "Visible agent", "visible", {
    source: "agent",
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  await addMessage!(room.id, "Prompt agent A", "", {
    source: "agent-a",
    agent_prompt_kind: "auto",
    reply_to_message_id: visible.id,
    thread_root_message_id: root.id,
  });
  await addMessage!(room.id, "Prompt agent B", "", {
    source: "agent-b",
    agent_prompt_kind: "auto",
    reply_to_message_id: visible.id,
    thread_root_message_id: root.id,
  });
  const supersededPrompt = await addMessage!(room.id, "Superseded agent", "", {
    source: "same-agent",
    agent_prompt_kind: "auto",
    reply_to_message_id: visible.id,
    thread_root_message_id: root.id,
    publisher_agent_key: "test/superseded",
    account_id: promptOwner,
  });
  await addMessage!(room.id, "Superseded agent", "", {
    source: "same-agent",
    agent_prompt_kind: "auto",
    reply_to_message_id: visible.id,
    thread_root_message_id: root.id,
    publisher_agent_key: "test/superseded",
    account_id: promptOwner,
  });

  const routing = await pool!.query<{ sender: string; message_count: number; routing_message_count: number }>(
    `SELECT sender, message_count, routing_message_count
       FROM message_thread_participants
      WHERE room_id = $1 AND thread_root_number = $2
      ORDER BY sender`,
    [room.id, Number(root.id.slice(4))],
  );
  assert.deepEqual(routing.rows.map((row) => row.sender), [
    "Human", "Prompt agent A", "Prompt agent B", "Superseded agent", "Visible agent",
  ]);
  assert.deepEqual(
    routing.rows.filter((row) => row.sender.startsWith("Prompt agent"))
      .map((row) => ({ visible: row.message_count, routing: row.routing_message_count })),
    [{ visible: 0, routing: 1 }, { visible: 0, routing: 1 }],
  );

  const thread = await getMessageThread!(room.id, root.id);
  assert.deepEqual(thread?.summary.participants.map((participant) => participant.sender), [
    "Visible agent", "Human",
  ]);
  const cleanup = await pool!.query<{
    messages: number;
    projected: number;
    routing_count: number;
    durable_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM messages WHERE room_id = $1 AND number = $2) AS messages,
       (SELECT COUNT(*)::int FROM message_thread_projected_messages
         WHERE room_id = $1 AND message_number = $2) AS projected,
       (SELECT routing_message_count FROM message_thread_participants
         WHERE room_id = $1 AND thread_root_number = $3 AND sender = 'Superseded agent') AS routing_count,
       (SELECT message_count FROM message_thread_participant_agents
         WHERE room_id = $1 AND thread_root_number = $3
           AND agent_key = 'test/superseded') AS durable_count`,
    [room.id, Number(supersededPrompt.id.slice(4)), Number(root.id.slice(4))],
  );
  assert.deepEqual(cleanup.rows[0], {
    messages: 0,
    projected: 0,
    routing_count: 1,
    durable_count: 1,
  });
});

test("PG thread read overlay: extreme account skew stays one cursor query", runOptions, async () => {
  const room = await createProjectWithName!("parity_overlay_batch");
  const root = await addMessage!(room.id, "Human", "root");
  await addMessage!(room.id, "Agent", "reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const accountIds = Array.from({ length: 10_000 }, (_, index) => `overlay_${index}`);

  let queryCount = 0;
  const originalQuery = pool!.query.bind(pool!);
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    queryCount += 1;
    return (originalQuery as (...values: unknown[]) => unknown)(...args);
  };
  let overlays;
  try {
    overlays = await getMessageThreadReadOverlays!(
      room.id,
      [
        { root_message_id: root.id, reply_count: 1 },
        { root_message_id: root.id, reply_count: 7 },
      ],
      [...accountIds, accountIds[0]!],
    );
  } finally {
    (pool as unknown as { query: unknown }).query = originalQuery;
  }
  assert.equal(overlays.size, accountIds.length);
  assert.equal(queryCount, 1, "one thread and 10k subscribers should use one array-bound read");
  assert.deepEqual(overlays.get(accountIds.at(-1)!)?.get(root.id), {
    last_read_message_id: null,
    unread_count: 7,
    has_unread: true,
  });
  const reversed = await getMessageThreadReadOverlays!(
    room.id,
    [
      { root_message_id: root.id, reply_count: 7 },
      { root_message_id: root.id, reply_count: 1 },
    ],
    [accountIds[0]!],
  );
  assert.equal(reversed.get(accountIds[0]!)?.get(root.id)?.unread_count, 7);
  await assert.rejects(
    getMessageThreadReadOverlays!(
      room.id,
      [{ root_message_id: root.id, reply_count: 1 }],
      Array.from({ length: 100_001 }, (_, index) => `overflow_${index}`),
    ),
    /exceeds 100000 account\/thread pairs/,
  );
});

test("PG thread projection: repeated long-thread cursor writes use materialized ordinals", runOptions, async () => {
  const room = await createProjectWithName!("parity_long_read");
  const reader = await newReader();
  const root = await addMessage!(room.id, "Human", "root");
  let latest = root;
  for (let index = 0; index < 400; index += 1) {
    latest = await addMessage!(room.id, "Agent", `reply ${index}`, {
      reply_to_message_id: latest.id,
      thread_root_message_id: root.id,
    });
  }
  await markMessageThreadRead!(room.id, root.id, reader, { message_id: latest.id });
  const rootNumber = Number(root.id.slice(4));
  const latestNumber = Number(latest.id.slice(4));
  for (let index = 0; index < 50; index += 1) {
    await pool!.query(
      `UPDATE message_thread_reads
          SET last_read_message_number = $1, read_at = NOW()
        WHERE room_id = $2 AND thread_root_number = $3 AND account_id = $4`,
      [latestNumber, room.id, rootNumber, reader],
    );
  }
  const cursor = await pool!.query<{ last_read_reply_count: number }>(
    `SELECT last_read_reply_count FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2 AND account_id = $3`,
    [room.id, rootNumber, reader],
  );
  assert.equal(cursor.rows[0]?.last_read_reply_count, 400);

  await addMessage!(room.id, "Agent", "one more", {
    reply_to_message_id: latest.id,
    thread_root_message_id: root.id,
  });
  const page = await getMessageThreads!(room.id, { account_id: reader });
  assert.equal(page.unread_thread_count, 1);
  assert.equal(page.threads[0]?.summary.unread_count, 1);
});

test("PG thread projection: a reply never fan-outs across reader cursors", runOptions, async () => {
  const room = await createProjectWithName!("parity_high_readers");
  const root = await addMessage!(room.id, "Human", "root");
  const reply = await addMessage!(room.id, "Agent", "reply", {
    reply_to_message_id: root.id,
    thread_root_message_id: root.id,
  });
  const rootNumber = Number(root.id.slice(4));
  const replyNumber = Number(reply.id.slice(4));
  const readerCount = 500;
  await pool!.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
     SELECT 'fanout_' || value, 'test', 'fanout_' || value, 'fanout_' || value, NOW(), NOW()
       FROM generate_series(1, $1) AS value`,
    [readerCount],
  );
  await pool!.query(
    `INSERT INTO message_thread_reads (
       room_id, thread_root_number, account_id, last_read_message_number, read_at
     )
     SELECT $1, $2, 'fanout_' || value, $3, NOW()
       FROM generate_series(1, $4) AS value`,
    [room.id, rootNumber, replyNumber, readerCount],
  );
  const before = await pool!.query<{ versions: string[] }>(
    `SELECT ARRAY_AGG(xmin::text ORDER BY account_id) AS versions
       FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, rootNumber],
  );
  assert.equal(before.rows[0]?.versions.length, readerCount);

  await addMessage!(room.id, "Agent", "invalidates all", {
    reply_to_message_id: reply.id,
    thread_root_message_id: root.id,
  });
  const after = await pool!.query<{ versions: string[] }>(
    `SELECT ARRAY_AGG(xmin::text ORDER BY account_id) AS versions
       FROM message_thread_reads
      WHERE room_id = $1 AND thread_root_number = $2`,
    [room.id, rootNumber],
  );
  assert.deepEqual(after.rows[0]?.versions, before.rows[0]?.versions);

  const sample = await getMessageThreads!(room.id, { account_id: "fanout_1" });
  assert.equal(sample.unread_thread_count, 1);
  assert.equal(sample.threads[0]?.summary.unread_count, 1);
});

// Perf/scale contract: a bounded page remains a fixed query count even as the
// room grows because summaries and participants are incrementally projected.
test("PG thread inbox: bounded page over a ~2,000-message room", runOptions, async () => {
  const room = await createProjectWithName!("parity_perf");
  const reader = await newReader();

  const threadCount = 200;
  const repliesPerThread = 9; // 200 * (1 root + 9 replies) = 2,000 messages
  for (let t = 0; t < threadCount; t += 1) {
    const root = await addMessage!(room.id, "Human", `root ${t}`, { source: "browser" });
    let prev = root.id;
    for (let r = 0; r < repliesPerThread; r += 1) {
      const reply = await addMessage!(room.id, "Agent", `reply ${t}.${r}`, {
        source: "agent", reply_to_message_id: prev, thread_root_message_id: root.id,
      });
      prev = reply.id;
    }
  }

  // Grow thread cardinality cheaply so the planner selects the production
  // keyset index and the deep-page row bound is measurable. These inserts use
  // the same database trigger as application writes.
  const baseMessageCount = threadCount * (repliesPerThread + 1);
  const bulkThreads = 1_800;
  await pool!.query(
    `INSERT INTO messages (room_id, number, sender, text, routing_snapshot_version, timestamp)
     SELECT $1, $2 + value * 2, 'Human', 'bulk root ' || value, 1, NOW()
       FROM generate_series(0, $3 - 1) AS value`,
    [room.id, baseMessageCount + 1, bulkThreads],
  );
  await pool!.query(
    `INSERT INTO messages (
       room_id, number, reply_to_number, thread_root_number,
       sender, text, routing_snapshot_version, timestamp
     )
     SELECT $1, $2 + value * 2, $2 - 1 + value * 2, $2 - 1 + value * 2,
            'Agent', 'bulk reply ' || value, 1, NOW()
       FROM generate_series(0, $3 - 1) AS value`,
    [room.id, baseMessageCount + 2, bulkThreads],
  );
  await pool!.query("ANALYZE message_thread_summaries, message_thread_reads");
  const projectedThreadCount = threadCount + bulkThreads;

  const limit = 50;
  let queryCount = 0;
  const originalQuery = pool!.query.bind(pool!);
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    queryCount += 1;
    return (originalQuery as (...a: unknown[]) => unknown)(...args);
  };
  const startedAt = Date.now();
  let page;
  try {
    page = await getMessageThreads!(room.id, { limit, account_id: reader });
  } finally {
    (pool as unknown as { query: unknown }).query = originalQuery;
  }
  const elapsedMs = Date.now() - startedAt;

  // The returned page must be bounded to the requested limit regardless of room size.
  assert.equal(page.threads.length, limit);
  assert.equal(page.has_more, true);
  assert.equal(page.unread_thread_count, projectedThreadCount);
  assert.ok(queryCount > 0 && queryCount <= 5, `expected at most 5 bounded queries, got ${queryCount}`);

  const deepCursor = await pool!.query<{ latest_reply_number: number }>(
    `SELECT latest_reply_number
       FROM message_thread_summaries
      WHERE room_id = $1
      ORDER BY latest_reply_number DESC
      OFFSET 1000 LIMIT 1`,
    [room.id],
  );
  const cursorNumber = deepCursor.rows[0]!.latest_reply_number;
  const deepPage = await getMessageThreads!(room.id, {
    limit,
    before: `msg_${cursorNumber}`,
    account_id: reader,
  });
  assert.equal(deepPage.threads.length, 50);

  const explained = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT summary.thread_root_number, summary.reply_count, summary.latest_reply_number,
            thread_read.last_read_message_number, thread_read.last_read_reply_count
       FROM message_thread_summaries AS summary
       LEFT JOIN message_thread_reads AS thread_read
         ON thread_read.room_id = summary.room_id
        AND thread_read.thread_root_number = summary.thread_root_number
        AND thread_read.account_id = $2
      WHERE summary.room_id = $1 AND summary.latest_reply_number < $3
      ORDER BY summary.latest_reply_number DESC
      LIMIT 51`,
    [room.id, reader, cursorNumber],
  );
  const pageNodes = flattenExplainPlan(explained.rows[0]!["QUERY PLAN"][0]!.Plan);
  assert.equal(
    pageNodes.some((node) => node["Relation Name"] === "messages"),
    false,
    "page-key query must not hydrate messages before LIMIT",
  );
  const summaryNode = pageNodes.find((node) => node["Relation Name"] === "message_thread_summaries");
  assert.ok(
    (summaryNode?.["Actual Rows"] ?? Number.POSITIVE_INFINITY) <= 51,
    `deep page summary scan should stay row-bounded: ${JSON.stringify(summaryNode)}`,
  );

  await pool!.query(
    `INSERT INTO message_thread_reads (
       room_id, thread_root_number, account_id, last_read_message_number, read_at
     )
     SELECT summary.room_id, summary.thread_root_number, $2,
            summary.latest_reply_number, NOW()
       FROM message_thread_summaries AS summary
      WHERE summary.room_id = $1
     ON CONFLICT (room_id, thread_root_number, account_id) DO UPDATE SET
       last_read_message_number = EXCLUDED.last_read_message_number,
       read_at = EXCLUDED.read_at`,
    [room.id, reader],
  );
  let allReadQueryCount = 0;
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    allReadQueryCount += 1;
    return (originalQuery as (...values: unknown[]) => unknown)(...args);
  };
  let allRead;
  try {
    allRead = await getMessageThreads!(room.id, { filter: "unread", account_id: reader });
  } finally {
    (pool as unknown as { query: unknown }).query = originalQuery;
  }
  assert.equal(allRead.threads.length, 0);
  assert.equal(allReadQueryCount, 1, "all-read inbox should stop after the compact aggregate");

  const oldest = await pool!.query<{ thread_root_number: number }>(
    `SELECT thread_root_number FROM message_thread_summaries
      WHERE room_id = $1 ORDER BY latest_reply_number ASC LIMIT 1`,
    [room.id],
  );
  await pool!.query(
    `UPDATE message_thread_reads
        SET last_read_message_number = thread_root_number, read_at = NOW()
      WHERE room_id = $1 AND account_id = $2 AND thread_root_number = $3`,
    [room.id, reader, oldest.rows[0]!.thread_root_number],
  );
  const sparseUnread = await getMessageThreads!(room.id, { filter: "unread", account_id: reader });
  assert.equal(sparseUnread.unread_thread_count, 1);
  assert.deepEqual(
    sparseUnread.threads.map((thread) => Number(thread.root.id.slice(4))),
    [oldest.rows[0]!.thread_root_number],
  );

  const statsExplain = await pool!.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT room_stats.thread_count,
            account_stats.read_thread_count,
            account_stats.fully_read_thread_count
       FROM message_room_thread_stats AS room_stats
       LEFT JOIN message_account_thread_read_stats AS account_stats
         ON account_stats.room_id = room_stats.room_id
        AND account_stats.account_id = $2
      WHERE room_stats.room_id = $1`,
    [room.id, reader],
  );
  const statsNodes = flattenExplainPlan(statsExplain.rows[0]!["QUERY PLAN"][0]!.Plan);
  assert.equal(statsNodes.some((node) => node["Relation Name"] === "messages"), false);
  assert.equal(
    statsNodes.some((node) => node["Relation Name"] === "message_thread_reads"),
    false,
    "a warm unread aggregate lookup never scans account cursor history",
  );
  // eslint-disable-next-line no-console
  console.log(`[perf] getMessageThreads over ${baseMessageCount + bulkThreads * 2} messages / ${projectedThreadCount} threads: ${elapsedMs}ms, ${queryCount} pool queries; deep summary rows=${summaryNode?.["Actual Rows"]}`);
});
