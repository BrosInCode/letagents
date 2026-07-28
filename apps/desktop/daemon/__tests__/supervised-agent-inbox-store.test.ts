import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervised-inbox-"));
  return { root, database: join(root, "daemon-state.sqlite"), legacy: join(root, "legacy.json"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function prepareSecretBearingV5(env: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const initial = new WorkerBindingStore(env.legacy, undefined, env.database);
  await initial.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run", agent_session_id: "session", agent_session_token: "one-shot", api_url: "https://letagents.test" });
  await initial.close();
  const db = new DatabaseSync(env.database);
  db.exec(`DROP INDEX worker_session_binding_authority;
    ALTER TABLE worker_session_bindings RENAME TO worker_session_bindings_v6_source;
    CREATE TABLE worker_session_bindings (
      entry_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, work_attempt_id TEXT NOT NULL,
      execution_generation_id TEXT NOT NULL, agent_session_id TEXT NOT NULL, agent_session_token TEXT NOT NULL,
      api_url TEXT NOT NULL, room_cursor TEXT, last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0), binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1), updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO worker_session_bindings SELECT entry_id,room_id,work_attempt_id,execution_generation_id,agent_session_id,'old-persisted-secret',api_url,room_cursor,last_sequence,last_observed_at_ms,binding_epoch,updated_at FROM worker_session_bindings_v6_source;
    DROP TABLE worker_session_bindings_v6_source;
    CREATE UNIQUE INDEX worker_session_binding_authority ON worker_session_bindings(entry_id,binding_epoch,execution_generation_id,agent_session_id);
    UPDATE manifest_metadata SET schema_version=5 WHERE singleton=1;
    PRAGMA user_version=5;`);
  db.close();
}

test("poll ingestion advances its cursor atomically, deduplicates replay, and retains FIFO", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-20T12:00:00.000Z");
    const first = await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: "2", messages: [
      { source_message_id: "1", source_message: { text: "one" }, activation: { for_current_agent: true } },
      { source_message_id: "2", source_message: { text: "two" }, activation: { for_current_agent: true } },
    ] });
    assert.deepEqual(first.map((item) => item.fifo_sequence), [1, 2]);
    const replay = await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: "3", messages: [
      { source_message_id: "2", source_message: { text: "changed but ignored" }, activation: { for_current_agent: true } },
      { source_message_id: "3", source_message: { text: "three" }, activation: { for_current_agent: true } },
    ] });
    assert.deepEqual(replay.map((item) => item.fifo_sequence), [2, 3]);
    assert.equal((await store.cursor("stone"))?.last_observed_message_id, "3");
    await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: null, messages: [] });
    assert.equal((await store.cursor("stone"))?.last_observed_message_id, "3", "a replay without a cursor cannot regress durable progress");
    await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: "1", messages: [] });
    assert.equal((await store.cursor("stone"))?.last_observed_message_id, "3", "a delayed older poll cannot regress the cursor");
    await assert.rejects(() => store.ingestPoll({ agent_id: "stone", room_id: "room", expected_cursor: "2", last_observed_message_id: "4", messages: [] }), /cursor changed/);
    assert.equal((await store.head("stone"))?.source_message_id, "1");
    assert.match(first[0]!.action_id, /stone:room:1:action:v1$/);
    assert.match(first[0]!.reply_client_message_id, /stone:room:1:reply:v1$/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("the same source id in separate rooms remains separate durable inbox and observed context", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [first] = await store.ingestPoll({
      agent_id: "stone", room_id: "room_a", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { text: "first room" }, activation: {} }],
      observed_messages: [{ source_message_id: "msg_1", source_message: { text: "first room" }, activation: {}, activation_decision: "activate" }],
    });
    await store.commitRoomMoveQueue({ agent_id: "stone", old_room_id: "room_a", after_fifo_sequence: first!.fifo_sequence });
    const [second] = await store.ingestPoll({
      agent_id: "stone", room_id: "room_b", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { text: "second room" }, activation: {} }],
      observed_messages: [{ source_message_id: "msg_1", source_message: { text: "second room" }, activation: {}, activation_decision: "activate" }],
    });
    assert.ok(first && second);
    assert.notEqual(first.inbox_item_id, second.inbox_item_id);
    assert.notEqual(first.action_id, second.action_id);
    assert.notEqual(first.reply_client_message_id, second.reply_client_message_id);
    assert.match(first.action_id, /stone:room_a:msg_1:action:v1$/);
    assert.match(second.reply_client_message_id, /stone:room_b:msg_1:reply:v1$/);
    assert.equal((await store.detail("stone", "room_a", "msg_1")).source_message?.text, "first room");
    assert.equal((await store.detail("stone", "room_b", "msg_1")).source_message?.text, "second room");
    assert.equal((await store.observedContext("stone", "room_a"))[0]?.source_message_id, "msg_1");
    assert.equal((await store.observedContext("stone", "room_b"))[0]?.source_message_id, "msg_1");
    await store.close();
  } finally { await env.cleanup(); }
});

test("blocked FIFO head exposes the causal wait and retry resumes that exact item", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [one] = await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: "1", messages: [
      { source_message_id: "1", source_message: { text: "one" }, activation: {} },
    ] });
    await store.transition(one!.inbox_item_id, "dispatching");
    await store.transition(one!.inbox_item_id, "awaiting_result", { provider_turn_id: "turn_1" });
    const noReply = await store.transition(one!.inbox_item_id, "acknowledged_no_reply", { outcome: "no_reply" });
    assert.equal(noReply.state, "acknowledged_no_reply");
    assert.ok(noReply.acknowledged_at);
    // A separate agent exercises the blocked-head behavior independently.
    const [blocked] = await store.ingestPoll({ agent_id: "blocked", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "b", source_message: {}, activation: {} }] });
    const [later] = await store.ingestPoll({ agent_id: "blocked", room_id: "room", last_observed_message_id: "2", messages: [{ source_message_id: "c", source_message: {}, activation: {} }] });
    await store.transition(blocked!.inbox_item_id, "dispatching");
    await assert.rejects(() => store.transition(later!.inbox_item_id, "dispatching"), /FIFO head/);
    await store.transition(blocked!.inbox_item_id, "blocked", { last_error: "terminal failure" });
    assert.equal((await store.head("blocked"))?.inbox_item_id, blocked!.inbox_item_id);
    const blockedReceipts = await store.receipts("blocked");
    assert.equal(blockedReceipts[1]!.receipt_state, "queued_behind_blocked");
    const retriedBlocked = await store.retryBlocked(blocked!.inbox_item_id);
    assert.equal(retriedBlocked.blocked_by_inbox_item_id, null);
    assert.equal(retriedBlocked.next_attempt_at_ms, null);
    assert.equal(later!.state, "pending");
    assert.equal((await store.claimHead("blocked"))?.inbox_item_id, blocked!.inbox_item_id);
    await store.close();
  } finally { await env.cleanup(); }
});

