import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { RoomHistoryTask, RoomHistorySummarizerConfig } from "../history-summary/summarizer.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import("../db/client.js") : null;
const rooms = url ? await import("../db.js") : null;
const settings = url ? await import("../db/room-settings.js") : null;
const store = url ? await import("../history-summary/store.js") : null;
const worker = url ? await import("../history-summary/worker.js") : null;
const summarizer = url ? await import("../history-summary/summarizer.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;
const config: RoomHistorySummarizerConfig = { apiKey: "k", baseUrl: "https://example.test/v1", model: "m", timeoutMs: 1000 };

/** A summarizer that names what it summarized, so a test can check every line's source. */
function fakeWriter(log: RoomHistoryTask[] = []) {
  return async (_config: RoomHistorySummarizerConfig, task: RoomHistoryTask) => {
    log.push(task);
    return task.kind === "message" ? `S(${task.messageId})` : `M(${task.firstMessageId}..${task.lastMessageId})`;
  };
}

/** Runs worker turns for one room until it has nothing left to do. */
async function settle(roomId: string, write = fakeWriter(), maxTurns = 400): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    await store!.startOrWakeRoomHistory(roomId);
    for (const claim of await store!.claimRoomHistoryRooms(50)) {
      // Rooms of other tests are given back at once, never left held.
      if (claim.roomId === roomId) await worker!.runRoomHistoryTurn(claim, { config, write });
      else await store!.releaseRoomHistoryRoom(claim, { kind: "settle" });
    }
    if (!await store!.roomHistoryHasWork(roomId)) return;
  }
  throw new Error("the room never settled");
}

/** Claims due rooms, keeps this one, and gives the others back at once. */
async function claimOnly(roomId: string) {
  let mine = null;
  for (const claim of await store!.claimRoomHistoryRooms(50)) {
    if (claim.roomId === roomId) mine = claim;
    else await store!.releaseRoomHistoryRoom(claim, { kind: "settle" });
  }
  return mine;
}

const long = (label: string) => `${label} ${"detail ".repeat(120)}`;

test("messages become a tree of lines: short ones as they are, long ones summarized, pairs merged", options, async () => {
  const room = await rooms!.createProjectWithName(unique("history-tree"));
  for (let index = 1; index <= 6; index += 1) {
    await rooms!.addMessage(room.id, index % 2 ? "emmy" : "agent", index === 3 ? long("big") : `short ${index}`);
  }
  const log: RoomHistoryTask[] = [];
  await settle(room.id, fakeWriter(log));
  // Only the long message needed the summarizer; and the merges whose two lines did not fit together.
  assert.deepEqual(log.filter((task) => task.kind === "message").map((task) => task.kind === "message" && task.messageId), ["msg_3"]);
  const view = await store!.readRoomHistoryView(room.id, 160);
  assert.equal(view.covered_through_message_id, "msg_6");
  assert.deepEqual(view.lines.map((line) => line.pending), view.lines.map(() => false));
  // Every message is covered exactly once, in order.
  const covered = view.lines.flatMap((line) => {
    const first = Number(line.first_message_id.slice(4));
    const last = Number(line.last_message_id.slice(4));
    return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  });
  assert.deepEqual(covered, [1, 2, 3, 4, 5, 6]);
  assert.match(view.lines.map((line) => line.text).join(" | "), /S\(msg_3\)/);
  // Expanding a line goes down to the message.
  const top = view.lines[0]!;
  let node = top.node;
  for (let depth = 0; depth < 10 && !node.startsWith("0:"); depth += 1) {
    const [level, idx] = node.split(":").map(Number);
    const expansion = await store!.readRoomHistoryExpansion(room.id, level!, idx!);
    assert.equal(expansion!.lines.length, 2);
    node = expansion!.lines[0]!.node;
  }
  const leaf = await store!.readRoomHistoryExpansion(room.id, 0, 0);
  assert.equal(leaf!.message!.id, "msg_1");
  assert.equal(leaf!.message!.text, "short 1");
  const status = await store!.readRoomHistoryStatus(room.id);
  assert.equal(status.state, "ready");
  assert.equal(status.summarized_messages, 6);
});

test("a summarizer failure keeps the line waiting, shows the wait, and a later turn finishes it", options, async () => {
  const room = await rooms!.createProjectWithName(unique("history-retry"));
  await rooms!.addMessage(room.id, "emmy", long("first"));
  await rooms!.addMessage(room.id, "emmy", "second");
  const failing = async () => { throw new summarizer!.RoomHistorySummarizerError("retry", "The summarizer failed (HTTP 503)."); };
  await store!.startOrWakeRoomHistory(room.id);
  const claim = await claimOnly(room.id);
  await worker!.runRoomHistoryTurn(claim!, { config, write: failing });
  const waiting = await store!.readRoomHistoryStatus(room.id);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.last_error, "The summarizer failed (HTTP 503).");
  assert.ok(waiting.retry_at && new Date(waiting.retry_at).getTime() > Date.now());
  // The waiting message is shown as itself, clipped, and marked pending.
  const view = await store!.readRoomHistoryView(room.id, 160);
  assert.equal(view.lines[0]!.pending, true);
  assert.match(view.lines[0]!.text, /^emmy: first detail/);
  // A wake does not cut the wait short; the claim does not take the room yet.
  await store!.startOrWakeRoomHistory(room.id);
  assert.equal(await claimOnly(room.id), null);
  // Once the wait is over, the next turn writes the line.
  await client!.db.execute((await import("drizzle-orm")).sql`UPDATE room_history_summary_state SET available_at = now() WHERE room_id = ${room.id}`);
  await settle(room.id);
  assert.equal((await store!.readRoomHistoryStatus(room.id)).state, "ready");
  assert.equal((await store!.readRoomHistoryView(room.id, 160)).lines.every((line) => !line.pending), true);
});

