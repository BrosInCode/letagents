import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { DAEMON_STATE_SCHEMA_VERSION, DaemonStateSchema } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { ManifestStore } from "../manifest-store.js";
import type { DaemonManifestEntry } from "../types.js";

const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt",
  origin_execution_generation_id: "generation",
  provider_continuation_id: "continuation",
} as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervised-inbox-"));
  return { root, database: join(root, "daemon-state.sqlite"), legacy: join(root, "legacy.json"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function seedActiveAgent(env: Awaited<ReturnType<typeof fixture>>, input: {
  agentId: string; roomId: string; workAttemptId: string; executionGenerationId: string; providerContinuationId: string;
}): Promise<void> {
  const manifest = new ManifestStore(env.database);
  const loaded = await manifest.load();
  const active: DaemonManifestEntry = {
    id: input.agentId, room_id: input.roomId, display_name: input.agentId,
    provider: "codex", model: null, charter: "test", desired_state: "running",
    observed_state: "working", condition: "none", permission_profile_id: null,
    delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
    created_at: "2026-08-05T00:00:00.000Z", workspace_path: "/tmp/workspace",
    work_attempt_id: input.workAttemptId,
    provider_ref: {
      work_attempt_id: input.workAttemptId,
      provider_continuation_id: input.providerContinuationId,
      provider_connection: { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "test:4311" },
      execution_generation_id: input.executionGenerationId,
    },
    workplace_liveness: { state: "reachable", observed_at: "2026-08-05T00:00:00.000Z", detail: null },
    native_liveness: { state: "active", observed_at: "2026-08-05T00:00:00.000Z", detail: null },
    activity: [], restart_count: 0, last_turn_control_sequence: 0,
  };
  await manifest.write(loaded.generation, [...loaded.entries.filter((entry) => entry.id !== input.agentId), active]);
  await manifest.close();
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

test("an exact never-dispatched provider turn can be atomically reset without consuming an attempt", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-02T00:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "cursor-agent", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.claimHead("cursor-agent");
    await store.checkpointDispatchIntent(item!.inbox_item_id);
    const started = await store.checkpointTurnStarted(item!.inbox_item_id, "cursor:prepared-only", TEST_PROVIDER_TURN_AUTHORITY);
    assert.equal(started.attempt_count, 1);
    assert.deepEqual(await store.providerTurnBinding(item!.inbox_item_id), {
      inbox_item_id: item!.inbox_item_id,
      agent_id: "cursor-agent",
      room_id: "room",
      provider_turn_id: "cursor:prepared-only",
      ...TEST_PROVIDER_TURN_AUTHORITY,
    });
    const idempotent = await store.checkpointTurnStarted(item!.inbox_item_id, "cursor:prepared-only", TEST_PROVIDER_TURN_AUTHORITY);
    assert.equal(idempotent.attempt_count, 1, "an exact checkpoint retry never consumes another attempt");
    await assert.rejects(() => store.checkpointTurnStarted(item!.inbox_item_id, "cursor:prepared-only", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      provider_continuation_id: "different-continuation",
    }), /durable authority binding/);

    const reset = await store.resetUndispatchedTurn(item!.inbox_item_id, "cursor:prepared-only");
    assert.equal(reset.state, "pending");
    assert.equal(reset.provider_turn_id, null);
    assert.equal(reset.attempt_count, 0);
    assert.equal(await store.providerTurnBinding(item!.inbox_item_id), null, "reset removes the exact recovery authority with the turn id");
    assert.equal((await store.claimHead("cursor-agent"))?.inbox_item_id, item!.inbox_item_id);
    await assert.rejects(
      store.resetUndispatchedTurn(item!.inbox_item_id, "cursor:different"),
      /does not match the exact in-flight provider turn/,
    );
    const timeline = (await store.receipts("cursor-agent"))[0]!.timeline;
    assert.equal(timeline.some((event) => event.phase === "retry_scheduled"), true);
    await store.close();
  } finally { await env.cleanup(); }
});

test("an undispatched reset refuses compact effect evidence without erasing turn authority", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-02T00:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "cursor-tombstone", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.claimHead("cursor-tombstone");
    await store.checkpointDispatchIntent(item!.inbox_item_id);
    await store.checkpointTurnStarted(item!.inbox_item_id, "cursor:compacted-effect", TEST_PROVIDER_TURN_AUTHORITY);

    const evidence = new DatabaseSync(env.database);
    try {
      evidence.prepare(`INSERT INTO supervised_agent_effect_tombstones
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "compacted-effect", "cursor-tombstone", "room", TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id,
        "cursor:compacted-effect", "request-1", "send_message", "0".repeat(64), 2, 1, "uncertain", null,
        "The mutating tool may have completed.", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
      );
    } finally { evidence.close(); }

    await assert.rejects(
      store.resetUndispatchedTurn(item!.inbox_item_id, "cursor:compacted-effect"),
      /terminal or effect evidence/,
    );
    const preserved = await store.inboxForProviderTurn("cursor-tombstone", "cursor:compacted-effect");
    assert.equal(preserved?.state, "dispatching");
    assert.equal(preserved?.attempt_count, 1);
    assert.ok(await store.providerTurnBinding(item!.inbox_item_id),
      "refusing reset preserves exact recovery authority for the evidenced turn");
    await store.close();
  } finally { await env.cleanup(); }
});

test("an undispatched reset ignores compact evidence from an older execution generation", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-02T00:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "cursor-reused-turn", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.claimHead("cursor-reused-turn");
    await store.checkpointDispatchIntent(item!.inbox_item_id);
    const currentAuthority = {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      origin_execution_generation_id: "execution-generation-current",
    };
    await store.checkpointTurnStarted(item!.inbox_item_id, "cursor:reused-turn", currentAuthority);

    const evidence = new DatabaseSync(env.database);
    try {
      evidence.prepare(`INSERT INTO supervised_agent_effect_tombstones
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "old-generation-effect", "cursor-reused-turn", "room", "execution-generation-old",
        "cursor:reused-turn", "request-old", "send_message", "0".repeat(64), 2, 1, "uncertain", null,
        "Old generation evidence.", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
      );
    } finally { evidence.close(); }

    const reset = await store.resetUndispatchedTurn(item!.inbox_item_id, "cursor:reused-turn");
    assert.equal(reset.state, "pending");
    assert.equal(reset.provider_turn_id, null);
    assert.equal(reset.attempt_count, 0);
    assert.equal(await store.providerTurnBinding(item!.inbox_item_id), null);
    await store.close();
  } finally { await env.cleanup(); }
});

test("a clean pre-native handoff can atomically restore only an evidence-free dispatch intent", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-02T00:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "cursor-handoff", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    await store.claimHead("cursor-handoff");
    await store.checkpointDispatchIntent(item!.inbox_item_id);

    const reset = await store.resetPreNativeHandoff(item!.inbox_item_id);
    assert.equal(reset.state, "pending");
    assert.equal(reset.provider_turn_id, null);
    assert.equal(reset.attempt_count, 0);
    assert.equal((await store.receipts("cursor-handoff"))[0]!.timeline.at(-1)?.phase, "queued");

    await store.claimHead("cursor-handoff");
    await store.transition(item!.inbox_item_id, "retryable", { last_error: "pre-native retry backoff" });
    assert.equal((await store.resetPreNativeHandoff(item!.inbox_item_id)).state, "pending");
    await store.claimHead("cursor-handoff");
    await store.checkpointTurnStarted(item!.inbox_item_id, "cursor:started", TEST_PROVIDER_TURN_AUTHORITY);
    await assert.rejects(
      store.resetPreNativeHandoff(item!.inbox_item_id),
      /exact unstarted dispatch or retry-backoff intent/,
    );
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
    await store.checkpointTurnStarted(one!.inbox_item_id, "turn_1", TEST_PROVIDER_TURN_AUTHORITY);
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
    await store.checkpointTurnStarted(started!.inbox_item_id, "turn_started", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(started!.inbox_item_id, "blocked", { last_error: historicalError });

    const [durableReply] = await store.ingestPoll({
      agent_id: "durable-reply",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "durable-reply", source_message: {}, activation: {} }],
    });
    await store.transition(durableReply!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(durableReply!.inbox_item_id, "turn_with_reply", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(durableReply!.inbox_item_id, "awaiting_result", {
      outcome: JSON.stringify({ kind: "reply", text: "already durable", evidence: "transcript" }),
    });
    await store.transition(durableReply!.inbox_item_id, "publishing");

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
      DROP TABLE supervised_agent_provider_turn_bindings;
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
    assert.equal((await migrated.get(started!.inbox_item_id))?.state, "acknowledged_no_reply",
      "the upgrade retires an unbound legacy provider turn without fabricating a user cancellation");
    assert.equal((await migrated.get(started!.inbox_item_id))?.terminal_reason, "upgrade_authority_unavailable");
    assert.match((await migrated.get(started!.inbox_item_id))?.last_error ?? "", /upgrade.*exact durable authority.*not replayed/i);
    assert.equal((await migrated.receipts("started"))[0]?.timeline.at(-1)?.phase, "no_reply");
    assert.equal((await migrated.get(durableReply!.inbox_item_id))?.state, "publishing",
      "a durable legacy reply remains publication-only and never needs provider authority recovery");
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
    await store.checkpointTurnStarted(ambiguous!.inbox_item_id, "turn-started", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(ambiguous!.inbox_item_id, "blocked", { last_error: "terminal evidence ambiguous" });
    await assert.rejects(
      store.skipBlocked(ambiguous!.inbox_item_id),
      /provider work may already have started/,
    );
    assert.equal((await store.get(ambiguous!.inbox_item_id))?.state, "blocked");
    await store.close();
  } finally { await env.cleanup(); }
});

