import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { selectLivenessTransitions } from "../rooms/liveness-sweep.js";

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
const getLivenessAnnouncementCandidate = dbModule?.getLivenessAnnouncementCandidate;
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
const skipOptions = { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed liveness tests" : false };

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function seedConnectedWorker(): Promise<string> {
  const project = await createProjectWithName!("liveness-announcements-test");
  await markRoomAgentDeliveryConnected!({
    room_id: project.id,
    actor_label: ACTOR_LABEL,
    session_kind: "worker",
    display_name: "FieldSignal",
    transport: "long_poll",
  });
  return project.id;
}

/** Rewind delivery timestamps so freshness windows treat the row as aged. */
async function backdateDelivery(
  roomId: string,
  deliveryKey: string,
  fields: Partial<Record<"updated_at" | "last_disconnected_at" | "reconnect_grace_expires_at", number>>
): Promise<void> {
  const assignments = Object.entries(fields)
    .map(([column], index) => `${column} = $${index + 3}`)
    .join(", ");
  await pool!.query(
    `UPDATE room_agent_delivery_sessions SET ${assignments} WHERE room_id = $1 AND delivery_key = $2`,
    [roomId, deliveryKey, ...Object.values(fields).map((minutesAgo) => new Date(Date.now() - minutesAgo! * 60_000))]
  );
}

async function fetchCandidate(roomId: string, deliveryKey: string) {
  const candidate = await getLivenessAnnouncementCandidate!({
    room_id: roomId,
    delivery_key: deliveryKey,
  });
  assert.ok(candidate, "expected the delivery session to exist");
  return candidate!;
}

test(
  "journey: offline announce, recovery, then a second clean disconnect re-announces",
  skipOptions,
  async () => {
    const roomId = await seedConnectedWorker();

    // First death: clean disconnect 30 minutes ago, announced 28 minutes ago —
    // explicit stamps keep the marker causally after its outage epoch, the way
    // real sweeps behave.
    const disconnected = await markRoomAgentDeliveryDisconnected!({
      room_id: roomId,
      actor_label: ACTOR_LABEL,
    });
    const deliveryKey = disconnected!.delivery_key;
    await backdateDelivery(roomId, deliveryKey, {
      updated_at: 30,
      last_disconnected_at: 30,
      reconnect_grace_expires_at: 30,
    });

    const listed = (await listLivenessAnnouncementCandidates!()).find(
      (entry) => entry.session.room_id === roomId && entry.session.delivery_key === deliveryKey
    );
    assert.ok(listed, "expected the disconnected worker to be listed");
    assert.equal(listed!.agent_session_ended_at, null);

    let [transition] = selectLivenessTransitions({ candidates: [listed!] });
    assert.equal(transition?.kind, "offline");
    assert.equal(
      await markAgentOfflineAnnounced!({
        room_id: roomId,
        delivery_key: deliveryKey,
        announced_at: isoMinutesAgo(28),
      }),
      true
    );

    // Announced outage stays quiet while still dead.
    assert.deepEqual(
      selectLivenessTransitions({ candidates: [await fetchCandidate(roomId, deliveryKey)] }),
      []
    );

    // Recovery: reconnect flips the transition to "recovered"; mark it.
    await markRoomAgentDeliveryConnected!({
      room_id: roomId,
      actor_label: ACTOR_LABEL,
      session_kind: "worker",
      display_name: "FieldSignal",
      transport: "long_poll",
    });
    [transition] = selectLivenessTransitions({ candidates: [await fetchCandidate(roomId, deliveryKey)] });
    assert.equal(transition?.kind, "recovered");
    assert.equal(await markAgentRecoveryAnnounced!({ room_id: roomId, delivery_key: deliveryKey }), true);
    assert.deepEqual(
      selectLivenessTransitions({ candidates: [await fetchCandidate(roomId, deliveryKey)] }),
      []
    );

    // Second death: another clean disconnect starts a new epoch and re-announces.
    await markRoomAgentDeliveryDisconnected!({ room_id: roomId, actor_label: ACTOR_LABEL });
    await backdateDelivery(roomId, deliveryKey, {
      updated_at: 6,
      last_disconnected_at: 6,
      reconnect_grace_expires_at: 6,
    });
    const relisted = (await listLivenessAnnouncementCandidates!()).find(
      (entry) => entry.session.room_id === roomId && entry.session.delivery_key === deliveryKey
    );
    assert.ok(relisted, "expected the re-disconnected worker to be listed again");
    [transition] = selectLivenessTransitions({ candidates: [relisted!] });
    assert.equal(transition?.kind, "offline");
  }
);

test(
  "journey: offline announce, recovery, then a stale-heartbeat death re-announces",
  skipOptions,
  async () => {
    const roomId = await seedConnectedWorker();
    const disconnected = await markRoomAgentDeliveryDisconnected!({
      room_id: roomId,
      actor_label: ACTOR_LABEL,
    });
    const deliveryKey = disconnected!.delivery_key;
    await backdateDelivery(roomId, deliveryKey, {
      updated_at: 30,
      last_disconnected_at: 30,
      reconnect_grace_expires_at: 30,
    });
    assert.equal(
      await markAgentOfflineAnnounced!({
        room_id: roomId,
        delivery_key: deliveryKey,
        announced_at: isoMinutesAgo(28),
      }),
      true
    );

    // Recovery clears last_disconnected_at (reconnect) and gets announced.
    await markRoomAgentDeliveryConnected!({
      room_id: roomId,
      actor_label: ACTOR_LABEL,
      session_kind: "worker",
      display_name: "FieldSignal",
      transport: "long_poll",
    });
    assert.equal(await markAgentRecoveryAnnounced!({ room_id: roomId, delivery_key: deliveryKey }), true);

    // Second death: the process freezes — the socket never closes, so
    // last_disconnected_at stays NULL and only the heartbeat goes stale.
    await backdateDelivery(roomId, deliveryKey, { updated_at: 5 });

    const relisted = (await listLivenessAnnouncementCandidates!()).find(
      (entry) => entry.session.room_id === roomId && entry.session.delivery_key === deliveryKey
    );
    assert.ok(relisted, "dead-socket death after a recovery must re-enter the candidate list");
    assert.equal(relisted!.session.last_disconnected_at, null);

    const [transition] = selectLivenessTransitions({ candidates: [relisted!] });
    assert.equal(transition?.kind, "offline");
  }
);

test(
  "message-level idempotency: replaying an announcement client_message_id creates no duplicate",
  skipOptions,
  async () => {
    const roomId = await seedConnectedWorker();
    const { addMessageWithCreateStatus } = dbModule!;
    const clientMessageId = "agent_liveness:offline:agent_session:test:epoch";

    const first = await addMessageWithCreateStatus!(roomId, "letagents", "[status] X appears to be offline", {
      client_message_id: clientMessageId,
    });
    const replay = await addMessageWithCreateStatus!(roomId, "letagents", "[status] X appears to be offline", {
      client_message_id: clientMessageId,
    });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.message.id, first.message.id);
  }
);

