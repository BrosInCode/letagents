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
const utilsModule = testDatabaseUrl ? await import("../db/utils.js") : null;
const failoverModule = testDatabaseUrl
  ? await import("../db/coordination/board-manager-failover.js")
  : null;

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

  return { roomId: project.id, sessionA, sessionB, account };
}

async function connectWorker(roomId: string, session: Awaited<ReturnType<typeof seedRoomWithTwoWorkers>>["sessionA"]): Promise<void> {
  await dbModule!.markRoomAgentDeliveryConnected!({
    room_id: roomId,
    actor_label: session.actor_label,
    agent_session_id: session.session_id,
    session_kind: "worker",
    display_name: session.display_name,
    credential_fence: {
      kind: "session_token",
      token_hash: utilsModule!.hashToken(session.session_token),
    },
    transport: "long_poll",
  });
}

test("automatic failover loses its fence when the manager reconnects after selection", skipOptions, async () => {
  const { assignBoardManager, listActiveBoardManagerAssignments, releaseBoardManagerAssignmentTx } = dbModule!;
  const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();
  await Promise.all([connectWorker(roomId, sessionA), connectWorker(roomId, sessionB)]);
  const manager = await assignBoardManager!({
    room_id: roomId,
    agent_session_id: sessionA.session_id,
    assigned_by: "EmmyMay",
  });
  assert.ok(manager);
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [roomId, sessionA.session_id],
  );
  await pool!.query(
    `UPDATE board_manager_assignments SET stall_check_at = now() - interval '1 minute' WHERE id = $1`,
    [manager!.id],
  );
  const claimed = (await listActiveBoardManagerAssignments!({ now: Date.now(), limit: 1 }))[0]!;
  assert.equal(claimed.assignment.id, manager!.id);

  await connectWorker(roomId, sessionA);
  const released = await releaseBoardManagerAssignmentTx!(db!, {
    assignment_id: manager!.id,
    released_by: "letagents:manager_failover",
    reason: "automatic failover",
    claimed_check_at: claimed.claimed_check_at,
    require_unreachable_delivery: true,
  });
  assert.equal(released, null, "a heartbeat after selection must invalidate the due claim and release");
  assert.equal((await dbModule!.getActiveBoardManager!(roomId))?.agent_session_id, sessionA.session_id);
});

test("automatic failover rolls back when the selected successor loses delivery", skipOptions, async () => {
  const { assignBoardManager, listActiveBoardManagerAssignments, promoteBoardManagerTx,
    releaseBoardManagerAssignmentTx } = dbModule!;
  const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();
  await Promise.all([connectWorker(roomId, sessionA), connectWorker(roomId, sessionB)]);
  const manager = await assignBoardManager!({
    room_id: roomId,
    agent_session_id: sessionA.session_id,
    assigned_by: "EmmyMay",
  });
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [roomId, sessionA.session_id],
  );
  await pool!.query(
    `UPDATE board_manager_assignments SET stall_check_at = now() - interval '1 minute' WHERE id = $1`,
    [manager!.id],
  );
  const claimed = (await listActiveBoardManagerAssignments!({ now: Date.now(), limit: 1 }))[0]!;
  assert.ok(claimed.successor_candidates?.some((entry) => entry.candidate.agent_session_id === sessionB.session_id));
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [roomId, sessionB.session_id],
  );

  await assert.rejects(db!.transaction(async (tx) => {
    const released = await releaseBoardManagerAssignmentTx!(tx, {
      assignment_id: manager!.id,
      released_by: "letagents:manager_failover",
      reason: "automatic failover",
      claimed_check_at: claimed.claimed_check_at,
      require_unreachable_delivery: true,
    });
    assert.ok(released);
    const promoted = await promoteBoardManagerTx!(tx, {
      room_id: roomId,
      agent_session_id: sessionB.session_id,
      assigned_by: "letagents:manager_failover",
      require_reachable_delivery: true,
    });
    if (!promoted) throw new Error("successor unavailable");
  }), /successor unavailable/);
  assert.equal((await dbModule!.getActiveBoardManager!(roomId))?.agent_session_id, sessionA.session_id);
});

