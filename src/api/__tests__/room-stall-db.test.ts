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
    throw new Error("DB-backed stall tests require TEST_DB_URL");
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

const skipOptions = { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed stall tests" : false };

async function seedRoomWithClosedTask(name: string, closedMinutesAgo: number) {
  const { createProjectWithName, createTask } = dbModule!;
  const project = await createProjectWithName!(name);
  const task = await createTask!(project.id, "finished work", "EmmyMay");
  await pool!.query(
    "UPDATE tasks SET status = 'done', updated_at = $3 WHERE room_id = $1 AND number = $2",
    [project.id, Number(task.id.replace("task_", "")), new Date(Date.now() - closedMinutesAgo * 60_000)]
  );
  return project.id;
}

test(
  "stalled-room listing finds drained boards and skips active or never-worked rooms",
  skipOptions,
  async () => {
    const { createProjectWithName, createTask, listStalledRoomCandidates } = dbModule!;

    const drainedRoom = await seedRoomWithClosedTask("stall-drained-room", 45);
    const activeRoom = await createProjectWithName!("stall-active-room");
    await createTask!(activeRoom.id, "still open", "EmmyMay");
    const emptyRoom = await createProjectWithName!("stall-never-worked-room");
    const freshRoom = await seedRoomWithClosedTask("stall-fresh-room", 5);

    const candidates = await listStalledRoomCandidates!({ stalledForMs: 30 * 60_000 });
    const roomIds = candidates.map((entry) => entry.room_id);
    assert.ok(roomIds.includes(drainedRoom), "a 45-minute-drained board is a candidate");
    assert.ok(!roomIds.includes(activeRoom.id), "open tasks exclude the room");
    assert.ok(!roomIds.includes(emptyRoom.id), "rooms that never had tasks are silent");
    assert.ok(!roomIds.includes(freshRoom), "recently drained rooms wait out the threshold");

    const drained = candidates.find((entry) => entry.room_id === drainedRoom);
    assert.ok(drained?.last_closed_at, "the drain epoch is reported");
    assert.equal(drained?.stall_nudged_at, null);
  }
);

test(
  "the stall nudge commits atomically with its fence and fires once per drain epoch",
  skipOptions,
  async () => {
    const { addMessageWithCreateStatus, getRoomBoardSettings, listStalledRoomCandidates, markRoomStallNudgedTx } =
      dbModule!;
    const roomId = await seedRoomWithClosedTask("stall-nudge-room", 45);
    const [candidate] = (await listStalledRoomCandidates!({ stalledForMs: 30 * 60_000 })).filter(
      (entry) => entry.room_id === roomId
    );
    assert.ok(candidate);
    const epoch = candidate!.last_closed_at;
    const clientMessageId = `room_stall:${roomId}:${epoch}`;

    // A mid-transaction failure rolls back both the message and the fence.
    await assert.rejects(
      addMessageWithCreateStatus!(roomId, "letagents", "[status] stall nudge", {
        client_message_id: clientMessageId,
        with_created_message_in_transaction: async (tx) => {
          assert.equal(await markRoomStallNudgedTx!(tx, { room_id: roomId, epoch }), true);
          throw new Error("boom");
        },
      })
    );
    assert.equal((await getRoomBoardSettings!(roomId)).stall_nudged_at, null);

    // The success path commits both; the fence then rejects the same epoch.
    const created = await addMessageWithCreateStatus!(roomId, "letagents", "[status] stall nudge", {
      client_message_id: clientMessageId,
      with_created_message_in_transaction: async (tx) => {
        assert.equal(await markRoomStallNudgedTx!(tx, { room_id: roomId, epoch }), true);
      },
    });
    assert.equal(created.created, true);
    assert.ok((await getRoomBoardSettings!(roomId)).stall_nudged_at);
    assert.equal(await markRoomStallNudgedTx!(db!, { room_id: roomId, epoch }), false);

    // A NEWER drain epoch re-arms the fence.
    const newerEpoch = new Date(Date.parse(epoch) + 60 * 60_000).toISOString();
    assert.equal(
      await markRoomStallNudgedTx!(db!, { room_id: roomId, epoch: newerEpoch }),
      true
    );
  }
);
