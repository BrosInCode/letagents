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
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const createProjectWithName = dbModule?.createProjectWithName;
const getRoomAgentPresence = dbModule?.getRoomAgentPresence;
const getRoomAgentPresenceSnapshot = dbModule?.getRoomAgentPresenceSnapshot;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
const markRoomAgentDeliveryDisconnected = dbModule?.markRoomAgentDeliveryDisconnected;
const pruneStaleRoomAgentDeliveryInstances = dbModule?.pruneStaleRoomAgentDeliveryInstances;
const upsertDesktopRoomAgentDeliveryHeartbeat = dbModule?.upsertDesktopRoomAgentDeliveryHeartbeat;
const setRoomLiveAgentSuppressed = dbModule?.setRoomLiveAgentSuppressed;
const upsertAccount = dbModule?.upsertAccount;
const upsertRoomAgentLivenessObservation = dbModule?.upsertRoomAgentLivenessObservation;
const upsertRoomAgentPresence = dbModule?.upsertRoomAgentPresence;
const room_agent_delivery_sessions = schemaModule?.room_agent_delivery_sessions;
const { ACTIVE_AGENT_DELIVERY_WINDOW_MS } = agentPresenceModule;
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