test("continuation repair journal resumes across daemon generations and releases only its exact head", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-27T12:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "repairable",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: 00000000-0000-0000-0000-000000000001",
    });
    const repair = await store.beginContinuationRepair({
      agent_id: "repairable",
      room_id: "room",
      inbox_item_id: item!.inbox_item_id,
      daemon_generation: 4,
      execution_generation_id: "execution_1",
      work_attempt_id: "attempt_1",
      expected_pid: 4100,
      expected_process_identity: "pid-4100-birth-1",
      missing_continuation: "00000000-0000-0000-0000-000000000001",
    });
    await store.checkpointContinuationReplacement(
      repair.repair_id,
      "00000000-0000-0000-0000-000000000002",
    );
    await store.close();

    const successor = new SupervisedAgentInboxStore(env.database, () => "2026-07-27T12:00:07.000Z");
    const resumed = await successor.beginContinuationRepair({
      agent_id: "repairable",
      room_id: "room",
      inbox_item_id: item!.inbox_item_id,
      daemon_generation: 5,
      execution_generation_id: "execution_1",
      work_attempt_id: "attempt_1",
      expected_pid: 4100,
      expected_process_identity: "pid-4100-birth-1",
      missing_continuation: "00000000-0000-0000-0000-000000000001",
    });
    assert.equal(resumed.repair_id, repair.repair_id);
    assert.equal(resumed.daemon_generation, 5);
    assert.equal(resumed.phase, "replacement_created");
    assert.equal(resumed.replacement_continuation, "00000000-0000-0000-0000-000000000002");
    await assert.rejects(
      successor.commitContinuationRepair(
        resumed.repair_id,
        "00000000-0000-0000-0000-000000000003",
        true,
      ),
      /different replacement conversation/,
      "the journal cannot be committed with an uncheckpointed continuation",
    );
    const released = await successor.commitContinuationRepair(
      resumed.repair_id,
      resumed.replacement_continuation!,
      true,
    );
    assert.equal(released.state, "pending");
    assert.equal(released.failure_code, null);
    assert.equal(released.attempt_count, 0);
    assert.equal((await successor.latestContinuationRepair("repairable"))?.phase, "committed");
    assert.deepEqual(
      (await successor.receipts("repairable"))[0]!.timeline.map((event) => event.phase),
      ["received", "queued", "blocked", "conversation_restoring", "conversation_restored"],
    );
    await successor.close();
  } finally { await env.cleanup(); }
});

test("a committed repair can be durably exhausted without reopening the blocked head", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-27T12:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "repair-loop",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: thread-1",
    });
    const repair = await store.beginContinuationRepair({
      agent_id: "repair-loop",
      room_id: "room",
      inbox_item_id: item!.inbox_item_id,
      daemon_generation: 4,
      execution_generation_id: "execution_1",
      work_attempt_id: "attempt_1",
      expected_pid: 4100,
      expected_process_identity: "pid-4100-birth-1",
      missing_continuation: "thread-1",
    });
    await store.commitContinuationRepair(repair.repair_id, "thread-1", false);
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.transition(item!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: thread-1",
    });

    const exhausted = await store.exhaustCommittedContinuationRepair(
      item!.inbox_item_id,
      repair.repair_id,
      "Automatic recovery stopped to prevent a retry loop.",
    );
    assert.equal(exhausted.state, "blocked");
    assert.equal(exhausted.attempt_count, 0);
    assert.equal(exhausted.last_error, "Automatic recovery stopped to prevent a retry loop.");
    await store.exhaustCommittedContinuationRepair(
      item!.inbox_item_id,
      repair.repair_id,
      "Automatic recovery stopped to prevent a retry loop.",
    );
    assert.equal(
      (await store.receipts("repair-loop"))[0]!.timeline.filter((event) =>
        event.detail === "Automatic recovery stopped to prevent a retry loop.").length,
      1,
      "replayed exhaustion records one durable blocked event",
    );
    await store.close();
  } finally { await env.cleanup(); }
});

test("v12 migration types only exact pre-turn historical missing-thread failures", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const historicalError = "thread not found: 00000000-0000-0000-0000-000000000001";
    const [safe] = await store.ingestPoll({
      agent_id: "safe",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "safe", source_message: {}, activation: {} }],
    });
    await store.transition(safe!.inbox_item_id, "blocked", { last_error: historicalError });

    const [started] = await store.ingestPoll({
      agent_id: "started",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "started", source_message: {}, activation: {} }],
    });
    await store.transition(started!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(started!.inbox_item_id, "turn_started");
    await store.transition(started!.inbox_item_id, "blocked", { last_error: historicalError });

    const [wrapped] = await store.ingestPoll({
      agent_id: "wrapped",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "wrapped", source_message: {}, activation: {} }],
    });
    await store.transition(wrapped!.inbox_item_id, "blocked", {
      last_error: `Provider failed because ${historicalError}`,
    });
    await store.close();

    // Recreate the physical v12 delivery tables around these real rows. This
    // is the exact predecessor shape shipped before continuation repair.
    const database = new DatabaseSync(env.database);
    database.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      DROP TABLE provider_continuation_repairs;
      DROP TABLE supervised_agent_inbox_events;
      DROP TABLE supervised_agent_terminal_results;
      DROP TABLE supervised_agent_publications;
      ALTER TABLE supervised_agent_inbox RENAME TO supervised_agent_inbox_v13_source;
      CREATE TABLE supervised_agent_inbox (
        inbox_item_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
        source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
        fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        action_id TEXT NOT NULL, reply_client_message_id TEXT NOT NULL,
        provider_turn_id TEXT, outcome TEXT, last_error TEXT,
        blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
        next_attempt_at_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
        UNIQUE(agent_id,room_id,source_message_id), UNIQUE(agent_id,fifo_sequence),
        UNIQUE(inbox_item_id,agent_id,room_id)
      ) STRICT;
      INSERT INTO supervised_agent_inbox
        (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
        SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
        FROM supervised_agent_inbox_v13_source;
      DROP TABLE supervised_agent_inbox_v13_source;
      CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
      CREATE TABLE supervised_agent_inbox_events (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0), idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
        observed_at TEXT NOT NULL, detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence), UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
      CREATE TABLE supervised_agent_terminal_results (
        inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL, execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','unreadable')),
        normalized_text TEXT, evidence_source TEXT NOT NULL CHECK(evidence_source IN ('transcript','stream','none')),
        terminal_evidence_json TEXT NOT NULL, observed_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);
      CREATE TABLE supervised_agent_publications (
        inbox_item_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL, canonical_message_id TEXT NOT NULL, published_at TEXT NOT NULL,
        FOREIGN KEY(inbox_item_id,agent_id,room_id)
          REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE,
        UNIQUE(room_id,client_message_id), UNIQUE(room_id,canonical_message_id)
      ) STRICT;
      CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(agent_id,room_id);
      UPDATE manifest_metadata SET schema_version=12 WHERE singleton=1;
      PRAGMA user_version=12;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
    database.close();

    const migrated = new SupervisedAgentInboxStore(env.database);
    assert.equal((await migrated.get(safe!.inbox_item_id))?.failure_code, "provider_continuation_missing");
    assert.equal((await migrated.get(started!.inbox_item_id))?.failure_code, null, "a started turn remains ambiguous");
    assert.equal((await migrated.get(wrapped!.inbox_item_id))?.failure_code, null, "similar prose is never promoted to recovery authority");
    await migrated.close();
  } finally { await env.cleanup(); }
});