test("repeated pre-turn skips retain exactly bounded physical history", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T13:00:00.000Z");
  let oldest = "";
  let newest = "";
  try {
    for (let index = 1; index <= 205; index += 1) {
      const item = await store.enqueueCorrection({
        agent_id: "bounded-skip", room_id: "room", source_message_id: `skip-${index}`,
        source_message: { index }, activation: { decision: "activate" },
      });
      if (index === 1) oldest = item.inbox_item_id;
      newest = item.inbox_item_id;
      await store.transition(item.inbox_item_id, "blocked", { last_error: "safe pre-turn failure" });
      assert.equal((await store.skipBlocked(item.inbox_item_id)).state, "cancelled_by_user");
    }
    const inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id='bounded-skip' AND state='cancelled_by_user'`).get() as { count: number }).count), 200);
    assert.ok(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox_events e
      JOIN supervised_agent_inbox i USING (inbox_item_id) WHERE i.agent_id='bounded-skip'`).get() as { count: number }).count) <= 800);
    assert.equal(inspection.prepare("SELECT 1 FROM supervised_agent_inbox WHERE inbox_item_id=?").get(oldest), undefined);
    assert.ok(inspection.prepare("SELECT 1 FROM supervised_agent_inbox WHERE inbox_item_id=?").get(newest));
    assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
    inspection.close();
    await store.close();
    const reopened = new SupervisedAgentInboxStore(env.database);
    assert.equal((await reopened.receipts("bounded-skip")).length, 200);
    await reopened.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("cancelInterruptedTurn settles an in-flight head and releases the next FIFO item", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [first, second] = await store.ingestPoll({
      agent_id: "interrupt",
      room_id: "room",
      last_observed_message_id: "2",
      messages: [
        { source_message_id: "1", source_message: {}, activation: {} },
        { source_message_id: "2", source_message: {}, activation: {} },
      ],
    });
    // A dispatching head (no provider result yet) is settled cancelled_by_user.
    assert.equal((await store.claimHead("interrupt"))?.inbox_item_id, first!.inbox_item_id);
    const settled = await store.cancelInterruptedTurn(first!.inbox_item_id);
    assert.equal(settled?.state, "cancelled_by_user");
    assert.ok(settled?.acknowledged_at);
    assert.equal(settled?.last_error, "Stopped by the user.");
    assert.equal((await store.receipts("interrupt"))[0]!.timeline.at(-1)?.phase, "user_cancelled");
    // The FIFO advances to the next item — the cancelled head is terminal.
    assert.equal((await store.claimHead("interrupt"))?.inbox_item_id, second!.inbox_item_id);

    // Awaiting-result is still pre-publish, so it is also interruptible.
    const outcome = JSON.stringify({ kind: "reply", text: "partial", evidence: "transcript" });
    await store.checkpointTurnStarted(second!.inbox_item_id, "turn-2", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(second!.inbox_item_id, "awaiting_result", { provider_turn_id: "turn-2", outcome });
    const settledSecond = await store.cancelInterruptedTurn(second!.inbox_item_id, "Redirected by the user.");
    assert.equal(settledSecond?.state, "cancelled_by_user");
    assert.equal(settledSecond?.last_error, "Redirected by the user.");

    // A vanished item is an idempotent no-op (an interrupt that already settled).
    assert.equal(await store.cancelInterruptedTurn("does-not-exist"), null);
    await store.close();
  } finally { await env.cleanup(); }
});

