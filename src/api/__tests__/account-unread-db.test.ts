import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createKnowledgeRecord } from "../../../shared/room-knowledge.mjs";

// Account-level unread counts and "Needs you" against a real database.
const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const skip = url ? false : "set TEST_DB_URL to run the account unread DB tests";
const client = url ? await import("../db/client.js") : null;
const api = url ? await import("../db.js") : null;
const unread = url ? await import("../account-unread/unread.js") : null;
const attention = url ? await import("../account-unread/attention.js") : null;
const knowledge = url ? await import("../db/room-knowledge.js") : null;
const members = url ? await import("../db/room-members.js") : null;
const settle = url ? await import("./settle-background-db-work.js") : null;

if (url) {
  test.beforeEach(async () => {
    await settle!.settleBackgroundDbWork();
    await client!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client!.pool.query("CREATE SCHEMA public");
    await migrate(client!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  });
  test.after(async () => {
    await settle!.settleBackgroundDbWork();
    await client!.pool.end();
  });
}

let sequence = 0;
async function account(login: string) {
  sequence += 1;
  return api!.upsertAccount({ provider: "github", provider_user_id: `unread-${sequence}`, login, display_name: `${login} Display` });
}
async function read(roomId: string, accountId: string, first: number, last: number, scope: "timeline" | "thread" = "timeline", root: number | null = null) {
  sequence += 1;
  await client!.pool.query(`
    INSERT INTO message_human_read_ranges (id, room_id, account_id, scope_kind, thread_root_number, first_message_sequence,
      last_message_sequence, client_batch_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
  `, [`range-${sequence}`, roomId, accountId, scope, root, first, last, `batch-${sequence}`]);
}
const num = (id: string) => Number(id.slice(4));

test("unread counts follow the account's read point and the desktop's rules", { skip }, async () => {
  const me = await account("Emmy");
  const other = await account("Ada");
  const room = await api!.createProjectWithName("unread-rules");
  const quiet = await api!.createProjectWithName("unread-never-read");
  const send = (sender: string, text: string, options: Record<string, unknown> = {}) =>
    api!.addMessage(room.id, sender, text, { source: "browser", ...options });

  const first = await send("Ada", "before the read point", { account_id: other.id });
  await read(room.id, me.id, num(first.id), num(first.id));
  await send("Ada", "counted: another person", { account_id: other.id });
  await send("Emmy", "own: my account", { account_id: me.id });
  await send("emmy display", "own: my display name, an old message with no account");
  await send("Worker", "counted: my own agent", { source: "agent", account_id: me.id, publisher_agent_key: `${me.id}/worker` });
  await send("Worker", "", { source: "agent", agent_prompt_kind: "auto" }); // blank automatic prompt
  await send("github", "Check \"build\" (GitHub Actions) success in BrosInCode/letagents https://github.com/x/y/runs/1", { source: "github" });
  await send("github", "check \"lint\" SKIPPED in BrosInCode/letagents linked to task_7", { source: "github" });
  await send("github", "Check \"test\" failure in BrosInCode/letagents https://github.com/x/y/runs/2", { source: "github" });
  await send("github", "Pull request #12 opened by Ada", { source: "github" });
  const hidden = await send("Ada", "a rental message hidden from the room", { account_id: other.id });
  await client!.pool.query("UPDATE messages SET visibility = 'internal' WHERE room_id = $1 AND number = $2", [room.id, num(hidden.id)]);

  const rows = await unread!.loadAccountRoomUnread({ accountId: me.id, ownSenderNames: ["Emmy", "Emmy Display"], roomIds: [room.id, quiet.id, room.id] });
  const byRoom = new Map(rows.map((row) => [row.room_id, row]));
  assert.equal(rows.length, 2);
  assert.deepEqual(byRoom.get(room.id), {
    room_id: room.id, read_message_id: first.id,
    unread_count: 2, // another person, my own agent
    github_unread_count: 2, // the failed check and the pull request; passing and skipped checks never count
  });
  assert.deepEqual(byRoom.get(quiet.id), { room_id: quiet.id, read_message_id: null, unread_count: null, github_unread_count: null });

  // The read point is the furthest read in any scope, on any device.
  const last = await send("Ada", "the newest", { account_id: other.id });
  await read(room.id, me.id, num(last.id), num(last.id), "thread", num(first.id));
  const [after] = await unread!.loadAccountRoomUnread({ accountId: me.id, ownSenderNames: ["Emmy"], roomIds: [room.id] });
  assert.deepEqual(after, { room_id: room.id, read_message_id: last.id, unread_count: 0, github_unread_count: 0 });
  // Another account's reads are its own.
  const [theirs] = await unread!.loadAccountRoomUnread({ accountId: other.id, ownSenderNames: ["Ada"], roomIds: [room.id] });
  assert.equal(theirs!.read_message_id, null);
});

test("unread counts stop at the cap", { skip }, async () => {
  const me = await account("Emmy");
  const room = await api!.createProjectWithName("unread-cap");
  const first = await api!.addMessage(room.id, "Ada", "start", { source: "browser" });
  await read(room.id, me.id, num(first.id), num(first.id));
  await client!.pool.query(`
    INSERT INTO messages (room_id, number, sender, text, source, timestamp)
    SELECT $1, $2 + n, 'Ada', 'bulk ' || n, 'browser', now() FROM generate_series(1, $3) AS n
  `, [room.id, num(first.id), unread!.UNREAD_COUNT_CAP + 5]);
  const [row] = await unread!.loadAccountRoomUnread({ accountId: me.id, ownSenderNames: [], roomIds: [room.id] });
  assert.equal(row!.unread_count, unread!.UNREAD_COUNT_CAP);
});

test("Needs you for the account matches each room's attention route and skips rooms it cannot read", { skip }, async () => {
  const me = await account("Emmy");
  const admin = await api!.createProjectWithName("attention-admin");
  const member = await api!.createProjectWithName("attention-member");
  const stranger = await api!.createProjectWithName("attention-stranger");
  await api!.assignProjectAdmin(admin.id, me.id);
  await members!.addRoomMember({ roomId: admin.id, accountId: me.id, addedVia: "creator" });
  await members!.addRoomMember({ roomId: member.id, accountId: me.id, addedVia: "seed" });
  const agent = { id: "owner/worker", label: "Worker", kind: "agent" as const };
  for (const room of [admin, member, stranger]) {
    await knowledge!.createRoomKnowledge(createKnowledgeRecord(room.id, "attention",
      { client_id: `ask-${room.id}`, category: "decision", title: `Decide in ${room.id}`, body: "Which one?" }, agent));
  }
  const card = await api!.createTask(member.id, "Blocked card", "Worker");
  await client!.pool.query("UPDATE tasks SET status = 'blocked' WHERE room_id = $1 AND number = $2", [member.id, Number(card.id.replace(/^task_/, ""))]);
  const sessionAccount = { account_id: me.id, provider: "github", login: "Emmy", provider_access_token: null } as never;
  const result = await attention!.loadAccountAttention(sessionAccount, [
    { room_id: admin.id, role: "admin", latest_message_at: null },
    { room_id: member.id, role: "participant", latest_message_at: null },
    { room_id: stranger.id, role: "participant", latest_message_at: null },
  ]);
  assert.deepEqual(result.rooms.map((room) => room.room_id), [admin.id, member.id]);
  assert.deepEqual(result.failures, [{ room_id: stranger.id }]);
  for (const room of result.rooms) {
    const perRoom = await knowledge!.listRoomKnowledge(room.room_id, "attention");
    assert.deepEqual(room.records, perRoom.records);
    assert.equal(room.truncated, perRoom.truncated);
  }
  assert.deepEqual(result.rooms[1]!.tasks.map((task) => [task.id, task.status]), [[card.id, "blocked"]]);
  assert.deepEqual(result.rooms[0]!.tasks, []);
  assert.deepEqual(result.rooms[0]!.board_intents, [], "an admin room carries its pending intents");
  assert.equal(result.rooms[1]!.board_intents, undefined, "a participant does not decide intents");
});

test("the read point index is built concurrently after the migrations, once, and is used for the read point", { skip }, async () => {
  const rollout = await import("../db/read-range-index-rollout.js");
  assert.deepEqual(await rollout.reconcileReadRangeIndexRollout(client!.pool), [rollout.READ_RANGE_READ_POINT_INDEX]);
  assert.deepEqual(await rollout.reconcileReadRangeIndexRollout(client!.pool), [], "a second run builds nothing");
  const plan = await client!.pool.query(`EXPLAIN SELECT max(last_message_sequence) FROM message_human_read_ranges
    WHERE room_id = 'r' AND account_id = 'a'`);
  assert.match(plan.rows.map((row) => Object.values(row)[0]).join("\n"), /read_point_idx/);
});