test("automatic failover waits for an overlapping manager reconnect before release", skipOptions, async () => {
  const { assignBoardManager, listActiveBoardManagerAssignments, promoteBoardManagerTx,
    releaseBoardManagerAssignmentTx } = dbModule!;
  const { lockBoardManagerFailoverDeliveryKeysTx } = failoverModule!;
  const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();
  await Promise.all([connectWorker(roomId, sessionA), connectWorker(roomId, sessionB)]);
  const manager = await assignBoardManager!({
    room_id: roomId, agent_session_id: sessionA.session_id, assigned_by: "EmmyMay",
  });
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [roomId, sessionA.session_id],
  );
  await pool!.query(`UPDATE board_manager_assignments SET stall_check_at = now() - interval '1 minute' WHERE id = $1`, [manager!.id]);
  const claimed = (await listActiveBoardManagerAssignments!({ now: Date.now(), limit: 1 }))[0]!;

  const reconnect = await pool!.connect();
  await reconnect.query("BEGIN");
  try {
    await reconnect.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(concat($1::text, chr(31), $2::text), 0))`,
      [roomId, `agent_session:${sessionA.session_id}`],
    );
    await reconnect.query(
      `UPDATE room_agent_delivery_sessions
          SET active_connection_count = 1,
              reconnect_grace_expires_at = NULL,
              updated_at = now()
        WHERE room_id = $1 AND agent_session_id = $2`,
      [roomId, sessionA.session_id],
    );
    let failoverSettled = false;
    const failover = db!.transaction(async (tx) => {
      await lockBoardManagerFailoverDeliveryKeysTx(tx, {
        room_id: roomId,
        dead_agent_session_id: sessionA.session_id,
        successor_agent_session_id: sessionB.session_id,
      });
      const released = await releaseBoardManagerAssignmentTx!(tx, {
        assignment_id: manager!.id,
        released_by: "letagents:manager_failover",
        reason: "automatic failover",
        claimed_check_at: claimed.claimed_check_at,
        require_unreachable_delivery: true,
      });
      if (!released) return null;
      return promoteBoardManagerTx!(tx, {
        room_id: roomId,
        agent_session_id: sessionB.session_id,
        assigned_by: "letagents:manager_failover",
        require_reachable_delivery: true,
      });
    }).finally(() => { failoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(failoverSettled, false, "failover must wait in the shared delivery lock domain");
    await reconnect.query("COMMIT");
    assert.equal(await failover, null, "the committed reconnect must defeat the stale claim");
  } finally {
    await reconnect.query("ROLLBACK").catch(() => {});
    reconnect.release();
  }
  assert.equal((await dbModule!.getActiveBoardManager!(roomId))?.agent_session_id, sessionA.session_id);
});

test("automatic failover waits for an overlapping successor disconnect before promotion", skipOptions, async () => {
  const { assignBoardManager, listActiveBoardManagerAssignments, promoteBoardManagerTx,
    releaseBoardManagerAssignmentTx } = dbModule!;
  const { lockBoardManagerFailoverDeliveryKeysTx } = failoverModule!;
  const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();
  await Promise.all([connectWorker(roomId, sessionA), connectWorker(roomId, sessionB)]);
  const manager = await assignBoardManager!({
    room_id: roomId, agent_session_id: sessionA.session_id, assigned_by: "EmmyMay",
  });
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [roomId, sessionA.session_id],
  );
  await pool!.query(`UPDATE board_manager_assignments SET stall_check_at = now() - interval '1 minute' WHERE id = $1`, [manager!.id]);
  const claimed = (await listActiveBoardManagerAssignments!({ now: Date.now(), limit: 1 }))[0]!;

  const disconnect = await pool!.connect();
  await disconnect.query("BEGIN");
  try {
    await disconnect.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(concat($1::text, chr(31), $2::text), 0))`,
      [roomId, `agent_session:${sessionB.session_id}`],
    );
    await disconnect.query(
      `UPDATE room_agent_delivery_sessions
          SET active_connection_count = 0,
              reconnect_grace_expires_at = now() - interval '10 minutes',
              updated_at = now() - interval '10 minutes'
        WHERE room_id = $1 AND agent_session_id = $2`,
      [roomId, sessionB.session_id],
    );
    let failoverSettled = false;
    const failover = db!.transaction(async (tx) => {
      await lockBoardManagerFailoverDeliveryKeysTx(tx, {
        room_id: roomId,
        dead_agent_session_id: sessionA.session_id,
        successor_agent_session_id: sessionB.session_id,
      });
      const released = await releaseBoardManagerAssignmentTx!(tx, {
        assignment_id: manager!.id,
        released_by: "letagents:manager_failover",
        reason: "automatic failover",
        claimed_check_at: claimed.claimed_check_at,
        require_unreachable_delivery: true,
      });
      assert.ok(released);
      const promoted = await promoteBoardManagerTx!(tx, {
        room_id: roomId,
        agent_session_id: sessionB.session_id,
        assigned_by: "letagents:manager_failover",
        require_reachable_delivery: true,
      });
      if (!promoted) throw new Error("successor unavailable");
      return promoted;
    }).finally(() => { failoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(failoverSettled, false, "failover must wait for the in-flight successor transition");
    await disconnect.query("COMMIT");
    await assert.rejects(failover, /successor unavailable/);
  } finally {
    await disconnect.query("ROLLBACK").catch(() => {});
    disconnect.release();
  }
  assert.equal((await dbModule!.getActiveBoardManager!(roomId))?.agent_session_id, sessionA.session_id);
});

