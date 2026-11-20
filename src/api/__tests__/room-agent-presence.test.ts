import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const schemaModule = testDatabaseUrl ? await import("../db/schema.js") : null;
const agentPresenceModule = await import("../../shared/agent-presence.js");
const roomAgentActivityModule = await import("../../shared/room-agent-activity.js");
type RoomAgentDeliveryCredentialFence = import("../../shared/agent-presence.js").RoomAgentDeliveryCredentialFence;
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const createProjectWithName = dbModule?.createProjectWithName;
const endRoomAgentSession = dbModule?.endRoomAgentSession;
const getRoomAgentPresence = dbModule?.getRoomAgentPresence;
const getRoomAgentPresenceSnapshot = dbModule?.getRoomAgentPresenceSnapshot;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
const markRoomAgentDeliveryDisconnected = dbModule?.markRoomAgentDeliveryDisconnected;
const markRoomAgentDeliveryHeartbeat = dbModule?.markRoomAgentDeliveryHeartbeat;
const pruneStaleRoomAgentDeliveryInstances = dbModule?.pruneStaleRoomAgentDeliveryInstances;
const upsertDesktopRoomAgentDeliveryHeartbeat = dbModule?.upsertDesktopRoomAgentDeliveryHeartbeat;
const upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat = dbModule?.upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat;
const setRoomLiveAgentSuppressed = dbModule?.setRoomLiveAgentSuppressed;
const upsertAccount = dbModule?.upsertAccount;
const upsertRoomAgentLivenessObservation = dbModule?.upsertRoomAgentLivenessObservation;
const upsertRoomAgentPresence = dbModule?.upsertRoomAgentPresence;
const recordNativeHarnessActivity = dbModule?.recordNativeHarnessActivity;
const getRoomAgentDeliverySessions = dbModule?.getRoomAgentDeliverySessions;
const room_agent_delivery_sessions = schemaModule?.room_agent_delivery_sessions;
const deliveryHelpersModule = testDatabaseUrl ? await import("../db/presence/helpers.js") : null;
const {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS,
  ROOM_AGENT_HEARTBEAT_WRITE_COALESCE_MS,
} = agentPresenceModule;
const { RECENTLY_OFFLINE_MAX_AGENTS, RECENTLY_OFFLINE_WINDOW_MS } = roomAgentActivityModule;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  if (!pool) {
    throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error("database did not become ready in time");
}

async function resetDatabase(): Promise<void> {
  if (!db || !pool) {
    throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
  }

  await waitForDatabaseReady();
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

if (!requiresDatabase) {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.after(async () => {
    await pool?.end();
  });
}

test(
  "fresh status-only room presence stays out of the reachable live roster",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !getRoomAgentPresence || !getRoomAgentPresenceSnapshot || !upsertRoomAgentPresence) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: "MapleRidge | EmmyMay's agent | Agent",
      agent_key: "EmmyMay/mapleridge",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Agent",
      status: "working",
      status_text: "working on task_58",
    });

    assert.deepEqual(await getRoomAgentPresence(room.id), []);

    const snapshot = await getRoomAgentPresenceSnapshot(room.id);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.actor_label, "MapleRidge | EmmyMay's agent | Agent");
    assert.equal(snapshot[0]?.status, "working");
    assert.equal(snapshot[0]?.status_text, "working on task_58");
    assert.equal(snapshot[0]?.freshness, "stale");
    assert.equal(snapshot[0]?.activity_state, "offline");
    assert.deepEqual(snapshot[0]?.source_flags, ["presence"]);
  }
);

test(
  "upsertRoomAgentPresence updates an existing agent row instead of duplicating it",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !getRoomAgentPresence || !getRoomAgentPresenceSnapshot || !upsertRoomAgentPresence) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: "MapleRidge | EmmyMay's agent | Agent",
      agent_key: "EmmyMay/mapleridge",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Agent",
      status: "idle",
      status_text: "available in room",
    });

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: "MapleRidge | EmmyMay's agent | Agent",
      agent_key: "EmmyMay/mapleridge",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Agent",
      status: "reviewing",
      status_text: "reviewing PR #146",
    });

    assert.deepEqual(await getRoomAgentPresence(room.id), []);

    const snapshot = await getRoomAgentPresenceSnapshot(room.id);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.status, "reviewing");
    assert.equal(snapshot[0]?.status_text, "reviewing PR #146");
    assert.equal(snapshot[0]?.activity_state, "offline");
  }
);

test(
  "presence snapshots attach session liveness to status-only worker sessions",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !createRoomAgentSession ||
      !getRoomAgentPresence ||
      !getRoomAgentPresenceSnapshot ||
      !upsertAccount ||
      !upsertRoomAgentLivenessObservation ||
      !upsertRoomAgentPresence
    ) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const actorLabel = "MapleRidge | EmmyMay's agent | Codex";
    const owner = await upsertAccount({
      provider: "github",
      provider_user_id: "31524469",
      login: "EmmyMay",
      display_name: "EmmyMay",
    });
    const agentSession = await createRoomAgentSession({
      room_id: room.id,
      session_kind: "worker",
      runtime: "codex",
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      agent_instance_id: "instance-status-only-worker",
      display_name: "MapleRidge",
      owner_account_id: owner.id,
      owner_label: "EmmyMay",
      ide_label: "Codex",
    });

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      agent_session_id: agentSession.session_id,
      session_kind: "worker",
      runtime: "codex",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      status: "working",
      status_text: "working without a delivery stream",
    });
    await upsertRoomAgentLivenessObservation({
      room_id: room.id,
      agent_session_id: agentSession.session_id,
      source: "agent_session",
      host_kind: "macos",
      liveness_capability: "session_activity",
      last_observed_at: "2026-05-08T12:00:00.000Z",
    });

    assert.deepEqual(await getRoomAgentPresence(room.id), []);

    const snapshot = await getRoomAgentPresenceSnapshot(room.id);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.actor_label, actorLabel);
    assert.equal(snapshot[0]?.session_kind, "worker");
    assert.equal(snapshot[0]?.activity_state, "offline");
    assert.deepEqual(snapshot[0]?.source_flags, ["presence"]);
    assert.equal(snapshot[0]?.liveness_observation?.agent_session_id, agentSession.session_id);
    const lastObservedAt = snapshot[0]?.liveness_observation?.last_observed_at;
    assert.ok(lastObservedAt);
    assert.equal(new Date(lastObservedAt).toISOString(), "2026-05-08T12:00:00.000Z");
  }
);