test("current v13 repairs an intermediate inbox missing the failure-code constraint", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [item] = await store.ingestPoll({
      agent_id: "partial-v13",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: 00000000-0000-0000-0000-000000000001",
    });
    const repair = await store.beginContinuationRepair({
      agent_id: "partial-v13",
      room_id: "room",
      inbox_item_id: item!.inbox_item_id,
      daemon_generation: 4,
      execution_generation_id: "execution_1",
      work_attempt_id: "attempt_1",
      expected_pid: 4100,
      expected_process_identity: "pid-4100-birth-1",
      missing_continuation: "00000000-0000-0000-0000-000000000001",
    });
    await store.close();

    // Reproduce the intermediate v13 build that added the column and journal
    // but omitted the failure-code CHECK from the persisted table definition.
    const partial = new DatabaseSync(env.database);
    const schemaVersion = (partial.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
    partial.exec("PRAGMA writable_schema=ON");
    partial.prepare(`
      UPDATE sqlite_master
      SET sql=replace(
        sql,
        'failure_code TEXT CHECK(failure_code IS NULL OR failure_code=''provider_continuation_missing'')',
        'failure_code TEXT'
      )
      WHERE type='table' AND name='supervised_agent_inbox'
    `).run();
    partial.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1}`);
    partial.close();

    const repaired = new SupervisedAgentInboxStore(env.database);
    assert.equal(
      (await repaired.get(item!.inbox_item_id))?.failure_code,
      "provider_continuation_missing",
      "typed failure authority survives the table repair",
    );
    assert.equal(
      (await repaired.latestContinuationRepair("partial-v13"))?.repair_id,
      repair.repair_id,
      "the continuation-repair journal survives the table repair",
    );
    await repaired.close();

    const inspection = new DatabaseSync(env.database);
    const inboxSql = (inspection.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox'",
    ).get() as { sql: string }).sql;
    assert.match(
      inboxSql,
      /CHECK\s*\(\s*failure_code\s+IS\s+NULL\s+OR\s+failure_code\s*=\s*'provider_continuation_missing'\s*\)/i,
    );
    assert.equal(
      (inspection.prepare(
        "SELECT COUNT(*) AS count FROM supervised_agent_inbox_events WHERE inbox_item_id=?",
      ).get(item!.inbox_item_id) as { count: number }).count,
      4,
      "causal inbox events survive the table repair",
    );
    assert.equal(inspection.prepare("PRAGMA foreign_key_check").get(), undefined);
    inspection.close();
  } finally { await env.cleanup(); }
});

test("current v13 rejects unsupported failure codes even when the repair journal is absent", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [item] = await store.ingestPoll({
      agent_id: "unsupported-failure",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.close();

    const malformed = new DatabaseSync(env.database);
    const schemaVersion = (malformed.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
    malformed.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE provider_continuation_repairs;
      PRAGMA writable_schema=ON;
    `);
    malformed.prepare(`
      UPDATE sqlite_master
      SET sql=replace(
        sql,
        'failure_code TEXT CHECK(failure_code IS NULL OR failure_code=''provider_continuation_missing'')',
        'failure_code TEXT'
      )
      WHERE type='table' AND name='supervised_agent_inbox'
    `).run();
    malformed.exec(`PRAGMA writable_schema=OFF; PRAGMA schema_version=${schemaVersion + 1};`);
    malformed.close();

    const unsupported = new DatabaseSync(env.database);
    unsupported.prepare(
      "UPDATE supervised_agent_inbox SET failure_code='future_failure' WHERE inbox_item_id=?",
    ).run(item!.inbox_item_id);
    unsupported.close();

    const rejected = new SupervisedAgentInboxStore(env.database);
    await assert.rejects(
      () => rejected.get(item!.inbox_item_id),
      /unsupported continuation failure code/,
    );
    await rejected.close();
  } finally { await env.cleanup(); }
});

