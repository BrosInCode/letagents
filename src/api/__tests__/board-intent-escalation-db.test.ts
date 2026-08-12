import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const dbUtilsModule = testDatabaseUrl ? await import("../db/utils.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const hashToken = dbUtilsModule?.hashToken;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed escalation tests require TEST_DB_URL");
  }

  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

test.beforeEach(async () => {
  if (!requiresDatabase) {
    await resetDatabase();
  }
});

test.after(async () => {
  await pool?.end();
});

const skipOptions = { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed escalation tests" : false };

async function seedStuckTaskCreateIntent(minutesOld = 15) {
  const { createProjectWithName, createBoardIntent, boardIntentPayloadForTaskCreate } = dbModule!;
  const project = await createProjectWithName!("intent-escalation-test");
  const intent = await createBoardIntent!({
    room_id: project.id,
    action_type: "task_create",
    payload: boardIntentPayloadForTaskCreate!({ title: "Ship Phase D", description: "next slice" }),
    proposer_actor_label: "RiverGrove | EmmyMay's agent | Claude Code",
    proposer_actor_key: "EmmyMay/river-grove",
  });
  await pool!.query(
    "UPDATE board_intents SET created_at = $3, escalation_check_at = $3::timestamptz + interval '10 minutes' WHERE room_id = $1 AND id = $2",
    [project.id, intent.id, new Date(Date.now() - minutesOld * 60_000)]
  );
  return { roomId: project.id, intentId: intent.id };
}

test(
  "atomic escalation: announcement, fence, approval, and task creation commit together",
  skipOptions,
  async () => {
    const {
      acceptProposedTaskTx,
      addMessageWithCreateStatus,
      approveTaskCreateBoardIntent,
      assertBoardIntentAutoApprovalEligibilityTx,
      claimBoardIntentEscalationTx,
      countRecentAutoApprovedIntents,
      getBoardIntent,
      getTasks,
      listEscalationCandidateBoardIntents,
      markBoardIntentAutoApprovedTx,
    } = dbModule!;
    const { roomId, intentId } = await seedStuckTaskCreateIntent();

    const listed = (await listEscalationCandidateBoardIntents!({})).find(
      (entry) => entry.intent.id === intentId
    );
    assert.ok(listed, "a 15-minute-old pending intent must be an escalation candidate");
    assert.equal(listed!.manager_mode, "manager_optional");

    const clientMessageId = `board_intent_escalation:${intentId}`;
    const created = await addMessageWithCreateStatus!(
      roomId,
      "letagents",
      "[status] auto-approving stuck intent",
      {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          assert.equal(
            await claimBoardIntentEscalationTx!(tx, { room_id: roomId, intent_id: intentId }),
            true
          );
          await assertBoardIntentAutoApprovalEligibilityTx!(tx, {
            room_id: roomId,
            proposer_actor_key: "EmmyMay/river-grove",
            cap_window_ms: 60 * 60_000,
            cap_max: 5,
          });
          const result = await approveTaskCreateBoardIntent!(
            {
              room_id: roomId,
              intent_id: intentId,
              decision_by: "letagents:intent_escalation",
              reason: "Auto-approved after no Board Manager responded.",
            },
            tx
          );
          assert.ok(result, "approval inside the escalation transaction must succeed");
          assert.equal(
            await acceptProposedTaskTx!(tx, { room_id: roomId, task_id: result!.task.id }),
            true
          );
          await markBoardIntentAutoApprovedTx!(tx, { room_id: roomId, intent_id: intentId });
        },
      }
    );
    assert.equal(created.created, true);

    const intent = await getBoardIntent!({ room_id: roomId, intent_id: intentId });
    assert.equal(intent?.status, "used", "the approved intent is consumed by task creation");
    assert.equal(intent?.auto_approved, true);
    assert.ok(intent?.escalated_at);
    const { tasks } = await getTasks!(roomId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, "Ship Phase D");
    assert.equal(
      tasks[0]?.status,
      "accepted",
      "the escalated task must be claimable without an admin"
    );
    assert.equal(intent?.task_id, tasks[0]?.id);

    // The fence is exactly-once and the escalated intent leaves the candidate list.
    assert.equal(
      await claimBoardIntentEscalationTx!(db!, { room_id: roomId, intent_id: intentId }),
      false
    );
    assert.equal(
      (await listEscalationCandidateBoardIntents!({})).some(
        (entry) => entry.intent.id === intentId
      ),
      false
    );

    // The auto-approval feeds the proposer's rate-cap window.
    assert.equal(
      await countRecentAutoApprovedIntents!({
        room_id: roomId,
        proposer_actor_key: "EmmyMay/river-grove",
        windowMs: 60 * 60_000,
      }),
      1
    );

    // A deduped replay skips the hook entirely.
    const replay = await addMessageWithCreateStatus!(roomId, "letagents", "replayed", {
      client_message_id: clientMessageId,
      with_created_message_in_transaction: async () => {
        throw new Error("hook must not run on the deduped replay");
      },
    });
    assert.equal(replay.created, false);
  }
);

