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
const createProjectWithName = dbModule?.createProjectWithName;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
const markRoomAgentDeliveryDisconnected = dbModule?.markRoomAgentDeliveryDisconnected;
const listLivenessAnnouncementCandidates = dbModule?.listLivenessAnnouncementCandidates;
const markAgentOfflineAnnounced = dbModule?.markAgentOfflineAnnounced;
const markAgentRecoveryAnnounced = dbModule?.markAgentRecoveryAnnounced;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed liveness tests require TEST_DB_URL");
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

const ACTOR_LABEL = "FieldSignal | EmmyMay's agent | Codex";

async function seedDisconnectedWorker(): Promise<{ roomId: string; deliveryKey: string }> {
  const project = await createProjectWithName!("liveness-announcements-test");
  await markRoomAgentDeliveryConnected!({
    room_id: project.id,
    actor_label: ACTOR_LABEL,
    session_kind: "worker",
    display_name: "FieldSignal",
    transport: "long_poll",
  });
  const session = await markRoomAgentDeliveryDisconnected!({
    room_id: project.id,
    actor_label: ACTOR_LABEL,
  });
  assert.ok(session);
  return { roomId: project.id, deliveryKey: session!.delivery_key };
}

test(
  "disconnected workers surface as liveness candidates",
  { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed liveness tests" : false },
  async () => {
    const { roomId, deliveryKey } = await seedDisconnectedWorker();

    const candidates = await listLivenessAnnouncementCandidates!();
    const match = candidates.find(
      (candidate) =>
        candidate.session.room_id === roomId && candidate.session.delivery_key === deliveryKey
    );
    assert.ok(match, "expected the disconnected worker to be listed");
    assert.equal(match!.agent_session_ended_at, null);
    assert.equal(match!.session.offline_announced_at, null);
    assert.equal(match!.session.active_connection_count, 0);
  }
);

test(
  "offline and recovery announcement claims are exactly-once per marker value",
  { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed liveness tests" : false },
  async () => {
    const { roomId, deliveryKey } = await seedDisconnectedWorker();

    const firstClaim = await markAgentOfflineAnnounced!({
      room_id: roomId,
      delivery_key: deliveryKey,
      expected_offline_announced_at: null,
    });
    const duplicateClaim = await markAgentOfflineAnnounced!({
      room_id: roomId,
      delivery_key: deliveryKey,
      expected_offline_announced_at: null,
    });
    assert.equal(firstClaim, true);
    assert.equal(duplicateClaim, false);

    const recoveryClaim = await markAgentRecoveryAnnounced!({
      room_id: roomId,
      delivery_key: deliveryKey,
      expected_recovery_announced_at: null,
    });
    const duplicateRecoveryClaim = await markAgentRecoveryAnnounced!({
      room_id: roomId,
      delivery_key: deliveryKey,
      expected_recovery_announced_at: null,
    });
    assert.equal(recoveryClaim, true);
    assert.equal(duplicateRecoveryClaim, false);

    // A fresh outage epoch (new marker value read back) can be claimed again.
    const [candidate] = (await listLivenessAnnouncementCandidates!()).filter(
      (entry) => entry.session.room_id === roomId && entry.session.delivery_key === deliveryKey
    );
    assert.ok(candidate?.session.offline_announced_at);
    const reclaim = await markAgentOfflineAnnounced!({
      room_id: roomId,
      delivery_key: deliveryKey,
      expected_offline_announced_at: candidate!.session.offline_announced_at,
    });
    assert.equal(reclaim, true);
  }
);