test("startup recovery requeues only checkpoint-gated unstarted work and preserves exact-turn recovery", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    for (const agentId of ["cursor-gated", "provider-ambiguous", "exact-recovery", "no-reply-crash"]) {
      await store.ingestPoll({
        agent_id: agentId,
        room_id: "room",
        last_observed_message_id: "1",
        messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
      });
      await store.claimHead(agentId);
    }
    await store.normalizeStartupRecovery("cursor-gated", { resetCheckpointGatedUnstartedDispatch: true });
    assert.equal((await store.head("cursor-gated"))?.state, "pending", "Cursor's turn-id-before-release contract proves no native dispatch");

    await store.normalizeStartupRecovery("provider-ambiguous");
    assert.equal((await store.head("provider-ambiguous"))?.state, "blocked", "the same shape remains ambiguous for other providers");

    const exact = await store.head("exact-recovery");
    assert.ok(exact);
    await store.checkpointTurnStarted(exact.inbox_item_id, "provider:exact-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(exact.inbox_item_id, "retryable", { last_error: "idle provider-state checkpoint failed" });
    await store.normalizeStartupRecovery("exact-recovery");
    const recovered = await store.head("exact-recovery");
    assert.equal(recovered?.state, "pending");
    assert.equal(recovered?.provider_turn_id, "provider:exact-turn", "recovery inspects the exact turn and never reruns it");

    const noReply = await store.head("no-reply-crash");
    assert.ok(noReply);
    await store.checkpointTurnStarted(noReply.inbox_item_id, "provider:no-reply", TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, {
      agentId: "no-reply-crash", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const orphanInput = {
      agent_id: "no-reply-crash", room_id: "room", execution_generation_id: "generation",
      work_attempt_id: "attempt", current_execution_generation_id: "generation",
      provider_continuation_id: "continuation", provider_turn_id: "provider:no-reply",
      mcp_request_id: "handoff-orphan", tool_name: "send_message", request: { text: "unused" },
    };
    await store.prepareEffect(orphanInput);
    await store.checkpointTerminalOutcome(noReply.inbox_item_id, JSON.stringify({ kind: "no_reply", text: null }));
    await store.normalizeStartupRecovery("no-reply-crash");
    assert.equal((await store.get(noReply.inbox_item_id))?.state, "acknowledged_no_reply");
    assert.equal((await store.prepareEffect(orphanInput)).effect.state, "failed",
      "restart normalization settles a prepared effect that never acquired execution authority");
    await store.close();
  } finally { await env.cleanup(); }
});

test("cancelInterruptedTurn never overrides a committed publication or a terminal outcome", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [publishing] = await store.ingestPoll({
      agent_id: "publisher", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
    });
    const outcome = JSON.stringify({ kind: "reply", text: "hi", evidence: "transcript" });
    await store.claimHead("publisher");
    await store.checkpointTurnStarted(publishing!.inbox_item_id, "turn-1", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(publishing!.inbox_item_id, "awaiting_result", { provider_turn_id: "turn-1", outcome });
    await store.transition(publishing!.inbox_item_id, "publishing", { outcome });
    // Once the turn commits to publishing, the interrupt loses the race: the
    // published reply stays authoritative and the item is left untouched.
    const raced = await store.cancelInterruptedTurn(publishing!.inbox_item_id);
    assert.equal(raced?.state, "publishing");
    assert.equal((await store.get(publishing!.inbox_item_id))?.state, "publishing");

    const [done] = await store.ingestPoll({
      agent_id: "settled", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
    });
    await store.claimHead("settled");
    await store.checkpointTurnStarted(done!.inbox_item_id, "turn-9", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(done!.inbox_item_id, "awaiting_result", { provider_turn_id: "turn-9", outcome: JSON.stringify({ kind: "no_reply", text: null, evidence: "transcript" }) });
    await store.transition(done!.inbox_item_id, "acknowledged_no_reply", {});
    const terminal = await store.cancelInterruptedTurn(done!.inbox_item_id);
    assert.equal(terminal?.state, "acknowledged_no_reply");
    await store.close();
  } finally { await env.cleanup(); }
});

test("enqueueCorrection appends a same-session FIFO turn without moving the ingress cursor, idempotently", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-31T00:00:00.000Z");
    await store.bootstrapCursor({ agent_id: "corrector", room_id: "room", last_observed_message_id: null });
    const [observed] = await store.ingestPoll({
      agent_id: "corrector", room_id: "room", last_observed_message_id: "7",
      messages: [{ source_message_id: "7", source_message: { text: "please act" }, activation: {} }],
    });
    assert.equal((await store.cursor("corrector"))?.last_observed_message_id, "7");

    const correction = await store.enqueueCorrection({
      agent_id: "corrector", room_id: "room", source_message_id: "correction:action-1",
      source_message: { text: "Use the revised plan", sender: { kind: "supervisor_correction" } },
      activation: { decision: "activate", reason: "human_correction", addressed: true },
    });
    assert.equal(correction.state, "pending");
    assert.equal(correction.source_message_id, "correction:action-1");
    assert.equal((correction.source_message as { text?: string }).text, "Use the revised plan");
    assert.equal(correction.action_id, "supervised-room:corrector:room:correction:action-1:action:v1");
    assert.ok(correction.fifo_sequence > observed!.fifo_sequence, "the correction runs after already-queued work");
    // A correction is not an observed room message; the ingress cursor is untouched.
    assert.equal((await store.cursor("corrector"))?.last_observed_message_id, "7");

    // Idempotent: a retried control action re-enqueues the exact same item.
    const again = await store.enqueueCorrection({
      agent_id: "corrector", room_id: "room", source_message_id: "correction:action-1",
      source_message: { text: "different text should be ignored" }, activation: {},
    });
    assert.equal(again.inbox_item_id, correction.inbox_item_id);
    assert.equal((again.source_message as { text?: string }).text, "Use the revised plan");

    // FIFO: the correction becomes the head only after the earlier item settles.
    assert.equal((await store.claimHead("corrector"))?.inbox_item_id, observed!.inbox_item_id);
    await store.cancelInterruptedTurn(observed!.inbox_item_id);
    assert.equal((await store.claimHead("corrector"))?.inbox_item_id, correction.inbox_item_id);
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
    await store.checkpointTurnStarted(current!.inbox_item_id, "turn-move", TEST_PROVIDER_TURN_AUTHORITY);
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

test("room-move compensation pins cancelled history until rollback or terminal release", async () => {
  const env = await fixture();
  const inbox = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T12:30:00.000Z");
  const manifest = new ManifestStore(env.database);
  try {
    await seedActiveAgent(env, {
      agentId: "bounded-move", roomId: "old-room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const generation = (await manifest.load()).generation;
    for (let index = 1; index <= 205; index += 1) {
      await inbox.enqueueCorrection({
        agent_id: "bounded-move", room_id: "old-room", source_message_id: `move-${index}`,
        source_message: { text: `queued ${index}` }, activation: { decision: "activate" },
      });
    }
    const prepareMove = (operationId: string, destinationRoomId: string) => manifest.prepareRoomMove({
      operation_id: operationId,
      request_id: operationId,
      agent_id: "bounded-move",
      source_room_id: "old-room",
      destination_room_id: destinationRoomId,
      daemon_generation: generation,
      work_attempt_id: "attempt",
      execution_generation_id: "generation",
      agent_session_id: "session",
      activating_inbox_item_id: null,
      provider_turn_id: null,
      effect_id: null,
      phase: "membership_committed",
    });

    await prepareMove("move-rollback", "new-room");
    assert.equal(await inbox.commitRoomMoveQueue({
      operation_id: "move-rollback", agent_id: "bounded-move", old_room_id: "old-room", after_fifo_sequence: 0,
    }), 205);
    let inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id='bounded-move' AND state='cancelled_by_room_move'`).get() as { count: number }).count), 205,
    "nonterminal move authority may temporarily exceed receipt history because every row is rollback state");
    inspection.close();

    assert.equal(await inbox.rollbackRoomMoveIngress({
      operation_id: "move-rollback", agent_id: "bounded-move", source_room_id: "old-room", destination_room_id: "new-room",
      source_cursor_present: false, source_cursor: null, after_fifo_sequence: 0,
    }), 205, "all compensation rows survive long enough to be restored");
    await manifest.advanceRoomMove({
      operationId: "move-rollback", agentId: "bounded-move", expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: "generation", from: ["membership_committed"], to: "failed",
    });
    inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id='bounded-move' AND state='pending'`).get() as { count: number }).count), 205);
    inspection.close();

    await prepareMove("move-success", "final-room");
    assert.equal(await inbox.commitRoomMoveQueue({
      operation_id: "move-success", agent_id: "bounded-move", old_room_id: "old-room", after_fifo_sequence: 0,
    }), 205);
    await manifest.advanceRoomMove({
      operationId: "move-success", agentId: "bounded-move", expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: "generation", from: ["membership_committed"], to: "active",
    });
    inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id='bounded-move' AND state='cancelled_by_room_move'`).get() as { count: number }).count), 200,
    "terminal move release converges compensation rows to the ordinary history budget");
    assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
    inspection.close();

    await inbox.close();
    await manifest.close();
    const reopenedInbox = new SupervisedAgentInboxStore(env.database);
    assert.equal((await reopenedInbox.receipts("bounded-move")).length, 200);
    await reopenedInbox.close();
    const reopenedManifest = new ManifestStore(env.database);
    assert.equal((await reopenedManifest.getRoomMove("move-success"))?.phase, "active");
    await reopenedManifest.close();
  } finally {
    await inbox.close().catch(() => undefined);
    await manifest.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("prepared room moves remain discoverable across restart until their acknowledged turn is reconciled", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-22T12:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "mover", room_id: "old-room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "move" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn-move", TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, { agentId: "mover", roomId: "old-room", workAttemptId: "attempt", executionGenerationId: "generation", providerContinuationId: "continuation" });
    const prepared = await store.prepareRoomMoveEffect({
      agent_id: "mover", room_id: "old-room", effect_execution_generation_id: "generation",
      provider_turn_id: "turn-move", mcp_request_id: "join-1", request: { name: "new-room" },
      destination_room_id: "new-room", daemon_generation: 1, work_attempt_id: "attempt",
      execution_generation_id: "generation", provider_continuation_id: "continuation",
      agent_session_id: "session", activating_inbox_item_id: item!.inbox_item_id,
    });
    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "acknowledged_no_reply");
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
      await store.checkpointTurnStarted(item.inbox_item_id, `turn-${item.source_message_id}`, TEST_PROVIDER_TURN_AUTHORITY);
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
      await store.checkpointTurnStarted(item.inbox_item_id, `turn-${item.source_message_id}`, TEST_PROVIDER_TURN_AUTHORITY);
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

test("history pruning cannot delete a newer generation's exactly-once effect when provider turn ids repeat", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T12:00:00.000Z");
    const settle = async (sourceMessageId: string, providerTurnId: string, authority: typeof TEST_PROVIDER_TURN_AUTHORITY) => {
      const item = await store.enqueueCorrection({
        agent_id: "reused-turn", room_id: "room", source_message_id: sourceMessageId,
        source_message: { text: sourceMessageId }, activation: {},
      });
      await store.transition(item.inbox_item_id, "dispatching");
      await store.checkpointTurnStarted(item.inbox_item_id, providerTurnId, authority);
      await store.transition(item.inbox_item_id, "awaiting_result");
      return item;
    };
    const old = await settle("old", "shared-turn", {
      work_attempt_id: "attempt",
      origin_execution_generation_id: "origin-old",
      provider_continuation_id: "continuation-old",
    });
    await store.transition(old.inbox_item_id, "acknowledged_no_reply");
    for (let index = 0; index < 199; index += 1) {
      const filler = await settle(`filler-${index}`, `filler-turn-${index}`, TEST_PROVIDER_TURN_AUTHORITY);
      await store.transition(filler.inbox_item_id, "acknowledged_no_reply");
    }
    const current = await settle("current", "shared-turn", {
      work_attempt_id: "attempt",
      origin_execution_generation_id: "origin-current",
      provider_continuation_id: "continuation-current",
    });
    await seedActiveAgent(env, { agentId: "reused-turn", roomId: "room", workAttemptId: "attempt", executionGenerationId: "origin-current", providerContinuationId: "continuation-current" });
    const effectInput = {
      agent_id: "reused-turn", room_id: "room", execution_generation_id: "origin-current",
      work_attempt_id: "attempt", current_execution_generation_id: "origin-current", provider_continuation_id: "continuation-current",
      provider_turn_id: "shared-turn", mcp_request_id: "effect-current", tool_name: "claim_task",
      request: { task_id: "task-current" },
    };
    const prepared = await store.prepareEffect(effectInput);
    await store.markEffectExecuting({ effect_id: prepared.effect.effect_id, ...effectInput });
    await store.completeEffect({
      effect_id: prepared.effect.effect_id,
      result: { claimed: true },
      expected: {
        agent_id: "reused-turn", work_attempt_id: "attempt", provider_turn_id: "shared-turn",
      },
    });
    await store.transition(current.inbox_item_id, "acknowledged_no_reply");
    assert.equal(await store.get(old.inbox_item_id), null, "the old generation receipt is independently prunable");
    const replay = await store.prepareEffect(effectInput);
    assert.equal(replay.created, false, "the newer generation's durable request id remains an exactly-once barrier");
    assert.equal(replay.effect.state, "completed");
    assert.deepEqual(replay.effect.result, { claimed: true });
    await store.close();
  } finally { await env.cleanup(); }
});

test("receipt projections retain only the newest timeline events for a noisy inbox item", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-22T12:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "noisy",
      room_id: "room",
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });

    const database = new DatabaseSync(env.database);
    const insert = database.prepare(`INSERT INTO supervised_agent_inbox_events(
      inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail
    ) VALUES (?,?,?,?,?,?)`);
    for (let index = 0; index < 80; index += 1) {
      insert.run(
        item!.inbox_item_id,
        index + 3,
        `noise-${index}`,
        "conversation_restoring",
        "2026-07-22T12:00:00.000Z",
        `event-${index}`,
      );
    }
    database.close();

    const [receipt] = await store.receipts("noisy");
    assert.equal(receipt?.timeline.length, 64);
    assert.equal(receipt?.timeline[0]?.detail, "event-16");
    assert.equal(receipt?.timeline.at(-1)?.detail, "event-79");
    await store.close();
  } finally { await env.cleanup(); }
});

test("inspector detail checkpoints canonical publication and records a monotonic prune boundary", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-23T12:00:00.000Z");
    const items = await store.ingestPoll({ agent_id: "detail", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: { id: "1", sender: "Ada", text: "ship it", timestamp: "2026-07-23T12:00:00.000Z", thread_root_id: "1" }, activation: { decision: "activate" } }] });
    const item = items[0]!;
    await store.transition(item.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-detail", TEST_PROVIDER_TURN_AUTHORITY);
    await assert.rejects(() => store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: "detail", execution_generation_id: "wrong-generation", provider_turn_id: "turn-detail", outcome: "reply", text: "wrong", evidence: "transcript", terminal_evidence: { provider: "wrong" } }), /authority binding/i);
    await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: "detail", execution_generation_id: "generation", provider_turn_id: "turn-detail", outcome: "reply", text: "done", evidence: "transcript", terminal_evidence: { provider: "normalized-only" } });
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

test("v17 validation rejects malformed mutation policy and upgrade terminal classifications", async () => {
  {
    const env = await fixture(); try {
      const store = new SupervisedAgentInboxStore(env.database);
      await store.receipts("shape-v17");
      await store.close();
      const database = new DatabaseSync(env.database);
      database.exec(`
        DROP INDEX supervised_agent_effects_turn;
        ALTER TABLE supervised_agent_effects RENAME TO supervised_agent_effects_valid_v17;
        CREATE TABLE supervised_agent_effects (
          effect_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
          execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
          mcp_request_id TEXT NOT NULL, tool_name TEXT NOT NULL, request_json TEXT NOT NULL,
          mutation INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','executing','uncertain','completed','failed')),
          result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
        ) STRICT;
        INSERT INTO supervised_agent_effects SELECT * FROM supervised_agent_effects_valid_v17;
        DROP TABLE supervised_agent_effects_valid_v17;
        CREATE INDEX supervised_agent_effects_turn
          ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);
      `);
      database.close();
      const rejected = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(() => rejected.receipts("shape-v17"), /v17 supervised-effect journal.*invalid durable classification shape/i);
      await rejected.close();
    } finally { await env.cleanup(); }
  }

  {
    const env = await fixture(); try {
      const store = new SupervisedAgentInboxStore(env.database);
      const [item] = await store.ingestPoll({
        agent_id: "terminal-v17", room_id: "room", last_observed_message_id: "1",
        messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
      });
      await store.close();
      const database = new DatabaseSync(env.database);
      database.exec("PRAGMA ignore_check_constraints=ON");
      database.prepare("UPDATE supervised_agent_inbox SET terminal_reason='upgrade_authority_unavailable' WHERE inbox_item_id=?")
        .run(item!.inbox_item_id);
      database.close();
      const rejected = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(() => rejected.receipts("terminal-v17"), /mismatched upgrade terminal classification/i);
      await rejected.close();
    } finally { await env.cleanup(); }
  }
});

test("v17 validation requires the exact supervised-effect request identity and turn index", async () => {
  for (const malformed of ["missing_identity", "missing_turn_index"] as const) {
    const env = await fixture(); try {
      const store = new SupervisedAgentInboxStore(env.database);
      await store.receipts(`shape-v17-${malformed}`);
      await store.close();
      const database = new DatabaseSync(env.database);
      if (malformed === "missing_turn_index") {
        database.exec("DROP INDEX supervised_agent_effects_turn");
      } else {
        database.exec(`
          DROP INDEX supervised_agent_effects_turn;
          ALTER TABLE supervised_agent_effects RENAME TO supervised_agent_effects_valid_identity;
          CREATE TABLE supervised_agent_effects (
            effect_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
            execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
            mcp_request_id TEXT NOT NULL, tool_name TEXT NOT NULL, request_json TEXT NOT NULL,
            mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
            state TEXT NOT NULL CHECK(state IN ('prepared','executing','uncertain','completed','failed')),
            result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          ) STRICT;
          INSERT INTO supervised_agent_effects SELECT * FROM supervised_agent_effects_valid_identity;
          DROP TABLE supervised_agent_effects_valid_identity;
          CREATE INDEX supervised_agent_effects_turn
            ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);
        `);
      }
      database.close();
      const rejected = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(
        () => rejected.receipts(`shape-v17-${malformed}`),
        malformed === "missing_identity" ? /exact request identity constraint/i : /turn index is missing or malformed/i,
      );
      await rejected.close();
    } finally { await env.cleanup(); }
  }
});

test("v17 validation requires exact effect_id primary keys for full and compact effect journals", async () => {
  for (const malformed of ["effects", "tombstones"] as const) {
    const env = await fixture(); try {
      const store = new SupervisedAgentInboxStore(env.database);
      await store.receipts(`shape-v17-${malformed}-primary-key`);
      await store.close();
      const database = new DatabaseSync(env.database);
      if (malformed === "effects") {
        database.exec(`
          DROP INDEX supervised_agent_effects_turn;
          ALTER TABLE supervised_agent_effects RENAME TO supervised_agent_effects_valid_primary_key;
          CREATE TABLE supervised_agent_effects (
            effect_id TEXT NOT NULL, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
            execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
            mcp_request_id TEXT NOT NULL, tool_name TEXT NOT NULL, request_json TEXT NOT NULL,
            mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
            state TEXT NOT NULL CHECK(state IN ('prepared','executing','uncertain','completed','failed')),
            result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
          ) STRICT;
          INSERT INTO supervised_agent_effects SELECT * FROM supervised_agent_effects_valid_primary_key;
          DROP TABLE supervised_agent_effects_valid_primary_key;
          CREATE INDEX supervised_agent_effects_turn
            ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);
        `);
      } else {
        database.exec(`
          DROP INDEX supervised_agent_effect_tombstones_turn;
          ALTER TABLE supervised_agent_effect_tombstones RENAME TO supervised_agent_effect_tombstones_valid_primary_key;
          CREATE TABLE supervised_agent_effect_tombstones (
            effect_id TEXT NOT NULL, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
            execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
            mcp_request_id TEXT NOT NULL, tool_name TEXT NOT NULL,
            request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
            request_bytes INTEGER NOT NULL CHECK(request_bytes>=0),
            mutation INTEGER NOT NULL CHECK(mutation IN (0,1)),
            state TEXT NOT NULL CHECK(state IN ('uncertain','completed','failed')),
            result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
          ) STRICT;
          INSERT INTO supervised_agent_effect_tombstones SELECT * FROM supervised_agent_effect_tombstones_valid_primary_key;
          DROP TABLE supervised_agent_effect_tombstones_valid_primary_key;
          CREATE INDEX supervised_agent_effect_tombstones_turn
            ON supervised_agent_effect_tombstones(agent_id,execution_generation_id,provider_turn_id);
        `);
      }
      database.close();
      const rejected = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(
        () => rejected.receipts(`shape-v17-${malformed}-primary-key`),
        malformed === "effects"
          ? /supervised-effect journal effect_id.*TEXT primary key/i
          : /supervised-effect tombstone effect_id.*TEXT primary key/i,
      );
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
    const [item] = await store.ingestPoll({
      agent_id: "stone", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "run effect" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      origin_execution_generation_id: "run",
    });
    await seedActiveAgent(env, { agentId: "stone", roomId: "room", workAttemptId: "attempt", executionGenerationId: "run", providerContinuationId: "continuation" });
    const authority = {
      agent_id: "stone", room_id: "room", execution_generation_id: "run", provider_turn_id: "turn",
      work_attempt_id: "attempt", current_execution_generation_id: "run", provider_continuation_id: "continuation",
      mcp_request_id: "request-1", tool_name: "claim_task", request: { task_id: "task-1" },
    };
    await assert.rejects(() => store.prepareEffect({ ...authority, execution_generation_id: "other-run" }), /authority binding/i);
    const first = await store.prepareEffect(authority);
    assert.equal(first.created, true);
    await store.markEffectExecuting({ effect_id: first.effect.effect_id, ...authority });
    const completed = await store.completeEffect({
      effect_id: first.effect.effect_id,
      result: { claimed: true },
      expected: { agent_id: "stone", work_attempt_id: "attempt", provider_turn_id: "turn" },
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
      expected: { agent_id: "stone", work_attempt_id: "other-attempt", provider_turn_id: "turn" },
    }), /durable provider-turn authority binding/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("effect recovery redrives reads, quarantines mutations, and accepts a late exact completion", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T18:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "effect-recovery", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "recover tools" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn", {
      work_attempt_id: "attempt", origin_execution_generation_id: "run", provider_continuation_id: "continuation",
    });
    await seedActiveAgent(env, {
      agentId: "effect-recovery", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run", providerContinuationId: "continuation",
    });
    const base = {
      agent_id: "effect-recovery", room_id: "room", execution_generation_id: "run", provider_turn_id: "turn",
      work_attempt_id: "attempt", current_execution_generation_id: "run", provider_continuation_id: "continuation",
    };
    const read = { ...base, mcp_request_id: "read", tool_name: "get_board", request: {} };
    const mutation = { ...base, mcp_request_id: "mutation", tool_name: "send_message", request: { text: "once" } };

    const firstRead = await store.prepareEffect(read);
    assert.equal(firstRead.effect.mutation, false);
    await store.markEffectExecuting({ effect_id: firstRead.effect.effect_id, ...read });
    const retriedRead = await store.prepareEffect(read);
    assert.equal(retriedRead.effect.state, "prepared", "an exact duplicate safely reopens a read-only execution");
    await store.markEffectExecuting({ effect_id: firstRead.effect.effect_id, ...read });
    assert.equal((await store.completeEffect({
      effect_id: firstRead.effect.effect_id, result: { tasks: [] },
      expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
    })).state, "completed");

    const firstMutation = await store.prepareEffect(mutation);
    assert.equal(firstMutation.effect.mutation, true);
    await store.markEffectExecuting({ effect_id: firstMutation.effect.effect_id, ...mutation });
    const uncertain = await store.prepareEffect(mutation);
    assert.equal(uncertain.effect.state, "uncertain", "a mutation crossing its execution boundary is never invoked twice");
    assert.match(uncertain.effect.error ?? "", /may have completed.*verify external state/i);
    assert.equal((await store.prepareEffect(mutation)).effect.state, "uncertain", "uncertainty is durable and idempotent");
    assert.deepEqual((await store.completeEffect({
      effect_id: firstMutation.effect.effect_id, result: { sent: true },
      expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
    })).result, { sent: true }, "a delayed exact completion can converge the durable outcome");

    const restartRead = { ...read, mcp_request_id: "restart-read" };
    const restartMutation = { ...mutation, mcp_request_id: "restart-mutation" };
    const restartReadEffect = await store.prepareEffect(restartRead);
    const restartMutationEffect = await store.prepareEffect(restartMutation);
    await store.markEffectExecuting({ effect_id: restartReadEffect.effect.effect_id, ...restartRead });
    await store.markEffectExecuting({ effect_id: restartMutationEffect.effect.effect_id, ...restartMutation });
    await store.normalizeInterruptedEffects(base.agent_id);

    const inspection = new DatabaseSync(env.database);
    try {
      const state = (effectId: string) => (inspection.prepare("SELECT state FROM supervised_agent_effects WHERE effect_id=?").get(effectId) as { state: string }).state;
      assert.equal(state(restartReadEffect.effect.effect_id), "prepared");
      assert.equal(state(restartMutationEffect.effect.effect_id), "uncertain");
    } finally { inspection.close(); }
    await store.close();
  } finally { await env.cleanup(); }
});

test("v16 migration durably classifies interrupted reads and mutations", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T18:10:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "v16-effects", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn", {
      work_attempt_id: "attempt", origin_execution_generation_id: "run", provider_continuation_id: "continuation",
    });
    await seedActiveAgent(env, {
      agentId: "v16-effects", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run", providerContinuationId: "continuation",
    });
    const base = {
      agent_id: "v16-effects", room_id: "room", execution_generation_id: "run", provider_turn_id: "turn",
      work_attempt_id: "attempt", current_execution_generation_id: "run", provider_continuation_id: "continuation",
    };
    const read = { ...base, mcp_request_id: "read", tool_name: "wait_for_messages", request: {} };
    const mutation = { ...base, mcp_request_id: "mutation", tool_name: "claim_task", request: { task_id: "1" } };
    const readEffect = await store.prepareEffect(read);
    const mutationEffect = await store.prepareEffect(mutation);
    await store.markEffectExecuting({ effect_id: readEffect.effect.effect_id, ...read });
    await store.markEffectExecuting({ effect_id: mutationEffect.effect.effect_id, ...mutation });
    await store.close();

    const legacy = new DatabaseSync(env.database);
    legacy.exec(`
      DROP INDEX supervised_agent_effects_turn;
      ALTER TABLE supervised_agent_effects RENAME TO supervised_agent_effects_v17;
      CREATE TABLE supervised_agent_effects (
        effect_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
        execution_generation_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL,
        mcp_request_id TEXT NOT NULL, tool_name TEXT NOT NULL, request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','executing','completed','failed')),
        result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(agent_id,execution_generation_id,provider_turn_id,mcp_request_id)
      ) STRICT;
      INSERT INTO supervised_agent_effects
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_json,state,result_json,error,created_at,updated_at)
      SELECT effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
        tool_name,request_json,state,result_json,error,created_at,updated_at
      FROM supervised_agent_effects_v17;
      DROP TABLE supervised_agent_effects_v17;
      CREATE INDEX supervised_agent_effects_turn
        ON supervised_agent_effects(agent_id,execution_generation_id,provider_turn_id);
      UPDATE manifest_metadata SET schema_version=16 WHERE singleton=1;
      PRAGMA user_version=16;
    `);
    legacy.close();

    const migrated = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T18:11:00.000Z");
    assert.equal((await migrated.prepareEffect(read)).effect.state, "prepared", "the interrupted read remains safely redrivable");
    const migratedMutation = await migrated.prepareEffect(mutation);
    assert.equal(migratedMutation.effect.state, "uncertain");
    assert.equal(migratedMutation.effect.mutation, true);
    const inspection = new DatabaseSync(env.database);
    try {
      assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_SCHEMA_VERSION);
    } finally { inspection.close(); }
    await migrated.close();
  } finally { await env.cleanup(); }
});

test("33 active-turn uncertain mutations retain exact replay and late-completion authority beyond bounded diagnostics", async () => {
  const env = await fixture(); try {
    let clock = Date.parse("2026-08-05T18:20:00.000Z");
    const store = new SupervisedAgentInboxStore(env.database, () => new Date(clock++).toISOString());
    const [item] = await store.ingestPoll({
      agent_id: "uncertain-budget", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "current-turn", {
      work_attempt_id: "attempt", origin_execution_generation_id: "run", provider_continuation_id: "continuation",
    });
    await seedActiveAgent(env, {
      agentId: "uncertain-budget", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run", providerContinuationId: "continuation",
    });
    const base = {
      agent_id: "uncertain-budget", room_id: "room", execution_generation_id: "run",
      provider_turn_id: "current-turn", work_attempt_id: "attempt", current_execution_generation_id: "run",
      provider_continuation_id: "continuation",
    };
    const requests = Array.from({ length: 33 }, (_, index) => ({
      ...base, mcp_request_id: `mutation-${index + 1}`,
      tool_name: "send_message", request: { text: `message-${index + 1}` },
    }));
    const effects = [];
    for (const request of requests) {
      const prepared = await store.prepareEffect(request);
      effects.push(prepared.effect);
      await store.markEffectExecuting({ effect_id: prepared.effect.effect_id, ...request });
      assert.equal((await store.prepareEffect(request)).effect.state, "uncertain");
    }

    const compacted = new DatabaseSync(env.database);
    try {
      assert.equal((compacted.prepare("SELECT COUNT(*) AS count FROM supervised_agent_effects WHERE agent_id=? AND state='uncertain'")
        .get(base.agent_id) as { count: number }).count, 32, "only the Inspector diagnostic window retains full rows");
      assert.equal((compacted.prepare("SELECT COUNT(*) AS count FROM supervised_agent_effect_tombstones WHERE agent_id=?")
        .get(base.agent_id) as { count: number }).count, 1, "request 1 retains a compact durable identity");
      assert.equal((compacted.prepare(`SELECT COUNT(*) AS count FROM (
          SELECT effect_id FROM supervised_agent_effects
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
          UNION ALL
          SELECT effect_id FROM supervised_agent_effect_tombstones
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
        )`).get(
        base.agent_id, base.execution_generation_id, base.provider_turn_id,
        base.agent_id, base.execution_generation_id, base.provider_turn_id,
      ) as { count: number }).count, requests.length,
      "compaction preserves the same identities counted by bounded per-turn effect admission");
      assert.equal(compacted.prepare("SELECT 1 FROM supervised_agent_effects WHERE effect_id=?").get(effects[0]!.effect_id), undefined);
    } finally { compacted.close(); }

    const firstReplay = await store.prepareEffect(requests[0]!);
    assert.equal(firstReplay.created, false);
    assert.equal(firstReplay.effect.effect_id, effects[0]!.effect_id);
    assert.equal(firstReplay.effect.state, "uncertain", "request 1 cannot become executable after diagnostic compaction");
    await assert.rejects(() => store.prepareEffect({ ...requests[0]!, request: { text: "different" } }), /request id was reused/i);
    const lateCompletion = await store.completeEffect({
      effect_id: effects[0]!.effect_id, result: { message_id: "remote-1" },
      expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
    });
    assert.equal(lateCompletion.state, "completed");
    assert.deepEqual(lateCompletion.result, { message_id: "remote-1" });
    const completedReplay = await store.prepareEffect(requests[0]!);
    assert.equal(completedReplay.effect.state, "completed");
    assert.deepEqual(completedReplay.effect.result, { message_id: "remote-1" });

    const admitted = await store.prepareEffect({
      ...base, mcp_request_id: "new-live-effect",
      tool_name: "get_board", request: {},
    });
    assert.equal(admitted.created, true, "terminal uncertainty does not consume unresolved-effect admission quota");
    const visible = await store.detail(base.agent_id, "room", "1");
    assert.equal(visible.uncertain_effects.length, 32);
    assert.equal(visible.uncertain_effects.some((effect) => effect.effect_id === effects[0]!.effect_id), false,
      "the compact tombstone remains dedupe authority without expanding the Inspector window");
    assert.match(visible.uncertain_effects[0]?.error ?? "", /may have completed/i);

    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "acknowledged_no_reply");
    const terminalAuthority = new DatabaseSync(env.database);
    try {
      assert.equal((terminalAuthority.prepare("SELECT COUNT(*) AS count FROM supervised_agent_effect_tombstones WHERE effect_id=?")
        .get(effects[0]!.effect_id) as { count: number }).count, 1,
      "terminal receipt retention keeps delayed completion/replay authority while its binding exists");
    } finally { terminalAuthority.close(); }
    const later = await store.ingestPoll({
      agent_id: "uncertain-budget", room_id: "room", last_observed_message_id: "201",
      messages: Array.from({ length: 200 }, (_, index) => ({
        source_message_id: String(index + 2), source_message: {}, activation: {},
      })),
    });
    for (const laterItem of later) {
      await store.transition(laterItem.inbox_item_id, "blocked", { last_error: "terminal retention fixture" });
      await store.skipBlocked(laterItem.inbox_item_id);
    }
    const detail = await store.detail("uncertain-budget", "room", "1");
    assert.equal(detail.availability, "pruned", "uncertain effects do not pin their parent receipt beyond ordinary retention");
    assert.equal(detail.uncertain_effects.length, 0,
      "full diagnostics are removed once ordinary receipt retention removes the exact provider-turn binding");
    assert.equal((await store.receipts("uncertain-budget")).length, 200);

    const bounded = new DatabaseSync(env.database);
    try {
      assert.equal((bounded.prepare("SELECT COUNT(*) AS count FROM supervised_agent_effects WHERE agent_id=? AND state='uncertain'")
        .get("uncertain-budget") as { count: number }).count, 0);
      assert.equal((bounded.prepare("SELECT COUNT(*) AS count FROM supervised_agent_effect_tombstones WHERE agent_id=?")
        .get("uncertain-budget") as { count: number }).count, 0,
      "bounded receipt retention removes the provider-turn binding before compact dedupe identity is discarded");
    } finally { bounded.close(); }
    await store.close();
  } finally { await env.cleanup(); }
});

test("effect journal bounds per-turn rows and payload bytes without stranding completed side effects", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "bounded-effects", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "many tools" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "bounded-turn", {
      ...TEST_PROVIDER_TURN_AUTHORITY,
      origin_execution_generation_id: "run",
    });
    await seedActiveAgent(env, {
      agentId: "bounded-effects", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run", providerContinuationId: "continuation",
    });
    const base = {
      agent_id: "bounded-effects", room_id: "room", execution_generation_id: "run",
      provider_turn_id: "bounded-turn", work_attempt_id: "attempt",
      current_execution_generation_id: "run", provider_continuation_id: "continuation",
      tool_name: "send_message",
    };
    await assert.rejects(() => store.prepareEffect({
      ...base, mcp_request_id: "oversized-request", request: { text: "x".repeat(65 * 1024) },
    }), /request exceeds the 65536-byte durable limit/i);

    const effects = [];
    const first = await store.prepareEffect({
      ...base, mcp_request_id: "effect-0", request: { text: "small" },
    });
    effects.push(first.effect);
    for (let index = 1; index <= 8; index += 1) {
      effects.push((await store.prepareEffect({
        ...base, mcp_request_id: `effect-${index}`, request: { text: "x".repeat(60 * 1024) },
      })).effect);
    }
    await assert.rejects(() => store.prepareEffect({
      ...base, mcp_request_id: "request-budget-overflow", request: { text: "x".repeat(60 * 1024) },
    }), /durable request budget/i);
    for (let index = effects.length; index < 127; index += 1) {
      effects.push((await store.prepareEffect({
        ...base, mcp_request_id: `effect-${index}`, request: { index },
      })).effect);
    }
    const competingStore = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
    const raced = await Promise.allSettled([
      store.prepareEffect({ ...base, mcp_request_id: "effect-final-a", request: { contender: "a" } }),
      competingStore.prepareEffect({ ...base, mcp_request_id: "effect-final-b", request: { contender: "b" } }),
    ]);
    const admitted = raced.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.prepareEffect>>> => result.status === "fulfilled");
    const rejected = raced.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(admitted.length, 1, "BEGIN IMMEDIATE serializes independent stores racing the final turn slot");
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /at most 128 effects/i);
    effects.push(admitted[0]!.value.effect);
    await competingStore.close();
    await assert.rejects(() => store.prepareEffect({
      ...base, mcp_request_id: "effect-128", request: { over: true },
    }), /at most 128 effects/i);
    assert.equal((await store.prepareEffect({
      ...base, mcp_request_id: "effect-0", request: { text: "small" },
    })).created, false, "an exact replay remains available after admission reaches its cap");
    await assert.rejects(() => store.prepareRoomMoveEffect({
      agent_id: base.agent_id,
      room_id: base.room_id,
      effect_execution_generation_id: base.execution_generation_id,
      provider_turn_id: base.provider_turn_id,
      mcp_request_id: "move-after-cap",
      request: { name: "destination" },
      destination_room_id: "destination",
      daemon_generation: 1,
      work_attempt_id: base.work_attempt_id,
      execution_generation_id: base.current_execution_generation_id,
      provider_continuation_id: base.provider_continuation_id,
      agent_session_id: "agent-session",
      activating_inbox_item_id: item!.inbox_item_id,
    }), /at most 128 effects/i, "room moves share the same transactional per-turn admission cap");
    for (let index = 0; index < 4; index += 1) {
      await store.markEffectExecuting({ effect_id: effects[index]!.effect_id, ...base });
      const completed = await store.completeEffect({
        effect_id: effects[index]!.effect_id,
        result: { text: "r".repeat(250 * 1024) },
        expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
      });
      assert.equal(completed.state, "completed");
    }
    await store.markEffectExecuting({ effect_id: effects[4]!.effect_id, ...base });
    const omittedForBudget = await store.completeEffect({
      effect_id: effects[4]!.effect_id,
      result: { text: "r".repeat(250 * 1024) },
      expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
    });
    assert.deepEqual(omittedForBudget.result, {
      supervised_effect_result_omitted: true,
      reason: "durable_size_limit",
      serialized_bytes: 256011,
    }, "an already-executed effect settles with explicit omission instead of becoming immortal");

    await store.markEffectExecuting({ effect_id: effects[5]!.effect_id, ...base });
    const omittedUnserializable = await store.completeEffect({
      effect_id: effects[5]!.effect_id,
      result: { value: 1n },
      expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
    });
    assert.deepEqual(omittedUnserializable.result, {
      supervised_effect_result_omitted: true,
      reason: "not_json_serializable",
      serialized_bytes: null,
    });
    await assert.rejects(() => store.stagePreparedEffectResult(
      effects[6]!.effect_id, { text: "r".repeat(257 * 1024) },
    ), /prepared result exceeds the 262144-byte durable limit/i);

    await store.markEffectExecuting({ effect_id: effects[7]!.effect_id, ...base });
    const failed = await store.completeEffect({
      effect_id: effects[7]!.effect_id,
      error: "failure ".repeat(8 * 1024),
      expected: { agent_id: base.agent_id, work_attempt_id: base.work_attempt_id, provider_turn_id: base.provider_turn_id },
    });
    assert.equal(failed.state, "failed");
    assert.ok(Buffer.byteLength(failed.error ?? "", "utf8") <= 16 * 1024);
    assert.match(failed.error ?? "", /\[truncated\]$/);
    const completionPastOrdinaryCap = await store.prepareEffect({
      ...base, mcp_request_id: "completion-after-cap", tool_name: "complete_room_turn",
      request: { outcome: "reply", text: "The final answer still fits." }, mutation: true,
    });
    assert.equal(completionPastOrdinaryCap.effect.state, "completed",
      "ordinary tools cannot exhaust the reserved structured-completion contract");
    await store.close();
  } finally { await env.cleanup(); }
});

test("effect retention is globally bounded across terminal turns while unresolved evidence remains durable", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:30:00.000Z");
    await seedActiveAgent(env, {
      agentId: "unresolved-retention", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run-unresolved", providerContinuationId: "continuation",
    });
    const unresolvedItems = await store.ingestPoll({
      agent_id: "unresolved-retention",
      room_id: "room",
      last_observed_message_id: "129",
      messages: Array.from({ length: 129 }, (_, index) => ({
        source_message_id: String(index + 1), source_message: { index }, activation: {},
      })),
    });
    for (let index = 0; index < 128; index += 1) {
      const item = unresolvedItems[index]!;
      const providerTurnId = `unresolved-turn-${index}`;
      await store.transition(item.inbox_item_id, "dispatching");
      await store.checkpointTurnStarted(item.inbox_item_id, providerTurnId, {
        work_attempt_id: "attempt",
        origin_execution_generation_id: "run-unresolved",
        provider_continuation_id: "continuation",
      });
      const input = {
        agent_id: "unresolved-retention", room_id: "room", execution_generation_id: "run-unresolved",
        provider_turn_id: providerTurnId, work_attempt_id: "attempt",
        current_execution_generation_id: "run-unresolved", provider_continuation_id: "continuation",
        mcp_request_id: `unresolved-effect-${index}`, tool_name: "send_message", request: { index },
      };
      const prepared = await store.prepareEffect(input);
      await store.markEffectExecuting({ effect_id: prepared.effect.effect_id, ...input });
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, "acknowledged_no_reply");
    }
    const blockedItem = unresolvedItems[128]!;
    await store.transition(blockedItem.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(blockedItem.inbox_item_id, "unresolved-turn-blocked", {
      work_attempt_id: "attempt",
      origin_execution_generation_id: "run-unresolved",
      provider_continuation_id: "continuation",
    });
    await assert.rejects(() => store.prepareEffect({
      agent_id: "unresolved-retention", room_id: "room", execution_generation_id: "run-unresolved",
      provider_turn_id: "unresolved-turn-blocked", work_attempt_id: "attempt",
      current_execution_generation_id: "run-unresolved", provider_continuation_id: "continuation",
      mcp_request_id: "unresolved-effect-blocked", tool_name: "send_message", request: { blocked: true },
    }), /at most 128 unresolved effects across turns/i);
    await store.transition(blockedItem.inbox_item_id, "awaiting_result");
    await store.transition(blockedItem.inbox_item_id, "acknowledged_no_reply");

    await seedActiveAgent(env, {
      agentId: "completed-retention", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run-completed", providerContinuationId: "continuation",
    });
    const completedItems = await store.ingestPoll({
      agent_id: "completed-retention",
      room_id: "room",
      last_observed_message_id: "205",
      messages: Array.from({ length: 205 }, (_, index) => ({
        source_message_id: String(index + 1), source_message: { index }, activation: {},
      })),
    });
    for (let index = 0; index < completedItems.length; index += 1) {
      const item = completedItems[index]!;
      const providerTurnId = `completed-turn-${index}`;
      await store.transition(item.inbox_item_id, "dispatching");
      await store.checkpointTurnStarted(item.inbox_item_id, providerTurnId, {
        work_attempt_id: "attempt",
        origin_execution_generation_id: "run-completed",
        provider_continuation_id: "continuation",
      });
      const input = {
        agent_id: "completed-retention", room_id: "room", execution_generation_id: "run-completed",
        provider_turn_id: providerTurnId, work_attempt_id: "attempt",
        current_execution_generation_id: "run-completed", provider_continuation_id: "continuation",
        mcp_request_id: `completed-effect-${index}`, tool_name: "send_message", request: { index },
      };
      const prepared = await store.prepareEffect(input);
      await store.markEffectExecuting({ effect_id: prepared.effect.effect_id, ...input });
      await store.completeEffect({
        effect_id: prepared.effect.effect_id,
        result: { index },
        expected: { agent_id: input.agent_id, work_attempt_id: input.work_attempt_id, provider_turn_id: input.provider_turn_id },
      });
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, "acknowledged_no_reply");
      if (index === 0) {
        // A completed turn-control journal intentionally keeps its exact
        // provider-turn coordinates for audit/operator history. Reproduce that
        // durable terminal shape before enough later receipts trigger pruning.
        const journal = new DatabaseSync(env.database);
        journal.prepare(`INSERT INTO turn_control_sequence_watermarks(agent_id,last_sequence)
          VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET last_sequence=excluded.last_sequence`)
          .run("completed-retention", 1);
        journal.prepare(`UPDATE turn_control_journals SET
          turn_control_present=1,action_id=?,action_sequence=1,
          turn_work_attempt_id=?,turn_execution_generation_id=?,
          target_room_id=?,target_source_message_id=?,target_provider_continuation_id=?,
          inbox_item_id=?,provider_turn_id=?,has_correction=0,correction_text=NULL,
          correction_strategy=NULL,operator_resolution=NULL,status='completed',
          capability='native_interrupt',interrupted=1,resumed=0,turn_state='stopped',
          error=NULL,recorded_at=?,updated_at=? WHERE agent_id=?`).run(
          "completed-control", "attempt", "run-completed", "room", item.source_message_id,
          "continuation", item.inbox_item_id, providerTurnId,
          "2026-08-05T17:30:00.000Z", "2026-08-05T17:30:00.000Z", "completed-retention",
        );
        journal.close();
      }
    }
    assert.equal((await store.receipts("unresolved-retention")).length, 129,
      "unresolved execution evidence pins only the globally capped receipt set");
    assert.equal((await store.receipts("completed-retention")).length, 200);
    assert.equal((await store.get(completedItems[0]!.inbox_item_id))?.source_message_id, "1",
      "the exact completed turn-control target remains inside the fixed receipt budget");
    assert.equal(await store.get(completedItems[1]!.inbox_item_id), null,
      "pinning the control target does not grow the bounded terminal history");
    await store.close();

    const inspection = new DatabaseSync(env.database);
    assert.equal((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_effects
      WHERE agent_id='unresolved-retention' AND state IN ('prepared','executing')`).get() as { count: number }).count, 128);
    assert.equal((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_effects
      WHERE agent_id='completed-retention'`).get() as { count: number }).count, 200,
    "completed effects are pruned with the same retained receipt scope");
    assert.equal(inspection.prepare("PRAGMA foreign_key_check").get(), undefined);
    assert.doesNotThrow(() => new DaemonStateSchema().createSchema(inspection),
      "retention cannot detach a completed turn-control journal from its exact inbox binding on reopen");
    assert.ok(inspection.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings
      WHERE inbox_item_id=?`).get(completedItems[0]!.inbox_item_id),
    "the pinned receipt keeps its exact provider-turn authority binding");

    // Simulate the predecessor retention bug on a current-v16 database. Since
    // the control is completed, startup repair must preserve its action audit
    // while honestly dropping the now-unprovable causal target tuple.
    inspection.prepare(`INSERT INTO supervised_agent_pruned_sources
      (agent_id,room_id,source_message_id,pruned_at) VALUES (?,?,?,?)`).run(
      "completed-retention", "room", completedItems[0]!.source_message_id, "2026-08-05T17:31:00.000Z",
    );
    inspection.prepare("DELETE FROM supervised_agent_inbox WHERE inbox_item_id=?")
      .run(completedItems[0]!.inbox_item_id);
    assert.doesNotThrow(() => new DaemonStateSchema().createSchema(inspection));
    const repairedControl = inspection.prepare(`SELECT status,target_room_id,
      target_source_message_id,target_provider_continuation_id,inbox_item_id,
      provider_turn_id,error FROM turn_control_journals WHERE agent_id=?`)
      .get("completed-retention") as Record<string, unknown>;
    assert.equal(repairedControl.status, "completed");
    for (const column of ["target_room_id", "target_source_message_id", "target_provider_continuation_id", "inbox_item_id", "provider_turn_id"]) {
      assert.equal(repairedControl[column], null, `${column} is cleared instead of guessed`);
    }
    assert.match(String(repairedControl.error), /retained as audit-only/i);
    inspection.close();
  } finally { await env.cleanup(); }
});