test(
  "live presence snapshots exclude ended workers while history retains their observations",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !createRoomAgentSession ||
      !endRoomAgentSession ||
      !getRoomAgentPresence ||
      !getRoomAgentPresenceSnapshot ||
      !markRoomAgentDeliveryConnected ||
      !upsertAccount ||
      !upsertRoomAgentLivenessObservation
    ) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const actorLabel = "CedarMeadow | EmmyMay's agent | Codex";
    const owner = await upsertAccount({
      provider: "github",
      provider_user_id: "31524469",
      login: "EmmyMay",
      display_name: "EmmyMay",
    });
    const agentSession = await createRoomAgentSession({
      room_id: room.id,
      session_kind: "worker",
      runtime: "codex",
      actor_label: actorLabel,
      agent_key: "EmmyMay/cedarmeadow",
      agent_instance_id: "instance-retired-live-snapshot",
      display_name: "CedarMeadow",
      owner_account_id: owner.id,
      owner_label: "EmmyMay",
      ide_label: "Codex",
    });

    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/cedarmeadow",
      agent_instance_id: "instance-retired-live-snapshot",
      agent_session_id: agentSession.session_id,
      session_kind: "worker",
      runtime: "codex",
      display_name: "CedarMeadow",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      transport: "desktop_events",
      credential_fence: {
        kind: "session_token",
        token_hash: hashToken(agentSession.session_token),
      },
    });
    await upsertRoomAgentLivenessObservation({
      room_id: room.id,
      agent_session_id: agentSession.session_id,
      source: "native_harness",
      host_kind: "macos",
      liveness_capability: "native_process",
      last_observed_at: new Date().toISOString(),
    });

    assert.equal((await getRoomAgentPresence(room.id)).length, 1);
    assert.equal((await getRoomAgentPresenceSnapshot(room.id)).length, 1);

    await endRoomAgentSession({ session_id: agentSession.session_id });

    assert.deepEqual(await getRoomAgentPresence(room.id), []);
    assert.deepEqual(await getRoomAgentPresenceSnapshot(room.id), []);
    const historySnapshot = await getRoomAgentPresenceSnapshot(room.id, {
      includeEndedSessions: true,
    });
    assert.equal(historySnapshot.length, 1);
    assert.equal(historySnapshot[0]?.agent_session_id, agentSession.session_id);
    assert.equal(
      historySnapshot[0]?.liveness_observation?.agent_session_id,
      agentSession.session_id,
    );
  },
);

test(
  "delivery sessions drive active and offline room activity while preserving the latest status snapshot",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !db ||
      !getRoomAgentPresence ||
      !markRoomAgentDeliveryConnected ||
      !markRoomAgentDeliveryDisconnected ||
      !room_agent_delivery_sessions ||
      !upsertRoomAgentPresence
    ) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const actorLabel = "MapleRidge | EmmyMay's agent | Codex";

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      status: "reviewing",
      status_text: "reviewing task_159 backend lane",
    });

    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      agent_instance_id: "instance-room-agent-presence-test",
      session_kind: "worker",
      runtime: "codex",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      transport: "long_poll",
    });

    const livePresence = await getRoomAgentPresence(room.id);
    assert.equal(livePresence[0]?.freshness, "active");
    assert.equal(livePresence[0]?.activity_state, "active");
    assert.equal(livePresence[0]?.status, "reviewing");
    assert.equal(livePresence[0]?.ide_label, "Codex");
    assert.deepEqual(livePresence[0]?.source_flags, ["delivery", "presence"]);

    const staleHeartbeat = new Date(Date.now() - ACTIVE_AGENT_DELIVERY_WINDOW_MS - 1_000).toISOString();
    await db
      .update(room_agent_delivery_sessions)
      .set({
        updated_at: staleHeartbeat,
      })
      .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id} AND ${room_agent_delivery_sessions.actor_label} = ${actorLabel}`);

    const staleActiveConnectionPresence = await getRoomAgentPresence(room.id);
    assert.equal(staleActiveConnectionPresence[0]?.freshness, "stale");
    assert.equal(staleActiveConnectionPresence[0]?.activity_state, "offline");
    assert.equal(staleActiveConnectionPresence[0]?.status_text, "reviewing task_159 backend lane");

    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
    });

    const disconnectedInGracePresence = await getRoomAgentPresence(room.id);
    assert.equal(disconnectedInGracePresence[0]?.freshness, "active");
    assert.equal(disconnectedInGracePresence[0]?.activity_state, "active");
    assert.equal(disconnectedInGracePresence[0]?.status_text, "reviewing task_159 backend lane");
    assert.deepEqual(disconnectedInGracePresence[0]?.source_flags, ["delivery", "presence"]);

    await db
      .update(room_agent_delivery_sessions)
      .set({
        reconnect_grace_expires_at: "2026-04-01T00:00:00.000Z",
      })
      .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id} AND ${room_agent_delivery_sessions.actor_label} = ${actorLabel}`);

    const stalePresence = await getRoomAgentPresence(room.id);
    assert.equal(stalePresence[0]?.freshness, "stale");
    assert.equal(stalePresence[0]?.activity_state, "offline");
    assert.equal(stalePresence[0]?.status_text, "reviewing task_159 backend lane");
  }
);

test(
  "process delivery instances make repeated disconnects idempotent across hosts",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (
      !createProjectWithName
      || !db
      || !markRoomAgentDeliveryConnected
      || !markRoomAgentDeliveryDisconnected
      || !room_agent_delivery_sessions
    ) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const room = await createProjectWithName("github.com/brosincode/delivery-instance-idempotency");
    const actorLabel = "Shared Poller | Owner | MCP";
    const base = {
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "owner/shared-poller",
      session_kind: "controller" as const,
      runtime: "mcp",
      display_name: "Shared Poller",
      owner_label: "Owner",
      ide_label: "MCP",
      transport: "long_poll" as const,
    };
    await markRoomAgentDeliveryConnected({ ...base, delivery_instance_id: "host-a" });
    await markRoomAgentDeliveryConnected({ ...base, delivery_instance_id: "host-b" });

    const readCount = async () => {
      const [row] = await db.select({ count: room_agent_delivery_sessions.active_connection_count })
        .from(room_agent_delivery_sessions)
        .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id}`);
      return row?.count;
    };
    assert.equal(await readCount(), 2);

    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
      delivery_instance_id: "host-a",
    });
    assert.equal(await readCount(), 1);
    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
      delivery_instance_id: "host-a",
    });
    assert.equal(await readCount(), 1, "a retried release cannot consume host B's count");

    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
      delivery_instance_id: "host-b",
    });
    assert.equal(await readCount(), 0);
  },
);

test(
  "the bounded liveness sweep prunes abandoned delivery instances and their aggregate count",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (
      !createProjectWithName
      || !db
      || !markRoomAgentDeliveryConnected
      || !pruneStaleRoomAgentDeliveryInstances
      || !room_agent_delivery_sessions
    ) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const room = await createProjectWithName("github.com/brosincode/delivery-instance-prune");
    const actorLabel = "Abandoned Poller | Owner | MCP";
    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "owner/abandoned-poller",
      session_kind: "controller",
      runtime: "mcp",
      display_name: "Abandoned Poller",
      owner_label: "Owner",
      ide_label: "MCP",
      delivery_instance_id: "crashed-host",
      transport: "long_poll",
    });
    const staleAt = new Date(Date.now() - ACTIVE_AGENT_DELIVERY_WINDOW_MS - 1_000).toISOString();
    await pool!.query(
      "UPDATE room_agent_delivery_instances SET updated_at = $1 WHERE room_id = $2",
      [staleAt, room.id],
    );
    assert.equal(await pruneStaleRoomAgentDeliveryInstances({ limit: 1 }), 1);
    const [row] = await db.select({ count: room_agent_delivery_sessions.active_connection_count })
      .from(room_agent_delivery_sessions)
      .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id}`);
    assert.equal(row?.count, 0);
  },
);

