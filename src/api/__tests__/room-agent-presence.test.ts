import assert from "node:assert/strict";
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

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createProjectWithName = dbModule?.createProjectWithName;
const getRoomAgentPresence = dbModule?.getRoomAgentPresence;
const getRoomAgentPresenceSnapshot = dbModule?.getRoomAgentPresenceSnapshot;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
const markRoomAgentDeliveryDisconnected = dbModule?.markRoomAgentDeliveryDisconnected;
const setRoomLiveAgentSuppressed = dbModule?.setRoomLiveAgentSuppressed;
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
    assert.equal(disconnectedInGracePresence[0]?.freshness, "stale");
    assert.equal(disconnectedInGracePresence[0]?.activity_state, "offline");
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
