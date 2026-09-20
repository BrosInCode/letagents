import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DaemonStateSchema, DAEMON_STATE_SCHEMA_VERSION } from "../daemon-state-database.js";
import { prepareRoomContext } from "../prepared-room-context.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";

test("context snapshots bound retained text and exclude non-text provider fields", () => {
  const snapshot = prepareRoomContext(Array.from({ length: 32 }, (_, index) => ({
    id: String(index), sender: "Emmy", text: "a".repeat(2_001),
    attachment: { data: "attachment-payload" }, token: "runtime-credential",
  })), "2026-09-20T09:00:00.000Z");
  assert.equal(snapshot.messages.length, 30);
  assert.equal(snapshot.totalMessages, 32);
  assert.equal(snapshot.omittedMessages, 2);
  assert.equal(snapshot.messages[0]?.text?.length, 2_000);
  assert.equal(snapshot.messages[0]?.truncated, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /attachment-payload|runtime-credential/);
  assert.deepEqual(prepareRoomContext([null, { text: "" }], "now").messages, [
    { id: null, sender: null, text: null, truncated: false },
    { id: null, sender: null, text: "", truncated: false },
  ]);
});

test("dispatch context survives restart, remains exact to its message, and is pruned with the receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-prepared-context-"));
  const path = join(root, "state.sqlite");
  let store = new SupervisedAgentInboxStore(path, () => "2026-09-20T09:00:00.000Z");
  try {
    const [item] = await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1", text: "Fix auth" }, activation: { reason: "mention" } }] });
    assert.equal((await store.detail("stone", "room", "1")).prepared_context, null);
    await assert.rejects(store.checkpointDispatchIntent(item!.inbox_item_id, undefined, []), /unstarted dispatching/);
    await store.transition(item!.inbox_item_id, "dispatching");
    const context = [{ id: "0", sender: "Emmy", text: "Keep the public API unchanged" }];
    await store.checkpointDispatchIntent(item!.inbox_item_id, undefined, context);
    await store.checkpointTurnStarted(item!.inbox_item_id, "native-1", {
      work_attempt_id: "attempt", origin_execution_generation_id: "generation", provider_continuation_id: "conversation",
    });
    await assert.rejects(store.checkpointDispatchIntent(item!.inbox_item_id, undefined, []), /unstarted dispatching/);
    await store.close();
    store = new SupervisedAgentInboxStore(path);
    const saved = (await store.detail("stone", "room", "1")).prepared_context;
    assert.deepEqual(saved, prepareRoomContext(context, "2026-09-20T09:00:00.000Z"));
    assert.equal((await store.detail("other-agent", "room", "1")).prepared_context, undefined);
    assert.equal((await store.detail("stone", "other-room", "1")).prepared_context, undefined);
    assert.equal((await store.detail("stone", "room", "2")).prepared_context, undefined);
    await store.close();
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      database.prepare("DELETE FROM supervised_agent_inbox WHERE inbox_item_id=?").run(item!.inbox_item_id);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM supervised_agent_prepared_context").get()?.count, 0);
    } finally { database.close(); }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("v42 migration preserves manifest generation and rolls back both version markers on failure", () => {
  const database = new DatabaseSync(":memory:");
  try {
    new DaemonStateSchema().createSchema(database);
    database.exec("DROP TABLE supervised_agent_prepared_context; PRAGMA user_version=42; UPDATE manifest_metadata SET schema_version=42");
    const metadata = database.prepare("SELECT generation FROM manifest_metadata").get();
    assert.throws(() => new DaemonStateSchema(() => { throw new Error("interrupted upgrade"); }).createSchema(database), /interrupted upgrade/);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 42);
    assert.equal(database.prepare("SELECT schema_version FROM manifest_metadata").get()?.schema_version, 42);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='supervised_agent_prepared_context'").get(), undefined);
    new DaemonStateSchema().createSchema(database);
    new DaemonStateSchema().validateCurrentShape(database);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.deepEqual(database.prepare("SELECT generation FROM manifest_metadata").get(), metadata);
    database.exec("DROP TABLE supervised_agent_prepared_context");
    assert.throws(() => new DaemonStateSchema().createSchema(database), /invalid schema/);
  } finally { database.close(); }
});
