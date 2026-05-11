import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
} else {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const schemaModule = testDatabaseUrl ? await import("../db/schema.js") : null;
const accountRoomModule = testDatabaseUrl ? await import("../account-room-membership.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const accountRoomRecents = schemaModule?.account_room_recents;
const assignProjectAdmin = dbModule?.assignProjectAdmin;
const createFocusRoomForTask = dbModule?.createFocusRoomForTask;
const createProjectWithName = dbModule?.createProjectWithName;
const createRoomAgentSession = dbModule?.createRoomAgentSession;
const createTask = dbModule?.createTask;
const upsertAccount = dbModule?.upsertAccount;
const upsertRoomParticipant = dbModule?.upsertRoomParticipant;
const getAccountRoomsForAccount = accountRoomModule?.getAccountRoomsForAccount;
const upsertAccountRoomRecent = accountRoomModule?.upsertAccountRoomRecent;

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function requireTestDeps(): asserts db is NonNullable<typeof db> {
  assert.ok(db);
  assert.ok(pool);
  assert.ok(accountRoomRecents);
  assert.ok(assignProjectAdmin);
  assert.ok(createFocusRoomForTask);
  assert.ok(createProjectWithName);
  assert.ok(createRoomAgentSession);
  assert.ok(createTask);
  assert.ok(upsertAccount);
  assert.ok(upsertRoomParticipant);
  assert.ok(getAccountRoomsForAccount);
  assert.ok(upsertAccountRoomRecent);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabaseReady(): Promise<void> {
  assert.ok(pool);
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
  assert.ok(db);
  assert.ok(pool);
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
  "getAccountRoomsForAccount returns account rooms with nested focus rooms",
  { skip: requiresDatabase },
  async () => {
    requireTestDeps();

    const account = await upsertAccount({
      provider: "github",
      provider_user_id: "acct-rooms-test",
      login: "EmmyMay",
      display_name: "EmmyMay",
    });

    const adminRoom = await createProjectWithName("github.com/acct/admin-room");
    await assignProjectAdmin(adminRoom.id, account.id);
    const task = await createTask(adminRoom.id, "Build sidebar", "EmmyMay");
    const adminFocusRoom = await createFocusRoomForTask(adminRoom.id, task.id);

    const participantRoom = await createProjectWithName("github.com/acct/participant-room");
    await upsertRoomParticipant({
      room_id: participantRoom.id,
      participant_key: "human:login:emmymay",
      kind: "human",
      github_login: null,
      display_name: "EmmyMay",
      last_seen_at: "2026-05-10T10:00:00.000Z",
    });

    const agentRoom = await createProjectWithName("github.com/acct/agent-room");
    await createRoomAgentSession({
      room_id: agentRoom.id,
      session_kind: "worker",
      runtime: "codex",
      actor_label: "OwlSolar | EmmyMay's agent | Codex",
      agent_key: "EmmyMay/owlsolar",
      display_name: "OwlSolar",
      owner_account_id: account.id,
      owner_label: "EmmyMay",
      ide_label: "Codex",
    });

    const focusOnlyParent = await createProjectWithName("github.com/acct/focus-only");
    const focusOnlyTask = await createTask(focusOnlyParent.id, "Focused work", "EmmyMay");
    const focusOnlyRoom = await createFocusRoomForTask(focusOnlyParent.id, focusOnlyTask.id);
    assert.ok(focusOnlyRoom);
    await createRoomAgentSession({
      room_id: focusOnlyRoom.room.id,
      session_kind: "worker",
      runtime: "codex",
      actor_label: "OwlSolar 2 | EmmyMay's agent | Codex",
      agent_key: "EmmyMay/owlsolar",
      display_name: "OwlSolar 2",
      owner_account_id: account.id,
      owner_label: "EmmyMay",
      ide_label: "Codex",
    });

    const recentRoom = await createProjectWithName("github.com/acct/recent-room");
    await upsertAccountRoomRecent({
      accountId: account.id,
      roomId: recentRoom.id,
      displayName: "Recent Room",
      source: "open_room",
    });

    const archivedRoom = await createProjectWithName("github.com/acct/archived-room");
    await upsertAccountRoomRecent({
      accountId: account.id,
      roomId: archivedRoom.id,
      displayName: archivedRoom.display_name,
      source: "open_room",
    });
    await db
      .update(accountRoomRecents)
      .set({ archived: true })
      .where(and(
        eq(accountRoomRecents.account_id, account.id),
        eq(accountRoomRecents.room_id, archivedRoom.id)
      ));

    const rooms = await getAccountRoomsForAccount(account.id, {
      login: "EmmyMay",
      limit: 20,
    });
    const roomsById = new Map(rooms.map((room) => [room.room_id, room]));

    assert.equal(roomsById.get(adminRoom.id)?.role, "admin");
    assert.deepEqual(
      roomsById.get(adminRoom.id)?.focus_rooms.map((room) => room.room_id),
      [adminFocusRoom?.room.id]
    );
    assert.equal(roomsById.get(participantRoom.id)?.source, "participant");
    assert.equal(roomsById.get(agentRoom.id)?.source, "agent");
    assert.deepEqual(
      roomsById.get(focusOnlyParent.id)?.focus_rooms.map((room) => room.room_id),
      [focusOnlyRoom.room.id]
    );
    assert.equal(roomsById.get(recentRoom.id)?.display_name, "Recent Room");
    assert.equal(roomsById.has(archivedRoom.id), false);

    const includingArchived = await getAccountRoomsForAccount(account.id, {
      login: "EmmyMay",
      includeArchived: true,
      limit: 20,
    });
    assert.equal(includingArchived.some((room) => room.room_id === archivedRoom.id), true);
  }
);