test(
  "announcement message and marker commit atomically — a marker failure rolls the message back",
  skipOptions,
  async () => {
    const roomId = await seedConnectedWorker();
    const { addMessageWithCreateStatus } = dbModule!;
    const disconnected = await markRoomAgentDeliveryDisconnected!({
      room_id: roomId,
      actor_label: ACTOR_LABEL,
    });
    const deliveryKey = disconnected!.delivery_key;
    await backdateDelivery(roomId, deliveryKey, {
      updated_at: 30,
      last_disconnected_at: 30,
      reconnect_grace_expires_at: 30,
    });
    const clientMessageId = `agent_liveness:offline:${deliveryKey}:epoch-1`;

    // Reviewer scenario: message persisted, marker write fails. With the
    // marker inside the message transaction this partial state cannot
    // exist — the failure rolls the message back too.
    await assert.rejects(
      addMessageWithCreateStatus!(roomId, "letagents", "[status] FieldSignal appears to be offline", {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async () => {
          throw new Error("marker write failed");
        },
      })
    );
    const { rows: orphanRows } = await pool!.query(
      "SELECT number FROM messages WHERE room_id = $1 AND client_message_id = $2",
      [roomId, clientMessageId]
    );
    assert.equal(orphanRows.length, 0, "a failed marker write must roll back the message");
    let candidate = await fetchCandidate(roomId, deliveryKey);
    assert.equal(candidate.session.offline_announced_at, null);

    // Worker reconnects before the retry: nothing was announced, so the
    // selector correctly proposes neither offline nor recovered.
    await markRoomAgentDeliveryConnected!({
      room_id: roomId,
      actor_label: ACTOR_LABEL,
      session_kind: "worker",
      display_name: "FieldSignal",
      transport: "long_poll",
    });
    assert.deepEqual(
      selectLivenessTransitions({ candidates: [await fetchCandidate(roomId, deliveryKey)] }),
      []
    );

    // The success path commits both together, and a replay of the same
    // client_message_id does not rerun the marker side effect.
    await markRoomAgentDeliveryDisconnected!({ room_id: roomId, actor_label: ACTOR_LABEL });
    await backdateDelivery(roomId, deliveryKey, {
      updated_at: 5,
      last_disconnected_at: 5,
      reconnect_grace_expires_at: 5,
    });
    let hookRuns = 0;
    const announce = () =>
      addMessageWithCreateStatus!(roomId, "letagents", "[status] FieldSignal appears to be offline", {
        client_message_id: `agent_liveness:offline:${deliveryKey}:epoch-2`,
        with_created_message_in_transaction: async (tx) => {
          hookRuns += 1;
          await markAgentOfflineAnnounced!(
            { room_id: roomId, delivery_key: deliveryKey, announced_at: isoMinutesAgo(4) },
            tx
          );
        },
      });

    const created = await announce();
    assert.equal(created.created, true);
    candidate = await fetchCandidate(roomId, deliveryKey);
    assert.ok(candidate.session.offline_announced_at, "marker must be set with the message");

    const replay = await announce();
    assert.equal(replay.created, false);
    assert.equal(hookRuns, 1, "the replay path must not rerun the atomic side effect");
  }
);