test("automatic failover waits for an overlapping successor session end before promotion", skipOptions, async () => {
  const { assignBoardManager, listActiveBoardManagerAssignments, promoteBoardManagerTx,
    releaseBoardManagerAssignmentTx } = dbModule!;
  const { lockBoardManagerFailoverDeliveryKeysTx } = failoverModule!;
  const { roomId, sessionA, sessionB } = await seedRoomWithTwoWorkers();
  await Promise.all([connectWorker(roomId, sessionA), connectWorker(roomId, sessionB)]);
  const manager = await assignBoardManager!({
    room_id: roomId, agent_session_id: sessionA.session_id, assigned_by: "EmmyMay",
  });
  await pool!.query(
    `UPDATE room_agent_delivery_sessions
        SET active_connection_count = 0,
            reconnect_grace_expires_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      WHERE room_id = $1 AND agent_session_id = $2`,
    [roomId, sessionA.session_id],
  );
  await pool!.query(`UPDATE board_manager_assignments SET stall_check_at = now() - interval '1 minute' WHERE id = $1`, [manager!.id]);
  const claimed = (await listActiveBoardManagerAssignments!({ now: Date.now(), limit: 1 }))[0]!;

  const ending = await pool!.connect();
  await ending.query("BEGIN");
  try {
    // Match endRoomAgentSession's production order: session row first, then
    // the delivery advisory key and projection retirement.
    await ending.query(`UPDATE room_agent_sessions SET ended_at = now() WHERE session_id = $1`, [sessionB.session_id]);
    let failoverSettled = false;
    const failover = db!.transaction(async (tx) => {
      await lockBoardManagerFailoverDeliveryKeysTx(tx, {
        room_id: roomId,
        dead_agent_session_id: sessionA.session_id,
        successor_agent_session_id: sessionB.session_id,
      });
      const released = await releaseBoardManagerAssignmentTx!(tx, {
        assignment_id: manager!.id,
        released_by: "letagents:manager_failover",
        reason: "automatic failover",
        claimed_check_at: claimed.claimed_check_at,
        require_unreachable_delivery: true,
      });
      assert.ok(released);
      const promoted = await promoteBoardManagerTx!(tx, {
        room_id: roomId,
        agent_session_id: sessionB.session_id,
        assigned_by: "letagents:manager_failover",
        require_reachable_delivery: true,
      });
      if (!promoted) throw new Error("successor unavailable");
      return promoted;
    }).finally(() => { failoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(failoverSettled, false, "failover must wait on the in-flight session row transition");

    await ending.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(concat($1::text, chr(31), $2::text), 0))`,
      [roomId, `agent_session:${sessionB.session_id}`],
    );
    await ending.query(
      `UPDATE room_agent_delivery_sessions
          SET active_connection_count = 0,
              reconnect_grace_expires_at = now(),
              updated_at = now()
        WHERE room_id = $1 AND agent_session_id = $2`,
      [roomId, sessionB.session_id],
    );
    await ending.query("COMMIT");
    await assert.rejects(failover, /successor unavailable/);
  } finally {
    await ending.query("ROLLBACK").catch(() => {});
    ending.release();
  }
  const successor = (await pool!.query<{ ended: boolean }>(
    `SELECT ended_at IS NOT NULL AS ended FROM room_agent_sessions WHERE session_id = $1`,
    [sessionB.session_id],
  )).rows[0];
  assert.equal(successor?.ended, true);
  assert.equal((await dbModule!.getActiveBoardManager!(roomId))?.agent_session_id, sessionA.session_id);
});

test("multi-session replacement and failover share one canonical session row lock order", skipOptions, async () => {
  const { createFencedRoomAgentSession, createRoomAgentSession } = dbModule!;
  const { lockBoardManagerFailoverDeliveryKeysTx } = failoverModule!;
  const { roomId, account } = await seedRoomWithTwoWorkers();
  const sharedIdentity = {
    room_id: roomId,
    session_kind: "worker" as const,
    runtime: "codex",
    actor_label: "LockOrder | EmmyMay's agent | Codex",
    agent_key: "EmmyMay/lock-order",
    agent_instance_id: "lock-order-instance",
    display_name: "LockOrder",
    owner_account_id: account.id,
    owner_label: "EmmyMay",
    ide_label: "Codex",
  };
  const first = await createRoomAgentSession!(sharedIdentity);
  const second = await createRoomAgentSession!({
    ...sharedIdentity,
    actor_label: "LockOrder Legacy | EmmyMay's agent | Codex",
    display_name: "LockOrder Legacy",
  });
  const [lowerId, higherId] = [first.session_id, second.session_id].sort();
  assert.notEqual(lowerId, higherId);
  // Deliberately invert metadata preference relative to the canonical ID
  // order. The pre-fix replacement query requested higherId first because it
  // was newer, while failover requested lowerId first, creating a deadlock.
  await pool!.query(
    `UPDATE room_agent_sessions
        SET last_seen_at = CASE WHEN session_id = $2
          THEN now() - interval '20 minutes'
          ELSE now() - interval '10 minutes'
        END
      WHERE session_id = ANY($1::text[])`,
    [[lowerId, higherId], lowerId],
  );

  const higherBlocker = await pool!.connect();
  await higherBlocker.query("BEGIN");
  try {
    await higherBlocker.query(
      `SELECT session_id FROM room_agent_sessions WHERE session_id = $1 FOR UPDATE`,
      [higherId],
    );
    let replacementSettled = false;
    const replacement = createFencedRoomAgentSession!(sharedIdentity)
      .finally(() => { replacementSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replacementSettled, false, "replacement must be waiting for the blocked higher-id row");
    const lockProbe = await pool!.connect();
    try {
      await lockProbe.query("BEGIN");
      await assert.rejects(
        lockProbe.query(
          `SELECT session_id FROM room_agent_sessions WHERE session_id = $1 FOR UPDATE NOWAIT`,
          [lowerId],
        ),
        (error: unknown) => (error as { code?: string }).code === "55P03",
        "replacement must acquire the lower-id row before waiting on the higher-id row",
      );
    } finally {
      await lockProbe.query("ROLLBACK").catch(() => {});
      lockProbe.release();
    }

    let failoverSettled = false;
    const failover = db!.transaction(async (tx) => {
      await lockBoardManagerFailoverDeliveryKeysTx(tx, {
        room_id: roomId,
        dead_agent_session_id: lowerId,
        successor_agent_session_id: higherId,
      });
    }).finally(() => { failoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(failoverSettled, false, "failover must queue behind replacement's lower-id row lock");

    await higherBlocker.query("COMMIT");
    await Promise.all([replacement, failover]);
  } finally {
    await higherBlocker.query("ROLLBACK").catch(() => {});
    higherBlocker.release();
  }
});

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
    await endRoomAgentSession!({ session_id: sessionB.session_id });
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
