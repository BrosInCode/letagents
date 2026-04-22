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

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const createProjectWithName = dbModule?.createProjectWithName;
const getRoomAgentPresence = dbModule?.getRoomAgentPresence;
const markRoomAgentDeliveryConnected = dbModule?.markRoomAgentDeliveryConnected;
const markRoomAgentDeliveryDisconnected = dbModule?.markRoomAgentDeliveryDisconnected;
const upsertRoomAgentPresence = dbModule?.upsertRoomAgentPresence;
const room_agent_delivery_sessions = schemaModule?.room_agent_delivery_sessions;

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
  "status-only room presence is not treated as online without a live delivery channel",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !getRoomAgentPresence || !upsertRoomAgentPresence) {
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

    const presence = await getRoomAgentPresence(room.id);
    assert.equal(presence.length, 1);
    assert.equal(presence[0]?.actor_label, "MapleRidge | EmmyMay's agent | Agent");
    assert.equal(presence[0]?.status, "working");
    assert.equal(presence[0]?.status_text, "working on task_58");
    assert.equal(presence[0]?.freshness, "stale");
    assert.equal(presence[0]?.activity_state, "stale");
    assert.deepEqual(presence[0]?.source_flags, ["presence"]);
  }
);

test(
  "upsertRoomAgentPresence updates an existing agent row instead of duplicating it",
  {
    concurrency: false,
    skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed room agent presence tests" : false,
  },
  async () => {
    if (!createProjectWithName || !getRoomAgentPresence || !upsertRoomAgentPresence) {
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
      status_text: "online in room",
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

    const presence = await getRoomAgentPresence(room.id);
    assert.equal(presence.length, 1);
    assert.equal(presence[0]?.status, "reviewing");
    assert.equal(presence[0]?.status_text, "reviewing PR #146");
    assert.equal(presence[0]?.activity_state, "online");
  }
);

test(
  "delivery sessions drive online freshness while preserving the latest status snapshot",
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
    assert.equal(livePresence[0]?.activity_state, "online");
    assert.equal(livePresence[0]?.status, "reviewing");
    assert.equal(livePresence[0]?.ide_label, "Codex");
    assert.deepEqual(livePresence[0]?.source_flags, ["presence"]);

    await markRoomAgentDeliveryDisconnected({
      room_id: room.id,
      actor_label: actorLabel,
    });
    await db
      .update(room_agent_delivery_sessions)
      .set({
        reconnect_grace_expires_at: "2026-04-01T00:00:00.000Z",
      })
      .where(sql`${room_agent_delivery_sessions.room_id} = ${room.id} AND ${room_agent_delivery_sessions.actor_label} = ${actorLabel}`);

    const stalePresence = await getRoomAgentPresence(room.id);
    assert.equal(stalePresence[0]?.freshness, "stale");
    assert.equal(stalePresence[0]?.activity_state, "stale");
    assert.equal(stalePresence[0]?.status_text, "reviewing task_159 backend lane");
  }
);