test(
  "a failed escalation rolls back the announcement, the fence, and the approval",
  skipOptions,
  async () => {
    const { addMessageWithCreateStatus, claimBoardIntentEscalationTx, getBoardIntent, getTasks } =
      dbModule!;
    const { roomId, intentId } = await seedStuckTaskCreateIntent();
    const clientMessageId = `board_intent_escalation:${intentId}`;

    await assert.rejects(
      addMessageWithCreateStatus!(roomId, "letagents", "[status] escalation attempt", {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          assert.equal(
            await claimBoardIntentEscalationTx!(tx, { room_id: roomId, intent_id: intentId }),
            true
          );
          throw new Error("approval failed mid-transaction");
        },
      })
    );

    const { rows } = await pool!.query(
      "SELECT number FROM messages WHERE room_id = $1 AND client_message_id = $2",
      [roomId, clientMessageId]
    );
    assert.equal(rows.length, 0, "the announcement must roll back");
    const intent = await getBoardIntent!({ room_id: roomId, intent_id: intentId });
    assert.equal(intent?.status, "pending", "the intent stays pending for the retry");
    assert.equal(intent?.escalated_at, null, "the fence must roll back too");
    assert.equal((await getTasks!(roomId)).tasks.length, 0);
  }
);

test(
  "candidate listing excludes young, escalated, and expired intents",
  skipOptions,
  async () => {
    const { createBoardIntent, boardIntentPayloadForTaskCreate, listEscalationCandidateBoardIntents } =
      dbModule!;
    const { roomId, intentId: oldPendingId } = await seedStuckTaskCreateIntent();

    const young = await createBoardIntent!({
      room_id: roomId,
      action_type: "task_create",
      payload: boardIntentPayloadForTaskCreate!({ title: "Too new to escalate" }),
      proposer_actor_key: "EmmyMay/river-grove",
    });
    const expired = await createBoardIntent!({
      room_id: roomId,
      action_type: "task_create",
      payload: boardIntentPayloadForTaskCreate!({ title: "Past pending TTL" }),
      proposer_actor_key: "EmmyMay/river-grove",
    });
    await pool!.query(
      "UPDATE board_intents SET created_at = $3, escalation_check_at = $3::timestamptz + interval '10 minutes', expires_at = $4 WHERE room_id = $1 AND id = $2",
      [roomId, expired.id, new Date(Date.now() - 30 * 60_000), new Date(Date.now() - 60_000)]
    );

    const candidates = await listEscalationCandidateBoardIntents!({});
    const ids = candidates.map((entry) => entry.intent.id);
    assert.ok(ids.includes(oldPendingId));
    assert.ok(!ids.includes(young.id), "young intents wait out the threshold");
    assert.ok(!ids.includes(expired.id), "expired intents never escalate");
  }
);

test(
  "eligibility revalidation aborts when a manager reconnects or the mode changes mid-flight",
  skipOptions,
  async () => {
    const {
      addMessageWithCreateStatus,
      assertBoardIntentAutoApprovalEligibilityTx,
      assignBoardManager,
      claimBoardIntentEscalationTx,
      createRoomAgentSession,
      getBoardIntent,
      markRoomAgentDeliveryConnected,
      setRoomBoardManagerMode,
      upsertAccount,
    } = dbModule!;
    const { roomId, intentId } = await seedStuckTaskCreateIntent();

    // Simulate the race: after the sweep selected this intent, a manager
    // registered, connected, and took the role before the transaction ran.
    const account = await upsertAccount!({
      provider: "github",
      provider_user_id: "escalation-race-test",
      login: "EmmyMay",
      display_name: "EmmyMay",
    });
    const manager = await createRoomAgentSession!({
      room_id: roomId,
      session_kind: "worker",
      runtime: "codex",
      actor_label: "CedarFern | EmmyMay's agent | Codex",
      agent_key: "EmmyMay/cedar-fern",
      display_name: "CedarFern",
      owner_account_id: account.id,
      owner_label: "EmmyMay",
      ide_label: "Codex",
    });
    if (!hashToken) throw new Error("DB-backed escalation tests require TEST_DB_URL");
    await markRoomAgentDeliveryConnected!({
      room_id: roomId,
      actor_label: "CedarFern | EmmyMay's agent | Codex",
      agent_session_id: manager.session_id,
      session_kind: "worker",
      display_name: "CedarFern",
      credential_fence: {
        kind: "session_token",
        token_hash: hashToken(manager.session_token),
      },
      transport: "long_poll",
    });
    await assignBoardManager!({
      room_id: roomId,
      agent_session_id: manager.session_id,
      assigned_by: "EmmyMay",
    });

    const clientMessageId = `board_intent_escalation:${intentId}`;
    await assert.rejects(
      addMessageWithCreateStatus!(roomId, "letagents", "[status] escalation attempt", {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          assert.equal(
            await claimBoardIntentEscalationTx!(tx, { room_id: roomId, intent_id: intentId }),
            true
          );
          await assertBoardIntentAutoApprovalEligibilityTx!(tx, {
            room_id: roomId,
            proposer_actor_key: "EmmyMay/river-grove",
            cap_window_ms: 60 * 60_000,
            cap_max: 5,
          });
        },
      }),
      (error: Error) => error.name === "BoardIntentAutoApprovalIneligibleError"
    );

    const { rows } = await pool!.query(
      "SELECT number FROM messages WHERE room_id = $1 AND client_message_id = $2",
      [roomId, clientMessageId]
    );
    assert.equal(rows.length, 0, "the announcement must roll back");
    const intent = await getBoardIntent!({ room_id: roomId, intent_id: intentId });
    assert.equal(intent?.status, "pending");
    assert.equal(intent?.escalated_at, null, "the fence must roll back for re-evaluation");

    // Mode change is caught the same way even with the manager gone again.
    await pool!.query("UPDATE board_manager_assignments SET status = 'released', released_at = now() WHERE room_id = $1", [roomId]);
    await setRoomBoardManagerMode!({
      room_id: roomId,
      manager_mode: "intent_required",
      updated_by: "EmmyMay",
    });
    await assert.rejects(
      addMessageWithCreateStatus!(roomId, "letagents", "[status] escalation attempt 2", {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          await assertBoardIntentAutoApprovalEligibilityTx!(tx, {
            room_id: roomId,
            proposer_actor_key: "EmmyMay/river-grove",
            cap_window_ms: 60 * 60_000,
            cap_max: 5,
          });
        },
      }),
      (error: Error) => error.name === "BoardIntentAutoApprovalIneligibleError"
    );
  }
);