test("a room starts with its newest backfill window, skips hidden messages, and stops when turned off", options, async () => {
  const room = await rooms!.createProjectWithName(unique("history-window"));
  for (let index = 1; index <= 2003; index += 1) await rooms!.addMessage(room.id, "bot", `m${index}`);
  // A blank automatic agent prompt is not a visible message.
  await rooms!.addMessage(room.id, "letagents", "", { agent_prompt_kind: "auto" } as never).catch(() => undefined);
  await settle(room.id);
  const status = await store!.readRoomHistoryStatus(room.id);
  assert.equal(status.summarized_messages, 2000);
  const view = await store!.readRoomHistoryView(room.id, 160);
  assert.equal(view.lines[0]!.first_message_id, "msg_4");
  assert.equal(view.covered_through_message_id, "msg_2003");

  await settings!.setRoomHistorySummaryEnabled(room.id, false);
  await rooms!.addMessage(room.id, "bot", "said while off");
  const before = (await store!.readRoomHistoryStatus(room.id)).summarized_messages;
  await store!.startOrWakeRoomHistory(room.id);
  const claim = await claimOnly(room.id);
  if (claim) await worker!.runRoomHistoryTurn(claim, { config, write: fakeWriter() });
  assert.equal((await store!.readRoomHistoryStatus(room.id)).summarized_messages, before, "nothing is read while off");
  // Turned back on (as the route does): what was said while off never leaves.
  await settings!.setRoomHistorySummaryEnabled(room.id, true);
  await store!.skipRoomHistoryToNow(room.id);
  const said = await rooms!.addMessage(room.id, "bot", "said after on");
  await settle(room.id);
  const after = await store!.readRoomHistoryView(room.id, 400);
  assert.equal((await store!.readRoomHistoryStatus(room.id)).summarized_messages, before + 1);
  assert.equal(after.covered_through_message_id, said.id);
  assert.ok(!after.lines.some((line) => line.text.includes("said while off")));
});

test("a wake while a worker holds the room is not lost", options, async () => {
  const room = await rooms!.createProjectWithName(unique("history-wake"));
  await rooms!.addMessage(room.id, "emmy", "first");
  await settle(room.id);
  await store!.startOrWakeRoomHistory(room.id);
  const claim = await claimOnly(room.id);
  assert.ok(claim, "the woken room is claimed");
  // A message arrives and its wake runs while the worker still holds the room.
  await rooms!.addMessage(room.id, "emmy", "second");
  await store!.startOrWakeRoomHistory(room.id);
  await store!.releaseRoomHistoryRoom(claim!, { kind: "settle" });
  assert.ok(await claimOnly(room.id), "the room is due again at once, not after the idle recheck");
});

test("an agent sees nothing held for its sequential reply turn", options, async () => {
  const room = await rooms!.createProjectWithName(unique("history-hold"));
  for (let index = 1; index <= 8; index += 1) await rooms!.addMessage(room.id, "emmy", `message ${index}`);
  await settle(room.id);
  const now = new Date().toISOString();
  await client!.db.execute((await import("drizzle-orm")).sql`INSERT INTO message_agent_receipts
    (id, message_room_id, message_number, room_id, agent_session_id, agent_key, actor_label, activation_reason,
     receipt_state, turn_position, turn_count, hold_release_after, created_at, updated_at)
    VALUES (${unique("receipt")}, ${room.id}, 6, ${room.id}, 'session-1', 'agent-b', 'Agent B', 'broadcast',
     'queued', 2, 2, now() + interval '5 minutes', ${now}, ${now})`);
  const held = await store!.readRoomHistoryView(room.id, 160, { holdAgentKey: "agent-b" });
  assert.equal(held.covered_through_message_id, "msg_5");
  assert.ok(held.lines.every((line) => Number(line.last_message_id.slice(4)) < 6));
  assert.equal(await store!.readRoomHistoryExpansion(room.id, 0, 6, { holdAgentKey: "agent-b" }), null);
  assert.equal(await store!.readRoomHistoryExpansion(room.id, 3, 0, { holdAgentKey: "agent-b" }), null, "a line that covers a held message");
  assert.equal((await store!.readRoomHistoryExpansion(room.id, 0, 4, { holdAgentKey: "agent-b" }))!.message!.id, "msg_5");
  // Other agents and people see everything.
  assert.equal((await store!.readRoomHistoryView(room.id, 160, { holdAgentKey: "agent-c" })).covered_through_message_id, "msg_8");
  assert.equal((await store!.readRoomHistoryView(room.id, 160)).covered_through_message_id, "msg_8");
});

test("a lost lease writes nothing", options, async () => {
  const room = await rooms!.createProjectWithName(unique("history-lease"));
  await rooms!.addMessage(room.id, "emmy", long("only"));
  await store!.startOrWakeRoomHistory(room.id);
  const claim = await claimOnly(room.id);
  assert.equal(await store!.ingestRoomHistoryMessages(claim!), 1);
  assert.equal(await store!.writeRoomHistoryLine({ ...claim!, token: "someone-else" }, 0, 0, "stolen"), false);
  assert.equal((await store!.readRoomHistoryView(room.id, 160)).lines[0]!.pending, true);
});