test(
  "stale delivery prune discovers only a bounded updated-at index window before deduplicating keys",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !pool) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const room = await createProjectWithName("github.com/brosincode/delivery-instance-prune-plan");
    await pool.query(`
      INSERT INTO room_agent_delivery_instances (
        room_id, delivery_key, instance_id, credential_fingerprint,
        transport, created_at, updated_at
      )
      SELECT $1,
             'controller:plan-' || series,
             'instance-' || series,
             NULL,
             'long_poll',
             NOW() - INTERVAL '2 minutes',
             NOW() - INTERVAL '2 minutes'
      FROM generate_series(1, 10000) AS series
    `, [room.id]);
    await pool.query("ANALYZE room_agent_delivery_instances");
    const explained = await pool.query<{ "QUERY PLAN": string }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT DISTINCT candidate.room_id, candidate.delivery_key
      FROM (
        SELECT room_id, delivery_key
        FROM room_agent_delivery_instances
        WHERE updated_at < NOW() - INTERVAL '1 minute'
        ORDER BY updated_at
        LIMIT 1000
      ) AS candidate
      ORDER BY candidate.room_id, candidate.delivery_key
    `);
    const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /Limit/);
    assert.match(plan, /room_agent_delivery_instances_stale_idx/);
    assert.doesNotMatch(plan, /Seq Scan on room_agent_delivery_instances/);
  },
);

test(
  "concurrent final-host releases serialize before instance mutation and converge the aggregate to zero",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryDisconnected || !pool) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const room = await createProjectWithName("github.com/brosincode/delivery-instance-concurrent-release");
    const actorLabel = "Concurrent Poller | Owner | MCP";
    const deliveryKey = `controller:${actorLabel}`;
    const base = {
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "owner/concurrent-poller",
      session_kind: "controller" as const,
      runtime: "mcp",
      display_name: "Concurrent Poller",
      owner_label: "Owner",
      ide_label: "MCP",
      transport: "long_poll" as const,
    };
    await markRoomAgentDeliveryConnected({ ...base, delivery_instance_id: "host-a" });
    await markRoomAgentDeliveryConnected({ ...base, delivery_instance_id: "host-b" });

    const gate = await pool.connect();
    try {
      await gate.query("BEGIN");
      await gate.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(concat($1::text, chr(31), $2::text), 0))",
        [room.id, deliveryKey],
      );
      let releaseASettled = false;
      let releaseBSettled = false;
      const releaseA = markRoomAgentDeliveryDisconnected({
        room_id: room.id,
        actor_label: actorLabel,
        delivery_instance_id: "host-a",
      }).finally(() => { releaseASettled = true; });
      const releaseB = markRoomAgentDeliveryDisconnected({
        room_id: room.id,
        actor_label: actorLabel,
        delivery_instance_id: "host-b",
      }).finally(() => { releaseBSettled = true; });
      await sleep(50);
      assert.equal(releaseASettled, false, "host A waits before deleting its instance");
      assert.equal(releaseBSettled, false, "host B waits before deleting its instance");
      await gate.query("COMMIT");
      await Promise.all([releaseA, releaseB]);
    } finally {
      await gate.query("ROLLBACK").catch(() => undefined);
      gate.release();
    }

    const final = await pool.query<{ count: number; instances: number }>(`
      SELECT delivery.active_connection_count::int AS count,
             count(instance.instance_id)::int AS instances
      FROM room_agent_delivery_sessions AS delivery
      LEFT JOIN room_agent_delivery_instances AS instance
        ON instance.room_id = delivery.room_id
       AND instance.delivery_key = delivery.delivery_key
      WHERE delivery.room_id = $1 AND delivery.delivery_key = $2
      GROUP BY delivery.active_connection_count
    `, [room.id, deliveryKey]);
    assert.deepEqual(final.rows[0], { count: 0, instances: 0 });
  },
);

test(
  "desktop event heartbeats create one idempotent reachable delivery lease",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !createRoomAgentSession || !upsertAccount || !getRoomAgentPresence || !upsertDesktopRoomAgentDeliveryHeartbeat) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const room = await createProjectWithName("github.com/brosincode/desktop-heartbeat");
    const owner = await upsertAccount({
      provider: "github",
      provider_user_id: "desktop-heartbeat-owner",
      login: "DesktopOwner",
    });
    const actorLabel = "DesktopPulse | DesktopOwner's agent | Cursor";
    const worker = await createRoomAgentSession({
      room_id: room.id,
      session_kind: "worker",
      runtime: "cursor",
      actor_label: actorLabel,
      agent_key: "DesktopOwner/desktop-pulse",
      agent_instance_id: "desktop-instance",
      display_name: "DesktopPulse",
      owner_account_id: owner.id,
      owner_label: "DesktopOwner",
      ide_label: "Cursor",
    });
    const heartbeat = () => upsertDesktopRoomAgentDeliveryHeartbeat({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "DesktopOwner/desktop-pulse",
      agent_instance_id: "desktop-instance",
      agent_session_id: worker.session_id,
      session_kind: "worker",
      runtime: "cursor",
      display_name: "DesktopPulse",
      owner_label: "DesktopOwner",
      ide_label: "Cursor",
      credential_fence: { kind: "session_token", token_hash: hashToken(worker.session_token) },
    });
    await heartbeat();
    await heartbeat();
    const presence = await getRoomAgentPresence(room.id);
    assert.equal(presence.length, 1);
    assert.equal(presence[0]?.freshness, "active");
    assert.equal(presence[0]?.source_flags.includes("delivery"), true);
    const [row] = await db!.select().from(room_agent_delivery_sessions!).where(
      sql`${room_agent_delivery_sessions!.room_id} = ${room.id}`,
    );
    assert.equal(row?.transport, "desktop_events");
    assert.equal(row?.active_connection_count, 1);
  },
);

test(
  "controller delivery sessions stay out of the reachable live roster",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !getRoomAgentPresence || !getRoomAgentPresenceSnapshot || !markRoomAgentDeliveryConnected) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const actorLabel = "ControllerOak | EmmyMay's agent | Agent";

    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/controlleroak",
      agent_instance_id: "instance-controlleroak",
      display_name: "ControllerOak",
      owner_label: "EmmyMay",
      ide_label: "Agent",
      transport: "long_poll",
    });

    assert.deepEqual(await getRoomAgentPresence(room.id), []);
    const snapshot = await getRoomAgentPresenceSnapshot(room.id);
    assert.equal(snapshot[0]?.session_kind, "controller");
    assert.equal(snapshot[0]?.freshness, "active");
  }
);

test(
  "old stale room presence ages out of the live roster window",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !db || !getRoomAgentPresence || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryDisconnected || !room_agent_delivery_sessions || !upsertRoomAgentPresence) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const actorLabel = "OldPine | EmmyMay's agent | Agent";

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/oldpine",
      display_name: "OldPine",
      owner_label: "EmmyMay",
      ide_label: "Agent",
      status: "idle",
      status_text: "was active earlier",
    });

    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/oldpine",
      agent_instance_id: "instance-oldpine",
      session_kind: "worker",
      runtime: "codex",
      display_name: "OldPine",
      owner_label: "EmmyMay",
      ide_label: "Agent",
      transport: "long_poll",
    });
    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
    });

    const expiredTimestamp = new Date(Date.now() - RECENTLY_OFFLINE_WINDOW_MS - 1_000).toISOString();
    await db
      .update(room_agent_delivery_sessions)
      .set({
        last_disconnected_at: expiredTimestamp,
        reconnect_grace_expires_at: "2026-04-01T00:00:00.000Z",
        updated_at: expiredTimestamp,
      })
      .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id} AND ${room_agent_delivery_sessions.actor_label} = ${actorLabel}`);

    const presence = await getRoomAgentPresence(room.id, { limit: 50 });
    assert.deepEqual(presence, []);
  }
);