test(
  "runtime evidence from the liveness ledger suppresses and reclassifies announcements",
  skipOptions,
  async () => {
    const {
      createRoomAgentSession,
      markRoomAgentDeliveryConnected,
      markRoomAgentDeliveryDisconnected,
      upsertAccount,
      upsertRoomAgentLivenessObservation,
      getLivenessAnnouncementCandidate,
    } = dbModule!;
    const { createProjectWithName } = dbModule!;
    const project = await createProjectWithName!("liveness-runtime-evidence-test");

    const account = await upsertAccount!({
      provider: "github",
      provider_user_id: "runtime-evidence-test",
      login: "EmmyMay",
      display_name: "EmmyMay",
    });
    const session = await createRoomAgentSession!({
      room_id: project.id,
      session_kind: "worker",
      runtime: "claude-code",
      actor_label: ACTOR_LABEL,
      agent_key: "EmmyMay/field-signal",
      display_name: "FieldSignal",
      owner_account_id: account.id,
      owner_label: "EmmyMay",
      ide_label: "Codex",
    });
    await markRoomAgentDeliveryConnected!({
      room_id: project.id,
      actor_label: ACTOR_LABEL,
      agent_session_id: session.session_id,
      session_kind: "worker",
      display_name: "FieldSignal",
      transport: "long_poll",
    });
    const disconnected = await markRoomAgentDeliveryDisconnected!({
      room_id: project.id,
      actor_label: ACTOR_LABEL,
      agent_session_id: session.session_id,
    });
    const deliveryKey = disconnected!.delivery_key;
    await backdateDelivery(project.id, deliveryKey, {
      updated_at: 5,
      last_disconnected_at: 5,
      reconnect_grace_expires_at: 5,
    });

    // Fresh tool activity: the channel is silent but the runtime is working.
    await upsertRoomAgentLivenessObservation!({
      room_id: project.id,
      agent_session_id: session.session_id,
      last_observed_at: isoMinutesAgo(1),
      last_tool_call_at: isoMinutesAgo(1),
    });
    let candidate = await getLivenessAnnouncementCandidate!({
      room_id: project.id,
      delivery_key: deliveryKey,
    });
    assert.ok(candidate?.runtime_last_active_at, "the ledger evidence must surface on the candidate");
    assert.deepEqual(
      selectLivenessTransitions({ candidates: [candidate!] }),
      [],
      "an active runtime suppresses the offline announcement"
    );

    // Stale runtime evidence: now it is a real death, classified as such.
    await pool!.query(
      "UPDATE room_agent_liveness_observations SET last_observed_at = $2, last_tool_call_at = $2 WHERE agent_session_id = $1",
      [session.session_id, new Date(Date.now() - 20 * 60_000)]
    );
    candidate = await getLivenessAnnouncementCandidate!({
      room_id: project.id,
      delivery_key: deliveryKey,
    });
    const [transition] = selectLivenessTransitions({ candidates: [candidate!] });
    assert.equal(transition?.kind, "offline");
    assert.equal(transition?.runtime_evidence, "stale");
  }
);
