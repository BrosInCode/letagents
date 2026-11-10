import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const counts = url ? await import("../db/messages/history/activity-counts.js") : null;
const skip = { skip: !url && "set TEST_DB_URL to run room message count tests" };

test.before(async () => {
  if (!client) return;
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve("drizzle") });
  process.env.LETAGENTS_JEV_ROUTING = "off";
});
test.after(async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  await client?.pool.end();
});
test.beforeEach(() => counts?.clearRoomMessageCountCache());

type Count = { actor_label: string; count: number };
const sorted = (rows: Count[]) => [...rows].sort((a, b) => a.actor_label.localeCompare(b.actor_label));

/** The query this route ran before the cache: a full scan of the room. */
async function referenceCounts(roomId: string): Promise<Count[]> {
  const { rows } = await client!.pool.query<Count>(
    `SELECT sender AS actor_label, COUNT(*)::int AS count FROM messages
      WHERE room_id = $1
        AND (agent_prompt_kind IS NULL OR agent_prompt_kind <> 'auto' OR BTRIM(text) <> '')
      GROUP BY sender`, [roomId]);
  return sorted(rows);
}

async function expectMatches(roomId: string) {
  const actual = sorted(await api!.getRoomMessageCountsBySender(roomId));
  assert.deepEqual(actual, await referenceCounts(roomId));
  return actual;
}

const send = (roomId: string, sender: string, text: string, extra = {}) =>
  api!.addMessage(roomId, sender, text, { source: "agent", ...extra });
const autoPrompt = (roomId: string, sender: string, text = "") =>
  send(roomId, sender, text, { agent_prompt_kind: "auto" });

/** Records the SQL text and values of every query the pool runs. */
function captureQueries() {
  const pool = client!.pool as unknown as { query: (...args: unknown[]) => unknown };
  const original = pool.query;
  const seen: { text: string; values: unknown[] }[] = [];
  pool.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text: string; values?: unknown[] };
    const values = (typeof first === "string" ? undefined : first.values) ?? (args[1] as unknown[]) ?? [];
    seen.push({ text: typeof first === "string" ? first : first.text, values });
    return original.apply(this, args);
  };
  return { seen, restore: () => { pool.query = original; } };
}

let serial = 0;
const newRoom = () => api!.createProjectWithName(`message-counts-${++serial}`);

test("an empty room and a missing room have no counts", skip, async () => {
  const room = await newRoom();
  assert.deepEqual(await expectMatches(room.id), []);
  assert.deepEqual(await expectMatches(room.id), []);
  assert.deepEqual(await api!.getRoomMessageCountsBySender("no-such-room"), []);
});

test("counts match the full query across the cache boundary, with hidden auto prompts", skip, async () => {
  const room = await newRoom();
  await send(room.id, "Alice", "one");
  await send(room.id, "Bob", "two");
  await autoPrompt(room.id, "Carol");
  await autoPrompt(room.id, "Bob", "visible auto prompt");
  await send(room.id, "Alice", "three", { agent_prompt_kind: "inline" });
  assert.deepEqual(await expectMatches(room.id), [
    { actor_label: "Alice", count: 2 },
    { actor_label: "Bob", count: 2 },
  ]);

  // Rows above the covered number: a new sender, a hidden row, more from old senders.
  await send(room.id, "Dave", "four");
  await autoPrompt(room.id, "Dave");
  await send(room.id, "Alice", "five");
  await autoPrompt(room.id, "Carol", "  now visible  ");
  assert.deepEqual(await expectMatches(room.id), [
    { actor_label: "Alice", count: 3 },
    { actor_label: "Bob", count: 2 },
    { actor_label: "Carol", count: 1 },
    { actor_label: "Dave", count: 1 },
  ]);
  await expectMatches(room.id);
});