test(
  "suppressed stale room presence stays out of the live roster until reconnect",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (
      !createProjectWithName ||
      !db ||
      !getRoomAgentPresence ||
      !markRoomAgentDeliveryConnected ||
      !markRoomAgentDeliveryDisconnected ||
      !room_agent_delivery_sessions ||
      !setRoomLiveAgentSuppressed ||
      !upsertRoomAgentPresence
    ) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");
    const actorLabel = "MapleRidge | EmmyMay's agent | Codex";

    await upsertRoomAgentPresence({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      status: "idle",
      status_text: "polling in room",
    });

    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      agent_instance_id: "instance-suppression-stale",
      session_kind: "worker",
      runtime: "codex",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      transport: "long_poll",
    });
    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
    });

    const recentlyStaleHeartbeat = new Date(Date.now() - 120_000).toISOString();
    await db
      .update(room_agent_delivery_sessions)
      .set({
        last_disconnected_at: recentlyStaleHeartbeat,
        reconnect_grace_expires_at: "2026-04-01T00:00:00.000Z",
        updated_at: recentlyStaleHeartbeat,
      })
      .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id} AND ${room_agent_delivery_sessions.actor_label} = ${actorLabel}`);

    const beforeSuppression = await getRoomAgentPresence(room.id);
    assert.equal(beforeSuppression.length, 1);
    assert.equal(beforeSuppression[0]?.freshness, "stale");

    await setRoomLiveAgentSuppressed({
      room_id: room.id,
      actor_labels: [actorLabel],
      suppressed: true,
      suppressed_by: "EmmyMay",
    });

    const suppressed = await getRoomAgentPresence(room.id);
    assert.deepEqual(suppressed, []);

    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      agent_key: "EmmyMay/mapleridge",
      agent_instance_id: "instance-suppression-reset",
      session_kind: "worker",
      runtime: "codex",
      display_name: "MapleRidge",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      transport: "long_poll",
    });

    const afterReconnect = await getRoomAgentPresence(room.id);
    assert.equal(afterReconnect.length, 1);
    assert.equal(afterReconnect[0]?.freshness, "active");
    assert.equal(afterReconnect[0]?.activity_state, "away");
    assert.deepEqual(afterReconnect[0]?.source_flags, ["delivery", "presence"]);
  }
);

test(
  "live room presence caps offline agents to the configured bound",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !db || !getRoomAgentPresence || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryDisconnected || !room_agent_delivery_sessions || !upsertRoomAgentPresence) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }

    const room = await createProjectWithName("github.com/brosincode/letagents");

    for (let index = 0; index < RECENTLY_OFFLINE_MAX_AGENTS + 5; index += 1) {
      const actorLabel = `Agent${index} | EmmyMay's agent | Agent`;
      await upsertRoomAgentPresence({
        room_id: room.id,
        actor_label: actorLabel,
        agent_key: `EmmyMay/agent${index}`,
        display_name: `Agent${index}`,
        owner_label: "EmmyMay",
        ide_label: "Agent",
        status: "idle",
        status_text: `idle ${index}`,
      });
      await markRoomAgentDeliveryConnected({
        room_id: room.id,
        actor_label: actorLabel,
        agent_key: `EmmyMay/agent${index}`,
        agent_instance_id: `instance-agent-${index}`,
        session_kind: "worker",
        runtime: "codex",
        display_name: `Agent${index}`,
        owner_label: "EmmyMay",
        ide_label: "Agent",
        transport: "long_poll",
      });
      await markRoomAgentDeliveryDisconnected({
        room_id: room.id,
        actor_label: actorLabel,
      });
      const disconnectedAt = new Date(Date.now() - index * 1_000).toISOString();
      await db
        .update(room_agent_delivery_sessions)
        .set({
          last_disconnected_at: disconnectedAt,
          reconnect_grace_expires_at: "2026-04-01T00:00:00.000Z",
          updated_at: disconnectedAt,
        })
        .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id} AND ${room_agent_delivery_sessions.actor_label} = ${actorLabel}`);
    }

    const presence = await getRoomAgentPresence(room.id, { limit: 200 });
    assert.equal(presence.length, RECENTLY_OFFLINE_MAX_AGENTS);
    assert.ok(presence.every((entry) => entry.freshness === "stale"));
  }
);

async function createDeliveryWorker(slug: string, options: { bearer?: boolean } = {}) {
  if (!createProjectWithName || !createRoomAgentSession || !upsertAccount || !pool) {
    throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
  }
  const room = await createProjectWithName(`github.com/brosincode/${slug}`);
  const owner = await upsertAccount({
    provider: "github",
    provider_user_id: `${slug}-owner`,
    login: "PulseOwner",
  });
  const actorLabel = "Pulse | PulseOwner's agent | Codex";
  const bearerFlag = process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED;
  if (options.bearer) process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "1";
  const worker = await createRoomAgentSession({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: actorLabel,
    agent_key: "PulseOwner/pulse",
    agent_instance_id: `${slug}-instance`,
    display_name: "Pulse",
    owner_account_id: owner.id,
    owner_label: "PulseOwner",
    ide_label: "Codex",
  }).finally(() => {
    if (bearerFlag === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = bearerFlag;
  });
  let credential_fence: RoomAgentDeliveryCredentialFence = {
    kind: "session_token",
    token_hash: hashToken(worker.session_token),
  };
  if (options.bearer) {
    const bearer = (await pool.query<{ bearer_id: string; generation: number }>(
      "SELECT bearer_id, generation FROM room_agent_session_bearers WHERE session_id = $1",
      [worker.session_id],
    )).rows[0];
    assert.ok(bearer, "worker bearer was issued");
    credential_fence = { kind: "bearer", bearer_id: bearer.bearer_id, generation: bearer.generation };
  }
  const identity = {
    room_id: room.id,
    actor_label: actorLabel,
    agent_key: "PulseOwner/pulse",
    agent_instance_id: `${slug}-instance`,
    agent_session_id: worker.session_id,
    session_kind: "worker" as const,
    runtime: "codex",
    display_name: "Pulse",
    owner_label: "PulseOwner",
    ide_label: "Codex",
    credential_fence,
  };
  return {
    room,
    worker,
    deliveryKey: `agent_session:${worker.session_id}`,
    connect: (instanceId: string) => markRoomAgentDeliveryConnected!({
      ...identity,
      delivery_instance_id: instanceId,
      transport: "long_poll",
    }),
    heartbeat: (instanceId: string) => markRoomAgentDeliveryHeartbeat!({
      room_id: room.id,
      actor_label: actorLabel,
      agent_session_id: worker.session_id,
      credential_fence,
      delivery_instance_id: instanceId,
    }),
    disconnect: (instanceId: string) => markRoomAgentDeliveryDisconnected!({
      room_id: room.id,
      actor_label: actorLabel,
      agent_session_id: worker.session_id,
      credential_fence,
      delivery_instance_id: instanceId,
    }),
    desktopHeartbeat: () => upsertDesktopRoomAgentDeliveryHeartbeat!(identity),
  };
}

function deadlockCodes(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result) => result.status === "rejected"
    ? [String((result.reason as { code?: string; cause?: { code?: string } })?.code
      ?? (result.reason as { cause?: { code?: string } })?.cause?.code
      ?? (result.reason as Error)?.message)]
    : []);
}

test(
  "heartbeat, desktop heartbeat and disconnect of one worker serialize without a lock-order deadlock",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!pool || !markRoomAgentDeliveryHeartbeat || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryDisconnected || !upsertDesktopRoomAgentDeliveryHeartbeat) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    for (const bearer of [false, true]) {
      const delivery = await createDeliveryWorker(`delivery-lock-order-${bearer ? "bearer" : "token"}`, { bearer });
      const pairs: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
        ["two process heartbeats", () => delivery.heartbeat("host-a"), () => delivery.heartbeat("host-b")],
        ["heartbeat and disconnect", () => delivery.heartbeat("host-a"), () => delivery.disconnect("host-b")],
        ["heartbeat and desktop heartbeat", () => delivery.heartbeat("host-a"), () => delivery.desktopHeartbeat()],
        ["desktop heartbeat and disconnect", () => delivery.desktopHeartbeat(), () => delivery.disconnect("host-a")],
      ];
      for (const [name, first, second] of pairs) {
        await delivery.connect("host-a");
        await delivery.connect("host-b");
        // Hold the delivery key lock so both calls start their transactions
        // before either can proceed. The first passes the credential check and
        // waits here; the second waits at the session row lock.
        const gate = await pool.connect();
        let results: PromiseSettledResult<unknown>[];
        try {
          await gate.query("BEGIN");
          await gate.query(
            "SELECT pg_advisory_xact_lock(hashtextextended(concat($1::text, chr(31), $2::text), 0))",
            [delivery.room.id, delivery.deliveryKey],
          );
          const calls = [first(), second()];
          await sleep(100);
          await gate.query("COMMIT");
          results = await Promise.allSettled(calls);
        } finally {
          await gate.query("ROLLBACK").catch(() => undefined);
          gate.release();
        }
        assert.deepEqual(deadlockCodes(results), [], `${name} (${bearer ? "bearer" : "session token"}) must not fail`);
      }
      if (bearer) continue;

      // Unordered rounds of every path at once, on separate pool connections.
      let failures: string[] = [];
      for (let round = 0; round < 8; round += 1) {
        await delivery.connect("host-a");
        const results = await Promise.allSettled([
          delivery.heartbeat("host-a"),
          delivery.heartbeat("host-a"),
          delivery.desktopHeartbeat(),
          delivery.disconnect("host-a"),
        ]);
        failures = failures.concat(deadlockCodes(results));
      }
      assert.deepEqual(failures, []);

      const final = await pool.query<{ instances: number; count: number; last_seen_at: string | null }>(`
        SELECT (SELECT count(*)::int FROM room_agent_delivery_instances
                 WHERE room_id = $1 AND delivery_key = $2 AND instance_id = 'host-a') AS instances,
               delivery.active_connection_count AS count,
               session.last_seen_at
          FROM room_agent_delivery_sessions AS delivery
          JOIN room_agent_sessions AS session ON session.session_id = delivery.agent_session_id
         WHERE delivery.room_id = $1 AND delivery.delivery_key = $2
      `, [delivery.room.id, delivery.deliveryKey]);
      // A heartbeat never re-creates an instance, so host A's disconnect leaves
      // it gone in every order. The aggregate counts host B (still connected
      // from the gated pairs) and may hold the desktop lease.
      assert.equal(final.rows[0]?.instances, 0);
      assert.ok([0, 1, 2].includes(final.rows[0]!.count));
      assert.ok(final.rows[0]?.last_seen_at);
    }
  },
);

async function readHeartbeatRows(roomId: string, deliveryKey: string, instanceId: string) {
  const row = (await pool!.query<{
    instance_at: Date | null;
    instance_version: string | null;
    delivery_at: Date;
    delivery_version: string;
    count: number;
    session_seen_at: Date;
    session_at: Date;
  }>(`
    SELECT instance.updated_at AS instance_at,
           instance.xmin::text AS instance_version,
           delivery.updated_at AS delivery_at,
           delivery.xmin::text AS delivery_version,
           delivery.active_connection_count AS count,
           session.last_seen_at AS session_seen_at,
           session.updated_at AS session_at
      FROM room_agent_delivery_sessions AS delivery
      JOIN room_agent_sessions AS session ON session.session_id = delivery.agent_session_id
      LEFT JOIN room_agent_delivery_instances AS instance
        ON instance.room_id = delivery.room_id
       AND instance.delivery_key = delivery.delivery_key
       AND instance.instance_id = $3
     WHERE delivery.room_id = $1 AND delivery.delivery_key = $2
  `, [roomId, deliveryKey, instanceId])).rows[0];
  assert.ok(row, "delivery row exists");
  return row;
}

test(
  "a duplicate delivery heartbeat inside the coalescing window writes no row; a later or count-changing one writes",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async (context) => {
    if (!pool || !markRoomAgentDeliveryHeartbeat || !markRoomAgentDeliveryConnected) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const delivery = await createDeliveryWorker("delivery-coalesce");
    await delivery.connect("host-a");

    context.mock.timers.tick(ROOM_AGENT_HEARTBEAT_WRITE_COALESCE_MS + 1_000);
    assert.equal(await delivery.heartbeat("host-a"), true);
    const written = await readHeartbeatRows(delivery.room.id, delivery.deliveryKey, "host-a");
    assert.equal(written.instance_at?.getTime(), Date.now());
    assert.equal(written.delivery_at.getTime(), Date.now());
    assert.equal(written.session_seen_at.getTime(), Date.now());
    assert.equal(written.session_at.getTime(), Date.now());

    // The heartbeat a long-poll start forces, two seconds after the interval one.
    context.mock.timers.tick(2_000);
    assert.equal(await delivery.heartbeat("host-a"), true);
    assert.deepEqual(await readHeartbeatRows(delivery.room.id, delivery.deliveryKey, "host-a"), written);
    // A skipped write must not read as a missing instance, nor hide one.
    assert.equal(await delivery.heartbeat("host-missing"), false);

    context.mock.timers.tick(ROOM_AGENT_HEARTBEAT_WRITE_COALESCE_MS);
    assert.equal(await delivery.heartbeat("host-a"), true);
    const later = await readHeartbeatRows(delivery.room.id, delivery.deliveryKey, "host-a");
    assert.equal(later.instance_at?.getTime(), Date.now());
    assert.equal(later.delivery_at.getTime(), Date.now());
    assert.equal(later.session_seen_at.getTime(), Date.now());
    assert.notEqual(later.instance_version, written.instance_version);
    assert.notEqual(later.delivery_version, written.delivery_version);

    // A crashed second process: its stale instance is removed inside the
    // window and the count change is written even though no timestamp is due.
    await delivery.connect("host-b");
    await pool.query(
      `UPDATE room_agent_delivery_instances SET updated_at = $3::timestamptz
        WHERE room_id = $1 AND delivery_key = $2 AND instance_id = 'host-b'`,
      [delivery.room.id, delivery.deliveryKey, new Date(Date.now() - ACTIVE_AGENT_DELIVERY_WINDOW_MS - 1_000).toISOString()],
    );
    assert.equal((await readHeartbeatRows(delivery.room.id, delivery.deliveryKey, "host-a")).count, 2);
    context.mock.timers.tick(1_000);
    assert.equal(await delivery.heartbeat("host-a"), true);
    const pruned = await readHeartbeatRows(delivery.room.id, delivery.deliveryKey, "host-a");
    assert.equal(pruned.count, 1);
    assert.equal((await readHeartbeatRows(delivery.room.id, delivery.deliveryKey, "host-b")).instance_at, null);
  },
);

test(
  "a worker that heartbeats every interval stays reachable while duplicate heartbeats are coalesced",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async (context) => {
    if (!getRoomAgentDeliverySessions || !deliveryHelpersModule) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const { isRoomAgentDeliverySessionReachable } = deliveryHelpersModule;
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const delivery = await createDeliveryWorker("delivery-coalesce-reachable");
    await delivery.connect("host-a");
    const current = async () => {
      const [session] = await getRoomAgentDeliverySessions(delivery.room.id);
      assert.ok(session);
      return session;
    };

    for (let interval = 0; interval < 10; interval += 1) {
      context.mock.timers.tick(ROOM_AGENT_DELIVERY_HEARTBEAT_INTERVAL_MS - 2_000);
      assert.equal(isRoomAgentDeliverySessionReachable(await current(), Date.now()), true, `reachable before beat ${interval}`);
      assert.equal(await delivery.heartbeat("host-a"), true);
      const stored = await current();
      assert.ok(Date.now() - Date.parse(stored.updated_at) <= ROOM_AGENT_HEARTBEAT_WRITE_COALESCE_MS);
      context.mock.timers.tick(2_000);
      assert.equal(await delivery.heartbeat("host-a"), true);
      assert.equal(isRoomAgentDeliverySessionReachable(await current(), Date.now()), true);
    }

    // Coalescing never stretches the reachability window itself.
    context.mock.timers.tick(ACTIVE_AGENT_DELIVERY_WINDOW_MS + 1_000);
    assert.equal(isRoomAgentDeliverySessionReachable(await current(), Date.now()), false);
  },
);

test(
  "native activity keeps a due time that is less than a minute early and rewrites an older one",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async (context) => {
    if (!pool || !recordNativeHarnessActivity) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const delivery = await createDeliveryWorker("native-due-time");
    await delivery.connect("host-a");
    let sequence = 0;
    const record = async () => {
      sequence += 1;
      const result = await recordNativeHarnessActivity({
        room_id: delivery.room.id,
        agent_session_id: delivery.worker.session_id,
        actor_label: delivery.worker.actor_label,
        agent_key: delivery.worker.agent_key!,
        session_kind: "worker",
        runtime: "codex",
        display_name: "Pulse",
        owner_label: "PulseOwner",
        ide_label: "Codex",
        repo_branch: null,
        provider_observed_at: new Date().toISOString(),
        sequence,
        method: "native_harness.bound",
        status: "working",
      });
      assert.equal(result.accepted, true);
    };
    const due = async () => (await pool!.query<{ due: Date; version: string }>(
      `SELECT next_liveness_check_at AS due, xmin::text AS version
         FROM room_agent_delivery_sessions WHERE room_id = $1 AND delivery_key = $2`,
      [delivery.room.id, delivery.deliveryKey],
    )).rows[0]!;

    context.mock.timers.tick(61_000);
    await record();
    const rescheduled = await due();
    assert.equal(rescheduled.due.getTime(), Date.now() + 5 * 60_000);

    context.mock.timers.tick(30_000);
    await record();
    assert.deepEqual(await due(), rescheduled);

    context.mock.timers.tick(31_000);
    await record();
    assert.equal((await due()).due.getTime(), Date.now() + 5 * 60_000);
  },
);

test(
  "a duplicate heartbeat of a lease without process instances is coalesced and still reports a live lease",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async (context) => {
    if (!pool || !createProjectWithName || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryDisconnected || !markRoomAgentDeliveryHeartbeat) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const room = await createProjectWithName("github.com/brosincode/delivery-coalesce-controller");
    const actorLabel = "Lease Poller | Owner | MCP";
    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      session_kind: "controller",
      display_name: "Lease Poller",
      transport: "long_poll",
    });
    const read = async () => (await pool.query<{ updated_at: Date; version: string }>(
      `SELECT updated_at, xmin::text AS version FROM room_agent_delivery_sessions
        WHERE room_id = $1 AND delivery_key = $2`,
      [room.id, `controller:${actorLabel}`],
    )).rows[0]!;
    const heartbeat = () => markRoomAgentDeliveryHeartbeat({ room_id: room.id, actor_label: actorLabel });

    context.mock.timers.tick(ROOM_AGENT_HEARTBEAT_WRITE_COALESCE_MS + 1_000);
    assert.equal(await heartbeat(), true);
    const written = await read();
    assert.equal(written.updated_at.getTime(), Date.now());

    context.mock.timers.tick(2_000);
    assert.equal(await heartbeat(), true);
    assert.deepEqual(await read(), written);

    await markRoomAgentDeliveryDisconnected({ room_id: room.id, actor_label: actorLabel });
    assert.equal(await heartbeat(), false);
  },
);

test(
  "native activity and a desktop heartbeat with presence take the delivery row before the presence row",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!pool || !recordNativeHarnessActivity || !upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const delivery = await createDeliveryWorker("native-desktop-lock-order");
    let sequence = 0;
    const native = () => {
      sequence += 1;
      return recordNativeHarnessActivity({
        room_id: delivery.room.id,
        agent_session_id: delivery.worker.session_id,
        actor_label: delivery.worker.actor_label,
        agent_key: delivery.worker.agent_key!,
        session_kind: "worker",
        runtime: "codex",
        display_name: "Pulse",
        owner_label: "PulseOwner",
        ide_label: "Codex",
        repo_branch: null,
        provider_observed_at: new Date(Date.now() + sequence).toISOString(),
        sequence,
        method: "native_harness.bound",
        status: "working",
      });
    };
    const desktop = () => upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat({
      room_id: delivery.room.id,
      actor_label: delivery.worker.actor_label,
      agent_key: delivery.worker.agent_key,
      agent_instance_id: "native-desktop-lock-order-instance",
      agent_session_id: delivery.worker.session_id,
      session_kind: "worker",
      runtime: "codex",
      display_name: "Pulse",
      owner_label: "PulseOwner",
      ide_label: "Codex",
      credential_fence: { kind: "session_token", token_hash: hashToken(delivery.worker.session_token) },
      presence: { status: "working", status_text: "Working" },
    });
    // After an offline announcement the due time stays NULL until recovery,
    // so the native report must write, and lock, the delivery row.
    const clearDueTime = () => pool.query(
      "UPDATE room_agent_delivery_sessions SET next_liveness_check_at = NULL WHERE room_id = $1",
      [delivery.room.id],
    );
    await desktop();

    // Hold the presence row: the native report queues on it first, then the
    // desktop heartbeat queues on it holding whatever it locked before.
    await clearDueTime();
    const gate = await pool.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      await gate.query("BEGIN");
      await gate.query(
        "SELECT 1 FROM room_agent_presence WHERE room_id = $1 AND actor_label = $2 FOR UPDATE",
        [delivery.room.id, delivery.worker.actor_label],
      );
      const nativeCall = native();
      await sleep(50);
      const desktopCall = desktop();
      await sleep(100);
      await gate.query("COMMIT");
      results = await Promise.allSettled([nativeCall, desktopCall]);
    } finally {
      await gate.query("ROLLBACK").catch(() => undefined);
      gate.release();
    }
    assert.deepEqual(deadlockCodes(results), []);

    let failures: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      await clearDueTime();
      failures = failures.concat(deadlockCodes(await Promise.allSettled([native(), desktop(), native(), desktop()])));
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "a heartbeat without a process instance waits for a concurrent disconnect and reports it",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!pool || !createProjectWithName || !markRoomAgentDeliveryConnected || !markRoomAgentDeliveryHeartbeat) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const room = await createProjectWithName("github.com/brosincode/delivery-heartbeat-disconnect-race");
    const actorLabel = "Lease Poller | Owner | MCP";
    await markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: actorLabel,
      session_kind: "controller",
      display_name: "Lease Poller",
      transport: "long_poll",
    });
    await pool.query(
      "UPDATE room_agent_delivery_sessions SET updated_at = now() - interval '20 seconds' WHERE room_id = $1",
      [room.id],
    );
    const gate = await pool.connect();
    let heartbeat: Promise<boolean>;
    try {
      await gate.query("BEGIN");
      await gate.query(
        "UPDATE room_agent_delivery_sessions SET active_connection_count = 0, updated_at = now() WHERE room_id = $1",
        [room.id],
      );
      heartbeat = markRoomAgentDeliveryHeartbeat({ room_id: room.id, actor_label: actorLabel });
      await sleep(100);
      await gate.query("COMMIT");
    } finally {
      await gate.query("ROLLBACK").catch(() => undefined);
      gate.release();
    }
    assert.equal(await heartbeat, false);
  },
);

test(
  "roster reads return the workers of the full snapshot, from the worker rows alone",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!pool || !getRoomAgentPresence || !getRoomAgentPresenceSnapshot || !setRoomLiveAgentSuppressed) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    const presenceModule = await import("../db/presence.js");
    const { AGENT_AVATAR_COLORS } = await import("../../../shared/agent-avatar.mjs");

    const roomId = "roster-read";
    const now = Date.now();
    const at = (deltaMs: number) => new Date(now + deltaMs).toISOString();
    const minute = 60_000;
    const day = 24 * 60 * minute;
    await pool.query("INSERT INTO rooms (id, display_name, created_at) VALUES ($1, 'Roster', $2)", [roomId, at(-day)]);
    await pool.query(
      `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
       VALUES ('roster-owner', 'github', 'roster-owner', 'Owner', $1, $1)`,
      [at(-day)]
    );
    await pool.query(
      `INSERT INTO agents (id, canonical_key, name, display_name, owner_account_id, owner_login, owner_label, avatar, created_at, updated_at)
       VALUES ('roster-agent-1', 'owner/w1', 'w1', 'Worker 1', 'roster-owner', 'owner', 'Owner', $1, $2, $2),
              ('roster-agent-4', 'owner/w4', 'w4', 'Worker 4', 'roster-owner', 'owner', 'Owner', $1, $2, $2)`,
      [JSON.stringify({ kind: "initials", color: AGENT_AVATAR_COLORS[0] }), at(-day)]
    );

    // One session per worker; `ended` sessions are outside every roster read.
    const sessions: Array<{ id: string; label: string; key: string; instance: string; ended?: boolean }> = [
      { id: "s1", label: "Worker 1", key: "owner/w1", instance: "i1" },
      { id: "s2", label: "Worker 2", key: "owner/w2", instance: "i2" },
      { id: "s3", label: "Worker 3", key: "owner/w3", instance: "i3" },
      { id: "s4", label: "Worker 4", key: "owner/w4", instance: "i4" },
      { id: "s5a", label: "Worker 5 before restart", key: "owner/w5", instance: "i5" },
      { id: "s5b", label: "Worker 5", key: "owner/w5", instance: "i5" },
      { id: "s6", label: "Ended 6", key: "owner/w6", instance: "i6", ended: true },
      { id: "s7", label: "Legacy 7", key: "owner/w7", instance: "i7" },
      { id: "s8", label: "Worker 8", key: "owner/w8", instance: "i8" },
      { id: "s9", label: "Absorbed 9", key: "owner/w9", instance: "i9" },
      { id: "s10", label: "StatusOnly 10", key: "owner/w10", instance: "i10" },
    ];
    for (const session of sessions) {
      await pool.query(
        `INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key,
           agent_instance_id, display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at, ended_at)
         VALUES ($1, $2, $3, 'worker', 'codex', $4, $5, $6, $4, 'roster-owner', 'Owner', 'Codex', $7, $7, $7, $8)`,
        [session.id, roomId, `roster-token-${session.id}`, session.label, session.key, session.instance, at(-day),
          session.ended ? at(-minute) : null]
      );
    }

    const deliveries: Array<{
      session: string; label: string; key: string | null; instance: string | null;
      connections?: number; updated: number; disconnected?: number; grace?: number;
    }> = [
      { session: "s1", label: "Worker 1", key: "owner/w1", instance: "i1", connections: 1, updated: -5_000 },
      { session: "s2", label: "Worker 2", key: "owner/w2", instance: "i2", updated: -20_000, disconnected: -20_000, grace: 60 * minute },
      { session: "s3", label: "Worker 3", key: "owner/w3", instance: "i3", updated: -2 * minute, disconnected: -2 * minute },
      { session: "s4", label: "Worker 4", key: "owner/w4", instance: "i4", updated: -3 * day, disconnected: -3 * day },
      { session: "s5a", label: "Worker 5 before restart", key: "owner/w5", instance: "i5", updated: -4 * minute, disconnected: -4 * minute },
      { session: "s5b", label: "Worker 5", key: "owner/w5", instance: "i5", connections: 2, updated: -8_000 },
      { session: "s6", label: "Ended 6", key: "owner/w6", instance: "i6", connections: 1, updated: -6_000 },
      { session: "s7", label: "Legacy 7", key: null, instance: null, updated: -5 * minute, disconnected: -5 * minute },
      { session: "s8", label: "Worker 8", key: "owner/w8", instance: "i8", updated: -3 * minute, disconnected: -3 * minute },
    ];
    for (const delivery of deliveries) {
      await pool.query(
        `INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, agent_session_id, session_kind, actor_label, agent_key,
           agent_instance_id, display_name, repo_branch, transport, active_connection_count, last_connected_at,
           last_disconnected_at, reconnect_grace_expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'worker', $4, $5, $6, $4, $7, 'sse', $8, $9, $10, $11, $9, $12)`,
        [roomId, `agent_session:${delivery.session}`, delivery.session, delivery.label, delivery.key, delivery.instance,
          `branch-${delivery.session}`, delivery.connections ?? 0, at(-day),
          delivery.disconnected === undefined ? null : at(delivery.disconnected),
          delivery.grace === undefined ? null : at(delivery.grace), at(delivery.updated)]
      );
    }
    // The connection history of chats that never were workers: far more rows
    // than workers, some newer than every worker row. "Absorbed 9" and
    // "Worker 3" share their label with a status row or a worker row.
    await pool.query(
      `INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, session_kind, actor_label, display_name, transport,
         active_connection_count, last_connected_at, last_disconnected_at, created_at, updated_at)
       SELECT $1, 'controller:' || label, 'controller', label, label, 'sse', CASE WHEN i % 50 = 0 THEN 1 ELSE 0 END,
         $2::timestamptz, $3::timestamptz - i * interval '1 second', $2::timestamptz, $3::timestamptz - i * interval '1 second'
       FROM (SELECT i, CASE i WHEN 401 THEN 'Absorbed 9' WHEN 402 THEN 'Worker 3' ELSE 'Chat ' || i END AS label
             FROM generate_series(1, 402) i) chats`,
      [roomId, at(-day), at(-1_000)]
    );

    const statuses: Array<{ label: string; kind: "worker" | "controller"; session: string | null; status: string }> = [
      { label: "Worker 1", kind: "worker", session: "s1", status: "working" },
      // A status row of another kind still belongs to the worker with its label.
      { label: "Worker 3", kind: "controller", session: null, status: "reviewing" },
      // Only a controller delivery row has this label, so the merge hides the row.
      { label: "Absorbed 9", kind: "worker", session: "s9", status: "working" },
      { label: "StatusOnly 10", kind: "worker", session: "s10", status: "blocked" },
      { label: "Chat 5", kind: "controller", session: null, status: "working" },
      { label: "Ended 6", kind: "worker", session: "s6", status: "working" },
    ];
    for (const status of statuses) {
      await pool.query(
        `INSERT INTO room_agent_presence (room_id, actor_label, agent_session_id, session_kind, display_name, status,
           status_text, last_heartbeat_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $2, $5, 'text', $6, $6, $6)`,
        [roomId, status.label, status.session, status.kind, status.status, at(-10_000)]
      );
    }
    await setRoomLiveAgentSuppressed({ room_id: roomId, actor_labels: ["Worker 8"], suppressed: true, suppressed_by: "Owner" });

    const isWorker = (entry: { session_kind: string }) => entry.session_kind === "worker";
    const full = await getRoomAgentPresenceSnapshot(roomId);
    const fullWorkers = full.filter(isWorker);
    assert.deepEqual(
      fullWorkers.map((entry) => entry.actor_label),
      ["Worker 1", "Worker 5", "Worker 2", "StatusOnly 10", "Worker 3", "Worker 8", "Legacy 7", "Worker 4"],
      "the fixture covers live, grace, offline, legacy, succession and status-only workers"
    );
    assert.equal(full.length - fullWorkers.length, 402, "the full snapshot also carries every controller row");
    assert.equal(fullWorkers.find((entry) => entry.actor_label === "Worker 3")?.status, "reviewing");
    assert.ok(fullWorkers.find((entry) => entry.actor_label === "Worker 4")?.avatar, "an entry outside a small limit has an avatar");

    for (const limit of [1, 3, 7, 50]) {
      assert.deepEqual(
        await getRoomAgentPresenceSnapshot(roomId, { relevantTo: "roster", limit }),
        fullWorkers.slice(0, limit),
        `roster snapshot with limit ${limit}`
      );
    }

    const expectedLive = presenceModule.filterRoomAgentPresenceForLiveRoster({
      presence: await presenceModule.getMergedRoomAgentPresenceRecords(roomId, {
        statusLimit: 500,
        deliveryLimit: 500,
        excludeEndedSessions: true,
      }),
      suppressedActors: await presenceModule.getRoomLiveAgentSuppressionActorLabels(roomId),
      limit: 500,
    });
    assert.deepEqual(
      expectedLive.map((entry) => entry.actor_label),
      ["Worker 1", "Worker 5", "Worker 2", "Worker 3", "Legacy 7"]
    );
    assert.deepEqual(await getRoomAgentPresence(roomId, { limit: 500 }), expectedLive);

    const originalQuery = pool.query;
    const reads: Array<{ text: string; rows: number }> = [];
    pool.query = (async function (...args: unknown[]) {
      const query = args[0] as string | { text: string };
      const result = await (originalQuery as (...args: unknown[]) => Promise<{ rows: unknown[] }>).apply(pool, args);
      reads.push({ text: typeof query === "string" ? query : query.text, rows: result.rows.length });
      return result;
    }) as typeof pool.query;
    try {
      await getRoomAgentPresenceSnapshot(roomId, { relevantTo: "roster", limit: 100 });
      await getRoomAgentPresence(roomId, { limit: 500 });
    } finally {
      pool.query = originalQuery;
    }
    const deliveryReads = reads.filter((read) => /^select .* from "room_agent_delivery_sessions"/i.test(read.text));
    const statusReads = reads.filter((read) => /^select .* from "room_agent_presence"/i.test(read.text));
    assert.equal(deliveryReads.length, 2);
    assert.equal(statusReads.length, 2);
    // 8 worker rows of open sessions, and the one controller row that hides a status row.
    assert.deepEqual(deliveryReads.map((read) => read.rows), [9, 9]);
    assert.deepEqual(statusReads.map((read) => read.rows), [4, 4]);
  }
);

test(
  "roster reads do not search a room's whole history for each row",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!pool || !getRoomAgentPresence || !getRoomAgentPresenceSnapshot) {
      throw new Error("DB-backed room agent presence tests require TEST_DB_URL");
    }
    // Worker rows are never deleted, so a room collects them. A filter that
    // compares each row with a list of them costs rows times list.
    const roomId = "roster-long-history";
    await pool.query(`
      INSERT INTO rooms (id, display_name, created_at) VALUES ('${roomId}', 'Long history', '2026-01-01');
      INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
        VALUES ('long-owner', 'github', 'long-owner', 'Owner', '2026-01-01', '2026-01-01');
      INSERT INTO room_agent_sessions (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key,
          agent_instance_id, display_name, owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at, ended_at)
        SELECT 'long-s-' || i, '${roomId}', 'long-t-' || i, 'worker', 'codex', 'Worker ' || i, 'owner/w' || i, 'inst-' || i,
          'Worker ' || i, 'long-owner', 'Owner', 'Codex', '2026-01-01', '2026-01-01', '2026-01-01',
          CASE WHEN i > 5 THEN '2026-02-01'::timestamptz END
        FROM generate_series(1, 1500) i;
      INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, agent_session_id, session_kind, actor_label, agent_key,
          agent_instance_id, display_name, transport, active_connection_count, last_connected_at, created_at, updated_at)
        SELECT '${roomId}', 'agent_session:long-s-' || i, 'long-s-' || i, 'worker', 'Worker ' || i, 'owner/w' || i, 'inst-' || i,
          'Worker ' || i, 'sse', CASE WHEN i <= 5 THEN 1 ELSE 0 END, '2026-01-01', '2026-01-01',
          CASE WHEN i <= 5 THEN now() ELSE now() - i * interval '1 minute' END
        FROM generate_series(1, 1500) i;
      INSERT INTO room_agent_delivery_sessions (room_id, delivery_key, session_kind, actor_label, display_name, transport,
          last_connected_at, created_at, updated_at)
        SELECT '${roomId}', 'controller:Chat ' || i, 'controller', 'Chat ' || i, 'Chat ' || i, 'sse', '2026-01-01', '2026-01-01',
          now() - i * interval '7 seconds'
        FROM generate_series(1, 6000) i;
      INSERT INTO room_agent_presence (room_id, actor_label, session_kind, display_name, status, last_heartbeat_at, created_at, updated_at)
        SELECT '${roomId}', 'Chat ' || i, 'controller', 'Chat ' || i, 'working', now() - i * interval '3 seconds', '2026-01-01', '2026-01-01'
        FROM generate_series(1, 3000) i;
      INSERT INTO room_agent_presence (room_id, actor_label, agent_session_id, session_kind, display_name, status, last_heartbeat_at, created_at, updated_at)
        SELECT '${roomId}', 'Worker ' || i, 'long-s-' || i, 'worker', 'Worker ' || i, 'working', now() - i * interval '1 minute', '2026-01-01', '2026-01-01'
        FROM generate_series(1, 1500) i;
      ANALYZE;
    `);

    const originalQuery = pool.query;
    const reads: Array<{ text: string; values: unknown[] }> = [];
    pool.query = (async function (...args: unknown[]) {
      const query = args[0] as string | { text: string; values?: unknown[] };
      reads.push({
        text: typeof query === "string" ? query : query.text,
        values: (typeof query === "string" ? args[1] : query.values ?? args[1]) as unknown[] ?? [],
      });
      return (originalQuery as (...args: unknown[]) => Promise<unknown>).apply(pool, args);
    }) as typeof pool.query;
    let live: Awaited<ReturnType<typeof getRoomAgentPresence>>;
    try {
      live = await getRoomAgentPresence(roomId);
      await getRoomAgentPresenceSnapshot(roomId, { relevantTo: "roster", limit: 100 });
    } finally {
      pool.query = originalQuery;
    }
    assert.deepEqual(live.map((entry) => entry.actor_label).sort(), ["Worker 1", "Worker 2", "Worker 3", "Worker 4", "Worker 5"]);

    const rosterReads = reads.filter((read) =>
      /^select [^()]*? from "room_agent_(delivery_sessions|presence)"/i.test(read.text));
    assert.equal(rosterReads.length, 4);
    for (const read of rosterReads) {
      // PostgreSQL searches an array from its start for each row it filters.
      // It picks that plan only for some room shapes, so the statement itself
      // must not compare a row with an array built from the room's rows.
      assert.doesNotMatch(read.text, /=\s*ANY\s*\(\s*ARRAY\s*\(/i, read.text.slice(0, 80));
      const result = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${read.text}`, read.values);
      const plan = JSON.stringify((result.rows[0] as { "QUERY PLAN": unknown })["QUERY PLAN"]);
      assert.doesNotMatch(plan, /"Filter": "[^"]*= ANY \(\$\d+\)/, read.text.slice(0, 80));
    }
  }
);
