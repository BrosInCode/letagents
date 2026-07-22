import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { DaemonStateSchema } from "../daemon-state-database.js";
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
    assert.match(first[0]!.action_id, /stone:1:action:v1$/);
    assert.match(first[0]!.reply_client_message_id, /stone:1:reply:v1$/);
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

test("room move cancels only later old-room work and clears old ingress authority", async () => {
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
    const cancelled = await store.commitRoomMoveQueue({ agent_id: "mover", old_room_id: "old-room", after_fifo_sequence: current!.fifo_sequence });
    assert.equal(cancelled, 1);
    assert.equal((await store.get(later!.inbox_item_id))?.state, "cancelled_by_room_move");
    assert.equal((await store.receipts("mover"))[1]?.timeline.at(-1)?.phase, "room_move_cancelled");
    assert.equal(await store.cursor("mover"), null);
    assert.equal(await store.ingressHealth("mover"), null);
    await store.close();
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
    assert.equal((partialV7.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
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
    assert.equal((interrupted.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
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