test("a repeat request does not count the whole room again", skip, async () => {
  const room = await newRoom();
  for (let i = 0; i < 5; i++) await send(room.id, i % 2 ? "Alice" : "Bob", `m${i}`);
  await expectMatches(room.id);
  const { rows: [covered] } = await client!.pool.query<{ max: number }>(
    "SELECT MAX(number)::int AS max FROM messages WHERE room_id = $1", [room.id]);

  const capture = captureQueries();
  try {
    await api!.getRoomMessageCountsBySender(room.id);
    await send(room.id, "Alice", "m5");
    capture.seen.length = 0;
    await api!.getRoomMessageCountsBySender(room.id);
  } finally {
    capture.restore();
  }
  const countReads = capture.seen.filter(q => /count\(/i.test(q.text) && /"messages"/.test(q.text));
  assert.equal(countReads.length, 1, "one count statement per request");
  assert.match(countReads[0]!.text, /"messages"\."number" > \$\d+/,
    "the count reads only rows above the covered message number");
  assert.ok(countReads[0]!.values.includes(covered!.max), "the covered number is the room's previous highest number");
  await expectMatches(room.id);
});

test("deleting older blank auto prompts keeps counts exact", skip, async () => {
  const room = await newRoom();
  await autoPrompt(room.id, "Agent");
  await send(room.id, "Agent", "visible");
  await expectMatches(room.id);
  // A new prompt-only message deletes the sender's older blank auto prompts.
  await autoPrompt(room.id, "Agent");
  const before = await client!.pool.query("SELECT COUNT(*)::int AS n FROM messages WHERE room_id=$1", [room.id]);
  assert.equal(before.rows[0].n, 2, "the older blank auto prompt was deleted");
  await expectMatches(room.id);
  await autoPrompt(room.id, "Agent");
  await send(room.id, "Agent", "again");
  await expectMatches(room.id);
});

test("no_wake and visibility updates do not change counts", skip, async () => {
  const room = await newRoom();
  const first = await send(room.id, "Alice", "one");
  await send(room.id, "Bob", "two");
  await expectMatches(room.id);
  const number = Number(first.id.slice(4));
  await client!.pool.query(
    `UPDATE messages SET no_wake = '{"reason":"unknown"}'::jsonb, visibility = 'renter_only'
      WHERE room_id = $1 AND number = $2`, [room.id, number]);
  await expectMatches(room.id);
});

test("a reused room id is counted from the start, after a code rotation or a delete", skip, async () => {
  const room = await api!.createProject();
  const oldId = room.id;
  for (let i = 0; i < 4; i++) await send(oldId, "Old", `old ${i}`);
  await expectMatches(oldId);

  const rotated = await api!.rotateProjectCode(oldId);
  assert.ok(rotated && rotated.id !== oldId);
  assert.deepEqual(await expectMatches(rotated.id), [{ actor_label: "Old", count: 4 }]);

  // A new room takes the old id. Its numbers start at 1 again.
  await client!.db.insert(schema!.rooms).values({
    id: oldId, display_name: "reused", created_at: new Date(Date.now() + 1000).toISOString(),
  });
  for (let i = 0; i < 6; i++) await send(oldId, "New", `new ${i}`);
  assert.deepEqual(await expectMatches(oldId), [{ actor_label: "New", count: 6 }]);

  // Delete and recreate again.
  await client!.pool.query("DELETE FROM rooms WHERE id = $1", [oldId]);
  assert.deepEqual(await expectMatches(oldId), []);
  await client!.db.insert(schema!.rooms).values({
    id: oldId, display_name: "reused again", created_at: new Date(Date.now() + 2000).toISOString(),
  });
  await client!.pool.query("DELETE FROM id_sequences WHERE name = $1", [`messages:${oldId}`]);
  await send(oldId, "Newer", "hello");
  assert.deepEqual(await expectMatches(oldId), [{ actor_label: "Newer", count: 1 }]);
});

test("a change made outside the app is corrected within the full-recount bound", skip, async () => {
  const room = await newRoom();
  await send(room.id, "Alice", "one");
  await send(room.id, "Alice", "two");
  const start = Date.now();
  assert.deepEqual(await counts!.readRoomMessageCountsBySender(room.id, start),
    [{ actor_label: "Alice", count: 2 }]);

  // Manual SQL that no app path performs: rename a sender.
  await client!.pool.query("UPDATE messages SET sender = 'Bob' WHERE room_id = $1 AND number = 1", [room.id]);
  assert.deepEqual(await counts!.readRoomMessageCountsBySender(room.id, start + 1000),
    [{ actor_label: "Alice", count: 2 }], "inside the bound the cached answer may be stale");
  assert.deepEqual(
    sorted(await counts!.readRoomMessageCountsBySender(room.id, start + counts!.ROOM_MESSAGE_COUNT_FULL_RECOUNT_MS)),
    await referenceCounts(room.id));
});
