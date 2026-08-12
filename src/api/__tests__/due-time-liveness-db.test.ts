import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const rolloutModule = testDatabaseUrl ? await import("../db/due-time-liveness-rollout.js") : null;
const dueContextModule = testDatabaseUrl ? await import("../db/coordination/due-room-context.js") : null;
const offlineModule = testDatabaseUrl ? await import("../db/presence/offline-announcements.js") : null;
const utilsModule = testDatabaseUrl ? await import("../db/utils.js") : null;
const pool = dbClientModule?.pool;
const db = dbClientModule?.db;
const skipOptions = { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed due-time tests" : false };

async function resetDatabase(): Promise<void> {
  if (!db || !pool) throw new Error("DB-backed due-time tests require TEST_DB_URL");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  await rolloutModule!.reconcileDueTimeLivenessRollout(pool);
}

test.beforeEach(async () => {
  if (!requiresDatabase) await resetDatabase();
});

test.after(async () => {
  await pool?.end();
});

function flattenPlan(node: Record<string, unknown>): Record<string, unknown>[] {
  const children = Array.isArray(node.Plans) ? node.Plans as Record<string, unknown>[] : [];
  return [node, ...children.flatMap(flattenPlan)];
}

test("partial due indexes are installed post-commit and bound discovery", skipOptions, async () => {
  const indexes = await pool!.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_due_idx'`,
  );
  assert.deepEqual(new Set(indexes.rows.map((row) => row.indexname)), new Set([
    "room_agent_delivery_sessions_liveness_due_idx",
    "board_manager_assignments_stall_due_idx",
    "board_intents_escalation_due_idx",
    "board_intents_expiry_due_idx",
    "room_board_settings_stall_due_idx",
  ]));

  const planResult = await pool!.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
    `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT room_id, delivery_key
         FROM room_agent_delivery_sessions
        WHERE session_kind = 'worker' AND next_liveness_check_at <= now()
        ORDER BY next_liveness_check_at, room_id, delivery_key
        LIMIT 250`,
  );
  const nodes = flattenPlan(planResult.rows[0]!["QUERY PLAN"][0]!.Plan as Record<string, unknown>);
  assert.ok(nodes.some((node) => node["Index Name"] === "room_agent_delivery_sessions_liveness_due_idx"));
  assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));

  await pool!.query("SET enable_seqscan = off");
  for (const expectation of [
    {
      index: "board_manager_assignments_stall_due_idx",
      query: `SELECT id FROM board_manager_assignments
               WHERE status = 'active' AND stall_check_at <= now()
               ORDER BY stall_check_at, id LIMIT 100`,
    },
    {
      index: "board_intents_escalation_due_idx",
      query: `SELECT id FROM board_intents
               WHERE status = 'pending' AND escalated_at IS NULL
                 AND escalation_check_at <= now()
               ORDER BY escalation_check_at, id LIMIT 100`,
    },
    {
      index: "board_intents_expiry_due_idx",
      query: `SELECT id FROM board_intents
               WHERE status IN ('pending', 'approved') AND expires_at IS NOT NULL
                 AND expires_at <= now()
               ORDER BY expires_at, id LIMIT 100`,
    },
  ]) {
    const duePlan = await pool!.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF) ${expectation.query}`,
    );
    const dueNodes = flattenPlan(duePlan.rows[0]!["QUERY PLAN"][0]!.Plan as Record<string, unknown>);
    assert.ok(dueNodes.some((node) => node["Index Name"] === expectation.index), `${expectation.index} must serve the due claim`);
    assert.ok(!dueNodes.some((node) => node["Node Type"] === "Sort"), `${expectation.index} must satisfy due/id ordering`);
    assert.ok(!dueNodes.some((node) => node["Node Type"] === "Seq Scan"), `${expectation.index} must bound discovery`);
  }

  const taskPlanResult = await pool!.query<{ "QUERY PLAN": Array<Record<string, unknown>> }>(
    `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT room_id FROM tasks
        WHERE room_id > ''
        GROUP BY room_id
        ORDER BY room_id
        LIMIT 500`,
  );
  await pool!.query("RESET enable_seqscan");
  const taskNodes = flattenPlan(taskPlanResult.rows[0]!["QUERY PLAN"][0]!.Plan as Record<string, unknown>);
  assert.ok(taskNodes.some((node) => String(node["Index Name"] ?? "").startsWith("tasks_room")));
  assert.ok(!taskNodes.some((node) => node["Node Type"] === "Seq Scan"));

  assert.deepEqual(await rolloutModule!.reconcileDueTimeLivenessRollout(pool!), {
    delivery_rows: 0,
    manager_rows: 0,
    intent_rows: 0,
    task_rooms: 0,
  }, "a completed rollout must not rescan historical tables on the next deploy");

  await pool!.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'board_intents_expiry_due_idx'::regclass");
  await rolloutModule!.reconcileDueTimeLivenessRollout(pool!);
  const repaired = await pool!.query<{ valid: boolean }>(
    `SELECT indisvalid AS valid FROM pg_index
      WHERE indexrelid = 'board_intents_expiry_due_idx'::regclass`,
  );
  assert.equal(repaired.rows[0]?.valid, true, "a cancelled concurrent build must be repaired on rerun");
});

test("task summary follows close, reopen, and concurrent terminal transitions", skipOptions, async () => {
  const { createProjectWithName, createTask } = dbModule!;
  const room = await createProjectWithName!("due-task-summary");
  const taskA = await createTask!(room.id, "A", "EmmyMay");
  const taskB = await createTask!(room.id, "B", "EmmyMay");
  const read = async () => (await pool!.query<{
    open_task_count: number;
    last_task_closed_at: string | null;
    stall_check_at: string | null;
  }>(`SELECT open_task_count, last_task_closed_at, stall_check_at FROM room_board_settings WHERE room_id = $1`, [room.id])).rows[0]!;
  assert.equal((await read()).open_task_count, 2);

  await Promise.all([taskA, taskB].map((task) => pool!.query(
    `UPDATE tasks SET status = 'done' WHERE room_id = $1 AND number = $2`,
    [room.id, Number(task.id.replace("task_", ""))],
  )));
  const drained = await read();
  assert.equal(drained.open_task_count, 0);
  assert.ok(drained.last_task_closed_at);
  assert.ok(drained.stall_check_at);

  await pool!.query(`UPDATE tasks SET status = 'in_progress' WHERE room_id = $1 AND number = $2`, [
    room.id,
    Number(taskA.id.replace("task_", "")),
  ]);
  const reopened = await read();
  assert.equal(reopened.open_task_count, 1);
  assert.equal(reopened.stall_check_at, null);
});

test("task summary trigger permits a populated room cascade delete", skipOptions, async () => {
  const { createProjectWithName, createTask } = dbModule!;
  const room = await createProjectWithName!("due-room-delete");
  await createTask!(room.id, "deleted with room", "EmmyMay");
  await pool!.query("DELETE FROM rooms WHERE id = $1", [room.id]);
  assert.equal((await pool!.query("SELECT 1 FROM tasks WHERE room_id = $1", [room.id])).rowCount, 0);
  assert.equal((await pool!.query("SELECT 1 FROM room_board_settings WHERE room_id = $1", [room.id])).rowCount, 0);
});

test("room id cascade carries complete liveness projections behind rollout cursors", skipOptions, async () => {
  const { assignBoardManager, createProjectWithName, createRoomAgentSession, createTask,
    markRoomAgentDeliveryConnected, upsertAccount } = dbModule!;
  const room = await createProjectWithName!("zz-due-room-rename");
  const account = await upsertAccount!({
    provider: "github", provider_user_id: "due-rename-account", login: "EmmyMay", display_name: "EmmyMay",
  });
  const worker = await createRoomAgentSession!({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: "Oak | EmmyMay's agent | Codex", agent_key: "EmmyMay/oak", display_name: "Oak",
    owner_account_id: account.id, owner_label: "EmmyMay", ide_label: "Codex",
  });
  await markRoomAgentDeliveryConnected!({
    room_id: room.id, actor_label: worker.actor_label, agent_session_id: worker.session_id,
    session_kind: "worker", display_name: worker.display_name,
    credential_fence: { kind: "session_token", token_hash: utilsModule!.hashToken(worker.session_token) },
    transport: "long_poll",
  });
  await assignBoardManager!({ room_id: room.id, agent_session_id: worker.session_id, assigned_by: "EmmyMay" });
  await createTask!(room.id, "still open", "EmmyMay");
  await pool!.query(`UPDATE room_agent_delivery_sessions SET next_liveness_check_at = NULL WHERE room_id = $1`, [room.id]);
  await pool!.query(`UPDATE board_manager_assignments SET stall_check_at = NULL WHERE room_id = $1`, [room.id]);
  await pool!.query(`UPDATE room_board_settings SET open_task_count = 0 WHERE room_id = $1`, [room.id]);
  const nextRoomId = `aa-${room.id}`;
  await pool!.query("UPDATE rooms SET id = $1 WHERE id = $2", [nextRoomId, room.id]);
  const projection = (await pool!.query<{
    open_task_count: number; delivery_due: string | null; manager_due: string | null;
  }>(`SELECT settings.open_task_count,
             delivery.next_liveness_check_at AS delivery_due,
             assignment.stall_check_at AS manager_due
        FROM room_board_settings AS settings
        JOIN room_agent_delivery_sessions AS delivery ON delivery.room_id = settings.room_id
        JOIN board_manager_assignments AS assignment ON assignment.room_id = settings.room_id AND assignment.status = 'active'
       WHERE settings.room_id = $1`, [nextRoomId])).rows[0]!;
  assert.equal(projection.open_task_count, 1);
  assert.ok(projection.delivery_due);
  assert.ok(projection.manager_due);
});

test("rollout advances from the selected batch when concurrent deletes make its update empty", skipOptions, async () => {
  await pool!.query(`
    INSERT INTO rooms (id, display_name, kind, created_at)
    SELECT 'batch_room_' || lpad(value::text, 4, '0'), 'Batch room', 'main', now()
      FROM generate_series(1, 501) AS value
  `);
  await pool!.query(`
    INSERT INTO room_agent_delivery_sessions (
      room_id, delivery_key, actor_label, display_name, session_kind, runtime,
      transport, active_connection_count, last_connected_at, created_at, updated_at
    )
    SELECT id, 'agent_session:batch', 'Batch worker', 'Batch worker', 'worker',
           'codex', 'long_poll', 0, now(), now(), now()
      FROM rooms WHERE id LIKE 'batch_room_%'
  `);
  await pool!.query(`
    UPDATE room_agent_delivery_sessions
       SET next_liveness_check_at = NULL
     WHERE room_id LIKE 'batch_room_%'
  `);
  await pool!.query(`DELETE FROM due_time_liveness_rollout_state WHERE rollout_key = '0082_due_time_liveness_v1'`);
  await pool!.query(`
    CREATE OR REPLACE FUNCTION test_skip_first_delivery_rollout_batch()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.room_id < 'batch_room_0501' THEN RETURN NULL; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_skip_first_delivery_rollout_batch
    BEFORE UPDATE OF next_liveness_check_at ON room_agent_delivery_sessions
    FOR EACH ROW WHEN (NEW.room_id LIKE 'batch_room_%')
    EXECUTE FUNCTION test_skip_first_delivery_rollout_batch();
  `);
  try {
    const result = await rolloutModule!.reconcileDueTimeLivenessRollout(pool!);
    assert.equal(result.delivery_rows, 1, "the skipped first batch must not terminate enumeration");
    const last = (await pool!.query<{ due: string | null }>(
      `SELECT next_liveness_check_at AS due
         FROM room_agent_delivery_sessions
        WHERE room_id = 'batch_room_0501'`,
    )).rows[0];
    assert.ok(last?.due, "a later row must still be reconciled after an empty update result");
  } finally {
    await pool!.query("DROP TRIGGER IF EXISTS test_skip_first_delivery_rollout_batch ON room_agent_delivery_sessions");
    await pool!.query("DROP FUNCTION IF EXISTS test_skip_first_delivery_rollout_batch()");
  }
});

test("accepted native harness activity pushes the indexed delivery deadline", skipOptions, async () => {
  const { createProjectWithName, createRoomAgentSession, markRoomAgentDeliveryConnected,
    recordNativeHarnessActivity, upsertAccount } = dbModule!;
  const room = await createProjectWithName!("due-native-activity");
  const account = await upsertAccount!({
    provider: "github", provider_user_id: "due-native-account", login: "EmmyMay", display_name: "EmmyMay",
  });
  const worker = await createRoomAgentSession!({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: "Oak | EmmyMay's agent | Codex", agent_key: "EmmyMay/oak", display_name: "Oak",
    owner_account_id: account.id, owner_label: "EmmyMay", ide_label: "Codex",
  });
  await markRoomAgentDeliveryConnected!({
    room_id: room.id, actor_label: worker.actor_label, agent_session_id: worker.session_id,
    session_kind: "worker", display_name: worker.display_name,
    credential_fence: { kind: "session_token", token_hash: utilsModule!.hashToken(worker.session_token) },
    transport: "long_poll",
  });
  await pool!.query(
    "UPDATE room_agent_delivery_sessions SET next_liveness_check_at = now() - interval '1 minute' WHERE room_id = $1",
    [room.id],
  );
  const before = Date.now();
  const result = await recordNativeHarnessActivity!({
    room_id: room.id, agent_session_id: worker.session_id, actor_label: worker.actor_label,
    agent_key: worker.agent_key, session_kind: "worker", runtime: worker.runtime,
    display_name: worker.display_name, owner_label: worker.owner_label, ide_label: worker.ide_label,
    repo_branch: null, provider_observed_at: new Date().toISOString(), sequence: 1,
    method: "native_harness.bound", status: "working",
  });
  assert.equal(result.accepted, true);
  const due = (await pool!.query<{ due: string }>(
    "SELECT next_liveness_check_at AS due FROM room_agent_delivery_sessions WHERE room_id = $1",
    [room.id],
  )).rows[0]!.due;
  assert.ok(Date.parse(due) >= before + 4 * 60_000);
});

test("concurrent candidate claims are disjoint and a stale claim cannot overwrite a heartbeat", skipOptions, async () => {
  const { createProjectWithName, markRoomAgentDeliveryConnected, listLivenessAnnouncementCandidates } = dbModule!;
  const { rescheduleLivenessAnnouncementCandidate } = offlineModule!;
  const rooms = await Promise.all(["a", "b"].map((suffix) => createProjectWithName!(`due-claim-${suffix}`)));
  for (const [index, room] of rooms.entries()) {
    await markRoomAgentDeliveryConnected!({
      room_id: room.id,
      actor_label: `Worker ${index}`,
      session_kind: "worker",
      display_name: `Worker ${index}`,
      transport: "long_poll",
    });
  }
  await pool!.query(`UPDATE room_agent_delivery_sessions SET next_liveness_check_at = now() - interval '1 minute'`);
  const now = Date.now();
  const [left, right] = await Promise.all([
    listLivenessAnnouncementCandidates!({ now, limit: 1 }),
    listLivenessAnnouncementCandidates!({ now, limit: 1 }),
  ]);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0]!.session.delivery_key + left[0]!.session.room_id,
    right[0]!.session.delivery_key + right[0]!.session.room_id);

  const claimed = left[0]!;
  await pool!.query(
    `UPDATE room_agent_delivery_sessions SET updated_at = now()
      WHERE room_id = $1 AND delivery_key = $2`,
    [claimed.session.room_id, claimed.session.delivery_key],
  );
  const scheduledAfterHeartbeat = (await pool!.query<{ next_liveness_check_at: string }>(
    `SELECT next_liveness_check_at FROM room_agent_delivery_sessions WHERE room_id = $1 AND delivery_key = $2`,
    [claimed.session.room_id, claimed.session.delivery_key],
  )).rows[0]!.next_liveness_check_at;
  await rescheduleLivenessAnnouncementCandidate!({
    room_id: claimed.session.room_id,
    delivery_key: claimed.session.delivery_key,
    claimed_check_at: claimed.claimed_check_at!,
    next_check_at: null,
  });
  const finalDue = (await pool!.query<{ next_liveness_check_at: string }>(
    `SELECT next_liveness_check_at FROM room_agent_delivery_sessions WHERE room_id = $1 AND delivery_key = $2`,
    [claimed.session.room_id, claimed.session.delivery_key],
  )).rows[0]!.next_liveness_check_at;
  assert.equal(new Date(finalDue).toISOString(), new Date(scheduledAfterHeartbeat).toISOString());
});

test("a stale stall claim cannot fence a drain after new work opens", skipOptions, async () => {
  const { createProjectWithName, createTask, listStalledRoomCandidates, markRoomStallNudgedTx } = dbModule!;
  const room = await createProjectWithName!("due-stall-race");
  const task = await createTask!(room.id, "old drain", "EmmyMay");
  await pool!.query(
    `UPDATE tasks SET status = 'done', updated_at = now() - interval '45 minutes'
      WHERE room_id = $1 AND number = $2`,
    [room.id, Number(task.id.replace("task_", ""))],
  );
  await pool!.query(
    `UPDATE room_board_settings
        SET last_task_closed_at = now() - interval '45 minutes',
            stall_check_at = now() - interval '15 minutes'
      WHERE room_id = $1`,
    [room.id],
  );
  const candidate = (await listStalledRoomCandidates!({})).find((row) => row.room_id === room.id);
  assert.ok(candidate);
  await createTask!(room.id, "new cycle", "EmmyMay");
  assert.equal(await markRoomStallNudgedTx!(db!, {
    room_id: room.id,
    epoch: candidate!.last_closed_at,
  }), false, "reopened work must defeat the old drain fence");
});

test("due room context batches manager, delivery, and suppression state", skipOptions, async () => {
  const { createProjectWithName, createRoomAgentSession, markRoomAgentDeliveryConnected, setRoomLiveAgentSuppressed,
    assignBoardManager, upsertAccount } = dbModule!;
  const { getDueRoomOperationalContext, getLivenessRoomContexts } = dueContextModule!;
  const room = await createProjectWithName!("due-room-context");
  const account = await upsertAccount!({
    provider: "github",
    provider_user_id: "due-context-account",
    login: "EmmyMay",
    display_name: "EmmyMay",
  });
  const worker = await createRoomAgentSession!({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: "Oak | EmmyMay's agent | Codex",
    agent_key: "EmmyMay/oak",
    display_name: "Oak",
    owner_account_id: account.id,
    owner_label: "EmmyMay",
    ide_label: "Codex",
  });
  await markRoomAgentDeliveryConnected!({
    room_id: room.id,
    actor_label: "Oak | EmmyMay's agent | Codex",
    agent_session_id: worker.session_id,
    session_kind: "worker",
    display_name: "Oak",
    credential_fence: {
      kind: "session_token",
      token_hash: utilsModule!.hashToken(worker.session_token),
    },
    transport: "long_poll",
  });
  await assignBoardManager!({
    room_id: room.id,
    agent_session_id: worker.session_id,
    assigned_by: "EmmyMay",
  });
  let context = await getDueRoomOperationalContext!([room.id]);
  assert.deepEqual(context.live_worker_labels_by_room.get(room.id), ["Oak | EmmyMay's agent | Codex"]);
  assert.ok(context.reachable_manager_room_ids.has(room.id));

  await setRoomLiveAgentSuppressed!({
    room_id: room.id,
    actor_labels: ["Oak | EmmyMay's agent | Codex"],
    suppressed: true,
  });
  context = await getDueRoomOperationalContext!([room.id]);
  assert.deepEqual(context.live_worker_labels_by_room.get(room.id) ?? [], []);
  assert.ok(
    context.reachable_manager_room_ids.has(room.id),
    "reminder suppression must not erase exact manager reachability authority",
  );
  const liveness = await getLivenessRoomContexts!([room.id]);
  assert.ok(liveness.get(room.id)!.suppressed_actor_labels.has("Oak | EmmyMay's agent | Codex"));
  assert.equal(liveness.get(room.id)!.active_manager_session_id, worker.session_id);
});

test("a dead assigned manager cannot permanently disable a drained-room nudge", skipOptions, async () => {
  const { assignBoardManager, createProjectWithName, createRoomAgentSession, createTask,
    listStalledRoomCandidates, markRoomAgentDeliveryConnected,
    markRoomStallNudgedTx, upsertAccount } = dbModule!;
  const { getDueRoomOperationalContext } = dueContextModule!;
  const room = await createProjectWithName!("due-dead-manager-stall");
  const account = await upsertAccount!({
    provider: "github",
    provider_user_id: "due-dead-manager-account",
    login: "EmmyMay",
    display_name: "EmmyMay",
  });
  const createWorker = (name: string) => createRoomAgentSession!({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: `${name} | EmmyMay's agent | Codex`,
    agent_key: `EmmyMay/${name.toLowerCase()}`,
    display_name: name,
    owner_account_id: account.id,
    owner_label: "EmmyMay",
    ide_label: "Codex",
  });
  const [manager, helper] = await Promise.all([createWorker("Oak"), createWorker("Pine")]);
  for (const worker of [manager, helper]) {
    await markRoomAgentDeliveryConnected!({
      room_id: room.id,
      actor_label: worker.actor_label,
      agent_session_id: worker.session_id,
      session_kind: "worker",
      display_name: worker.display_name,
      credential_fence: { kind: "session_token", token_hash: utilsModule!.hashToken(worker.session_token) },
      transport: "long_poll",
    });
  }
  await assignBoardManager!({ room_id: room.id, agent_session_id: manager.session_id, assigned_by: "EmmyMay" });
  const task = await createTask!(room.id, "finished phase", "EmmyMay");
  await pool!.query(`UPDATE tasks SET status = 'done' WHERE room_id = $1 AND number = $2`, [
    room.id,
    Number(task.id.replace("task_", "")),
  ]);
  await pool!.query(
    `UPDATE room_board_settings
        SET last_task_closed_at = now() - interval '45 minutes',
            stall_check_at = now() - interval '15 minutes'
      WHERE room_id = $1`,
    [room.id],
  );
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [room.id, manager.session_id],
  );

  const context = await getDueRoomOperationalContext!([room.id]);
  assert.equal(context.reachable_manager_room_ids.has(room.id), false);
  assert.deepEqual(context.live_worker_labels_by_room.get(room.id), [helper.actor_label]);
  const candidate = (await listStalledRoomCandidates!({})).find((entry) => entry.room_id === room.id);
  assert.ok(candidate, "unreachable assignment must leave the drained room due");
  assert.equal(await markRoomStallNudgedTx!(db!, {
    room_id: room.id,
    epoch: candidate!.last_closed_at,
  }), true, "the final fence must reject only a reachable manager");
});