test("effect completion releases every terminal receipt pin and converges physical history", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T18:00:00.000Z");
  try {
    await seedActiveAgent(env, {
      agentId: "effect-unpin", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "run", providerContinuationId: "continuation",
    });
    const settle = async (index: number, withEffect: boolean) => {
      const item = await store.enqueueCorrection({
        agent_id: "effect-unpin", room_id: "room", source_message_id: `effect-unpin-${index}`,
        source_message: { index }, activation: { decision: "activate" },
      });
      assert.equal((await store.claimHead("effect-unpin"))?.inbox_item_id, item.inbox_item_id);
      const providerTurnId = `effect-unpin-turn-${index}`;
      await store.checkpointTurnStarted(item.inbox_item_id, providerTurnId, {
        work_attempt_id: "attempt", origin_execution_generation_id: "run", provider_continuation_id: "continuation",
      });
      let effectId: string | null = null;
      if (withEffect) {
        const input = {
          agent_id: "effect-unpin", room_id: "room", execution_generation_id: "run",
          provider_turn_id: providerTurnId, work_attempt_id: "attempt",
          current_execution_generation_id: "run", provider_continuation_id: "continuation",
          mcp_request_id: `effect-unpin-request-${index}`, tool_name: "send_message", request: { index },
        };
        const prepared = await store.prepareEffect(input);
        await store.markEffectExecuting({ effect_id: prepared.effect.effect_id, ...input });
        effectId = prepared.effect.effect_id;
      }
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, "acknowledged_no_reply");
      return { effectId, providerTurnId };
    };

    for (let index = 0; index < 200; index += 1) await settle(index, false);
    const executing = [];
    for (let index = 200; index < 328; index += 1) executing.push(await settle(index, true));
    let inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id='effect-unpin'`).get() as { count: number }).count), 328,
    "executing effects intentionally pin their terminal receipts above ordinary history retention");
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_effects
      WHERE agent_id='effect-unpin' AND state='executing'`).get() as { count: number }).count), 128);
    inspection.close();

    for (const effect of executing) {
      await store.completeEffect({
        effect_id: effect.effectId!, result: { completed: true },
        expected: { agent_id: "effect-unpin", work_attempt_id: "attempt", provider_turn_id: effect.providerTurnId },
      });
    }
    inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox
      WHERE agent_id='effect-unpin'`).get() as { count: number }).count), 200,
    "the final unpin transaction converges immediately to the exact receipt budget");
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_effects
      WHERE agent_id='effect-unpin' AND state IN ('prepared','executing')`).get() as { count: number }).count), 0);
    assert.ok(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_effects
      WHERE agent_id='effect-unpin'`).get() as { count: number }).count) <= 128);
    assert.deepEqual(inspection.prepare("PRAGMA foreign_key_check").all(), []);
    inspection.close();

    await store.close();
    const reopened = new SupervisedAgentInboxStore(env.database);
    assert.equal((await reopened.receipts("effect-unpin")).length, 200);
    await reopened.close();
    const reopenedManifest = new ManifestStore(env.database);
    assert.equal((await reopenedManifest.getEntry("effect-unpin"))?.provider_ref?.execution_generation_id, "run");
    await reopenedManifest.close();
  } finally {
    await store.close().catch(() => undefined);
    await env.cleanup();
  }
});

test("an effect that loses runtime authority before execution is durably failed", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T13:00:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "stop-race", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "run effect" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn-stop-race", TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, {
      agentId: "stop-race", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const authority = {
      agent_id: "stop-race", room_id: "room", execution_generation_id: "generation",
      provider_turn_id: "turn-stop-race", work_attempt_id: "attempt",
      current_execution_generation_id: "generation", provider_continuation_id: "continuation",
      mcp_request_id: "request-stop-race", tool_name: "claim_task", request: { task_id: "task" },
    };
    const prepared = await store.prepareEffect(authority);

    const manifest = new ManifestStore(env.database);
    const current = await manifest.load();
    await manifest.write(current.generation, current.entries.map((candidate) => candidate.id === "stop-race"
      ? { ...candidate, desired_state: "stopped" as const }
      : candidate));
    await manifest.close();

    await assert.rejects(
      () => store.markEffectExecuting({ effect_id: prepared.effect.effect_id, ...authority }),
      /lost its exact current runtime authority/,
    );
    const replay = await store.prepareEffect(authority);
    assert.equal(replay.effect.state, "failed", "the rejected execution CAS cannot leave an immortal prepared row");
    assert.match(replay.effect.error ?? "", /lost its exact current runtime authority/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("structured room-turn completion is an atomic durable singleton across concurrency and restart", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T13:10:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "cursor-completion", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "answer this" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "cursor-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, {
      agentId: "cursor-completion", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const authority = {
      agent_id: "cursor-completion", room_id: "room", execution_generation_id: "generation",
      provider_turn_id: "cursor-turn", work_attempt_id: "attempt",
      current_execution_generation_id: "generation", provider_continuation_id: "continuation",
    };
    const completion = { outcome: "reply" as const, text: "Durable public answer." };
    const preCompletionEffect = await store.prepareEffect({
      ...authority, mcp_request_id: "read-before-complete", tool_name: "get_board",
      request: {}, mutation: false,
    });
    const preCompletionMoveInput = {
      agent_id: authority.agent_id,
      room_id: authority.room_id,
      effect_execution_generation_id: authority.execution_generation_id,
      provider_turn_id: authority.provider_turn_id,
      mcp_request_id: "move-before-complete",
      request: { name: "next-room" },
      destination_room_id: "next-room",
      daemon_generation: 1,
      work_attempt_id: authority.work_attempt_id,
      execution_generation_id: authority.current_execution_generation_id,
      provider_continuation_id: authority.provider_continuation_id,
      agent_session_id: "cursor-completion-session",
      activating_inbox_item_id: item!.inbox_item_id,
    };
    const preCompletionMove = await store.prepareRoomMoveEffect(preCompletionMoveInput);
    const competingStore = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T13:10:00.000Z");
    const concurrent = await Promise.all([
      store.prepareEffect({
        ...authority, mcp_request_id: "complete-1", tool_name: "complete_room_turn",
        request: completion, mutation: true,
      }),
      competingStore.prepareEffect({
        ...authority, mcp_request_id: "complete-2", tool_name: "complete_room_turn",
        request: completion, mutation: true,
      }),
    ]);
    assert.equal(concurrent[0]!.effect.state, "completed");
    assert.equal(concurrent[1]!.effect.state, "completed");
    assert.equal(concurrent[0]!.effect.effect_id, concurrent[1]!.effect.effect_id,
      "independent stores converge on the one exact-turn proposal");
    assert.equal((await competingStore.prepareEffect({
      ...authority, mcp_request_id: "read-before-complete", tool_name: "get_board",
      request: {}, mutation: false,
    })).effect.effect_id, preCompletionEffect.effect.effect_id,
    "completion keeps idempotent replay of an already-admitted effect available");
    await assert.rejects(() => competingStore.markEffectExecuting({
      effect_id: preCompletionEffect.effect.effect_id,
      ...authority,
    }), /already complete.*may no longer execute/i,
    "an effect prepared before completion cannot cross its execution boundary afterward");
    assert.equal((await competingStore.prepareEffect({
      ...authority, mcp_request_id: "read-before-complete", tool_name: "get_board",
      request: {}, mutation: false,
    })).effect.state, "failed", "the completion fence is durable across exact replay");
    assert.equal((await competingStore.prepareRoomMoveEffect(preCompletionMoveInput)).effect.effect_id,
      preCompletionMove.effect.effect_id,
      "the exact prepared room move remains replayable for completion-coupled reconciliation");
    await assert.rejects(competingStore.prepareRoomMoveEffect({
      ...preCompletionMoveInput,
      mcp_request_id: "move-after-complete",
      request: { name: "another-room" },
      destination_room_id: "another-room",
    }), /already complete.*no new effects/i,
    "join_room cannot bypass the completed-turn admission seal");
    await assert.rejects(competingStore.prepareEffect({
      ...authority, mcp_request_id: "read-after-complete", tool_name: "get_board",
      request: {}, mutation: false,
    }), /already complete.*no new effects/i,
    "the atomic completion transaction seals the effect lane for every later request id");
    await competingStore.close();
    await store.close();

    // Simulate the only pre-atomic crash shape that can exist across an
    // upgrade: the request is durable but its old two-phase callback did not
    // checkpoint completion. Reopen must finish it locally, never quarantine.
    const legacy = new DatabaseSync(env.database);
    legacy.prepare("UPDATE supervised_agent_effects SET state='executing',result_json=NULL WHERE effect_id=?")
      .run(concurrent[0]!.effect.effect_id);
    legacy.close();

    const reopened = new SupervisedAgentInboxStore(env.database);
    const recovered = await reopened.prepareEffect({
      ...authority, mcp_request_id: "complete-after-restart", tool_name: "complete_room_turn",
      request: completion, mutation: true,
    });
    assert.equal(recovered.effect.state, "completed");
    assert.equal(recovered.effect.effect_id, concurrent[0]!.effect.effect_id);
    assert.equal((await reopened.prepareEffect({
      ...authority, mcp_request_id: "read-before-complete", tool_name: "get_board",
      request: {}, mutation: false,
    })).effect.state, "failed", "restart preserves the execution fence on pre-completion effects");
    const durable = await reopened.roomTurnCompletionEffects("cursor-completion", "generation", "cursor-turn");
    assert.equal(durable.length, 1);
    assert.equal(durable[0]?.state, "completed");
    assert.deepEqual(durable[0]?.request, { outcome: "reply", text: "Durable public answer." });
    assert.deepEqual(await reopened.roomTurnCompletionEffects("cursor-completion", "different-generation", "cursor-turn"), []);
    assert.deepEqual(await reopened.roomTurnCompletionEffects("cursor-completion", "generation", "different-turn"), []);

    await assert.rejects(() => reopened.prepareEffect({
      ...authority, mcp_request_id: "complete-conflict", tool_name: "complete_room_turn",
      request: { outcome: "no_reply" }, mutation: true,
    }), /different completion proposal/i);
    assert.equal((await reopened.roomTurnCompletionEffects("cursor-completion", "generation", "cursor-turn")).length, 1);
    await reopened.close();
  } finally { await env.cleanup(); }
});

test("room-turn completion waits until every already-executing effect has durably finished", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T13:12:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "completion-order", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "mutate then answer" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "ordered-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, {
      agentId: "completion-order", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const authority = {
      agent_id: "completion-order", room_id: "room", execution_generation_id: "generation",
      provider_turn_id: "ordered-turn", work_attempt_id: "attempt",
      current_execution_generation_id: "generation", provider_continuation_id: "continuation",
    };
    const mutation = await store.prepareEffect({
      ...authority, mcp_request_id: "mutation", tool_name: "send_message",
      request: { text: "side effect first" }, mutation: true,
    });
    await store.markEffectExecuting({ effect_id: mutation.effect.effect_id, ...authority });
    await assert.rejects(store.prepareEffect({
      ...authority, mcp_request_id: "completion-too-early", tool_name: "complete_room_turn",
      request: { outcome: "no_reply" }, mutation: true,
    }), /cannot complete while an earlier effect is still executing/i,
    "completion cannot claim to be the last action while an earlier effect is across its execution boundary");
    const legacy = new DatabaseSync(env.database);
    legacy.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('legacy-completion',?,?,?,?,?,'complete_room_turn',?,1,'executing',NULL,NULL,?,?)`).run(
      authority.agent_id, authority.room_id, authority.execution_generation_id, authority.provider_turn_id,
      "legacy-completion-request", JSON.stringify({ outcome: "no_reply" }),
      "2026-08-05T13:12:00.000Z", "2026-08-05T13:12:00.000Z",
    );
    legacy.close();
    await assert.rejects(store.prepareEffect({
      ...authority, mcp_request_id: "legacy-completion-request", tool_name: "complete_room_turn",
      request: { outcome: "no_reply" }, mutation: true,
    }), /cannot complete while an earlier effect is still executing/i,
    "restart replay of a pre-atomic completion cannot bypass the same ordering fence");
    await store.completeEffect({
      effect_id: mutation.effect.effect_id,
      result: { delivered: true },
      expected: { agent_id: authority.agent_id, work_attempt_id: authority.work_attempt_id, provider_turn_id: authority.provider_turn_id },
    });
    const completion = await store.prepareEffect({
      ...authority, mcp_request_id: "legacy-completion-request", tool_name: "complete_room_turn",
      request: { outcome: "no_reply" }, mutation: true,
    });
    assert.equal(completion.effect.state, "completed");
    await store.close();
  } finally { await env.cleanup(); }
});