test(
  "the rate cap holds under concurrent escalations",
  skipOptions,
  async () => {
    const {
      addMessageWithCreateStatus,
      assertBoardIntentAutoApprovalEligibilityTx,
      boardIntentPayloadForTaskCreate,
      claimBoardIntentEscalationTx,
      createBoardIntent,
      markBoardIntentAutoApprovedTx,
    } = dbModule!;
    const { roomId, intentId: firstId } = await seedStuckTaskCreateIntent();
    const second = await createBoardIntent!({
      room_id: roomId,
      action_type: "task_create",
      payload: boardIntentPayloadForTaskCreate!({ title: "Second stuck task" }),
      proposer_actor_key: "EmmyMay/river-grove",
    });
    await pool!.query(
      "UPDATE board_intents SET created_at = $3, escalation_check_at = $3::timestamptz + interval '10 minutes' WHERE room_id = $1 AND id = $2",
      [roomId, second.id, new Date(Date.now() - 15 * 60_000)]
    );

    // Spend 4 of the 5-per-hour budget directly.
    for (let i = 0; i < 4; i += 1) {
      const spent = await createBoardIntent!({
        room_id: roomId,
        action_type: "task_create",
        payload: boardIntentPayloadForTaskCreate!({ title: `Prior auto approval ${i}` }),
        proposer_actor_key: "EmmyMay/river-grove",
      });
      await pool!.query(
        "UPDATE board_intents SET status = 'used', auto_approved = true, decided_at = now() WHERE room_id = $1 AND id = $2",
        [roomId, spent.id]
      );
    }

    // Two concurrent escalations race for the single remaining budget slot.
    const escalate = (intentId: string) =>
      addMessageWithCreateStatus!(roomId, "letagents", `[status] escalating ${intentId}`, {
        client_message_id: `board_intent_escalation:${intentId}`,
        with_created_message_in_transaction: async (tx) => {
          assert.equal(
            await claimBoardIntentEscalationTx!(tx, { room_id: roomId, intent_id: intentId }),
            true
          );
          await assertBoardIntentAutoApprovalEligibilityTx!(tx, {
            room_id: roomId,
            proposer_actor_key: "EmmyMay/river-grove",
            cap_window_ms: 60 * 60_000,
            cap_max: 5,
          });
          // decided_at must be stamped through tx (markBoardIntentAutoApprovedTx
          // does it) — a pool.query here would deadlock against tx's row lock.
          await markBoardIntentAutoApprovedTx!(tx, { room_id: roomId, intent_id: intentId });
        },
      }).then(
        () => "approved" as const,
        (error: Error) =>
          error.name === "BoardIntentAutoApprovalIneligibleError"
            ? ("capped" as const)
            : Promise.reject(error)
      );

    const outcomes = await Promise.all([escalate(firstId), escalate(second.id)]);
    assert.deepEqual(
      [...outcomes].sort(),
      ["approved", "capped"],
      "exactly one concurrent escalation may take the last budget slot"
    );
  }
);