test("current v13 repair rolls back its temporary journal backup as one atomic unit", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [item] = await store.ingestPoll({
      agent_id: "repairable",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "blocked", {
      failure_code: "provider_continuation_missing",
      last_error: "thread not found: 00000000-0000-0000-0000-000000000001",
    });
    const repair = await store.beginContinuationRepair({
      agent_id: "repairable",
      room_id: "room",
      inbox_item_id: item!.inbox_item_id,
      daemon_generation: 4,
      execution_generation_id: "execution_1",
      work_attempt_id: "attempt_1",
      expected_pid: 4100,
      expected_process_identity: "pid-4100-birth-1",
      missing_continuation: "00000000-0000-0000-0000-000000000001",
    });
    await store.close();

    // Simulate a current v13 marker paired with the rolled-back v12 delivery
    // graph that the repair path is designed to heal. Keep the v13 repair
    // journal in place so applyV13Shape must use its TEMP backup path.
    const database = new DatabaseSync(env.database);
    database.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TEMP TABLE inbox_v13_backup AS SELECT * FROM supervised_agent_inbox;
      DROP TABLE supervised_agent_inbox_events;
      DROP TABLE supervised_agent_terminal_results;
      DROP TABLE supervised_agent_publications;
      DROP TABLE supervised_agent_inbox;
      CREATE TABLE supervised_agent_inbox (
        inbox_item_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
        source_message_json TEXT NOT NULL, activation_json TEXT NOT NULL,
        fifo_sequence INTEGER NOT NULL CHECK (fifo_sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('pending','dispatching','awaiting_result','result_recovery','publishing','retryable','blocked','acknowledged','acknowledged_no_reply','cancelled_by_room_move')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        action_id TEXT NOT NULL, reply_client_message_id TEXT NOT NULL,
        provider_turn_id TEXT, outcome TEXT, last_error TEXT,
        blocked_by_inbox_item_id TEXT REFERENCES supervised_agent_inbox(inbox_item_id),
        next_attempt_at_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT,
        UNIQUE(agent_id,room_id,source_message_id), UNIQUE(agent_id,fifo_sequence),
        UNIQUE(inbox_item_id,agent_id,room_id)
      ) STRICT;
      INSERT INTO supervised_agent_inbox
        (inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at)
        SELECT inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,outcome,last_error,blocked_by_inbox_item_id,next_attempt_at_ms,created_at,updated_at,acknowledged_at
        FROM temp.inbox_v13_backup;
      DROP TABLE temp.inbox_v13_backup;
      CREATE INDEX supervised_agent_inbox_head ON supervised_agent_inbox(agent_id,fifo_sequence);
      CREATE TABLE supervised_agent_inbox_events (
        inbox_item_id TEXT NOT NULL REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK(event_sequence > 0), idempotency_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('received','queued','turn_started','turn_finished','result_unreadable','publish_started','published','no_reply','retry_scheduled','blocked','room_move_cancelled')),
        observed_at TEXT NOT NULL, detail TEXT,
        PRIMARY KEY(inbox_item_id,event_sequence), UNIQUE(inbox_item_id,idempotency_key)
      ) STRICT;
      CREATE INDEX supervised_agent_inbox_events_timeline ON supervised_agent_inbox_events(inbox_item_id,event_sequence);
      CREATE TABLE supervised_agent_terminal_results (
        inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL, execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('reply','no_reply','unreadable')),
        normalized_text TEXT, evidence_source TEXT NOT NULL CHECK(evidence_source IN ('transcript','stream','none')),
        terminal_evidence_json TEXT NOT NULL, observed_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX supervised_agent_terminal_result_turn ON supervised_agent_terminal_results(agent_id,execution_generation_id,provider_turn_id);
      CREATE TABLE supervised_agent_publications (
        inbox_item_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL, canonical_message_id TEXT NOT NULL, published_at TEXT NOT NULL,
        FOREIGN KEY(inbox_item_id,agent_id,room_id)
          REFERENCES supervised_agent_inbox(inbox_item_id,agent_id,room_id) ON DELETE CASCADE,
        UNIQUE(room_id,client_message_id), UNIQUE(room_id,canonical_message_id)
      ) STRICT;
      CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(agent_id,room_id);
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);

    const interrupted = new DaemonStateSchema(
      undefined,
      undefined,
      undefined,
      () => { throw new Error("interrupt after v13 journal backup"); },
    );
    assert.throws(
      () => interrupted.createSchema(database),
      /interrupt after v13 journal backup/,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM provider_continuation_repairs WHERE repair_id=?").get(repair.repair_id) as { count: number }).count,
      1,
      "rollback restores the authoritative continuation-repair journal",
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('supervised_agent_inbox') WHERE name='failure_code'").get() as { count: number }).count,
      0,
      "rollback restores the complete predecessor inbox shape",
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM temp.sqlite_master WHERE name='provider_continuation_repairs_v13_backup'").get() as { count: number }).count,
      0,
      "rollback removes the temporary journal backup",
    );

    new DaemonStateSchema().createSchema(database);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM provider_continuation_repairs WHERE repair_id=?").get(repair.repair_id) as { count: number }).count,
      1,
      "a clean retry preserves the journal while repairing the inbox",
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('supervised_agent_inbox') WHERE name='failure_code'").get() as { count: number }).count,
      1,
    );
    database.close();
  } finally { await env.cleanup(); }
});

test("skip message is honest, pre-turn only, and releases the next FIFO item", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [first, second] = await store.ingestPoll({
      agent_id: "skipper",
      room_id: "room",
      last_observed_message_id: "2",
      messages: [
        { source_message_id: "1", source_message: {}, activation: {} },
        { source_message_id: "2", source_message: {}, activation: {} },
      ],
    });
    await store.transition(first!.inbox_item_id, "blocked", { last_error: "safe pre-turn failure" });
    const skipped = await store.skipBlocked(first!.inbox_item_id);
    assert.equal(skipped.state, "cancelled_by_user");
    assert.ok(skipped.acknowledged_at);
    assert.equal((await store.receipts("skipper"))[0]!.timeline.at(-1)?.phase, "user_cancelled");
    assert.equal((await store.claimHead("skipper"))?.inbox_item_id, second!.inbox_item_id);

    const [ambiguous] = await store.ingestPoll({
      agent_id: "ambiguous",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
    });
    await store.transition(ambiguous!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(ambiguous!.inbox_item_id, "turn-started");
    await store.transition(ambiguous!.inbox_item_id, "blocked", { last_error: "terminal evidence ambiguous" });
    await assert.rejects(
      store.skipBlocked(ambiguous!.inbox_item_id),
      /provider work may already have started/,
    );
    assert.equal((await store.get(ambiguous!.inbox_item_id))?.state, "blocked");
    await store.close();
  } finally { await env.cleanup(); }
});

