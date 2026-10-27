import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { inspectorPreparedRoomContext, readPreparedRoomTurnFiles, recordPreparedRoomTurnFiles } from "../prepared-room-context.js";

// Only the columns the record reads: the inbox rows and their prepared context.
function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE supervised_agent_inbox (inbox_item_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL);
    CREATE TABLE supervised_agent_prepared_context (inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id),
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))) STRICT;`);
  return db;
}

function turn(db: DatabaseSync, id: string, preparedAt: string | null, files?: { continuation: string; outcome: string; attachment?: string }) {
  db.prepare("INSERT INTO supervised_agent_inbox(inbox_item_id,agent_id,room_id) VALUES (?,?,?)").run(id, "agent", "room");
  if (preparedAt === null) return; // Still waiting: never prepared for dispatch.
  db.prepare("INSERT INTO supervised_agent_prepared_context(inbox_item_id,snapshot_json) VALUES (?,?)")
    .run(id, JSON.stringify({ preparedAt, totalMessages: 0, omittedMessages: 0, messages: [] }));
  if (files) recordPreparedRoomTurnFiles(db, id, { continuation: files.continuation,
    files: [{ message_id: "msg_4", attachment_id: files.attachment ?? "att_1", outcome: files.outcome as "image" }] });
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 10, minute)).toISOString();
const read = (db: DatabaseSync, inboxItemId: string, continuation = "thread") =>
  readPreparedRoomTurnFiles(db, { agentId: "agent", roomId: "room", continuation, inboxItemId });

test("a turn that overtook an older queued message still counts for it, by dispatch order", () => {
  const db = database();
  turn(db, "queued-automated", null);
  turn(db, "human", at(1), { continuation: "thread", outcome: "image" });
  // The older row runs after the human turn that overtook it.
  assert.deepEqual([...read(db, "queued-automated")], [["msg_4\natt_1", "image"]]);
  assert.deepEqual([...read(db, "human")], [], "a turn is not its own earlier turn");
  assert.deepEqual([...read(db, "queued-automated", "thread-2")], [], "another conversation has not received it");
});

test("a received image counts for 20 dispatched turns; a refusal for every retained turn", () => {
  const db = database();
  turn(db, "t0", at(0), { continuation: "thread", outcome: "image" });
  turn(db, "t0-refused", at(0), { continuation: "thread", outcome: "too_large", attachment: "att_2" });
  for (let index = 1; index < 20; index++) turn(db, `t${index}`, at(index));
  turn(db, "waiting", null);
  turn(db, "now", null);
  assert.equal(read(db, "now").get("msg_4\natt_1"), undefined, "21 dispatched turns ago is past the bound");
  assert.equal(read(db, "now").get("msg_4\natt_2"), "too_large");
  db.prepare("DELETE FROM supervised_agent_prepared_context WHERE inbox_item_id='t19'").run();
  assert.equal(read(db, "now").get("msg_4\natt_1"), "image", "20 dispatched turns ago is inside it; waiting rows do not count");
});

test("the Inspector's prepared context leaves the file record out", () => {
  assert.deepEqual(inspectorPreparedRoomContext({ preparedAt: "x", totalMessages: 0, omittedMessages: 0, messages: [], room_files: { continuation: "c", files: [] } }),
    { preparedAt: "x", totalMessages: 0, omittedMessages: 0, messages: [] });
  assert.equal(inspectorPreparedRoomContext(null), null);
});
