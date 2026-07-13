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

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed failover tests require TEST_DB_URL");
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

const skipOptions = { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed failover tests" : false };

async function seedRoomWithTwoWorkers() {
  const {
    createProjectWithName,
    createRoomAgentSession,
    upsertAccount,
  } = dbModule!;
  const account = await upsertAccount!({
    provider: "github",
    provider_user_id: "failover-test",
    login: "EmmyMay",
    display_name: "EmmyMay",
  });
  const project = await createProjectWithName!("board-manager-failover-test");

  const sessionA = await createRoomAgentSession!({
    room_id: project.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: "FieldSignal | EmmyMay's agent | Codex",
    agent_key: "EmmyMay/field-signal",
    display_name: "FieldSignal",
    owner_account_id: account.id,
    owner_label: "EmmyMay",
    ide_label: "Codex",
  });
  const sessionB = await createRoomAgentSession!({
    room_id: project.id,
    session_kind: "worker",
    runtime: "claude-code",
    actor_label: "RiverGrove | EmmyMay's agent | Claude Code",
    agent_key: "EmmyMay/river-grove",
    display_name: "RiverGrove",
    owner_account_id: account.id,
    owner_label: "EmmyMay",
    ide_label: "Claude Code",
  });

  return { roomId: project.id, sessionA, sessionB };
}

test(
  "atomic failover: announcement, fenced release, and promotion commit together",
  skipOptions,
  async () => {
    const {
      addMessageWithCreateStatus,
      assignBoardManager,
      getActiveBoardManager,
      promoteBoardManagerTx,
      releaseBoardManagerAssignmentTx,
      shouldRequireBoardIntent,
    } = dbModule!;
    const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();

    const deadManager = await assignBoardManager!({
      room_id: roomId,
      agent_session_id: sessionA.session_id,
      assigned_by: "EmmyMay",
    });
    assert.ok(deadManager);
    assert.equal((await getActiveBoardManager!(roomId))?.agent_session_id, sessionA.session_id);
    assert.equal(await shouldRequireBoardIntent!({ room_id: roomId }), true);

    const clientMessageId = `board_manager_failover:${deadManager!.id}`;
    const failover = await addMessageWithCreateStatus!(
      roomId,
      "letagents",
      "[status] FieldSignal appears to be offline. RiverGrove has been promoted.",
      {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          const released = await releaseBoardManagerAssignmentTx!(tx, {
            assignment_id: deadManager!.id,
            released_by: "letagents:manager_failover",
            reason: "Board Manager went offline; automatic failover.",
          });
          assert.ok(released, "fence must win on the first failover");
          const promoted = await promoteBoardManagerTx!(tx, {
            room_id: roomId,
            agent_session_id: sessionB.session_id,
            assigned_by: "letagents:manager_failover",
          });
          assert.ok(promoted, "live successor must be promotable");
        },
      }
    );
    assert.equal(failover.created, true);

    // Zombie fencing: the room's single source of manager authority now
    // resolves to the successor, so a resurrected old manager fails the
    // active-assignment check that authorizeBoardDecision performs.
    const activeManager = await getActiveBoardManager!(roomId);
    assert.equal(activeManager?.agent_session_id, sessionB.session_id);
    assert.notEqual(activeManager?.agent_session_id, sessionA.session_id);
    assert.equal(await shouldRequireBoardIntent!({ room_id: roomId }), true);

    // The fence is exactly-once: replaying the release loses.
    const replayedRelease = await releaseBoardManagerAssignmentTx!(db!, {
      assignment_id: deadManager!.id,
      released_by: "letagents:manager_failover",
      reason: "replay",
    });
    assert.equal(replayedRelease, null);

    // Replaying the whole announcement dedupes without re-running the hook.
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
  "a failed promotion rolls back the announcement and leaves the old manager active",
  skipOptions,
  async () => {
    const {
      addMessageWithCreateStatus,
      assignBoardManager,
      endRoomAgentSession,
      getActiveBoardManager,
      promoteBoardManagerTx,
      releaseBoardManagerAssignmentTx,
    } = dbModule!;
    const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();

    const manager = await assignBoardManager!({
      room_id: roomId,
      agent_session_id: sessionA.session_id,
      assigned_by: "EmmyMay",
    });
    assert.ok(manager);

    // The successor dies between selection and the transaction: promotion
    // returns null, the transaction aborts, and neither the message nor the
    // release survives.
    await endRoomAgentSession!(sessionB.session_id);
    const clientMessageId = `board_manager_failover:${manager!.id}`;
    await assert.rejects(
      addMessageWithCreateStatus!(roomId, "letagents", "[status] failover attempt", {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          const released = await releaseBoardManagerAssignmentTx!(tx, {
            assignment_id: manager!.id,
            released_by: "letagents:manager_failover",
            reason: "Board Manager went offline; automatic failover.",
          });
          assert.ok(released);
          const promoted = await promoteBoardManagerTx!(tx, {
            room_id: roomId,
            agent_session_id: sessionB.session_id,
            assigned_by: "letagents:manager_failover",
          });
          if (!promoted) {
            throw new Error("successor unavailable");
          }
        },
      })
    );

    const { rows } = await pool!.query(
      "SELECT number FROM messages WHERE room_id = $1 AND client_message_id = $2",
      [roomId, clientMessageId]
    );
    assert.equal(rows.length, 0, "the announcement must roll back with the failed failover");
    assert.equal(
      (await getActiveBoardManager!(roomId))?.agent_session_id,
      sessionA.session_id,
      "the release must roll back too — the old manager stays assigned"
    );
  }
);

test(
  "manager_failover setting persists through settings writes and defaults to auto",
  skipOptions,
  async () => {
    const { createProjectWithName, getRoomBoardSettings, setRoomBoardManagerMode } = dbModule!;
    const project = await createProjectWithName!("board-failover-settings-test");

    assert.equal((await getRoomBoardSettings!(project.id)).manager_failover, "auto");

    const announced = await setRoomBoardManagerMode!({
      room_id: project.id,
      manager_mode: "manager_optional",
      manager_failover: "announce",
      updated_by: "EmmyMay",
    });
    assert.equal(announced.manager_failover, "announce");

    // Updating only the mode leaves the failover policy untouched.
    const modeOnly = await setRoomBoardManagerMode!({
      room_id: project.id,
      manager_mode: "intent_required",
      updated_by: "EmmyMay",
    });
    assert.equal(modeOnly.manager_mode, "intent_required");
    assert.equal(modeOnly.manager_failover, "announce");
  }
);