test("room move compensation restores only its source queue and exact pre-move cursor idempotently", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-22T12:00:00.000Z");
    await store.bootstrapCursor({ agent_id: "mover", room_id: "old-room", last_observed_message_id: "9" });
    const [current, later] = await store.ingestPoll({
      agent_id: "mover", room_id: "old-room", expected_cursor: "9", last_observed_message_id: "11",
      messages: [
        { source_message_id: "10", source_message: { text: "move" }, activation: {} },
        { source_message_id: "11", source_message: { text: "later" }, activation: {} },
      ],
    });
    await store.setIngressHealth({ agent_id: "mover", room_id: "old-room", execution_generation_id: "run", state: "observing" });
    await store.transition(current!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(current!.inbox_item_id, "turn-move");
    await store.transition(current!.inbox_item_id, "awaiting_result");
    await store.transition(current!.inbox_item_id, "acknowledged_no_reply");
    const cancelled = await store.commitRoomMoveQueue({ operation_id: "move_1", agent_id: "mover", old_room_id: "old-room", after_fifo_sequence: current!.fifo_sequence });
    assert.equal(cancelled, 1);
    assert.equal((await store.get(later!.inbox_item_id))?.state, "cancelled_by_room_move");
    assert.equal((await store.receipts("mover"))[1]?.timeline.at(-1)?.phase, "room_move_cancelled");
    assert.equal(await store.cursor("mover"), null);
    assert.equal(await store.ingressHealth("mover"), null);
    await store.commitRoomMoveCursor({ agent_id: "mover", source_room_id: "old-room", destination_room_id: "new-room", last_observed_message_id: "40" });
    const restored = await store.rollbackRoomMoveIngress({
      operation_id: "move_1", agent_id: "mover", source_room_id: "old-room", destination_room_id: "new-room",
      source_cursor_present: true, source_cursor: "11", after_fifo_sequence: current!.fifo_sequence,
    });
    assert.equal(restored, 1);
    assert.equal((await store.get(current!.inbox_item_id))?.state, "acknowledged_no_reply");
    assert.equal((await store.get(later!.inbox_item_id))?.state, "pending");
    assert.equal((await store.cursor("mover"))?.room_id, "old-room");
    assert.equal((await store.cursor("mover"))?.last_observed_message_id, "11");
    assert.equal((await store.receipts("mover"))[1]?.timeline.at(-1)?.phase, "retry_scheduled");
    assert.equal(await store.rollbackRoomMoveIngress({
      operation_id: "move_1", agent_id: "mover", source_room_id: "old-room", destination_room_id: "new-room",
      source_cursor_present: true, source_cursor: "11", after_fifo_sequence: current!.fifo_sequence,
    }), 0, "a crash replay cannot enqueue the restored message twice");
    await store.close();
  } finally { await env.cleanup(); }
});

test("prepared room moves remain discoverable across restart until their acknowledged turn is reconciled", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-22T12:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "mover", room_id: "old-room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "move" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn-move");
    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "acknowledged_no_reply");
    const prepared = await store.prepareEffect({
      agent_id: "mover", room_id: "old-room", execution_generation_id: "run",
      provider_turn_id: "turn-move", mcp_request_id: "join-1", tool_name: "join_room",
      request: { name: "new-room" },
    });
    await store.stagePreparedEffectResult(prepared.effect.effect_id, {
      requested_room: "new-room", destination_room: "new-room", phase: "validated",
    });
    await store.close();

    const reopened = new SupervisedAgentInboxStore(env.database);
    assert.equal((await reopened.preparedRoomMoves("mover"))[0]?.effect_id, prepared.effect.effect_id);
    assert.equal((await reopened.inboxForProviderTurn("mover", "turn-move"))?.state, "acknowledged_no_reply");
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("terminal receipts and observed context are bounded while prepared effects remain durable", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-22T12:00:00.000Z");
    const observed = Array.from({ length: 510 }, (_, index) => ({
      source_message_id: String(index + 1), source_message: { index }, activation: {}, activation_decision: "silent",
    }));
    await store.ingestPoll({ agent_id: "bounded", room_id: "room", last_observed_message_id: "510", messages: [], observed_messages: observed });
    assert.equal((await store.observedContext("bounded", "room", 200)).at(0)?.source_message_id, "311");

    const messages = Array.from({ length: 205 }, (_, index) => ({
      source_message_id: String(1000 + index), source_message: { index }, activation: {},
    }));
    const items = await store.ingestPoll({ agent_id: "bounded", room_id: "room", last_observed_message_id: "1204", messages });
    for (const item of items) {
      await store.transition(item.inbox_item_id, "dispatching");
      await store.checkpointTurnStarted(item.inbox_item_id, `turn-${item.source_message_id}`);
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, "acknowledged_no_reply");
    }
    assert.equal((await store.receipts("bounded")).length, 200);
    const firstBoundary = await store.detail("bounded", "room");
    assert.equal(firstBoundary.history_boundary?.pruned_before_message_id, "1004");
    assert.ok(firstBoundary.history_boundary?.pruned_at, "first retention wave records an explicit pruning time");
    assert.equal((await store.detail("bounded", "room", "1004")).availability, "pruned", "newest pruned receipt wins over its retained observed-message context");
    assert.equal((await store.detail("bounded", "room", "1004")).requested_source_message_id, "1004");
    const next = await store.ingestPoll({ agent_id: "bounded", room_id: "room", last_observed_message_id: "1206", messages: [
      { source_message_id: "1205", source_message: { index: 205 }, activation: {} },
      { source_message_id: "1206", source_message: { index: 206 }, activation: {} },
    ] });
    for (const item of next) {
      await store.transition(item.inbox_item_id, "dispatching");
      await store.checkpointTurnStarted(item.inbox_item_id, `turn-${item.source_message_id}`);
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, "acknowledged_no_reply");
    }
    const secondBoundary = await store.detail("bounded", "room");
    assert.equal(secondBoundary.history_boundary?.pruned_before_message_id, "1006", "later pruning advances the durable watermark");
    assert.ok(secondBoundary.history_boundary?.pruned_at);
    assert.equal((await store.detail("bounded", "room", "1006")).availability, "pruned");
    assert.equal((await store.detail("bounded", "room", "1000")).availability, "pruned", "exact evidence survives later pruning waves");
    await store.close();

    const afterPrune = new DatabaseSync(env.database);
    assert.equal(
      (afterPrune.prepare(`SELECT COUNT(*) AS value
        FROM supervised_agent_inbox_events events
        LEFT JOIN supervised_agent_inbox inbox ON inbox.inbox_item_id=events.inbox_item_id
        WHERE inbox.inbox_item_id IS NULL`).get() as { value: number }).value,
      0,
      "foreign-key cascading must remove timeline rows with pruned inbox receipts",
    );
    afterPrune.close();

    const reopened = new SupervisedAgentInboxStore(env.database);
    await reopened.removeAgent("bounded");
    assert.equal((await reopened.receipts("bounded")).length, 0);
    assert.equal((await reopened.observedContext("bounded", "room")).length, 0);
    await reopened.close();
    const afterRemoval = new DatabaseSync(env.database);
    assert.equal(
      (afterRemoval.prepare("SELECT COUNT(*) AS value FROM supervised_agent_inbox_events").get() as { value: number }).value,
      0,
      "agent removal must cascade through its retained timeline",
    );
    afterRemoval.close();
  } finally { await env.cleanup(); }
});