test("reply publication settles unexecuted ordinary effects but preserves prepared room moves", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T13:15:00.000Z");
    const [item] = await store.ingestPoll({
      agent_id: "terminal-effect", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "finish" }, activation: {} }],
    });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn-terminal", TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, {
      agentId: "terminal-effect", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const base = {
      agent_id: "terminal-effect", room_id: "room", execution_generation_id: "generation",
      provider_turn_id: "turn-terminal", work_attempt_id: "attempt",
      current_execution_generation_id: "generation", provider_continuation_id: "continuation",
    };
    const ordinary = await store.prepareEffect({
      ...base, mcp_request_id: "use-final", tool_name: "send_message", request: { reply_to: "1", text: "answer" },
    });
    const move = await store.prepareEffect({
      ...base, mcp_request_id: "move", tool_name: "join_room", request: { name: "next-room" },
    });
    await store.checkpointTerminalOutcome(item!.inbox_item_id, JSON.stringify({ kind: "reply", text: "answer" }));
    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "publishing");
    await store.checkpointPublication({
      inbox_item_id: item!.inbox_item_id, room_id: "room", canonical_message_id: "published-answer",
    });

    assert.equal((await store.prepareEffect({
      ...base, mcp_request_id: "use-final", tool_name: "send_message", request: { reply_to: "1", text: "answer" },
    })).effect.state, "failed");
    assert.equal((await store.preparedRoomMoves("terminal-effect"))[0]?.effect_id, move.effect.effect_id,
      "the post-publication room-move journal remains available for reconciliation");
    assert.notEqual(ordinary.effect.effect_id, move.effect.effect_id);
    await store.close();
  } finally { await env.cleanup(); }
});

test("delivery timeline records causal phases durably across a daemon restart", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-20T12:00:00.000Z");
    const [item] = await store.ingestPoll({ agent_id: "timeline", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.claimHead("timeline");
    await store.checkpointDispatchIntent(item!.inbox_item_id);
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
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
    await store.checkpointTurnStarted(item!.inbox_item_id, "turn-2", TEST_PROVIDER_TURN_AUTHORITY);
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