test("inspector detail checkpoints canonical publication and records a monotonic prune boundary", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-23T12:00:00.000Z");
    const items = await store.ingestPoll({ agent_id: "detail", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: { id: "1", sender: "Ada", text: "ship it", timestamp: "2026-07-23T12:00:00.000Z", thread_root_id: "1" }, activation: { decision: "activate" } }] });
    const item = items[0]!;
    await store.transition(item.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-detail");
    await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: "detail", execution_generation_id: "run", provider_turn_id: "turn-detail", outcome: "reply", text: "done", evidence: "transcript", terminal_evidence: { provider: "normalized-only" } });
    await store.transition(item.inbox_item_id, "awaiting_result");
    await store.transition(item.inbox_item_id, "publishing");
    const beforePublication = await store.detail("detail", "room", "1");
    assert.equal(beforePublication.requested_source_message_id, "1");
    assert.equal(beforePublication.publication, null, "publication stays null until a canonical checkpoint exists");
    await store.checkpointPublication({ inbox_item_id: item.inbox_item_id, room_id: "room", canonical_message_id: "msg_99" });
    await store.close();
    const reopened = new SupervisedAgentInboxStore(env.database);
    const detail = await reopened.detail("detail", "room", "1");
    assert.equal(detail.availability, "available");
    assert.equal(detail.requested_source_message_id, "1");
    assert.equal(detail.receipt?.provider_turn_id, "turn-detail");
    assert.equal(detail.publication?.canonical_message_id, "msg_99");
    assert.equal((await reopened.receipts("detail"))[0]?.canonical_message_id, "msg_99",
      "the lightweight manifest receipt retains exact reply-message identity");
    assert.equal(detail.source_message?.text, "ship it");
    assert.deepEqual(detail.timeline.map((event) => event.phase).slice(-2), ["publish_started", "published"]);
    assert.equal(detail.items[0]?.sender, "Ada");
    assert.equal(detail.items[0]?.text_preview, "ship it");
    await reopened.checkpointPublication({ inbox_item_id: item.inbox_item_id, room_id: "room", canonical_message_id: "msg_99" });
    const [noReply] = await reopened.ingestPoll({ agent_id: "no-reply", room_id: "room", last_observed_message_id: "2", messages: [{ source_message_id: "2", source_message: { id: "2" }, activation: {} }] });
    await reopened.transition(noReply!.inbox_item_id, "dispatching");
    await reopened.transition(noReply!.inbox_item_id, "awaiting_result");
    await reopened.transition(noReply!.inbox_item_id, "acknowledged_no_reply");
    await assert.rejects(() => reopened.checkpointPublication({ inbox_item_id: noReply!.inbox_item_id, room_id: "room", canonical_message_id: "msg_never" }), /publishing inbox item/);
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("v9 validation rejects malformed delivery-history table and relational shapes", async () => {
  for (const mutation of [
    `DROP INDEX supervised_agent_publications_agent_room; CREATE INDEX supervised_agent_publications_agent_room ON supervised_agent_publications(room_id,agent_id)`,
    `DROP TABLE supervised_agent_publications; CREATE TABLE supervised_agent_publications (inbox_item_id TEXT PRIMARY KEY REFERENCES supervised_agent_inbox(inbox_item_id),agent_id TEXT NOT NULL,room_id TEXT NOT NULL,client_message_id TEXT NOT NULL,canonical_message_id TEXT NOT NULL,published_at INTEGER NOT NULL,UNIQUE(room_id,client_message_id),UNIQUE(room_id,canonical_message_id)) STRICT`,
  ]) {
    const env = await fixture(); try {
      const store = new SupervisedAgentInboxStore(env.database); await store.receipts("shape"); await store.close();
      const database = new DatabaseSync(env.database); database.exec(mutation); database.close();
      const rejected = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(() => rejected.receipts("shape"), /Daemon state v(?:8|9) (?:table|index|delivery-history constraints|publication index)/);
      await rejected.close();
    } finally { await env.cleanup(); }
  }
});

test("v9 rejects corrupt publication parent identity and unpaired pruning fields", async () => {
  for (const corruption of ["publication", "boundary"] as const) {
    const env = await fixture(); try {
      const store = new SupervisedAgentInboxStore(env.database);
      const [item] = await store.ingestPoll({
        agent_id: "integrity", room_id: "room_a", last_observed_message_id: "msg_1",
        messages: [{ source_message_id: "msg_1", source_message: {}, activation: {} }],
      });
      await store.close();
      const database = new DatabaseSync(env.database);
      if (corruption === "publication") {
        database.exec("PRAGMA foreign_keys = OFF");
        database.prepare(`INSERT INTO supervised_agent_publications
          (inbox_item_id,agent_id,room_id,client_message_id,canonical_message_id,published_at)
          VALUES (?,?,?,?,?,?)`).run(item!.inbox_item_id, "integrity", "room_b", "bad-client", "bad-canonical", "2026-07-23T00:00:00.000Z");
      } else {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.prepare(`UPDATE supervised_agent_history_boundaries
          SET pruned_before_message_id=?, pruned_at=NULL
          WHERE agent_id=? AND room_id=?`).run("msg_1", "integrity", "room_a");
      }
      database.close();
      const rejected = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(
        () => rejected.receipts("integrity"),
        corruption === "publication" ? /publication parent identity|foreign key integrity/ : /history boundary pruning fields/,
      );
      await rejected.close();
    } finally { await env.cleanup(); }
  }
});

test("older marker with physical v7 delivery tables installs v9 before advancing", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database); await store.receipts("repair-v8"); await store.close();
    const database = new DatabaseSync(env.database);
    database.exec(`DROP INDEX supervised_agent_publications_agent_room; DROP INDEX supervised_agent_history_boundaries_updated; DROP INDEX supervised_agent_pruned_sources_retention; DROP TABLE supervised_agent_publications; DROP TABLE supervised_agent_history_boundaries; DROP TABLE supervised_agent_pruned_sources; UPDATE manifest_metadata SET schema_version=5 WHERE singleton=1; PRAGMA user_version=5;`);
    database.close();
    const reopened = new SupervisedAgentInboxStore(env.database); await reopened.receipts("repair-v8"); await reopened.close();
    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.ok(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervised_agent_pruned_sources'").get());
    inspection.close();
  } finally { await env.cleanup(); }
});

test("effect journal is exactly-once and rejects request-id or turn identity reuse", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-22T12:00:00.000Z");
    const authority = {
      agent_id: "stone", room_id: "room", execution_generation_id: "run", provider_turn_id: "turn",
      mcp_request_id: "request-1", tool_name: "claim_task", request: { task_id: "task-1" },
    };
    const first = await store.prepareEffect(authority);
    assert.equal(first.created, true);
    await store.markEffectExecuting(first.effect.effect_id);
    const completed = await store.completeEffect({
      effect_id: first.effect.effect_id,
      result: { claimed: true },
      expected: { agent_id: "stone", room_id: "room", execution_generation_id: "run", provider_turn_id: "turn" },
    });
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.result, { claimed: true });
    const replay = await store.prepareEffect(authority);
    assert.equal(replay.created, false);
    assert.equal(replay.effect.effect_id, first.effect.effect_id);
    assert.deepEqual(replay.effect.result, { claimed: true });
    await assert.rejects(() => store.prepareEffect({ ...authority, tool_name: "cancel_task" }), /request id was reused/);
    await assert.rejects(() => store.completeEffect({
      effect_id: first.effect.effect_id,
      expected: { agent_id: "stone", room_id: "room", execution_generation_id: "other-run", provider_turn_id: "turn" },
    }), /exact active turn/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("delivery timeline records causal phases durably across a daemon restart", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-20T12:00:00.000Z");
    const [item] = await store.ingestPoll({ agent_id: "timeline", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.claimHead("timeline");
    await store.checkpointDispatchIntent(item!.inbox_item_id);
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn");
    await store.checkpointTerminalOutcome(item!.inbox_item_id, JSON.stringify({ kind: "reply", text: "durable" }));
    await store.transition(item!.inbox_item_id, "awaiting_result", { provider_turn_id: "turn" });
    await store.transition(item!.inbox_item_id, "publishing");
    await store.close();
    const reopened = new SupervisedAgentInboxStore(env.database);
    const receipt = (await reopened.receipts("timeline"))[0]!;
    assert.deepEqual(receipt.timeline.map((event) => event.phase), ["received", "queued", "turn_started", "turn_finished", "publish_started"]);
    assert.equal(receipt.timeline.every((event) => event.observed_at === "2026-07-20T12:00:00.000Z"), true);
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("v7 repair adds a missing causal-event table without rewriting canonical inbox rows", async () => {
  const env = await fixture(); try {
    const first = new SupervisedAgentInboxStore(env.database);
    const [item] = await first.ingestPoll({ agent_id: "repair", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "msg_1", source_message: { durable: true }, activation: {} }] });
    await first.close();
    const partialV7 = new DatabaseSync(env.database);
    partialV7.exec("DROP TABLE supervised_agent_inbox_events");
    assert.equal((partialV7.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    partialV7.close();
    const repaired = new SupervisedAgentInboxStore(env.database);
    const preserved = (await repaired.receipts("repair"))[0]!;
    assert.equal(preserved.inbox_item_id, item!.inbox_item_id);
    assert.equal(preserved.source_message_id, "msg_1");
    assert.deepEqual(preserved.source_message, { durable: true });
    await repaired.close();
    const inspection = new DatabaseSync(env.database);
    const table = inspection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='supervised_agent_inbox_events'").get() as { sql: string } | undefined;
    assert.match(table?.sql ?? "", /event_sequence INTEGER NOT NULL CHECK\(event_sequence > 0\)/);
    inspection.close();
    const reopened = new SupervisedAgentInboxStore(env.database);
    assert.equal((await reopened.receipts("repair"))[0]?.inbox_item_id, item!.inbox_item_id, "a second canonical reopen is stable");
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("causal event journal is idempotent when an ingress replay shares a constant clock", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-20T12:00:00.000Z");
    await store.ingestPoll({ agent_id: "replay", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.ingestPoll({ agent_id: "replay", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    assert.deepEqual((await store.receipts("replay"))[0]!.timeline.map((event) => event.phase), ["received", "queued"]);
    await store.close();
  } finally { await env.cleanup(); }
});

test("retry attempts retain distinct causal phases while replaying one transition adds none", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-20T12:00:00.000Z");
    const [item] = await store.ingestPoll({ agent_id: "attempts", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.claimHead("attempts");
    await store.transition(item!.inbox_item_id, "retryable", { last_error: "retry" });
    await store.transition(item!.inbox_item_id, "pending");
    await store.claimHead("attempts");
    await store.checkpointDispatchIntent(item!.inbox_item_id);
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn-2");
    const phases = (await store.receipts("attempts"))[0]!.timeline.map((event) => event.phase);
    assert.deepEqual(phases, ["received", "queued", "retry_scheduled", "queued", "turn_started"]);
    await store.close();
  } finally { await env.cleanup(); }
});

test("ingress cannot silently change an agent room and a non-head cannot block", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [first] = await store.ingestPoll({ agent_id: "stone", room_id: "room_A", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    const [second] = await store.ingestPoll({ agent_id: "stone", room_id: "room_A", last_observed_message_id: "2", messages: [{ source_message_id: "2", source_message: {}, activation: {} }] });
    await assert.rejects(() => store.ingestPoll({ agent_id: "stone", room_id: "room_B", last_observed_message_id: "3", messages: [] }), /room changed/);
    await assert.rejects(() => store.transition(second!.inbox_item_id, "blocked", { last_error: "must not hide head" }), /current FIFO head/);
    await store.transition(first!.inbox_item_id, "dispatching");
    await store.transition(first!.inbox_item_id, "blocked", { last_error: "actual head" });
    assert.equal((await store.receipts("stone"))[1]!.blocked_by_inbox_item_id, first!.inbox_item_id);
    await store.close();
  } finally { await env.cleanup(); }
});

test("worker session secrets are memory-only and must be re-delivered after reopen", async () => {
  const env = await fixture(); try {
    const token = "do-not-write-this-secret-to-sqlite";
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    const binding = await store.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run", agent_session_id: "session", agent_session_token: token, api_url: "https://letagents.test" });
    assert.equal(await store.credentialFor(binding), token);
    await store.close();
    assert.equal((await readFile(env.database)).includes(Buffer.from(token)), false);
    const reopened = new WorkerBindingStore(env.legacy, undefined, env.database);
    const persisted = await reopened.get("stone");
    assert.ok(persisted); assert.equal(await reopened.credentialFor(persisted), null);
    assert.equal(await reopened.installCredential({ entry_id: "stone", agent_session_id: "session", execution_generation_id: "run", agent_session_token: "fresh-memory-secret" }), true);
    assert.equal(await reopened.credentialFor(persisted), "fresh-memory-secret");
    assert.equal(await reopened.installCredential({ entry_id: "stone", agent_session_id: "other", execution_generation_id: "run", agent_session_token: "must-not-install" }), false);
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("v5 binding migration removes the persisted credential column and requires re-delivery", async () => {
  const env = await fixture(); try {
    await prepareSecretBearingV5(env);
    const migrated = new WorkerBindingStore(env.legacy, undefined, env.database);
    const binding = await migrated.get("stone");
    assert.ok(binding); assert.equal(await migrated.credentialFor(binding), null);
    await migrated.close();
    const inspection = new DatabaseSync(env.database);
    const columns = inspection.prepare("PRAGMA table_xinfo(worker_session_bindings)").all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "agent_session_token"), false);
    inspection.close();
  } finally { await env.cleanup(); }
});

test("a post-COMMIT v6 scrub interruption leaves a durable marker that a reopen completes", async () => {
  const env = await fixture(); try {
    await prepareSecretBearingV5(env);
    const interrupted = new DatabaseSync(env.database);
    assert.throws(() => new DaemonStateSchema(undefined, () => { throw new Error("interrupt after v6 commit"); }).createSchema(interrupted), /interrupt after v6 commit/);
    assert.equal((interrupted.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    assert.equal((interrupted.prepare("SELECT checksum FROM migration_records WHERE migration_key='v6-worker-token-scrub'").get() as { checksum: string }).checksum, "pending");
    interrupted.close();
    const reopened = new DatabaseSync(env.database);
    new DaemonStateSchema().createSchema(reopened);
    assert.equal(reopened.prepare("SELECT checksum FROM migration_records WHERE migration_key='v6-worker-token-scrub'").get(), undefined);
    reopened.close();
  } finally { await env.cleanup(); }
});

test("a pending v6 scrub failure rejects reopen and retains its marker", async () => {
  const env = await fixture(); try {
    await prepareSecretBearingV5(env);
    const interrupted = new DatabaseSync(env.database);
    assert.throws(() => new DaemonStateSchema(undefined, () => { throw new Error("interrupt after v6 commit"); }).createSchema(interrupted), /interrupt after v6 commit/);
    interrupted.close();
    const reopened = new DatabaseSync(env.database);
    assert.throws(() => new DaemonStateSchema(undefined, undefined, () => { throw new Error("scrub unavailable"); }).createSchema(reopened), /scrub unavailable/);
    assert.equal((reopened.prepare("SELECT checksum FROM migration_records WHERE migration_key='v6-worker-token-scrub'").get() as { checksum: string }).checksum, "pending");
    reopened.close();
  } finally { await env.cleanup(); }
});

test("generation rollover preserves only the exact in-memory credential authority", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    const binding = await store.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run_1", agent_session_id: "session", agent_session_token: "memory-only", api_url: "https://letagents.test" });
    const result = await store.verifyAndAdvanceExecutionGeneration({ entryId: "stone", roomId: "room", workAttemptId: "attempt", fromExecutionGenerationId: "run_1", toExecutionGenerationId: "run_2", agentSessionId: "session" }, async () => ({ accepted: true }));
    assert.equal(result.advanced, true);
    assert.equal(await store.credentialFor(result.binding), "memory-only");
    assert.equal(await store.credentialFor(binding), null, "the predecessor generation cannot borrow the credential");
    await store.close();
  } finally { await env.cleanup(); }
});

test("legacy import retains token-free recovery evidence", async () => {
  const env = await fixture(); try {
    const secret = "legacy-secret-must-not-survive";
    await (await import("node:fs/promises")).writeFile(env.legacy, JSON.stringify({ version: 1, bindings: {
      stone: { entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run", agent_session_id: "session", agent_session_token: secret, api_url: "https://letagents.test", room_cursor: null, last_sequence: 0, last_observed_at_ms: 0, updated_at: "2026-01-01T00:00:00.000Z" },
    } }));
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    await store.list(); await store.close();
    const evidence = await readFile(`${env.legacy}.migrated-backup`, "utf8");
    assert.doesNotMatch(evidence, new RegExp(secret));
    assert.doesNotMatch(evidence, /agent_session_token/);
  } finally { await env.cleanup(); }
});

test("failed durable unbind does not revoke the in-memory credential", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    const binding = await store.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run", agent_session_id: "session", agent_session_token: "still-live", api_url: "https://letagents.test" });
    const database = new DatabaseSync(env.database);
    database.exec("CREATE TRIGGER reject_worker_unbind BEFORE DELETE ON worker_session_bindings BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END");
    database.close();
    await assert.rejects(() => store.unbind("stone", "session", "run"), /injected delete failure/);
    assert.equal(await store.credentialFor(binding), "still-live");
    assert.ok(await store.get("stone"));
    await store.close();
  } finally { await env.cleanup(); }
});

test("formal bind and desktop credential installation serialize to the latest exact authority", async () => {
  const env = await fixture(); try {
    const store = new WorkerBindingStore(env.legacy, undefined, env.database);
    const first = await store.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run", agent_session_id: "session", agent_session_token: "initial", api_url: "https://letagents.test" });
    // Bind commits its new credential reference before releasing its mutation
    // lane; the following install is therefore applied to that exact binding.
    const rebound = await store.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run", agent_session_id: "session", agent_session_token: "bound-second", api_url: "https://letagents.test" });
    assert.notEqual(rebound.credential_ref, first.credential_ref);
    assert.equal(await store.installCredential({ entry_id: "stone", agent_session_id: "session", execution_generation_id: "run", agent_session_token: "desktop-last" }), true);
    assert.equal(await store.credentialFor(rebound), "desktop-last");
    // A subsequent formal bind wins only when it actually replaces durable
    // authority; a delayed install for the old session cannot overwrite it.
    const successor = await store.bind({ entry_id: "stone", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "run_2", agent_session_id: "session_2", agent_session_token: "bound-successor", api_url: "https://letagents.test" });
    assert.equal(await store.installCredential({ entry_id: "stone", agent_session_id: "session", execution_generation_id: "run", agent_session_token: "stale-install" }), false);
    assert.equal(await store.credentialFor(successor), "bound-successor");
    await store.close();
  } finally { await env.cleanup(); }
});
