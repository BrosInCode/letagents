import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { DAEMON_STATE_USER_VERSION, DaemonStateSchema } from "../daemon-state-database.js";
import { WorkerBindingStore } from "../worker-binding-store.js";
import { ManifestStore } from "../manifest-store.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity } from "../execution-shadow-store.js";
import { RETAINED_TERMINAL_TIMELINE_EVENTS, RETAINED_TERMINAL_CONTINUATION_REPAIRS, settleCapturedExecutionAttempts } from "../supervised-agent-history-retention.js";
import type { DaemonManifestEntry } from "../types.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { seedBoundedMcpEffectRow } from "./helpers/bounded-effect-seed.js";

const TEST_PROVIDER_TURN_AUTHORITY = {
  work_attempt_id: "attempt",
  origin_execution_generation_id: "generation",
  provider_continuation_id: "continuation",
} as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "letagents-supervised-inbox-"));
  return { root, database: join(root, "daemon-state.sqlite"), legacy: join(root, "legacy.json"), cleanup: () => removeTestDirectory(root) };
}

function captureReceipt(database: DatabaseSync, item: Awaited<ReturnType<SupervisedAgentInboxStore["checkpointTurnStarted"]>>): string {
  const binding = database.prepare("SELECT * FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(item.inbox_item_id)!;
  const generation = String(binding.origin_execution_generation_id);
  const runtime = `captured-runtime:${item.agent_id}:${generation}`;
  const attempt = `captured-attempt:${item.inbox_item_id}`;
  const created = Date.parse(item.created_at);
  database.prepare("INSERT OR IGNORE INTO execution_generations VALUES(?,?,?)").run(generation, item.agent_id, created);
  database.prepare(`INSERT OR IGNORE INTO execution_runtime_generations
    (runtime_generation_id,execution_generation_id,agent_id,provider,authority_mode,runtime_state,control_state,continuation_state,config_revision,created_at_ms)
    VALUES(?,?,?,'codex','typed','ready','connecting','available',1,?)`).run(runtime, generation, item.agent_id, created);
  database.prepare(`INSERT INTO execution_message_attempts(attempt_id,agent_id,room_id,source_message_id,state,created_at_ms)
    VALUES(?,?,?,?,'active',?)`).run(attempt, item.agent_id, item.room_id, item.source_message_id, created);
  database.prepare("INSERT INTO execution_attempt_generations VALUES(?,?,?,?,?,?)")
    .run(attempt, item.agent_id, item.room_id, generation, String(binding.work_attempt_id), created);
  database.prepare(`INSERT INTO runs
    (turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms)
    VALUES(?,?,?,?,?,?,?,?,'none','none',?)`).run(`captured-turn:${item.inbox_item_id}`, attempt, item.agent_id, item.room_id,
    generation, runtime, String(binding.provider_continuation_id), item.provider_turn_id, created);
  return attempt;
}

async function completeCapturedReceipt(store: SupervisedAgentInboxStore, database: DatabaseSync, item: Awaited<ReturnType<SupervisedAgentInboxStore["ingestPoll"]>>[number],
  outcome: "reply" | "no_reply" | "failed" | "interrupted" | "cancelled_by_user" = "no_reply",
  capture: "before" | "after" = "after"): Promise<string> {
  await store.transition(item.inbox_item_id, "dispatching");
  const nativeTurn = `native:${item.source_message_id}`;
  const started = await store.checkpointTurnStarted(item.inbox_item_id, nativeTurn, TEST_PROVIDER_TURN_AUTHORITY);
  const attempt = capture === "before" ? captureReceipt(database, started) : undefined;
  if (outcome === "cancelled_by_user") {
    await store.cancelInterruptedTurn(item.inbox_item_id);
    return attempt ?? captureReceipt(database, started);
  }
  await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: item.agent_id,
    execution_generation_id: "generation", provider_turn_id: nativeTurn, outcome,
    text: outcome === "reply" ? "private reply text" : null, evidence: "stream",
    terminal_evidence: { turnId: nativeTurn, providerContinuationId: "continuation", outcome,
      text: outcome === "reply" ? "private reply text" : null, evidence: "stream" } });
  await store.transition(item.inbox_item_id, "awaiting_result");
  if (outcome === "reply") {
    await store.transition(item.inbox_item_id, "publishing");
    await store.checkpointPublication({ inbox_item_id: item.inbox_item_id, room_id: item.room_id, canonical_message_id: `published:${item.source_message_id}` });
  } else await store.transition(item.inbox_item_id, outcome === "no_reply" ? "acknowledged_no_reply" : "acknowledged_failed");
  return attempt ?? captureReceipt(database, started);
}

async function seedActiveAgent(env: Awaited<ReturnType<typeof fixture>>, input: {
  agentId: string; roomId: string; workAttemptId: string; executionGenerationId: string; providerContinuationId: string;
  operationalExecution?: boolean; provider?: "codex" | "claude-code";
}): Promise<void> {
  const manifest = new ManifestStore(env.database);
  const loaded = await manifest.load();
  const active: DaemonManifestEntry = {
    id: input.agentId, room_id: input.roomId, display_name: input.agentId,
    provider: input.provider ?? "codex", model: null, charter: "test", desired_state: "running",
    observed_state: "working", condition: "none", permission_profile_id: null,
    delivery_mode: "daemon_inbox", provider_launch_policy: {}, created_by: "test",
    created_at: "2026-08-05T00:00:00.000Z", workspace_path: "/tmp/workspace",
    work_attempt_id: input.workAttemptId,
    provider_ref: {
      work_attempt_id: input.workAttemptId,
      provider_continuation_id: input.providerContinuationId,
      provider_connection: input.provider === "claude-code"
        ? { kind: "claude_cli", pid: 4311, processIdentity: "test:4311" }
        : { kind: "codex_app_server", url: "http://127.0.0.1:4311", pid: 4311, processIdentity: "test:4311" },
      execution_generation_id: input.executionGenerationId,
    },
    workplace_liveness: { state: "reachable", observed_at: "2026-08-05T00:00:00.000Z", detail: null },
    native_liveness: { state: "active", observed_at: "2026-08-05T00:00:00.000Z", detail: null },
    activity: [], restart_count: 0, last_turn_control_sequence: 0,
  };
  await manifest.write([...loaded.entries.filter((entry) => entry.id !== input.agentId), active]);
  await manifest.close();
  if (input.operationalExecution) {
    const database = new DatabaseSync(env.database);
    try {
      database.prepare(`INSERT INTO work_attempts
        (work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,
          workspace_resolved_revision,workspace_bare_path,state,created_at)
        VALUES (?,?,?,1,?,'repo','https://example.test/repo.git',?,?,'active',?)`).run(
        input.workAttemptId, "task", "lease", active.workspace_path!, "a".repeat(40), join(env.root, "bare.git"), active.created_at,
      );
      database.prepare("INSERT INTO work_attempt_lease_epochs VALUES(?,0,'lease',1,?)").run(input.workAttemptId, active.created_at);
      database.prepare("INSERT INTO work_attempt_executions VALUES(?,?,?,'provider',1,NULL)")
        .run(input.executionGenerationId, input.workAttemptId, active.created_at);
    } finally { database.close(); }
  }
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

test("message interventions require exact native-turn, message, room and execution authority", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database);
  try {
    await seedActiveAgent(env, { agentId: "stone", roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation" });
    const [item] = await store.ingestPoll({ agent_id: "stone", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "Fix auth" }, activation: {} }] });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, "native-1", TEST_PROVIDER_TURN_AUTHORITY);
    const database = new DatabaseSync(env.database);
    try {
      const baseControl: Record<string, unknown> = {
        action_id: "control-1",
        action_sequence: 1,
        work_attempt_id: "attempt",
        execution_generation_id: "generation",
        target_room_id: "room",
        target_source_message_id: "1",
        target_provider_continuation_id: "continuation",
        inbox_item_id: item!.inbox_item_id,
        provider_turn_id: "native-1",
        has_correction: true,
        correction_text: "Keep the API unchanged",
        correction_strategy: "native",
        operator_resolution: null,
        status: "uncertain",
        capability: "native_interrupt",
        interrupted: null,
        resumed: null,
        state: null,
        stages: [],
        error: null,
        recorded_at: "2026-09-20T09:00:00.000Z",
        updated_at: "2026-09-20T09:00:00.000Z",
      };
      const writeControl = (control: Record<string, unknown>) => {
        database.prepare(`UPDATE agents SET last_turn_control_sequence=1,
          turn_control_inbox_item_id=?, turn_control_status=?, turn_control_json=?
          WHERE agent_id='stone'`).run(item!.inbox_item_id, String(control.status), JSON.stringify(control));
      };
      writeControl(baseControl);
      assert.equal((await store.detail("stone", "room", "1")).latest_intervention?.status, "uncertain");
      assert.equal((await store.detail("stone", "room", "1")).latest_intervention?.correctionText, "Keep the API unchanged");
      for (const field of [
        "provider_turn_id", "target_source_message_id", "target_room_id",
        "work_attempt_id", "execution_generation_id", "target_provider_continuation_id",
      ]) {
        writeControl({ ...baseControl, [field]: "different" });
        assert.equal((await store.detail("stone", "room", "1")).latest_intervention, null, field);
        writeControl(baseControl);
      }
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("a successful poll exposes received work and observing health in one notification", async () => {
  const env = await fixture();
  let observer: DatabaseSync | null = null;
  const snapshots: Array<{ inboxCount: number; state: string | null; detail: string | null; generation: string | null }> = [];
  const store = new SupervisedAgentInboxStore(
    env.database,
    () => "2026-08-28T00:28:08.282Z",
    () => {
      if (!observer) return;
      const inbox = observer.prepare("SELECT COUNT(*) AS count FROM inbox_items WHERE agent_id=?").get("cloudfern") as Record<string, unknown>;
      const health = observer.prepare("SELECT state,detail,execution_generation_id FROM supervised_agent_ingress_health WHERE agent_id=?").get("cloudfern") as Record<string, unknown> | undefined;
      snapshots.push({
        inboxCount: Number(inbox.count),
        state: health ? String(health.state) : null,
        detail: health?.detail === null || health?.detail === undefined ? null : String(health.detail),
        generation: health ? String(health.execution_generation_id) : null,
      });
    },
  );
  try {
    await store.setIngressHealth({
      agent_id: "cloudfern",
      room_id: "focus_82",
      execution_generation_id: "generation-current",
      state: "backoff",
      detail: "fetch failed",
    });
    observer = new DatabaseSync(env.database);

    await store.ingestSuccessfulPoll({
      agent_id: "cloudfern",
      room_id: "focus_82",
      execution_generation_id: "generation-current",
      last_observed_message_id: "5",
      messages: [{ source_message_id: "5", source_message: { text: "just checking if you are alive" }, activation: {} }],
    });

    assert.deepEqual(snapshots, [{
      inboxCount: 1,
      state: "observing",
      detail: null,
      generation: "generation-current",
    }], "no observer can see the new message paired with the previous backoff state");
  } finally {
    observer?.close();
    await store.close();
    await env.cleanup();
  }
});

test("unchanged empty successful polls preserve durable state without notifications and still validate ingress", async () => {
  const env = await fixture();
  let timestamp = "2026-09-20T00:00:00.000Z";
  const notifications: Array<string | undefined> = [];
  const store = new SupervisedAgentInboxStore(env.database, () => timestamp, (agentId) => notifications.push(agentId));
  let observer: DatabaseSync | undefined;
  const poll = { agent_id: "quiet", room_id: "room", execution_generation_id: "generation",
    last_observed_message_id: "1", expected_cursor: "1", messages: [] };
  try {
    await store.ingestSuccessfulPoll({ ...poll, expected_cursor: null,
      messages: [{ source_message_id: "1", source_message: { text: "retained" }, activation: {} }] });
    assert.deepEqual(notifications, ["quiet"]);
    notifications.length = 0;
    observer = new DatabaseSync(env.database);
    const state = () => ["supervised_agent_ingress_cursors", "supervised_agent_ingress_health", "supervised_agent_history_boundaries"]
      .map((table) => observer!.prepare(`SELECT * FROM ${table}`).all());
    const before = state();
    const version = observer.prepare("PRAGMA data_version").get()!.data_version;
    timestamp = "2026-09-21T00:00:00.000Z";
    for (const cursor of ["1", "0", null]) {
      assert.deepEqual(await store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: cursor }), []);
    }
    assert.deepEqual(state(), before, "idle polling does not rewrite timestamps or prune history boundaries");
    assert.equal(observer.prepare("PRAGMA data_version").get()!.data_version, version, "no SQLite pages changed");
    assert.deepEqual(notifications, []);
    await assert.rejects(store.ingestSuccessfulPoll({ ...poll, expected_cursor: "0" }), /cursor changed/);
    await assert.rejects(store.ingestSuccessfulPoll({ ...poll, room_id: "other" }), /ingress room changed/);
    await assert.rejects(store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: "invalid" }), /numeric room message/);
    assert.deepEqual(notifications, []);

    await store.ingestSuccessfulPoll({ ...poll, execution_generation_id: "replacement" });
    assert.equal((await store.ingressHealth("quiet"))?.execution_generation_id, "replacement");
    assert.deepEqual(notifications, ["quiet"], "generation changes cannot take the no-op path");
    await store.setIngressHealth({ agent_id: "quiet", room_id: "room", execution_generation_id: "replacement", state: "backoff", detail: "retry" });
    notifications.length = 0;
    await store.ingestSuccessfulPoll({ ...poll, execution_generation_id: "replacement" });
    assert.deepEqual(await store.ingressHealth("quiet"), { room_id: "room", execution_generation_id: "replacement", state: "observing", detail: null });
    assert.deepEqual(notifications, ["quiet"], "an empty recovery poll clears backoff and notifies after commit");

    notifications.length = 0;
    await store.ingestSuccessfulPoll({ ...poll, execution_generation_id: "replacement", last_observed_message_id: "502",
      observed_messages: Array.from({ length: 501 }, (_, index) => ({ source_message_id: String(index + 2),
        source_message: {}, activation: {}, activation_decision: "ignore" })) });
    assert.equal((await store.cursor("quiet"))?.last_observed_message_id, "502");
    assert.equal(observer.prepare("SELECT COUNT(*) AS n FROM supervised_agent_observed_messages WHERE agent_id='quiet'").get()!.n, 501,
      "silent growth is pruned to 500 recent observations plus the active message's pinned provenance");
    assert.deepEqual(notifications, ["quiet"]);
  } finally { observer?.close(); await store.close(); await env.cleanup(); }
});

test("new-source observation follows commit and excludes replay, synthetic insertion and rolled-back polls", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database);
  let observer: DatabaseSync | undefined;
  const snapshots: Array<{ ids: string[]; persisted: string[]; cursor: string | null }> = [];
  let throwHint = false;
  const onInserted = (ids: readonly string[]) => {
    snapshots.push({ ids: [...ids],
      persisted: observer!.prepare("SELECT source_message_id FROM inbox_items ORDER BY fifo_sequence").all().map(row => String(row.source_message_id)),
      cursor: observer!.prepare("SELECT last_observed_message_id FROM supervised_agent_ingress_cursors WHERE agent_id='stone'").get()?.last_observed_message_id as string | null });
    if (throwHint) throw new Error("optional observer unavailable");
  };
  const message = (source_message_id: string) => ({ source_message_id, source_message: {}, activation: {} });
  const poll = { agent_id: "stone", room_id: "room", execution_generation_id: "generation", onInserted };
  try {
    await store.bootstrapCursor({ agent_id: "stone", room_id: "room", last_observed_message_id: null });
    observer = new DatabaseSync(env.database);
    await store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: "msg_2", messages: [message("msg_1"), message("noncanonical")],
      observed_messages: [{ ...message("msg_2"), activation_decision: "silent" }] });
    assert.deepEqual(snapshots, [{ ids: ["msg_1", "noncanonical"], persisted: ["msg_1", "noncanonical"], cursor: "msg_2" }],
      "a separate connection sees committed rows/cursor; canonical filtering belongs to the publisher, not ingress");
    await store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: "msg_2", messages: [message("msg_1"), message("noncanonical")] });
    const synthetic = { agent_id: "stone", room_id: "room", ...message("initial"), onInserted };
    await store.enqueueInitialMessage(synthetic);
    await store.enqueueCorrection({ ...synthetic, source_message_id: "correction" });
    assert.equal(snapshots.length, 1, "replay and synthetic routes never reopen attribution");

    throwHint = true;
    await store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: "msg_3", messages: [message("msg_1"), message("msg_3")] });
    assert.deepEqual(snapshots[1], { ids: ["msg_3"], persisted: ["msg_1", "noncanonical", "initial", "correction", "msg_3"], cursor: "msg_3" });
    assert.equal((await store.cursor("stone"))?.last_observed_message_id, "msg_3", "observer failure cannot reject committed ingress");
    await store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: "msg_3", messages: [message("msg_2")] });
    assert.equal(snapshots.length, 2, "an older observed/pruned source is not fresh attribution just because its inbox row was absent");
    assert.ok(observer.prepare("SELECT 1 FROM inbox_items WHERE source_message_id='msg_2'").get(), "observation never changes ingestion behavior");
    observer.exec(`CREATE TRIGGER reject_second_observed_source BEFORE INSERT ON inbox_items
      WHEN NEW.source_message_id='msg_5' BEGIN SELECT RAISE(ABORT,'rejected second source'); END;`);
    await assert.rejects(store.ingestSuccessfulPoll({ ...poll, last_observed_message_id: "msg_5", messages: [message("msg_4"), message("msg_5")] }), /rejected second source/);
    assert.equal(snapshots.length, 2, "even an earlier INSERT in a failed batch cannot publish a hint");
    assert.equal(observer.prepare("SELECT COUNT(*) n FROM inbox_items WHERE source_message_id IN ('msg_4','msg_5')").get()!.n, 0);
    assert.equal((await store.cursor("stone"))?.last_observed_message_id, "msg_3");
  } finally { observer?.close(); await store.close(); await env.cleanup(); }
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

    const { item: reset, attempt } = await store.recordRetryFailure(item!.inbox_item_id, {
      domain: "pre_dispatch", error: "wrapper never started", resetUndispatchedTurnId: "cursor:prepared-only",
    });
    assert.equal(attempt, 1);
    assert.equal(reset.state, "pending");
    assert.equal(reset.provider_turn_id, null);
    assert.equal(reset.attempt_count, 0);
    assert.equal(await store.providerTurnBinding(item!.inbox_item_id), null, "reset removes the exact recovery authority with the turn id");
    assert.equal((await store.claimHead("cursor-agent"))?.inbox_item_id, item!.inbox_item_id);
    await assert.rejects(
      store.recordRetryFailure(item!.inbox_item_id, { domain: "pre_dispatch", error: "wrong turn", resetUndispatchedTurnId: "cursor:different" }),
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
      evidence.prepare(`INSERT INTO effect_tombstones
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "compacted-effect", "cursor-tombstone", "room", TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id,
        "cursor:compacted-effect", "request-1", "send_message", "0".repeat(64), 2, 1, "uncertain", null,
        "The mutating tool may have completed.", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
      );
    } finally { evidence.close(); }

    await assert.rejects(
      store.recordRetryFailure(item!.inbox_item_id, { domain: "pre_dispatch", error: "effect exists", resetUndispatchedTurnId: "cursor:compacted-effect" }),
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
      evidence.prepare(`INSERT INTO effect_tombstones
        (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,
         tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "old-generation-effect", "cursor-reused-turn", "room", "execution-generation-old",
        "cursor:reused-turn", "request-old", "send_message", "0".repeat(64), 2, 1, "uncertain", null,
        "Old generation evidence.", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
      );
    } finally { evidence.close(); }

    const { item: reset } = await store.recordRetryFailure(item!.inbox_item_id, {
      domain: "pre_dispatch", error: "wrapper never started", resetUndispatchedTurnId: "cursor:reused-turn",
    });
    assert.equal(reset.state, "pending");
    assert.equal(reset.provider_turn_id, null);
    assert.equal(reset.attempt_count, 0);
    assert.equal(await store.providerTurnBinding(item!.inbox_item_id), null);
    await store.close();
  } finally { await env.cleanup(); }
});

test("undispatched reset atomically archives an exited lost Cursor runtime and rejects every boundary mismatch without altering authority", async () => {
  const at = "2026-08-02T00:00:00.000Z";
  const atMs = Date.parse(at);

  const seedCase = async (options: {
    agentId: string;
    provider?: "cursor" | "codex";
    runtimeState?: "starting" | "ready" | "exited";
    turnState?: "none" | "active" | "terminal" | "lost";
    sideEffects?: "none" | "possible" | "observed";
    runRoomId?: string;
    runGenerationId?: string;
    runContinuationId?: string;
    runWorkspaceId?: string;
    extraRunOnRuntime?: boolean;
    executionFact?: boolean;
    pendingRecovery?: boolean;
    liveAgentPointsToRuntime?: boolean;
    agentProvider?: "cursor" | "codex";
    agentConnectionJson?: string | null;
    agentExecutionGenerationId?: string | null;
    observerSourceId?: string | null;
    omitObserverSourceRow?: boolean;
    observerMaxSequence?: number;
    observerPendingLifecycleFactId?: string | null;
    terminalResult?: boolean;
    effectRow?: boolean;
    tombstoneRow?: boolean;
    itemOutcome?: string | null;
    priorPreDispatchFailures?: number;
  }) => {
    const env = await fixture();
    const store = new SupervisedAgentInboxStore(env.database, () => at);
    const roomId = "room";
    const workAttemptId = TEST_PROVIDER_TURN_AUTHORITY.work_attempt_id;
    const generationId = TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id;
    const continuationId = TEST_PROVIDER_TURN_AUTHORITY.provider_continuation_id;
    const providerTurnId = `cursor:turn:${options.agentId}`;
    const [item] = await store.ingestPoll({
      agent_id: options.agentId,
      room_id: roomId,
      last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "hello" }, activation: {} }],
    });
    assert.ok(item);
    await store.claimHead(options.agentId);
    await store.checkpointDispatchIntent(item.inbox_item_id);
    await store.checkpointTurnStarted(item.inbox_item_id, providerTurnId, TEST_PROVIDER_TURN_AUTHORITY);

    const db = new DatabaseSync(env.database);
    db.exec("PRAGMA foreign_keys=ON");
    const runGen = options.runGenerationId ?? generationId;
    const runRoom = options.runRoomId ?? roomId;
    const runCont = options.runContinuationId ?? continuationId;
    const runWorkspace = options.runWorkspaceId ?? workAttemptId;
    const runtimeProvider = options.provider ?? "cursor";
    const runtimeState = options.runtimeState ?? "exited";
    const turnState = options.turnState ?? "lost";
    const sideEffects = options.sideEffects ?? "none";
    const birth = { kind: "cursor_cli" as const, pid: 7771, processIdentity: `birth-${options.agentId}` };
    const runtimeId = executionRuntimeStorageIdentity(options.agentId, runGen, birth.kind, birth.pid, birth.processIdentity);
    const attemptId = `attempt-${options.agentId}`;
    const turnRowId = `turn-${options.agentId}`;
    try {
      db.prepare("INSERT OR IGNORE INTO execution_generations VALUES(?,?,?)").run(runGen, options.agentId, atMs);
      db.prepare(`INSERT INTO execution_runtime_generations
        (runtime_generation_id,execution_generation_id,agent_id,provider,authority_mode,runtime_state,control_state,continuation_state,config_revision,created_at_ms,ended_at_ms)
        VALUES(?,?,?,?,'typed',?,'lost','available',1,?,?)`)
        .run(runtimeId, runGen, options.agentId, runtimeProvider, runtimeState, atMs, runtimeState === "exited" ? atMs + 10 : null);
      db.prepare(`INSERT INTO execution_message_attempts(attempt_id,agent_id,room_id,source_message_id,state,created_at_ms)
        VALUES(?,?,?,?,'active',?)`).run(attemptId, options.agentId, runRoom, "1", atMs);
      db.prepare("INSERT INTO execution_attempt_generations VALUES(?,?,?,?,?,?)")
        .run(attemptId, options.agentId, runRoom, runGen, runWorkspace, atMs);
      db.prepare(`INSERT INTO runs
        (turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(turnRowId, attemptId, options.agentId, runRoom, runGen, runtimeId, runCont, providerTurnId,
          turnState, sideEffects, atMs, turnState === "terminal" || turnState === "lost" ? atMs + 5 : null);
      const observerSourceId = options.observerSourceId !== undefined ? options.observerSourceId : `src-${options.agentId}`;
      const observerMaxSeq = options.observerMaxSequence ?? 3;
      const pendingLifecycleFactId = options.observerPendingLifecycleFactId ?? null;
      db.prepare(`INSERT INTO execution_observers
        (agent_id,execution_generation_id,runtime_generation_id,observer_execution_generation_id,observer_runtime_generation_id,daemon_generation_id,observer_epoch,last_source_sequence,max_observed_sequence,recovery_turn_id,bound_at_ms,source_id,pending_lifecycle_fact_id)
        VALUES(?,?,?,?,?,?,1,3,?,NULL,?,?,?)`)
        .run(options.agentId, runGen, runtimeId, runGen, runtimeId, "1", observerMaxSeq, atMs, observerSourceId, pendingLifecycleFactId);
      if (observerSourceId !== null && !options.omitObserverSourceRow) {
        db.prepare("INSERT INTO execution_observer_sources(agent_id,source_id) VALUES(?,?)").run(options.agentId, observerSourceId);
      }
      const connectionJson = options.agentConnectionJson !== undefined
        ? options.agentConnectionJson
        : JSON.stringify(options.liveAgentPointsToRuntime
          ? birth
          : { kind: "cursor_cli", pid: null, processIdentity: null });
      const agentExecGen = options.agentExecutionGenerationId !== undefined ? options.agentExecutionGenerationId : generationId;
      db.prepare(`INSERT INTO agents(agent_id,sort_order,version,created_by,created_at,display_name,room_id,provider,charter,config_revision,runtime_configuration_revision,desired_state,observed_state,condition,work_attempt_id,provider_work_attempt_id,provider_continuation_id,provider_execution_generation_id,provider_connection_json)
        VALUES(?,0,1,'owner',?,'Agent',?,?,'charter',1,1,'running','idle','none',?,?,?,?,?)`)
        .run(options.agentId, at, roomId, options.agentProvider ?? "cursor", workAttemptId, workAttemptId, continuationId, agentExecGen, connectionJson);

      if (options.extraRunOnRuntime) {
        const extraAttempt = `attempt-extra-${options.agentId}`;
        db.prepare(`INSERT INTO execution_message_attempts(attempt_id,agent_id,room_id,source_message_id,state,created_at_ms)
          VALUES(?,?,?,?,'active',?)`).run(extraAttempt, options.agentId, runRoom, "2", atMs);
        db.prepare("INSERT INTO execution_attempt_generations VALUES(?,?,?,?,?,?)")
          .run(extraAttempt, options.agentId, runRoom, runGen, runWorkspace, atMs);
        db.prepare(`INSERT INTO runs
          (turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms)
          VALUES(?,?,?,?,?,?,?,?,'terminal','none',?,?)`)
          .run(`turn-extra-${options.agentId}`, extraAttempt, options.agentId, runRoom, runGen, runtimeId, runCont, "cursor:other-turn", atMs, atMs + 2);
      }
      if (options.executionFact) {
        db.prepare(`INSERT INTO execution_facts
          (fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_execution_generation_id,observer_runtime_generation_id,observer_epoch,source_sequence,turn_id,execution_id,domain,kind,operation,side_effects,observed_at_ms)
          VALUES(?,?,?,?,?,?,1,1,?,'exec-1','execution','started','command','none',?)`)
          .run(`fact-${options.agentId}`, options.agentId, runGen, runtimeId, runGen, runtimeId, turnRowId, atMs + 1);
      }
      if (options.pendingRecovery) {
        db.prepare("INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,'resume','prepared',?,NULL,?,?)")
          .run(`pending-${options.agentId}`, options.agentId, roomId, runGen, runtimeId, JSON.stringify({ work_attempt_id: workAttemptId, execution_generation_id: runGen, provider_continuation_id: runCont, provider_connection: null }), at, at);
      }
      if (options.terminalResult) {
        db.prepare(`INSERT INTO supervised_agent_terminal_results
          (inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at)
          VALUES(?,?,?,?,'no_reply',NULL,'stream','{}',?,?)`)
          .run(item.inbox_item_id, options.agentId, generationId, providerTurnId, at, at);
      }
      if (options.effectRow) {
        seedBoundedMcpEffectRow(db, {
          id: `eff-${options.agentId}`,
          agent_id: options.agentId,
          room_id: roomId,
          execution_generation_id: generationId,
          provider_turn_id: providerTurnId,
          mcp_request_id: "req-1",
          tool_name: "send_message",
          state: "completed",
        });
      }
      if (options.tombstoneRow) {
        db.prepare(`INSERT INTO effect_tombstones
          (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_sha256,request_bytes,mutation,state,result_json,error,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(`tomb-${options.agentId}`, options.agentId, roomId, generationId, providerTurnId, "req-1", "send_message", "0".repeat(64), 2, 1, "uncertain", null, "uncertain", at, at);
      }
      if (options.itemOutcome) {
        db.prepare("UPDATE inbox_items SET outcome=? WHERE inbox_item_id=?").run(options.itemOutcome, item.inbox_item_id);
      }
      for (let i = 1; i <= (options.priorPreDispatchFailures ?? 0); i += 1) {
        db.prepare(`INSERT INTO supervised_agent_inbox_events(inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
          VALUES(?,?,?,?,?,?)`).run(item.inbox_item_id, 100 + i, `retry_failure:pre_dispatch:${i}`, "retry_scheduled", at, `prior ${i}`);
      }
    } finally {
      db.close();
    }
    return { env, store, item, providerTurnId, runtimeId };
  };

  // 1. Happy path: exact exited lost Cursor runtime is atomically archived with the inbox reset.
  {
    const c = await seedCase({ agentId: "cursor-ok" });
    try {
      const { item: reset, attempt } = await c.store.recordRetryFailure(c.item.inbox_item_id, {
        domain: "pre_dispatch", error: "wrapper not started", resetUndispatchedTurnId: c.providerTurnId,
      });
      assert.equal(attempt, 1);
      assert.equal(reset.state, "pending");
      assert.equal(reset.provider_turn_id, null);
      assert.equal(reset.attempt_count, 0);
      assert.equal(await c.store.providerTurnBinding(c.item.inbox_item_id), null);
      const check = new DatabaseSync(c.env.database);
      try {
        const rec = check.prepare("SELECT phase,mode,runtime_generation_id,observer_json FROM agent_runtime_recoveries WHERE agent_id=?")
          .get("cursor-ok") as { phase: string; mode: string; runtime_generation_id: string; observer_json: string | null };
        assert.equal(rec.phase, "complete");
        assert.equal(rec.mode, "resume");
        assert.equal(rec.runtime_generation_id, c.runtimeId);
        assert.equal((JSON.parse(rec.observer_json!) as { observer_epoch: number }).observer_epoch, 1);
        const obs = check.prepare("SELECT observer_epoch FROM execution_observers WHERE agent_id=?").get("cursor-ok") as { observer_epoch: number };
        assert.equal(obs.observer_epoch, 2);
      } finally { check.close(); }
      await c.store.close();
    } finally { await c.env.cleanup(); }
  }

  // 2. Every fail-closed rejection rolls back the entire transaction and preserves original authority untouched.
  const rejections: Array<{ label: string; opts: Parameters<typeof seedCase>[0]; pattern: RegExp; expectPendingCount?: number }> = [
    { label: "runtime not exited (ready)", opts: { agentId: "rej-ready", runtimeState: "ready" }, pattern: /already recorded as exited/ },
    { label: "runtime not exited (starting)", opts: { agentId: "rej-starting", runtimeState: "starting" }, pattern: /already recorded as exited/ },
    { label: "turn active", opts: { agentId: "rej-active", turnState: "active" }, pattern: /lost turn with no recorded side effects/ },
    { label: "turn terminal", opts: { agentId: "rej-terminal", turnState: "terminal" }, pattern: /lost turn with no recorded side effects/ },
    { label: "turn none", opts: { agentId: "rej-none", turnState: "none" }, pattern: /lost turn with no recorded side effects/ },
    { label: "side effects possible", opts: { agentId: "rej-se-possible", sideEffects: "possible" }, pattern: /lost turn with no recorded side effects/ },
    { label: "side effects observed", opts: { agentId: "rej-se-observed", sideEffects: "observed" }, pattern: /lost turn with no recorded side effects/ },
    { label: "recorded execution activity", opts: { agentId: "rej-exec-fact", executionFact: true }, pattern: /recorded execution activity/ },
    { label: "wrong provider (codex run on cursor agent)", opts: { agentId: "rej-codex", provider: "codex", agentProvider: "cursor" }, pattern: /exact bound turn authority/ },
    { label: "wrong generation", opts: { agentId: "rej-gen", runGenerationId: "other-generation" }, pattern: /exact bound turn authority/ },
    { label: "wrong room", opts: { agentId: "rej-room", runRoomId: "other-room" }, pattern: /exact bound turn authority/ },
    { label: "wrong continuation", opts: { agentId: "rej-cont", runContinuationId: "other-continuation" }, pattern: /exact bound turn authority/ },
    { label: "wrong workspace", opts: { agentId: "rej-ws", runWorkspaceId: "other-attempt" }, pattern: /exact bound turn authority/ },
    { label: "second turn on same runtime", opts: { agentId: "rej-extra-run", extraRunOnRuntime: true }, pattern: /carrying another turn/ },
    { label: "pending runtime recovery", opts: { agentId: "rej-pending-rec", pendingRecovery: true }, pattern: /runtime recovery is pending/, expectPendingCount: 1 },
    { label: "live agent still points to runtime", opts: { agentId: "rej-live-ref", liveAgentPointsToRuntime: true }, pattern: /still referenced by the live agent/ },
    { label: "non-cursor agent row with cursor run", opts: { agentId: "rej-agent-provider", agentProvider: "codex", provider: "cursor" }, pattern: /requires a Cursor agent/ },
    { label: "partial non-idle agent connection json", opts: { agentId: "rej-partial-conn", agentConnectionJson: JSON.stringify({ kind: "cursor_cli", pid: 7771, processIdentity: null }) }, pattern: /could not verify the live agent connection/ },
    { label: "empty object agent connection json", opts: { agentId: "rej-empty-conn", agentConnectionJson: "{}" }, pattern: /could not verify the live agent connection/ },
    { label: "live cursor connection missing execution generation", opts: { agentId: "rej-missing-gen", liveAgentPointsToRuntime: true, agentExecutionGenerationId: null }, pattern: /could not verify the live agent connection/ },
    { label: "non-string processIdentity in agent connection json", opts: { agentId: "rej-bad-identity-type", agentConnectionJson: JSON.stringify({ kind: "cursor_cli", pid: 7771, processIdentity: 123 }) }, pattern: /could not verify the live agent connection/ },
    { label: "gapped execution observer", opts: { agentId: "rej-gapped-obs", observerMaxSequence: 5 }, pattern: /incomplete or unverified observer/ },
    { label: "null source_id execution observer", opts: { agentId: "rej-null-src", observerSourceId: null }, pattern: /incomplete or unverified observer/ },
    { label: "unverified source_id missing from observer sources", opts: { agentId: "rej-unverified-src", omitObserverSourceRow: true }, pattern: /incomplete or unverified observer/ },
    { label: "pending lifecycle projection on observer", opts: { agentId: "rej-pending-lifecycle", observerPendingLifecycleFactId: "fact-pending" }, pattern: /incomplete or unverified observer/ },
    { label: "terminal result present", opts: { agentId: "rej-term-res", terminalResult: true }, pattern: /terminal or effect evidence/ },
    { label: "effect row present", opts: { agentId: "rej-effect", effectRow: true }, pattern: /terminal or effect evidence/ },
    { label: "effect tombstone present", opts: { agentId: "rej-tomb", tombstoneRow: true }, pattern: /terminal or effect evidence/ },
    { label: "inbox outcome present", opts: { agentId: "rej-outcome", itemOutcome: JSON.stringify({ kind: "no_reply" }) }, pattern: /terminal or effect evidence/ },
  ];

  for (const { label, opts, pattern, expectPendingCount = 0 } of rejections) {
    const c = await seedCase(opts);
    try {
      await assert.rejects(
        c.store.recordRetryFailure(c.item.inbox_item_id, {
          domain: "pre_dispatch", error: `reject ${label}`, resetUndispatchedTurnId: c.providerTurnId,
        }),
        pattern,
        label,
      );
      const preserved = await c.store.get(c.item.inbox_item_id);
      assert.equal(preserved?.state, "dispatching", `${label}: inbox state unchanged`);
      assert.equal(preserved?.provider_turn_id, c.providerTurnId, `${label}: provider_turn_id preserved`);
      assert.equal(preserved?.attempt_count, 1, `${label}: attempt_count preserved`);
      assert.ok(await c.store.providerTurnBinding(c.item.inbox_item_id), `${label}: turn binding preserved`);

      const check = new DatabaseSync(c.env.database);
      try {
        const recCount = Number((check.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=?").get(opts.agentId) as { n: number }).n);
        assert.equal(recCount, expectPendingCount, `${label}: no recovery row written`);
        const obsEpoch = Number((check.prepare("SELECT observer_epoch FROM execution_observers WHERE agent_id=?").get(opts.agentId) as { observer_epoch: number }).observer_epoch);
        assert.equal(obsEpoch, 1, `${label}: observer_epoch unchanged`);
        const rtState = String((check.prepare("SELECT runtime_state FROM execution_runtime_generations WHERE runtime_generation_id=?").get(c.runtimeId) as { runtime_state: string }).runtime_state);
        assert.equal(rtState, opts.runtimeState ?? "exited", `${label}: runtime_state never mutated`);
      } finally { check.close(); }
      await c.store.close();
    } finally { await c.env.cleanup(); }
  }

  // 3. Consistent non-Cursor agent + run skips Cursor archival cleanly and still resets to pending.
  {
    const c = await seedCase({
      agentId: "codex-undispatched",
      provider: "codex",
      agentProvider: "codex",
      runtimeState: "ready",
      turnState: "none",
      agentConnectionJson: JSON.stringify({ kind: "codex_app_server", pid: 7771, processIdentity: "birth-codex-undispatched" }),
    });
    try {
      const { item: reset, attempt } = await c.store.recordRetryFailure(c.item.inbox_item_id, {
        domain: "pre_dispatch", error: "codex turn never dispatched", resetUndispatchedTurnId: c.providerTurnId,
      });
      assert.equal(attempt, 1);
      assert.equal(reset.state, "pending");
      assert.equal(reset.provider_turn_id, null);
      assert.equal(reset.attempt_count, 0);
      assert.equal(await c.store.providerTurnBinding(c.item.inbox_item_id), null);
      const check = new DatabaseSync(c.env.database);
      try {
        const recCount = Number((check.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=?").get("codex-undispatched") as { n: number }).n);
        assert.equal(recCount, 0, "non-Cursor reset writes no Cursor recovery boundary");
        const obsEpoch = Number((check.prepare("SELECT observer_epoch FROM execution_observers WHERE agent_id=?").get("codex-undispatched") as { observer_epoch: number }).observer_epoch);
        assert.equal(obsEpoch, 1, "non-Cursor reset leaves observer_epoch untouched");
      } finally { check.close(); }
      await c.store.close();
    } finally { await c.env.cleanup(); }
  }

  // 4. Exhausted 3rd pre-dispatch failure moves to blocked without archiving or deleting the binding.
  {
    const c = await seedCase({ agentId: "cursor-exhausted", priorPreDispatchFailures: 2 });
    try {
      const { item: blocked, attempt } = await c.store.recordRetryFailure(c.item.inbox_item_id, {
        domain: "pre_dispatch", error: "wrapper failed third time", resetUndispatchedTurnId: c.providerTurnId,
      });
      assert.equal(attempt, 3);
      assert.equal(blocked.state, "blocked");
      assert.equal(blocked.provider_turn_id, c.providerTurnId);
      assert.ok(await c.store.providerTurnBinding(c.item.inbox_item_id), "exhausted failure preserves binding");
      const check = new DatabaseSync(c.env.database);
      try {
        const recCount = Number((check.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=?").get("cursor-exhausted") as { n: number }).n);
        assert.equal(recCount, 0, "exhausted failure does not archive without reset");
      } finally { check.close(); }
      await c.store.close();
    } finally { await c.env.cleanup(); }
  }
});

test("pre-dispatch, exact-result recovery, and publication have independent durable retry budgets", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database);
  try {
    const [item] = await store.ingestPoll({ agent_id: "domains", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await store.claimHead("domains");
      await assert.rejects(store.recordRetryFailure(item!.inbox_item_id, { domain: "result_recovery", error: "no native turn" }), /exact provider-turn authority/);
      await assert.rejects(store.recordRetryFailure(item!.inbox_item_id, { domain: "publication", error: "no saved answer" }), /publishing inbox item with its saved reply/);
      const failure = await store.recordRetryFailure(item!.inbox_item_id, { domain: "pre_dispatch", error: "setup unavailable" });
      assert.equal(failure.attempt, attempt);
      assert.equal(failure.item.state, "retryable");
      assert.equal(failure.item.attempt_count, 0);
      await store.transition(item!.inbox_item_id, "pending");
    }
    await store.claimHead("domains");
    await store.checkpointTurnStarted(item!.inbox_item_id, "exact-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await assert.rejects(store.recordRetryFailure(item!.inbox_item_id, { domain: "pre_dispatch", error: "must not replay" }), /unstarted dispatch/);
    const binding = await store.providerTurnBinding(item!.inbox_item_id);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const failure = await store.recordRetryFailure(item!.inbox_item_id, { domain: "result_recovery", error: "read failed" });
      assert.equal(failure.attempt, attempt, "a recovered exact turn can still be in dispatching state");
      assert.equal(failure.item.state, "retryable");
      assert.equal(failure.item.attempt_count, 1);
      assert.deepEqual(await store.providerTurnBinding(item!.inbox_item_id), binding);
      await store.transition(item!.inbox_item_id, "pending");
      await store.claimHead("domains");
    }
    await store.checkpointNormalizedTerminal({ inbox_item_id: item!.inbox_item_id, agent_id: "domains",
      execution_generation_id: TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id,
      provider_turn_id: "exact-turn", outcome: "reply", text: "Saved answer", evidence: "stream", terminal_evidence: {} });
    await assert.rejects(store.recordRetryFailure(item!.inbox_item_id, { domain: "result_recovery", error: "cleanup failed" }), /Accepted terminal completion/);
    const saved = await store.get(item!.inbox_item_id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await store.transition(item!.inbox_item_id, "awaiting_result");
      await store.transition(item!.inbox_item_id, "publishing");
      const failure = await store.recordRetryFailure(item!.inbox_item_id, { domain: "publication", error: "network unavailable" });
      assert.equal(failure.attempt, attempt);
      assert.equal(failure.item.state, attempt === 3 ? "blocked" : "retryable");
      assert.equal(failure.item.outcome, saved!.outcome);
      assert.equal(failure.item.reply_client_message_id, item!.reply_client_message_id);
      assert.equal(failure.item.attempt_count, 1);
      if (attempt < 3) {
        await store.transition(item!.inbox_item_id, "pending");
        await store.claimHead("domains");
      }
    }
  } finally { await store.close(); await env.cleanup(); }
});

for (const domain of ["pre_dispatch", "result_recovery", "publication"] as const) {
  test(`${domain} retry retains conservative legacy debt without charging other known domains or bookkeeping`, async () => {
    const env = await fixture();
    const store = new SupervisedAgentInboxStore(env.database);
    try {
      const [item] = await store.ingestPoll({ agent_id: "legacy", room_id: "room", last_observed_message_id: "1",
        messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
      await store.claimHead("legacy");
      if (domain !== "pre_dispatch") {
        await store.checkpointTurnStarted(item!.inbox_item_id, "exact-turn", TEST_PROVIDER_TURN_AUTHORITY);
        await store.transition(item!.inbox_item_id, "awaiting_result", domain === "publication"
          ? { outcome: JSON.stringify({ kind: "reply", text: "Saved legacy reply" }) } : {});
        await store.transition(item!.inbox_item_id, domain === "publication" ? "publishing" : "result_recovery");
      }
      const database = new DatabaseSync(env.database);
      try {
        const insert = database.prepare(`INSERT INTO supervised_agent_inbox_events
          (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail) VALUES (?,?,?,'retry_scheduled',?,?)`);
        for (const [index, key] of ["retry_scheduled:1", "undispatched_retry:2:old-turn", "result_recovery_retry:3", "room_move_rollback:op:1"].entries()) {
          insert.run(item!.inbox_item_id, index + 100, key, "2026-08-31T00:00:00.000Z", "Misleading publication prose must not decide the domain.");
        }
        database.prepare(`INSERT INTO supervised_agent_inbox_events
          (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail) VALUES (?,200,'handoff_queued:1','queued',?,NULL)`)
          .run(item!.inbox_item_id, "2026-08-31T00:00:00.000Z");
      } finally { database.close(); }
      const failure = await store.recordRetryFailure(item!.inbox_item_id, { domain, error: "unavailable" });
      assert.equal(failure.attempt, domain === "publication" ? 2 : 3);
      assert.equal(failure.item.state, domain === "publication" ? "retryable" : "blocked");
      assert.equal(failure.item.provider_turn_id, domain === "pre_dispatch" ? null : "exact-turn");
    } finally { await store.close(); await env.cleanup(); }
  });
}

test("retry exhaustion rolls back atomically and retains the exact undispatched binding on the third failure", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database);
  try {
    const [item] = await store.ingestPoll({ agent_id: "atomic-retry", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await store.claimHead("atomic-retry");
      await store.checkpointTurnStarted(item!.inbox_item_id, `wrapper-${attempt}`, TEST_PROVIDER_TURN_AUTHORITY);
      const failure = await store.recordRetryFailure(item!.inbox_item_id, {
        domain: "pre_dispatch", error: "not dispatched", resetUndispatchedTurnId: `wrapper-${attempt}`,
      });
      assert.equal(failure.attempt, attempt);
      assert.equal(failure.item.state, "pending");
      assert.equal(failure.item.attempt_count, 0);
    }
    await store.claimHead("atomic-retry");
    await store.checkpointTurnStarted(item!.inbox_item_id, "wrapper-3", TEST_PROVIDER_TURN_AUTHORITY);
    const before = await store.get(item!.inbox_item_id);
    const binding = await store.providerTurnBinding(item!.inbox_item_id);
    const database = new DatabaseSync(env.database);
    try {
      database.exec(`CREATE TRIGGER reject_retry_exhaustion BEFORE INSERT ON supervised_agent_inbox_events
        WHEN NEW.phase='blocked' BEGIN SELECT RAISE(ABORT, 'injected exhaustion failure'); END`);
      await assert.rejects(store.recordRetryFailure(item!.inbox_item_id, {
        domain: "pre_dispatch", error: "not dispatched", resetUndispatchedTurnId: "wrapper-3",
      }), /injected exhaustion failure/);
      assert.deepEqual(await store.get(item!.inbox_item_id), before);
      assert.deepEqual(await store.providerTurnBinding(item!.inbox_item_id), binding);
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox_events
        WHERE inbox_item_id=? AND idempotency_key GLOB 'retry_failure:pre_dispatch:*'`).get(item!.inbox_item_id) as { count: number }).count, 2);
      database.exec("DROP TRIGGER reject_retry_exhaustion");
    } finally { database.close(); }
    const exhausted = await store.recordRetryFailure(item!.inbox_item_id, {
      domain: "pre_dispatch", error: "not dispatched", resetUndispatchedTurnId: "wrapper-3",
    });
    assert.equal(exhausted.attempt, 3);
    assert.equal(exhausted.item.state, "blocked");
    assert.equal(exhausted.item.provider_turn_id, "wrapper-3");
    assert.equal(exhausted.item.attempt_count, 1);
    assert.deepEqual(await store.providerTurnBinding(item!.inbox_item_id), binding);
    await store.retryBlocked(item!.inbox_item_id);
    await store.claimHead("atomic-retry");
    const manualFailure = await store.recordRetryFailure(item!.inbox_item_id, {
      domain: "pre_dispatch", error: "operator retry also failed", resetUndispatchedTurnId: "wrapper-3",
    });
    assert.equal(manualFailure.attempt, 4, "manual retry permits another real attempt without forgetting prior debt");
    assert.equal(manualFailure.item.state, "blocked");
  } finally { await store.close(); await env.cleanup(); }
});

test("result-recovery debt survives a truncated receipt timeline and database reopen", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database);
  let reopened: SupervisedAgentInboxStore | null = null;
  try {
    const [item] = await store.ingestPoll({ agent_id: "retry-history", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.claimHead("retry-history");
    await store.checkpointTurnStarted(item!.inbox_item_id, "exact-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "result_recovery");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const failure = await store.recordRetryFailure(item!.inbox_item_id, { domain: "result_recovery", error: "read failed" });
      assert.equal(failure.attempt, attempt);
      assert.equal(failure.item.state, "result_recovery");
    }
    const database = new DatabaseSync(env.database);
    try {
      const insert = database.prepare(`INSERT INTO supervised_agent_inbox_events
        (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail) VALUES (?,?,?,'conversation_restoring',?,NULL)`);
      for (let index = 0; index < 80; index += 1) {
        insert.run(item!.inbox_item_id, index + 100, `noise:${index}`, "2026-08-31T00:00:00.000Z");
      }
    } finally { database.close(); }
    await store.pruneHistory("retry-history");
    assert.equal((await store.receipts("retry-history"))[0]!.timeline.length, 64);
    assert.equal((await store.receipts("retry-history"))[0]!.timeline.some((event) => event.phase === "retry_scheduled"), false);
    await store.close();
    reopened = new SupervisedAgentInboxStore(env.database);
    await reopened.pruneHistory("retry-history");
    const exhausted = await reopened.recordRetryFailure(item!.inbox_item_id, { domain: "result_recovery", error: "read still failed" });
    assert.equal(exhausted.attempt, 3);
    assert.equal(exhausted.item.state, "blocked");
    assert.equal(exhausted.item.provider_turn_id, "exact-turn");
    assert.equal(exhausted.item.attempt_count, 1);
  } finally { await reopened?.close(); await store.close(); await env.cleanup(); }
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

test("payload-free receipt projections preserve ordering, terminal bounds, blocked causality and timelines", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database);
  let raw: DatabaseSync | undefined;
  try {
    const items = await store.ingestPoll({ agent_id: "projection", room_id: "room", last_observed_message_id: "205",
      messages: Array.from({ length: 205 }, (_, index) => ({ source_message_id: String(index + 1),
        source_message: { text: "payload".repeat(300) }, activation: { for_current_agent: true } })) });
    raw = new DatabaseSync(env.database);
    raw.prepare("UPDATE inbox_items SET state='acknowledged_no_reply' WHERE agent_id='projection' AND fifo_sequence<=203").run();
    raw.prepare("UPDATE inbox_items SET state='blocked',last_error='blocked' WHERE inbox_item_id=?").run(items[203]!.inbox_item_id);
    raw.prepare("INSERT INTO supervised_agent_publications VALUES(?,?,?,?,?,?)").run(items[202]!.inbox_item_id, "projection", "room", "reply-203", "canonical-203", "2026-09-20T00:00:00Z");
    const event = raw.prepare("INSERT INTO supervised_agent_inbox_events VALUES(?,?,?,'queued',?,?)");
    for (let index = 3; index <= 82; index += 1) event.run(items[203]!.inbox_item_id, index, `extra-${index}`, "2026-09-20T00:00:00Z", `event-${index}`);
    for (const [limit, count] of [[0, 2], [2, 4], [500, 202]]) {
      const full = await store.receipts("projection", limit);
      const projected = await store.receiptProjection("projection", limit);
      assert.deepEqual(projected, full.map(({ source_message: _source, activation: _activation, ...metadata }) => metadata));
      assert.equal(projected.length, count);
      assert.equal(projected.at(-1)?.receipt_state, "queued_behind_blocked");
      assert.equal(projected.at(-1)?.blocked_by_inbox_item_id, items[203]!.inbox_item_id);
      assert.equal(projected.at(-2)?.timeline.length, 64);
      assert.equal(projected.at(-2)?.timeline[0]?.event_sequence, 19);
      if (limit! > 0) assert.equal(projected.find(item => item.fifo_sequence === 203)?.canonical_message_id, "canonical-203");
      assert.ok(full.every(item => typeof item.source_message === "object" && item.activation.for_current_agent === true));
    }
    const before = await store.receiptProjection("projection");
    raw.prepare("UPDATE inbox_items SET source_message_json='invalid-json',activation_json='invalid-json' WHERE agent_id='projection'").run();
    assert.deepEqual(await store.receiptProjection("projection"), before, "projection does not load or parse either payload column");
    await assert.rejects(store.receipts("projection"), SyntaxError, "the operational full receipt reader retains its payload contract");
    raw.prepare("UPDATE inbox_items SET last_error='current error' WHERE inbox_item_id=?").run(items[203]!.inbox_item_id);
    assert.equal((await store.receiptProjection("projection")).at(-2)?.last_error, "current error", "prepared reads return current rows");
  } finally { raw?.close(); await store.close(); await env.cleanup(); }
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

test("every re-block within one attempt is journaled, after trimmed history and after restarts", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const blockedEvents = async (agent: string) => (await store.receipts(agent))[0]!.timeline.filter((event) => event.phase === "blocked").length;

    // Retry re-reads the same turn; retention may already have trimmed older events.
    await store.ingestPoll({ agent_id: "reread", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    const item = (await store.claimHead("reread"))!;
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-1", TEST_PROVIDER_TURN_AUTHORITY);
    const reblock = async () => {
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, "result_recovery", { last_error: "Re-reading the same completed turn." });
      await store.transition(item.inbox_item_id, "blocked", { last_error: "Still unreadable; not rerun." });
    };
    await reblock();
    await store.retryBlocked(item.inbox_item_id); await store.claimHead("reread"); await reblock();
    assert.equal(await blockedEvents("reread"), 2);
    const trim = new DatabaseSync(env.database);
    trim.prepare(`DELETE FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='blocked'
      AND event_sequence=(SELECT MIN(event_sequence) FROM supervised_agent_inbox_events WHERE inbox_item_id=? AND phase='blocked')`)
      .run(item.inbox_item_id, item.inbox_item_id);
    trim.close();
    await store.retryBlocked(item.inbox_item_id); await store.claimHead("reread"); await reblock();
    assert.equal(await blockedEvents("reread"), 2, "the third block is kept although an older one was trimmed");

    // Startup recovery blocks the same unstarted dispatch twice within attempt 0.
    await store.ingestPoll({ agent_id: "restarts", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    const restarted = (await store.claimHead("restarts"))!;
    await store.normalizeStartupRecovery("restarts");
    await store.retryBlocked(restarted.inbox_item_id); await store.claimHead("restarts");
    await store.normalizeStartupRecovery("restarts");
    assert.equal((await store.get(restarted.inbox_item_id))?.state, "blocked");
    assert.equal(await blockedEvents("restarts"), 2);
    await store.normalizeStartupRecovery("restarts");
    assert.equal(await blockedEvents("restarts"), 2, "a row left blocked is not journaled again");

    // A row that stays in result_recovery across two restarts is one fact, journaled once.
    await store.ingestPoll({ agent_id: "rereading", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    const rereading = (await store.claimHead("rereading"))!;
    await store.checkpointTurnStarted(rereading.inbox_item_id, "turn-1", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(rereading.inbox_item_id, "awaiting_result");
    await store.transition(rereading.inbox_item_id, "result_recovery", { last_error: "Re-reading the same completed turn." });
    await store.normalizeStartupRecovery("rereading");
    await store.normalizeStartupRecovery("rereading");
    const recoveryEvents = (await store.receipts("rereading"))[0]!.timeline
      .filter((event) => event.phase === "result_unreadable" && /no new model turn will start/.test(event.detail ?? ""));
    assert.equal(recoveryEvents.length, 1);
    await store.close();
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

test("a started message can be skipped once its turn is finished or belongs to a replaced conversation", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const seed = (agentId: string, providerContinuationId: string) => seedActiveAgent(env, { agentId, roomId: "room",
      workAttemptId: TEST_PROVIDER_TURN_AUTHORITY.work_attempt_id, executionGenerationId: "generation-2", providerContinuationId });
    const ingest = (agent: string, ids: string[]) => store.ingestPoll({ agent_id: agent, room_id: "room", last_observed_message_id: ids.at(-1)!,
      messages: ids.map((id) => ({ source_message_id: id, source_message: {}, activation: {} })) });
    const startBlocked = async (agent: string, id: string, terminal: "unreadable" | "reply" | null) => {
      const item = (await store.claimHead(agent))!;
      assert.equal(item.source_message_id, id);
      await store.checkpointTurnStarted(item.inbox_item_id, `turn-${id}`, TEST_PROVIDER_TURN_AUTHORITY);
      if (terminal) {
        await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: agent,
          execution_generation_id: TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id, provider_turn_id: `turn-${id}`,
          outcome: terminal, text: terminal === "reply" ? "Saved answer" : null, evidence: terminal === "reply" ? "stream" : "none", terminal_evidence: {} });
      }
      await store.transition(item.inbox_item_id, "awaiting_result");
      await store.transition(item.inbox_item_id, terminal === "reply" ? "publishing" : "result_recovery");
      return store.transition(item.inbox_item_id, "blocked", { last_error: "The same turn was re-read and was not rerun." });
    };

    // The field case: the model finished with no readable answer, then the
    // agent was paused and resumed, so a new runtime generation owns it.
    const [, next] = await ingest("finished", ["1", "2"]);
    await seed("finished", TEST_PROVIDER_TURN_AUTHORITY.provider_continuation_id);
    const finished = await startBlocked("finished", "1", "unreadable");
    assert.deepEqual(await store.blockedHeadSkip("finished"), { inbox_item_id: finished.inbox_item_id, refusal: null });
    const skipped = await store.skipBlocked(finished.inbox_item_id);
    assert.equal(skipped.state, "cancelled_by_user");
    assert.match(skipped.last_error ?? "", /not rerun and its answer was dropped/);
    const event = (await store.receipts("finished"))[0]!.timeline.at(-1)!;
    assert.equal(event.phase, "user_cancelled");
    assert.match(event.detail ?? "", /not rerun/);
    assert.equal((await store.claimHead("finished"))?.inbox_item_id, next!.inbox_item_id);
    await assert.rejects(store.retryBlocked(finished.inbox_item_id), /Invalid supervised inbox transition/);

    // Retry and Skip on the same blocked head: exactly one of them applies.
    await ingest("race", ["1"]);
    const raced = await startBlocked("race", "1", "unreadable");
    const outcomes = await Promise.allSettled([store.retryBlocked(raced.inbox_item_id), store.skipBlocked(raced.inbox_item_id)]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal((await store.get(raced.inbox_item_id))?.state, "pending", "the first serialized request wins");

    // No terminal result: skippable only once the agent's own runtime record
    // shows the conversation that ran it was replaced.
    await ingest("unsettled", ["1"]);
    const unsettled = await startBlocked("unsettled", "1", null);
    const running = /provider work may already have started and may still be running.*Retry delivery.*Start fresh/;
    await assert.rejects(store.skipBlocked(unsettled.inbox_item_id), running, "no runtime record proves nothing");
    await seed("unsettled", TEST_PROVIDER_TURN_AUTHORITY.provider_continuation_id);
    assert.match((await store.blockedHeadSkip("unsettled"))?.refusal ?? "", running);
    await assert.rejects(store.skipBlocked(unsettled.inbox_item_id), running);
    await seed("unsettled", "replacement-continuation");
    assert.equal((await store.blockedHeadSkip("unsettled"))?.refusal, null);
    assert.equal((await store.skipBlocked(unsettled.inbox_item_id)).state, "cancelled_by_user");

    // A saved reply is posted by Retry, never dropped by Skip.
    await ingest("saved", ["1"]);
    await seed("saved", "replacement-continuation");
    const saved = await startBlocked("saved", "1", "reply");
    assert.match((await store.blockedHeadSkip("saved"))?.refusal ?? "", /saved reply/);
    await assert.rejects(store.skipBlocked(saved.inbox_item_id), /saved reply/);
    assert.equal((await store.get(saved.inbox_item_id))?.state, "blocked");

    // A stop or correction that is still settling this message owns it.
    await ingest("stopping", ["1"]);
    await seed("stopping", TEST_PROVIDER_TURN_AUTHORITY.provider_continuation_id);
    const stopping = await startBlocked("stopping", "1", "unreadable");
    const journal = new DatabaseSync(env.database);
    journal.prepare(`UPDATE agents SET turn_control_inbox_item_id=?, turn_control_status='dispatching',
      turn_control_json=? WHERE agent_id=?`)
      .run(stopping.inbox_item_id, JSON.stringify({ action_id: "stop-1", status: "dispatching", inbox_item_id: stopping.inbox_item_id }), "stopping");
    await assert.rejects(store.skipBlocked(stopping.inbox_item_id), /stop or correction for this message is still being settled/);
    journal.prepare("UPDATE agents SET turn_control_inbox_item_id=NULL, turn_control_status=NULL, turn_control_json=NULL WHERE agent_id=?").run("stopping");
    journal.close();
    assert.equal((await store.skipBlocked(stopping.inbox_item_id)).state, "cancelled_by_user");

    // Only the FIFO head can be skipped, even if a later row reads as blocked.
    const [head, later] = await ingest("head", ["1", "2"]);
    await store.transition((await store.claimHead("head"))!.inbox_item_id, "blocked", { last_error: "blocked head" });
    const corrupt = new DatabaseSync(env.database);
    corrupt.prepare("UPDATE inbox_items SET state='blocked' WHERE inbox_item_id=?").run(later!.inbox_item_id);
    corrupt.close();
    await assert.rejects(store.skipBlocked(later!.inbox_item_id), /Only the current FIFO head/);
    assert.equal((await store.get(head!.inbox_item_id))?.state, "blocked");
    await store.close();
  } finally { await env.cleanup(); }
});

test("Skip on a follow-up says that it was skipped only when no turn started for it; a follow-up that started keeps the text of a started turn", async () => {
  const SKIPPED = "You skipped the next attempt, and the task and its work lease are left as they are.";
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const ingest = (agent: string, id: string) => store.ingestPoll({ agent_id: agent, room_id: "room", last_observed_message_id: "9",
      messages: [{ source_message_id: id, source_message: {}, activation: {} }] });
    // A follow-up that was blocked and never started, and a room message that was blocked and never started.
    const [unstarted] = await ingest("unstarted", "task-continuation:parent");
    await store.transition(unstarted!.inbox_item_id, "blocked", { last_error: "The model provider needs authentication or account access." });
    assert.equal((await store.skipBlocked(unstarted!.inbox_item_id)).last_error, SKIPPED);
    const [message] = await ingest("message", "msg_1");
    await store.transition(message!.inbox_item_id, "blocked", { last_error: "safe pre-turn failure" });
    assert.equal((await store.skipBlocked(message!.inbox_item_id)).last_error, null, "a room message that never started has no text, as before");

    // A follow-up whose turn finished, and whose answer is dropped by Skip. It runs as an ordinary item, and has the id of a follow-up
    // by the time that it is skipped: a follow-up cannot be claimed without the record of the failure that it follows.
    await ingest("started", "1");
    await seedActiveAgent(env, { agentId: "started", roomId: "room", workAttemptId: TEST_PROVIDER_TURN_AUTHORITY.work_attempt_id,
      executionGenerationId: "generation-2", providerContinuationId: TEST_PROVIDER_TURN_AUTHORITY.provider_continuation_id });
    const item = (await store.claimHead("started"))!;
    await store.checkpointTurnStarted(item.inbox_item_id, "turn-started", TEST_PROVIDER_TURN_AUTHORITY);
    await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: "started",
      execution_generation_id: TEST_PROVIDER_TURN_AUTHORITY.origin_execution_generation_id, provider_turn_id: "turn-started",
      outcome: "unreadable", text: null, evidence: "none", terminal_evidence: {} });
    await store.transition(item.inbox_item_id, "awaiting_result");
    await store.transition(item.inbox_item_id, "result_recovery");
    await store.transition(item.inbox_item_id, "blocked", { last_error: "The same turn was re-read and was not rerun." });
    const raw = new DatabaseSync(env.database);
    raw.prepare("UPDATE inbox_items SET source_message_id='task-continuation:parent' WHERE inbox_item_id=?").run(item.inbox_item_id);
    raw.close();
    const skipped = await store.skipBlocked(item.inbox_item_id);
    assert.equal(skipped.source_message_id, "task-continuation:parent");
    assert.match(skipped.last_error ?? "", /not rerun and its answer was dropped/);
    assert.notEqual(skipped.last_error, SKIPPED, "a turn started, so \"the agent did not try again\" would be untrue");
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
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id='bounded-skip' AND state='cancelled_by_user'`).get() as { count: number }).count), 200);
    assert.ok(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM supervised_agent_inbox_events e
      JOIN inbox_items i USING (inbox_item_id) WHERE i.agent_id='bounded-skip'`).get() as { count: number }).count) <= 800);
    assert.equal(inspection.prepare("SELECT 1 FROM inbox_items WHERE inbox_item_id=?").get(oldest), undefined);
    assert.ok(inspection.prepare("SELECT 1 FROM inbox_items WHERE inbox_item_id=?").get(newest));
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
    // Delivery also normalizes whenever one agent's lane restarts, with the daemon still running.
    assert.equal(recovered?.last_error, "Room delivery restarted while awaiting the exact persisted provider turn; recovering it without rerunning.");

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

test("exact native failures settle without replay and preserve terminal winners across restart", async () => {
  for (const kind of ["failed", "interrupted"] as const) {
    for (const winner of ["failure", "reply", "no_reply", "stop", "transition"] as const) {
      const env = await fixture();
      let store = new SupervisedAgentInboxStore(env.database);
      try {
        const [item, tail] = await store.ingestPoll({ agent_id: "native", room_id: "room", last_observed_message_id: "2",
          messages: ["1", "2"].map((source_message_id) => ({ source_message_id, source_message: {}, activation: {} })) });
        await store.claimHead("native");
        await store.checkpointTurnStarted(item!.inbox_item_id, "native-turn", TEST_PROVIDER_TURN_AUTHORITY);
        const failureDetail = "Provider rejected this turn.";
        const proof = { turnId: "native-turn", providerContinuationId: "continuation", outcome: kind, text: null, evidence: "stream", error: failureDetail };
        const checkpoint = { inbox_item_id: item!.inbox_item_id, agent_id: "native", execution_generation_id: "generation",
          provider_turn_id: "native-turn", outcome: kind, text: null, evidence: "stream" as const,
          failure_detail: failureDetail, terminal_evidence: proof };
        await assert.rejects(() => store.transition(item!.inbox_item_id, "acknowledged_failed"), /exact native terminal/);
        await assert.rejects(() => store.checkpointTerminalOutcome(item!.inbox_item_id, JSON.stringify({ kind })), /exact terminal checkpoint/);
        await assert.rejects(() => store.checkpointNormalizedTerminal({ ...checkpoint, terminal_evidence: { ...proof, providerContinuationId: "wrong" } }), /exact continuation/);
        await assert.rejects(() => store.checkpointNormalizedTerminal({ ...checkpoint, evidence: "none" }), /exact continuation/);
        await assert.rejects(() => store.checkpointNormalizedTerminal({ ...checkpoint, execution_generation_id: "other-generation" }), /authority binding/);
        if (winner === "reply" || winner === "no_reply") {
          await store.checkpointNormalizedTerminal({ ...checkpoint, outcome: winner,
            text: winner === "reply" ? "saved reply" : null, failure_detail: null, terminal_evidence: {} });
          await store.checkpointNormalizedTerminal(checkpoint);
          assert.equal(await store.nativeFailure(item!.inbox_item_id), null);
          assert.equal(JSON.parse((await store.get(item!.inbox_item_id))!.outcome!).kind, winner);
          continue;
        }
        await store.checkpointNormalizedTerminal(checkpoint);
        await store.checkpointNormalizedTerminal(checkpoint);
        await assert.rejects(() => store.checkpointNormalizedTerminal({ ...checkpoint, outcome: "reply", text: "late reply", failure_detail: null }), /already accepted/);
        await assert.rejects(() => store.transition(item!.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "spoof" }) }), /overwritten/);
        await assert.rejects(() => store.checkpointTerminalOutcome(item!.inbox_item_id, JSON.stringify({ kind: "no_reply" })), /overwritten/);
        await assert.rejects(() => store.transition(item!.inbox_item_id, "acknowledged_failed", { last_error: null }), /unchanged exact native terminal/);
        if (winner === "stop") {
          const settled = await store.cancelInterruptedTurn(item!.inbox_item_id);
          assert.equal(settled?.state, "acknowledged_failed");
          assert.equal(settled?.last_error, failureDetail);
        } else if (winner === "transition") {
          const settled = await store.transition(item!.inbox_item_id, "acknowledged_failed", { last_error: "Provider rejected this turn." });
          assert.equal(settled.state, "acknowledged_failed");
          assert.equal(settled.last_error, "Provider rejected this turn.");
        }
        await store.close(); store = new SupervisedAgentInboxStore(env.database);
        await store.normalizeStartupRecovery("native");
        const recoveredFailure = await store.get(item!.inbox_item_id);
        assert.equal(recoveredFailure?.state, "acknowledged_failed");
        assert.equal(recoveredFailure?.last_error, failureDetail);
        assert.equal(await store.nativeFailure(item!.inbox_item_id), kind);
        assert.equal((await store.head("native"))?.inbox_item_id, tail!.inbox_item_id);
        assert.equal((await store.cursor("native"))?.last_observed_message_id, "2");
        const events = (await store.receipts("native"))[0]!.timeline;
        assert.equal(events.filter((event) => event.phase === "turn_finished").length, 1);
        assert.equal(events.some((event) => ["published", "no_reply", "user_cancelled"].includes(event.phase)), false);
        assert.deepEqual(await store.normalizeStartupRecovery("native"), []);
      } finally { await store.close(); await env.cleanup(); }
    }
  }
});

test("inconsistent native failure journals refuse recovery and Stop without changing delivery", async () => {
  for (const kind of ["failed", "interrupted"] as const) {
    for (const corruption of ["null", "malformed", "unreadable", "reply", "missing_binding", "wrong_binding", "null_and_missing_binding"] as const) {
      const env = await fixture(); let store = new SupervisedAgentInboxStore(env.database);
      const database = new DatabaseSync(env.database);
      try {
        const [item] = await store.ingestPoll({ agent_id: "native", room_id: "room", last_observed_message_id: "1",
          messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
        await store.claimHead("native");
        await store.checkpointTurnStarted(item!.inbox_item_id, "native-turn", TEST_PROVIDER_TURN_AUTHORITY);
        await store.checkpointNormalizedTerminal({ inbox_item_id: item!.inbox_item_id, agent_id: "native",
          execution_generation_id: "generation", provider_turn_id: "native-turn", outcome: kind, text: null, evidence: "stream",
          terminal_evidence: { turnId: "native-turn", providerContinuationId: "continuation", outcome: kind, text: null, evidence: "stream" } });
        if (["null", "malformed", "unreadable", "reply", "null_and_missing_binding"].includes(corruption)) {
          const outcome = corruption === "malformed" ? "{" : corruption === "reply" || corruption === "unreadable"
            ? JSON.stringify({ kind: corruption, text: corruption === "reply" ? "must not publish" : null, evidence: "stream" }) : null;
          database.prepare("UPDATE inbox_items SET outcome=? WHERE inbox_item_id=?").run(outcome, item!.inbox_item_id);
        }
        if (corruption === "missing_binding" || corruption === "null_and_missing_binding") {
          database.prepare("DELETE FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").run(item!.inbox_item_id);
        } else if (corruption === "wrong_binding") {
          database.prepare("UPDATE supervised_agent_provider_turn_bindings SET provider_continuation_id='other' WHERE inbox_item_id=?").run(item!.inbox_item_id);
        }
        const before = database.prepare("SELECT * FROM inbox_items WHERE inbox_item_id=?").get(item!.inbox_item_id);
        await assert.rejects(() => store.nativeFailure(item!.inbox_item_id), /exact native terminal/);
        await assert.rejects(() => store.cancelInterruptedTurn(item!.inbox_item_id), /exact native terminal/);
        await assert.rejects(() => store.normalizeStartupRecovery("native"), /exact native terminal/);
        await store.close(); store = new SupervisedAgentInboxStore(env.database);
        await assert.rejects(() => store.normalizeStartupRecovery("native"), /exact native terminal/, `${kind}:${corruption}`);
        assert.deepEqual(database.prepare("SELECT * FROM inbox_items WHERE inbox_item_id=?").get(item!.inbox_item_id), before);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM supervised_agent_publications").get()?.n, 0);
      } finally { database.close(); await store.close(); await env.cleanup(); }
    }
  }
});

test("failed receipts retain bounded history without hiding uncertain partial mutations", async () => {
  const env = await fixture(); const store = new SupervisedAgentInboxStore(env.database);
  try {
    const items = await store.ingestPoll({ agent_id: "native", room_id: "room", last_observed_message_id: "202",
      messages: Array.from({ length: 202 }, (_, index) => ({ source_message_id: String(index + 1), source_message: {}, activation: {} })) });
    await seedActiveAgent(env, { agentId: "native", roomId: "room", workAttemptId: "attempt", executionGenerationId: "generation", providerContinuationId: "continuation" });
    for (const [index, item] of items.entries()) {
      await store.claimHead("native");
      const turnId = `native-${index}`;
      await store.checkpointTurnStarted(item.inbox_item_id, turnId, TEST_PROVIDER_TURN_AUTHORITY);
      if (index === 201) {
        const request = { agent_id: "native", room_id: "room", work_attempt_id: "attempt", execution_generation_id: "generation",
          current_execution_generation_id: "generation", provider_continuation_id: "continuation", provider_turn_id: turnId,
          mcp_request_id: "partial-mutation", tool_name: "send_message", request: { text: "partially applied" } };
        const prepared = await store.prepareEffect(request);
        await store.markEffectExecuting({ ...request, effect_id: prepared.effect.effect_id });
      }
      await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: "native", execution_generation_id: "generation",
        provider_turn_id: turnId, outcome: "failed", text: null, evidence: "stream",
        terminal_evidence: { turnId, providerContinuationId: "continuation", outcome: "failed", text: null, evidence: "stream" } });
      await store.transition(item.inbox_item_id, "acknowledged_failed");
    }
    assert.equal(await store.head("native"), null);
    assert.equal((await store.receipts("native")).length, 200);
    const database = new DatabaseSync(env.database);
    try {
      assert.equal(database.prepare("SELECT state FROM effects WHERE kind='bounded_mcp_effect' AND json_extract(payload,'$.mcp_request_id')='partial-mutation'").get()?.state, "executing");
      await store.normalizeStartupRecovery("native");
      assert.equal(database.prepare("SELECT state FROM effects WHERE kind='bounded_mcp_effect' AND json_extract(payload,'$.mcp_request_id')='partial-mutation'").get()?.state, "uncertain");
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM supervised_agent_terminal_results").get()?.n, 200);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM supervised_agent_publications").get()?.n, 0);
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
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
  let inbox = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T12:30:00.000Z");
  const manifest = new ManifestStore(env.database);
  try {
    await seedActiveAgent(env, {
      agentId: "bounded-move", roomId: "old-room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation",
    });
    const generation = 1;
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
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id='bounded-move' AND state='cancelled_by_room_move'`).get() as { count: number }).count), 205,
    "nonterminal move authority may temporarily exceed receipt history because every row is rollback state");
    const noisyItem = inspection.prepare("SELECT inbox_item_id FROM inbox_items WHERE agent_id='bounded-move' ORDER BY fifo_sequence DESC LIMIT 1").get()!;
    const addNoise = inspection.prepare(`INSERT INTO supervised_agent_inbox_events
      VALUES (?,?,?,'conversation_restoring','2026-08-05T12:30:00.000Z',NULL)`);
    for (let index = 0; index < 100; index++) addNoise.run(String(noisyItem.inbox_item_id), index + 100, `move-noise:${index}`);
    inspection.close();
    await inbox.pruneHistory("bounded-move");
    await inbox.close();
    inbox = new SupervisedAgentInboxStore(env.database);
    await inbox.pruneHistory("bounded-move");

    assert.equal(await inbox.rollbackRoomMoveIngress({
      operation_id: "move-rollback", agent_id: "bounded-move", source_room_id: "old-room", destination_room_id: "new-room",
      source_cursor_present: false, source_cursor: null, after_fifo_sequence: 0,
    }), 205, "all compensation rows survive long enough to be restored");
    await manifest.advanceRoomMove({
      operationId: "move-rollback", agentId: "bounded-move", expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: "generation", from: ["membership_committed"], to: "failed",
    });
    inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id='bounded-move' AND state='pending'`).get() as { count: number }).count), 205);
    inspection.close();

    await prepareMove("move-success", "final-room");
    assert.equal(await inbox.commitRoomMoveQueue({
      operation_id: "move-success", agent_id: "bounded-move", old_room_id: "old-room", after_fifo_sequence: 0,
    }), 205);
    inspection = new DatabaseSync(env.database);
    const settledNoise = inspection.prepare(`INSERT INTO supervised_agent_inbox_events
      VALUES (?,?,?,'conversation_restoring','2026-08-05T12:30:00.000Z',NULL)`);
    for (let index = 0; index < 100; index++) settledNoise.run(String(noisyItem.inbox_item_id), index + 1000, `settled-move-noise:${index}`);
    inspection.close();
    await manifest.advanceRoomMove({
      operationId: "move-success", agentId: "bounded-move", expectedDaemonGeneration: generation,
      expectedExecutionGenerationId: "generation", from: ["membership_committed"], to: "active",
    });
    inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id='bounded-move' AND state='cancelled_by_room_move'`).get() as { count: number }).count), 200,
    "terminal move release converges compensation rows to the ordinary history budget");
    await inbox.pruneHistory("bounded-move");
    await inbox.pruneHistory("bounded-move");
    assert.equal(inspection.prepare(`SELECT COUNT(*) AS n FROM supervised_agent_inbox_events
      WHERE inbox_item_id=? AND idempotency_key GLOB 'room_move_cancelled:move-success:*'`).get(String(noisyItem.inbox_item_id))!.n, 1);
    assert.ok(Number(inspection.prepare("SELECT COUNT(*) AS n FROM supervised_agent_inbox_events WHERE inbox_item_id=?")
      .get(String(noisyItem.inbox_item_id))!.n) <= RETAINED_TERMINAL_TIMELINE_EVENTS + 3);
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
        LEFT JOIN inbox_items inbox ON inbox.inbox_item_id=events.inbox_item_id
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

test("inspector detail isolates unavailable optional execution capture from operational evidence", async () => {
  const env = await fixture(); const store = new SupervisedAgentInboxStore(env.database);
  try {
    const [item] = await store.ingestPoll({ agent_id: "detail", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { id: "1", text: "retained message" }, activation: {} }] });
    const before = await store.detail("detail", "room", "1");
    assert.deepEqual(before.recorded_execution, { availability: "not_captured" });
    assert.equal(before.runtime_control, null);
    assert.equal((await store.detail("detail", "room", "missing")).recorded_execution, undefined);
    const database = new DatabaseSync(env.database);
    try {
      database.exec("PRAGMA foreign_keys=ON");
      await store.transition(item!.inbox_item_id, "dispatching");
      const started = await store.checkpointTurnStarted(item!.inbox_item_id, "native-turn", TEST_PROVIDER_TURN_AUTHORITY);
      captureReceipt(database, started);
      const capture = new ExecutionShadowStore(database);
      const runtime = "captured-runtime:detail:generation";
      const observer = capture.bindObserver({ agentId: "detail", subjectRuntimeGenerationId: runtime, observerRuntimeGenerationId: runtime,
        daemonGenerationId: "daemon", sourceId: "source", expectedEpoch: 0, boundAtMs: 100 });
      capture.ingest("source", observer, { factId: "start", agentId: "detail", executionGenerationId: "generation", runtimeGenerationId: runtime,
        observerEpoch: 1, sourceSequence: 1, observedAtMs: 101, domain: "turn", kind: "state_changed", state: "active", sideEffects: "none",
        turnId: `captured-turn:${item!.inbox_item_id}`, providerContinuationId: "continuation", providerTurnId: "native-turn" });
      capture.ingest("source", observer, { factId: "control", agentId: "detail", executionGenerationId: "generation", runtimeGenerationId: runtime,
        observerEpoch: 1, sourceSequence: 2, observedAtMs: 102, domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" });
      const captured = await store.detail("detail", "room", "1", {
        executionGenerationId: "generation", runtimeGenerationId: runtime, daemonGenerationId: "daemon",
      });
      assert.deepEqual(captured.runtime_control, {
        control_state: "responsive", runtime_state: "ready", observed_at: "1970-01-01T00:00:00.102Z",
        execution_generation_id: "generation", daemon_generation_id: "daemon", runtime_generation_id: runtime,
      });
      assert.deepEqual(captured.recorded_execution, { availability: "available", truncated: false, evidenceIncomplete: false,
        turns: [{ turnId: `captured-turn:${item!.inbox_item_id}`, state: "active", outcome: null, operations: [] }] });
      assert.equal((await store.detail("detail", "room", "1", {
        executionGenerationId: "replacement", runtimeGenerationId: runtime, daemonGenerationId: "daemon",
      })).runtime_control, null, "a replaced provider runtime cannot project historical control health");
      assert.equal((await store.detail("detail", "room", "1", {
        executionGenerationId: "generation", runtimeGenerationId: runtime, daemonGenerationId: "replacement-daemon",
      })).runtime_control, null, "a prior daemon generation cannot project historical control health");
      assert.equal((await store.detail("detail", "room", "1", null)).runtime_control, null,
        "a manifest without a current provider birth cannot project historical control health");
      database.prepare("UPDATE execution_observers SET max_observed_sequence=last_source_sequence+1 WHERE agent_id=?").run("detail");
      assert.equal((await store.detail("detail", "room", "1", {
        executionGenerationId: "generation", runtimeGenerationId: runtime, daemonGenerationId: "daemon",
      })).runtime_control, null, "an observer with an uncommitted source frontier cannot project health");
      database.prepare("UPDATE execution_observers SET max_observed_sequence=last_source_sequence WHERE agent_id=?").run("detail");
      database.prepare("UPDATE execution_runtime_generations SET runtime_state='exited',ended_at_ms=created_at_ms+1 WHERE runtime_generation_id=?").run(runtime);
      assert.equal((await store.detail("detail", "room", "1", null)).runtime_control, null,
        "an idle provider with no current process does not expose its prior child exit as current health");
      database.exec("DROP TABLE execution_facts");
      const after = await store.detail("detail", "room", "1");
      assert.deepEqual(after, { ...captured, runtime_control: null, recorded_execution: { availability: "unavailable" } });
    } finally { database.close(); }
  } finally { await store.close(); await env.cleanup(); }
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
      const state = (effectId: string) => (inspection.prepare("SELECT state FROM effects WHERE id=?").get(effectId) as { state: string }).state;
      assert.equal(state(restartReadEffect.effect.effect_id), "prepared");
      assert.equal(state(restartMutationEffect.effect.effect_id), "uncertain");
    } finally { inspection.close(); }
    await store.close();
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
      assert.equal((compacted.prepare("SELECT COUNT(*) AS count FROM effects WHERE agent_id=? AND state='uncertain'")
        .get(base.agent_id) as { count: number }).count, 32, "only the Inspector diagnostic window retains full rows");
      assert.equal((compacted.prepare("SELECT COUNT(*) AS count FROM effect_tombstones WHERE agent_id=?")
        .get(base.agent_id) as { count: number }).count, 1, "request 1 retains a compact durable identity");
      assert.equal((compacted.prepare(`SELECT COUNT(*) AS count FROM (
          SELECT id AS effect_id FROM effects
          WHERE agent_id=? AND kind='bounded_mcp_effect'
            AND json_extract(payload,'$.execution_generation_id')=?
            AND json_extract(payload,'$.provider_turn_id')=?
          UNION ALL
          SELECT effect_id FROM effect_tombstones
          WHERE agent_id=? AND execution_generation_id=? AND provider_turn_id=?
        )`).get(
        base.agent_id, base.execution_generation_id, base.provider_turn_id,
        base.agent_id, base.execution_generation_id, base.provider_turn_id,
      ) as { count: number }).count, requests.length,
      "compaction preserves the same identities counted by bounded per-turn effect admission");
      assert.equal(compacted.prepare("SELECT 1 FROM effects WHERE id=?").get(effects[0]!.effect_id), undefined);
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
      assert.equal((terminalAuthority.prepare("SELECT COUNT(*) AS count FROM effect_tombstones WHERE effect_id=?")
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
      assert.equal((bounded.prepare("SELECT COUNT(*) AS count FROM effects WHERE agent_id=? AND state='uncertain'")
        .get("uncertain-budget") as { count: number }).count, 0);
      assert.equal((bounded.prepare("SELECT COUNT(*) AS count FROM effect_tombstones WHERE agent_id=?")
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
    const checkPreparedOutcome = new DatabaseSync(env.database);
    try {
      assert.throws(
        () => checkPreparedOutcome.prepare("UPDATE effects SET outcome='{\"staged\":true}' WHERE id=?").run(effects[6]!.effect_id),
        /CHECK constraint failed|invalid/i,
        "unified effects schema forbids storing an outcome on a prepared effect",
      );
    } finally { checkPreparedOutcome.close(); }

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

for (const writeFailure of [false, true]) test(`terminal receipt settlement does not require a live observer (write failure: ${writeFailure})`, async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const outcomes = ["failed", "interrupted", "cancelled_by_user", "no_reply", "reply"] as const;
    const items = await store.ingestPoll({ agent_id: "captured-no-observer", room_id: "room", last_observed_message_id: "5",
      messages: outcomes.map((_, index) => ({ source_message_id: String(index + 1), source_message: {}, activation: {} })) });
    database = new DatabaseSync(env.database);
    if (writeFailure) database.exec(`CREATE TRIGGER reject_optional_terminal_settlement BEFORE UPDATE ON execution_message_attempts
      BEGIN SELECT RAISE(ABORT,'optional projection unavailable'); END`);
    for (const [index, outcome] of outcomes.entries()) {
      const attempt = await completeCapturedReceipt(store, database, items[index]!, outcome, "before");
      assert.equal((await store.get(items[index]!.inbox_item_id))?.state,
        outcome === "reply" ? "acknowledged" : outcome === "no_reply" ? "acknowledged_no_reply" : outcome === "cancelled_by_user" ? "cancelled_by_user" : "acknowledged_failed");
      assert.equal(database.prepare("SELECT conclusion FROM execution_message_attempts WHERE attempt_id=?").get(attempt)!.conclusion,
        writeFailure ? null : outcome === "reply" ? "replied" : outcome === "no_reply" ? "acknowledged_no_reply" : outcome === "cancelled_by_user" ? "interrupted" : outcome,
      "the terminal transaction settles captured history without a scheduled callback");
    }
    assert.equal(await store.head("captured-no-observer"), null, "optional write failure cannot hold the operational FIFO");
    if (writeFailure) database.exec("DROP TRIGGER reject_optional_terminal_settlement");
  } finally { database?.close(); await store.close(); await env.cleanup(); }
});

test("captured receipt settlement accepts typed authority mode and rejects non-typed modes", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const [item] = await store.ingestPoll({ agent_id: "captured-authority", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    database = new DatabaseSync(env.database);
    const attempt = await completeCapturedReceipt(store, database, item!, "no_reply", "before");
    const readAttempt = () => ({ ...database!.prepare("SELECT state,conclusion FROM execution_message_attempts WHERE attempt_id=?").get(attempt) });
    const resetAttempt = database.prepare("UPDATE execution_message_attempts SET state='active',conclusion=NULL,settled_at_ms=NULL WHERE attempt_id=?");
    const setAuthorityMode = database.prepare(`UPDATE execution_runtime_generations SET authority_mode=?
      WHERE runtime_generation_id=(SELECT runtime_generation_id FROM runs WHERE attempt_id=?)`);
    assert.deepEqual(readAttempt(),
      { state: "cleanly_concluded", conclusion: "acknowledged_no_reply" });
    assert.throws(() => setAuthorityMode.run("unsupported_mode", attempt), /CHECK constraint failed/i);
    resetAttempt.run(attempt);
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-authority"),
      { lastFifoSequence: 1, hasMore: false, unavailable: false, changed: true });
    assert.deepEqual(readAttempt(),
      { state: "cleanly_concluded", conclusion: "acknowledged_no_reply" });
  } finally { database?.close(); await store.close(); await env.cleanup(); }
});

for (const writeFailure of [false, true]) test(`captured attempt settlement precedes receipt pruning without blocking it (write failure: ${writeFailure})`, async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const items = await store.ingestPoll({ agent_id: "captured-retention", room_id: "room", last_observed_message_id: "201",
      messages: Array.from({ length: 201 }, (_, index) => ({ source_message_id: String(index + 1), source_message: { text: "private input" }, activation: {} })) });
    database = new DatabaseSync(env.database);
    const first = await completeCapturedReceipt(store, database, items[0]!, "reply");
    assert.equal(database.prepare("SELECT state FROM execution_message_attempts WHERE attempt_id=?").get(first)!.state, "active",
      "late capture must still exercise the final pre-prune checkpoint");
    if (writeFailure) {
      database.exec(`CREATE TRIGGER reject_optional_settlement BEFORE UPDATE ON execution_message_attempts
        BEGIN SELECT RAISE(ABORT,'optional projection unavailable'); END`);
      assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-retention"),
        { lastFifoSequence: null, hasMore: false, unavailable: true, changed: false });
    }
    for (const item of items.slice(1)) await completeCapturedReceipt(store, database, item);
    assert.equal(await store.get(items[0]!.inbox_item_id), null, "receipt retention still prunes the oldest row");
    assert.equal((await store.receipts("captured-retention")).length, 200);
    assert.equal(database.prepare("SELECT 1 FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(items[0]!.inbox_item_id), undefined);
    assert.equal(database.prepare("SELECT 1 FROM supervised_agent_provider_turn_bindings WHERE inbox_item_id=?").get(items[0]!.inbox_item_id), undefined);
    assert.deepEqual({ ...database.prepare("SELECT state,conclusion FROM execution_message_attempts WHERE attempt_id=?").get(first) },
      writeFailure ? { state: "active", conclusion: null } : { state: "cleanly_concluded", conclusion: "replied" });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()!.count, 0, "receipt settlement never invents native facts");
    assert.ok(!JSON.stringify(database.prepare("SELECT * FROM execution_message_attempts").all()).includes("private"));
    if (writeFailure) database.exec("DROP TRIGGER reject_optional_settlement");
  } finally { database?.close(); await store.close(); await env.cleanup(); }
});

test("captured receipt settlement batches advance past invalid proof without crossing exact identities", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const items = await store.ingestPoll({ agent_id: "captured-batch", room_id: "room", last_observed_message_id: "35",
      messages: Array.from({ length: 35 }, (_, index) => ({ source_message_id: String(index + 1), source_message: {}, activation: {} })) });
    database = new DatabaseSync(env.database);
    const attempts: string[] = [];
    for (const item of items) attempts.push(await completeCapturedReceipt(store, database, item,
      item.source_message_id === "5" ? "reply" : item.source_message_id === "6" ? "failed" : "no_reply"));
    database.prepare("UPDATE execution_attempt_generations SET workspace_id='other-workspace' WHERE attempt_id=?").run(attempts[0]!);
    database.prepare("UPDATE supervised_agent_provider_turn_bindings SET origin_execution_generation_id='other-generation' WHERE inbox_item_id=?").run(items[1]!.inbox_item_id);
    database.prepare("UPDATE runs SET provider_continuation_id='other-continuation' WHERE attempt_id=?").run(attempts[2]!);
    database.prepare("UPDATE inbox_items SET terminal_reason='upgrade_authority_unavailable' WHERE inbox_item_id=?").run(items[3]!.inbox_item_id);
    database.prepare("DELETE FROM supervised_agent_publications WHERE inbox_item_id=?").run(items[4]!.inbox_item_id);
    database.prepare("UPDATE supervised_agent_terminal_results SET terminal_evidence_json='{}' WHERE inbox_item_id=?").run(items[5]!.inbox_item_id);
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-batch"), { lastFifoSequence: 32, hasMore: true, unavailable: true, changed: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM execution_message_attempts WHERE state='cleanly_concluded'").get()!.count, 26);
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-batch", { afterFifoSequence: 32 }),
      { lastFifoSequence: 35, hasMore: false, unavailable: false, changed: true });
    for (const attempt of attempts.slice(0, 6)) assert.equal(database.prepare("SELECT state FROM execution_message_attempts WHERE attempt_id=?").get(attempt)!.state, "active");
    const before = database.prepare("SELECT * FROM execution_message_attempts ORDER BY attempt_id").all();
    assert.deepEqual(settleCapturedExecutionAttempts(database, "wrong-agent", { inboxItemId: items[5]!.inbox_item_id }),
      { lastFifoSequence: null, hasMore: false, unavailable: false, changed: false });
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-batch", { afterFifoSequence: 35 }),
      { lastFifoSequence: null, hasMore: false, unavailable: false, changed: false });
    assert.deepEqual(database.prepare("SELECT * FROM execution_message_attempts ORDER BY attempt_id").all(), before);
  } finally { database?.close(); await store.close(); await env.cleanup(); }
});

test("captured attempt conclusions preserve native failures, cancellation, no-reply and caller rollback", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const outcomes = ["failed", "interrupted", "cancelled_by_user", "no_reply", "reply"] as const;
    const items = await store.ingestPoll({ agent_id: "captured-outcomes", room_id: "room", last_observed_message_id: "5",
      messages: outcomes.map((_, index) => ({ source_message_id: String(index + 1), source_message: {}, activation: {} })) });
    database = new DatabaseSync(env.database);
    for (const [index, outcome] of outcomes.entries()) await completeCapturedReceipt(store, database, items[index]!, outcome);
    const receipts = database.prepare("SELECT * FROM inbox_items ORDER BY fifo_sequence").all();
    database.exec(`CREATE TRIGGER reject_second_optional_settlement BEFORE UPDATE ON execution_message_attempts
      WHEN NEW.source_message_id='2' AND EXISTS (
        SELECT 1 FROM execution_message_attempts WHERE source_message_id='1' AND conclusion='failed'
      ) BEGIN SELECT RAISE(ABORT,'second optional write rejected after first settled'); END`);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("UPDATE inbox_items SET last_error=? WHERE inbox_item_id=?")
      .run("caller mutation survives", items[0]!.inbox_item_id);
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-outcomes"),
      { lastFifoSequence: null, hasMore: false, unavailable: true, changed: false });
    assert.equal(database.isTransaction, true, "a statement abort must preserve the caller transaction");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM execution_message_attempts WHERE state='active'").get()!.count, 5,
      "the second update's abort must roll back the successful first projection update too");
    database.exec("COMMIT");
    assert.equal(database.prepare("SELECT last_error FROM inbox_items WHERE inbox_item_id=?").get(items[0]!.inbox_item_id)!.last_error,
      "caller mutation survives");
    database.prepare("UPDATE inbox_items SET last_error=? WHERE inbox_item_id=?")
      .run(receipts[0]!.last_error, items[0]!.inbox_item_id);
    database.exec("DROP TRIGGER reject_second_optional_settlement");

    database.exec(`CREATE TRIGGER rollback_optional_settlement BEFORE UPDATE ON execution_message_attempts
      WHEN NEW.source_message_id='2' AND EXISTS (
        SELECT 1 FROM execution_message_attempts WHERE source_message_id='1' AND conclusion='failed'
      ) BEGIN SELECT RAISE(ROLLBACK,'optional write destroyed caller transaction'); END`);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("UPDATE inbox_items SET last_error=? WHERE inbox_item_id=?")
      .run("caller mutation must roll back", items[0]!.inbox_item_id);
    assert.throws(() => {
      settleCapturedExecutionAttempts(database!, "captured-outcomes");
      database!.prepare("UPDATE inbox_items SET last_error=? WHERE inbox_item_id=?")
        .run("must never commit in autocommit mode", items[1]!.inbox_item_id);
    }, /optional write destroyed caller transaction/);
    assert.equal(database.isTransaction, false, "SQLite rolled back the entire transaction");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM execution_message_attempts WHERE state='active'").get()!.count, 5);
    assert.deepEqual(database.prepare("SELECT * FROM inbox_items ORDER BY fifo_sequence").all(), receipts,
      "transaction loss must propagate before any subsequent authoritative mutation");
    database.exec("DROP TRIGGER rollback_optional_settlement");

    database.exec("BEGIN IMMEDIATE");
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-outcomes"),
      { lastFifoSequence: 5, hasMore: false, unavailable: false, changed: true });
    assert.equal(database.isTransaction, true, "optional helper cannot commit its caller's transaction");
    database.exec("ROLLBACK");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM execution_message_attempts WHERE state='active'").get()!.count, 5);
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-outcomes"),
      { lastFifoSequence: 5, hasMore: false, unavailable: false, changed: true });
    assert.deepEqual(database.prepare("SELECT conclusion FROM execution_message_attempts ORDER BY source_message_id").all().map((row) => row.conclusion),
      ["failed", "interrupted", "interrupted", "acknowledged_no_reply", "replied"]);
    const settled = database.prepare("SELECT * FROM execution_message_attempts ORDER BY attempt_id").all();
    assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-outcomes"),
      { lastFifoSequence: null, hasMore: false, unavailable: false, changed: false });
    assert.deepEqual(database.prepare("SELECT * FROM execution_message_attempts ORDER BY attempt_id").all(), settled);
    assert.deepEqual(database.prepare("SELECT * FROM inbox_items ORDER BY fifo_sequence").all(), receipts);
    database.close();
    database = new DatabaseSync(env.database);
    assert.deepEqual(database.prepare("SELECT * FROM execution_message_attempts ORDER BY attempt_id").all(), settled);
  } finally { database?.close(); await store.close(); await env.cleanup(); }
});

test("captured settlement does not conclude publishing, blocked or compensatable room-move receipts", async () => {
  const env = await fixture();
  const store = new SupervisedAgentInboxStore(env.database, () => "2026-08-05T17:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const [item] = await store.ingestPoll({ agent_id: "captured-unsettled", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.transition(item!.inbox_item_id, "dispatching");
    const started = await store.checkpointTurnStarted(item!.inbox_item_id, "native:1", TEST_PROVIDER_TURN_AUTHORITY);
    database = new DatabaseSync(env.database);
    const attempt = captureReceipt(database, started);
    for (const state of ["publishing", "blocked", "result_recovery", "cancelled_by_room_move"]) {
      database.prepare("UPDATE inbox_items SET state=? WHERE inbox_item_id=?").run(state, item!.inbox_item_id);
      assert.deepEqual(settleCapturedExecutionAttempts(database, "captured-unsettled", { inboxItemId: item!.inbox_item_id }),
        { lastFifoSequence: null, hasMore: false, unavailable: false, changed: false });
      assert.equal(database.prepare("SELECT state FROM execution_message_attempts WHERE attempt_id=?").get(attempt)!.state, "active");
    }
  } finally { database?.close(); await store.close(); await env.cleanup(); }
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
        journal.prepare(`UPDATE agents SET last_turn_control_sequence=1,
          turn_control_inbox_item_id=?, turn_control_status='completed', turn_control_json=?
          WHERE agent_id=?`).run(
          item.inbox_item_id,
          JSON.stringify({
            action_id: "completed-control", action_sequence: 1, work_attempt_id: "attempt",
            execution_generation_id: "run-completed", target_room_id: "room",
            target_source_message_id: item.source_message_id, target_provider_continuation_id: "continuation",
            inbox_item_id: item.inbox_item_id, provider_turn_id: providerTurnId,
            has_correction: false, correction_text: null, correction_strategy: null,
            operator_resolution: null, status: "completed", capability: "native_interrupt",
            interrupted: true, resumed: false, state: null, stages: [], error: null,
            recorded_at: "2026-08-05T17:30:00.000Z", updated_at: "2026-08-05T17:30:00.000Z",
          }),
          "completed-retention",
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
    assert.equal((inspection.prepare(`SELECT COUNT(*) AS count FROM effects
      WHERE agent_id='unresolved-retention' AND state IN ('prepared','executing')`).get() as { count: number }).count, 128);
    assert.equal((inspection.prepare(`SELECT COUNT(*) AS count FROM effects
      WHERE agent_id='completed-retention'`).get() as { count: number }).count, 200,
    "completed effects are pruned with the same retained receipt scope");
    assert.equal(inspection.prepare("PRAGMA foreign_key_check").get(), undefined);
    assert.doesNotThrow(() => new DaemonStateSchema().createSchema(inspection),
      "retention cannot detach a completed turn-control journal from its exact inbox binding on reopen");
    assert.ok(inspection.prepare(`SELECT 1 FROM supervised_agent_provider_turn_bindings
      WHERE inbox_item_id=?`).get(completedItems[0]!.inbox_item_id),
    "the pinned receipt keeps its exact provider-turn authority binding");
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
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id='effect-unpin'`).get() as { count: number }).count), 328,
    "executing effects intentionally pin their terminal receipts above ordinary history retention");
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM effects
      WHERE agent_id='effect-unpin' AND state='executing'`).get() as { count: number }).count), 128);
    inspection.close();

    for (const effect of executing) {
      await store.completeEffect({
        effect_id: effect.effectId!, result: { completed: true },
        expected: { agent_id: "effect-unpin", work_attempt_id: "attempt", provider_turn_id: effect.providerTurnId },
      });
    }
    inspection = new DatabaseSync(env.database);
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM inbox_items
      WHERE agent_id='effect-unpin'`).get() as { count: number }).count), 200,
    "the final unpin transaction converges immediately to the exact receipt budget");
    assert.equal(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM effects
      WHERE agent_id='effect-unpin' AND state IN ('prepared','executing')`).get() as { count: number }).count), 0);
    assert.ok(Number((inspection.prepare(`SELECT COUNT(*) AS count FROM effects
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
    await manifest.write(current.entries.map((candidate) => candidate.id === "stop-race"
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
    const completedId = concurrent[0]!.effect.effect_id;
    legacy.prepare("DELETE FROM effects WHERE id=?").run(completedId);
    seedBoundedMcpEffectRow(legacy, {
      id: completedId,
      agent_id: authority.agent_id,
      room_id: authority.room_id,
      execution_generation_id: authority.execution_generation_id,
      provider_turn_id: authority.provider_turn_id,
      mcp_request_id: concurrent[0]!.effect.mcp_request_id,
      tool_name: "complete_room_turn",
      request: completion,
      mutation: true,
      state: "executing",
      retryable: true,
      max_attempts: 8,
      attempt_count: 1,
    });
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
    const read = await store.prepareEffect({
      ...authority, mcp_request_id: "oversized-read", tool_name: "get_board",
      request: {}, mutation: false,
    });
    await store.markEffectExecuting({ effect_id: read.effect.effect_id, ...authority });
    await assert.rejects(store.prepareEffect({
      ...authority, mcp_request_id: "completion-too-early", tool_name: "complete_room_turn",
      request: { outcome: "no_reply" }, mutation: true,
    }), /cannot complete while an earlier effect is still executing/i,
    "completion cannot claim to be the last action while an earlier effect is across its execution boundary");
    const legacy = new DatabaseSync(env.database);
    seedBoundedMcpEffectRow(legacy, {
      id: "legacy-completion",
      agent_id: authority.agent_id,
      room_id: authority.room_id,
      execution_generation_id: authority.execution_generation_id,
      provider_turn_id: authority.provider_turn_id,
      mcp_request_id: "legacy-completion-request",
      tool_name: "complete_room_turn",
      request: { outcome: "no_reply" },
      mutation: true,
      state: "executing",
      retryable: true,
      max_attempts: 8,
      attempt_count: 1,
      created_at: "2026-08-05T13:12:00.000Z",
      updated_at: "2026-08-05T13:12:00.000Z",
    });
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
    const read = await store.prepareEffect({
      ...base, mcp_request_id: "large-board-read", tool_name: "get_board", request: {}, mutation: false,
    });
    await store.markEffectExecuting({ effect_id: read.effect.effect_id, ...base });
    await store.checkpointTerminalOutcome(item!.inbox_item_id, JSON.stringify({ kind: "reply", text: "answer" }));
    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "publishing");
    await store.checkpointPublication({
      inbox_item_id: item!.inbox_item_id, room_id: "room", canonical_message_id: "published-answer",
    });

    assert.equal((await store.prepareEffect({
      ...base, mcp_request_id: "use-final", tool_name: "send_message", request: { reply_to: "1", text: "answer" },
    })).effect.state, "failed");
    assert.equal((await store.prepareEffect({
      ...base, mcp_request_id: "large-board-read", tool_name: "get_board", request: {}, mutation: false,
    })).effect.state, "failed", "terminal publication settles an abandoned read journal");
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

test("current schema refuses a missing causal-event table without erasing populated inbox retry authority", async () => {
  const env = await fixture(); try {
    const first = new SupervisedAgentInboxStore(env.database);
    const [item] = await first.ingestPoll({ agent_id: "repair", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "msg_1", source_message: { durable: true }, activation: {} }] });
    await first.claimHead("repair");
    await first.recordRetryFailure(item!.inbox_item_id, { domain: "pre_dispatch", error: "setup unavailable" });
    await first.close();
    const damaged = new DatabaseSync(env.database);
    const original = damaged.prepare("SELECT * FROM inbox_items WHERE inbox_item_id=?").get(item!.inbox_item_id);
    damaged.exec("DROP TABLE supervised_agent_inbox_events");
    assert.equal((damaged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_USER_VERSION);
    damaged.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = new SupervisedAgentInboxStore(env.database);
      await assert.rejects(reopened.receipts("repair"), /schema mismatch|supervised_agent_inbox_events/i);
      await reopened.close();
    }
    const inspection = new DatabaseSync(env.database);
    assert.equal(inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='supervised_agent_inbox_events'").get(), undefined);
    assert.deepEqual(inspection.prepare("SELECT * FROM inbox_items WHERE inbox_item_id=?").get(item!.inbox_item_id), original);
    assert.equal((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, DAEMON_STATE_USER_VERSION);
    inspection.close();
  } finally { await env.cleanup(); }
});

test("causal event journal is idempotent when an ingress replay shares a constant clock", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-07-20T12:00:00.000Z");
    await store.ingestPoll({ agent_id: "replay", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    await store.ingestPoll({ agent_id: "replay", room_id: "room", last_observed_message_id: "1", messages: [{ source_message_id: "1", source_message: {}, activation: {} }] });
    const timeline = (await store.receipts("replay"))[0]!.timeline;
    assert.deepEqual(timeline.map((event) => event.phase), ["received", "queued"]);
    assert.deepEqual(timeline.map((event) => event.event_sequence), [1, 2]);
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

test("GIF intent survives restart, can be replaced or cleared, and never completes a turn", async () => {
  const env = await fixture();
  let store = new SupervisedAgentInboxStore(env.database);
  const authority = { agent_id: "gif-agent", room_id: "room", execution_generation_id: "generation",
    provider_turn_id: "native-turn", work_attempt_id: "attempt", current_execution_generation_id: "generation",
    provider_continuation_id: "continuation" };
  try {
    const [item] = await store.ingestPoll({ agent_id: authority.agent_id, room_id: "room", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1", text: "Good work" }, activation: {} }] });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, authority.provider_turn_id, TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, { agentId: authority.agent_id, roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation" });
    const gif = { provider: "giphy", id: "abc123", title: "Nice work", text_fallback_only: true };
    const request = { ...authority, mcp_request_id: "gif", tool_name: "set_reply_gif", request: { gif }, mutation: true };
    await assert.rejects(store.prepareEffect(request, async () => { throw new Error("authority lost"); }), /authority lost/);
    assert.equal(await store.replyGif(item!.inbox_item_id), null);
    const first = await store.prepareEffect(request);
    assert.equal(first.effect.state, "completed");
    assert.deepEqual(await store.replyGif(item!.inbox_item_id), gif);
    assert.equal((await store.get(item!.inbox_item_id))!.state, "dispatching");
    await store.close(); store = new SupervisedAgentInboxStore(env.database);
    assert.deepEqual(await store.prepareEffect(request), { created: false, effect: first.effect });
    assert.deepEqual(await store.replyGif(item!.inbox_item_id), gif);
    await store.prepareEffect({ ...request, mcp_request_id: "clear", request: { gif: null } });
    assert.equal(await store.replyGif(item!.inbox_item_id), null);
    await assert.rejects(store.prepareEffect({ ...request, mcp_request_id: "other-room", request: { gif, room_id: "different" } }), /Invalid GIF/);
    await store.prepareEffect({ ...authority, mcp_request_id: "finish", tool_name: "complete_room_turn", request: { outcome: "no_reply" } });
    await assert.rejects(store.prepareEffect({ ...request, mcp_request_id: "too-late" }), /already complete/);
  } finally { await store.close(); await env.cleanup(); }
});

test("reply attachment intent survives restart, can be replaced or cleared, journals no path, and never completes a turn", async () => {
  const env = await fixture();
  let store = new SupervisedAgentInboxStore(env.database);
  const authority = { agent_id: "files-agent", room_id: "room", execution_generation_id: "generation",
    provider_turn_id: "native-turn", work_attempt_id: "attempt", current_execution_generation_id: "generation",
    provider_continuation_id: "continuation" };
  const file = (name: string) => ({ spool_id: "c".repeat(32), name, mime_type: "image/png", size_bytes: 9, sha256: "d".repeat(64) });
  try {
    const [item] = await store.ingestPoll({ agent_id: authority.agent_id, room_id: "room", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1", text: "Show me" }, activation: {} }] });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, authority.provider_turn_id, TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, { agentId: authority.agent_id, roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation" });
    const request = { ...authority, mcp_request_id: "files", tool_name: "set_reply_attachments", request: { files: [file("before.png")] }, mutation: true };
    assert.deepEqual(await store.replyAttachments(item!.inbox_item_id), []);
    const first = await store.prepareEffect(request);
    assert.equal(first.effect.state, "completed");
    assert.match(JSON.stringify(first.effect.result), /REPLY_ATTACHMENTS_RECORDED/);
    assert.deepEqual(await store.replyAttachments(item!.inbox_item_id), [file("before.png")]);
    assert.equal((await store.get(item!.inbox_item_id))!.state, "dispatching");
    await store.close(); store = new SupervisedAgentInboxStore(env.database);
    assert.deepEqual(await store.prepareEffect(request), { created: false, effect: first.effect });
    await store.prepareEffect({ ...request, mcp_request_id: "replace", request: { files: [file("after.png")] } });
    assert.deepEqual(await store.replyAttachments(item!.inbox_item_id), [file("after.png")]);
    await store.prepareEffect({ ...request, mcp_request_id: "clear", request: { files: null } });
    assert.deepEqual(await store.replyAttachments(item!.inbox_item_id), []);
    for (const invalid of [{ files: ["/Users/owner/.ssh/id_ed25519"] }, { files: [{ ...file("a.png"), path: "/workspace/a.png" }] }, { files: [file("a/b.png")] }]) {
      await assert.rejects(store.prepareEffect({ ...request, mcp_request_id: `invalid-${JSON.stringify(invalid).length}`, request: invalid }), /Invalid reply attachments/);
    }
    await store.prepareEffect({ ...authority, mcp_request_id: "finish", tool_name: "complete_room_turn", request: { outcome: "no_reply" } });
    await assert.rejects(store.prepareEffect({ ...request, mcp_request_id: "too-late" }), /already complete/);
  } finally { await store.close(); await env.cleanup(); }
});

test("reply-thread intent commits atomically, deduplicates exact requests and permits later work", async () => {
  const env = await fixture();
  let store = new SupervisedAgentInboxStore(env.database);
  const authority = {
    agent_id: "thread-agent", room_id: "room", execution_generation_id: "generation",
    provider_turn_id: "native-turn", work_attempt_id: "attempt",
    current_execution_generation_id: "generation", provider_continuation_id: "continuation",
  };
  try {
    const [item] = await store.ingestPoll({ agent_id: authority.agent_id, room_id: "room", last_observed_message_id: "msg_1",
      messages: [{ source_message_id: "msg_1", source_message: { id: "msg_1", text: "answer here" }, activation: {} }] });
    await store.transition(item!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(item!.inbox_item_id, authority.provider_turn_id, TEST_PROVIDER_TURN_AUTHORITY);
    await seedActiveAgent(env, { agentId: authority.agent_id, roomId: "room", workAttemptId: "attempt",
      executionGenerationId: "generation", providerContinuationId: "continuation" });
    // A busy turn can outlive the rolling observation window. Silent later
    // messages must not erase the provenance of its still-active source.
    await store.ingestPoll({ agent_id: authority.agent_id, room_id: "room", last_observed_message_id: "msg_502", messages: [],
      observed_messages: Array.from({ length: 501 }, (_, n) => ({ source_message_id: `msg_${n + 2}`,
        source_message: { id: `msg_${n + 2}` }, activation: {}, activation_decision: "ignore" })) });
    const request = { ...authority, mcp_request_id: "intent", tool_name: "set_reply_thread", request: {}, mutation: true };
    await assert.rejects(store.prepareEffect(request, async () => { throw new Error("authority lost before commit"); }), /authority lost/);
    assert.equal(await store.hasInterceptedThreadReply(item!.inbox_item_id), false, "no half-committed intent");
    const first = await store.prepareEffect(request);
    assert.equal(first.effect.state, "completed");
    assert.equal(first.effect.mutation, true);
    assert.deepEqual(first.effect.request, {});
    assert.equal(await store.hasInterceptedThreadReply(item!.inbox_item_id), true);
    assert.equal((await store.get(item!.inbox_item_id))?.state, "dispatching", "routing cannot complete the turn");
    await store.close(); store = new SupervisedAgentInboxStore(env.database);
    assert.deepEqual(await store.prepareEffect(request), { created: false, effect: first.effect }, "lost receipt response is safe across restart");
    const second = await store.prepareEffect({ ...request, mcp_request_id: "intent-again" });
    assert.equal(second.effect.state, "completed");
    for (const mcp_request_id of ["intent", "intent-again"]) {
      await assert.rejects(store.prepareEffect({ ...request, mcp_request_id, tool_name: "send_message", request: { text: "different" } }), /reused/);
    }
    for (const tool_name of ["get_board", "update_task"]) {
      const next = await store.prepareEffect({ ...authority, mcp_request_id: tool_name, tool_name, request: {} });
      assert.equal(next.effect.state, "prepared", `${tool_name} remains available after thread selection`);
    }
    await store.prepareEffect({ ...authority, mcp_request_id: "finish", tool_name: "complete_room_turn", request: { outcome: "no_reply" } });
    await assert.rejects(store.prepareEffect({ ...request, mcp_request_id: "too-late" }), /already complete/);
    await store.checkpointNormalizedTerminal({ inbox_item_id: item!.inbox_item_id, agent_id: authority.agent_id,
      execution_generation_id: "generation", provider_turn_id: "native-turn", outcome: "no_reply", text: null, evidence: "stream",
      terminal_evidence: { turnId: "native-turn", providerContinuationId: "continuation", outcome: "no_reply", text: null, evidence: "stream" } });
    await store.transition(item!.inbox_item_id, "awaiting_result");
    await store.transition(item!.inbox_item_id, "acknowledged_no_reply");
    const db = new DatabaseSync(env.database);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM supervised_agent_observed_messages WHERE source_message_id='msg_1'").get()!.n, 0,
        "terminal turns release their provenance pin back to normal retention");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM supervised_agent_publications").get()!.n, 0, "no intent publishes text");
    } finally { db.close(); }
  } finally { await store.close(); await env.cleanup(); }
});

test("reply-thread intent rejects foreign or stale authority, extra arguments and synthetic sources", async () => {
  for (const sourceKind of ["observed", "synthetic", "copied-parent"] as const) {
    const env = await fixture();
    const store = new SupervisedAgentInboxStore(env.database);
    try {
      const source = { source_message_id: sourceKind === "copied-parent" ? "task-continuation:parent" : "msg_1",
        source_message: { id: "msg_1", text: "source" }, activation: {} };
      const item = sourceKind === "observed"
        ? (await store.ingestPoll({ agent_id: "thread-agent", room_id: "room", last_observed_message_id: "msg_1", messages: [source] }))[0]!
        : await store.enqueueCorrection({ agent_id: "thread-agent", room_id: "room", ...source });
      await store.transition(item.inbox_item_id, "dispatching");
      await store.checkpointTurnStarted(item.inbox_item_id, "native-turn", TEST_PROVIDER_TURN_AUTHORITY);
      await seedActiveAgent(env, { agentId: "thread-agent", roomId: "room", workAttemptId: "attempt",
        executionGenerationId: "generation", providerContinuationId: "continuation" });
      const input = { agent_id: "thread-agent", room_id: "room", execution_generation_id: "generation", provider_turn_id: "native-turn",
        work_attempt_id: "attempt", current_execution_generation_id: "generation", provider_continuation_id: "continuation",
        mcp_request_id: "intent", tool_name: "set_reply_thread", request: {}, mutation: true };
      if (sourceKind !== "observed") {
        await assert.rejects(store.prepareEffect(input), /observed activating room message/);
      } else {
        for (const key of ["agent_id", "room_id", "execution_generation_id", "provider_turn_id", "work_attempt_id", "current_execution_generation_id", "provider_continuation_id"] as const) {
          await assert.rejects(store.prepareEffect({ ...input, [key]: "foreign" }), /authority/);
        }
        for (const request of [null, [], { room_id: "other" }, { thread_parent_id: "msg_2" }, { text: "answer" }]) {
          await assert.rejects(store.prepareEffect({ ...input, request }), /empty object/);
        }
        await assert.rejects(store.prepareEffect({ ...input, mutation: false }), /classification/);
        await store.cancelInterruptedTurn(item.inbox_item_id);
        await assert.rejects(store.prepareEffect(input), /authority/);
      }
      assert.equal(await store.hasInterceptedThreadReply(item.inbox_item_id), false);
    } finally { await store.close(); await env.cleanup(); }
  }
});


test("settled child history converges on migration and settlement, retaining exact outcomes and ordering", async () => {
  const env = await fixture();
  let store = new SupervisedAgentInboxStore(env.database, () => "2026-09-01T00:00:00.000Z");
  let database: DatabaseSync | undefined;
  try {
    const [item] = await store.ingestPoll({ agent_id: "large-history", room_id: "room", last_observed_message_id: "1",
      messages: [{ source_message_id: "1", source_message: { text: "retain this" }, activation: {} }] });
    database = new DatabaseSync(env.database);
    await completeCapturedReceipt(store, database, item!, "reply");
    const before = await store.get(item!.inbox_item_id);
    const binding = await store.providerTurnBinding(item!.inbox_item_id);
    const terminal = database.prepare("SELECT * FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(item!.inbox_item_id);
    const publication = database.prepare("SELECT * FROM supervised_agent_publications WHERE inbox_item_id=?").get(item!.inbox_item_id);
    const seed = (id: string, count: number) => {
      database!.exec("BEGIN");
      try {
        const events = database!.prepare(`INSERT INTO supervised_agent_inbox_events
          VALUES (?,?,?,'conversation_restoring','2026-09-01T00:00:00.000Z',NULL)`);
        const repairs = database!.prepare(`INSERT INTO provider_continuation_repairs
          (repair_id,agent_id,room_id,inbox_item_id,daemon_generation,execution_generation_id,work_attempt_id,
           expected_pid,expected_process_identity,missing_continuation,replacement_continuation,phase,attempt_count,last_error,created_at,updated_at)
          VALUES (?,'large-history','room',?,1,'generation','attempt',1,'process','old','new','committed',1,NULL,?,?)`);
        for (let index = 0; index < count; index++) {
          events.run(id, index + 100, `noise:${index}`);
          repairs.run(`${id}:repair:${index}`, id, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
        }
        database!.exec("COMMIT");
      } catch (error) { database!.exec("ROLLBACK"); throw error; }
    };
    seed(item!.inbox_item_id, 10_000);
    const latest = await store.latestContinuationRepair("large-history");
    const maxSequence = database.prepare("SELECT MAX(event_sequence) AS n FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(item!.inbox_item_id)!.n;
    await store.close();
    store = new SupervisedAgentInboxStore(env.database);
    await store.pruneHistory("large-history");
    assert.deepEqual(await store.get(item!.inbox_item_id), before);
    const assertBounded = (id: string) => {
      assert.equal(database!.prepare("SELECT COUNT(*) AS n FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(id)!.n,
        RETAINED_TERMINAL_TIMELINE_EVENTS + 2);
      assert.equal(database!.prepare("SELECT COUNT(*) AS n FROM provider_continuation_repairs WHERE inbox_item_id=?").get(id)!.n,
        RETAINED_TERMINAL_CONTINUATION_REPAIRS);
    };
    assertBounded(item!.inbox_item_id);
    assert.deepEqual(await store.latestContinuationRepair("large-history"), latest);
    assert.deepEqual(await store.providerTurnBinding(item!.inbox_item_id), binding);
    assert.deepEqual(database.prepare("SELECT * FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(item!.inbox_item_id), terminal);
    assert.deepEqual(database.prepare("SELECT * FROM supervised_agent_publications WHERE inbox_item_id=?").get(item!.inbox_item_id), publication);
    assert.equal(database.prepare("SELECT MAX(event_sequence) AS n FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(item!.inbox_item_id)!.n, maxSequence);
    await store.pruneHistory("large-history");
    assertBounded(item!.inbox_item_id);
    const [next] = await store.ingestPoll({ agent_id: "large-history", room_id: "room", last_observed_message_id: "2",
      messages: [{ source_message_id: "2", source_message: {}, activation: {} }] });
    seed(next!.inbox_item_id, 100);
    await store.pruneHistory("large-history");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM provider_continuation_repairs WHERE inbox_item_id=?").get(next!.inbox_item_id)!.n, 100);
    database.exec("CREATE TRIGGER fail_child_cleanup BEFORE DELETE ON provider_continuation_repairs BEGIN SELECT RAISE(ABORT,'child cleanup interrupted'); END");
    await store.transition(next!.inbox_item_id, "dispatching");
    await store.checkpointTurnStarted(next!.inbox_item_id, "next-turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.checkpointTerminalOutcome(next!.inbox_item_id, JSON.stringify({ kind: "no_reply", text: null }));
    await store.transition(next!.inbox_item_id, "awaiting_result");
    const active = await store.get(next!.inbox_item_id);
    const eventsBefore = database.prepare("SELECT COUNT(*) AS n FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(next!.inbox_item_id)!.n;
    await assert.rejects(store.transition(next!.inbox_item_id, "acknowledged_no_reply"), /child cleanup interrupted/);
    assert.deepEqual(await store.get(next!.inbox_item_id), active);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM supervised_agent_inbox_events WHERE inbox_item_id=?").get(next!.inbox_item_id)!.n, eventsBefore);
    database.exec("DROP TRIGGER fail_child_cleanup");
    await store.transition(next!.inbox_item_id, "acknowledged_no_reply");
    assertBounded(next!.inbox_item_id);
    const [failed] = await store.ingestPoll({ agent_id: "large-history", room_id: "room", last_observed_message_id: "3",
      messages: [{ source_message_id: "3", source_message: {}, activation: {} }] });
    await completeCapturedReceipt(store, database, failed!, "failed");
    const failureEvidence = database.prepare("SELECT * FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(failed!.inbox_item_id);
    seed(failed!.inbox_item_id, 100);
    database.prepare("UPDATE provider_continuation_repairs SET phase='probing' WHERE repair_id=?").run(`${failed!.inbox_item_id}:repair:99`);
    await store.pruneHistory("large-history");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM provider_continuation_repairs WHERE inbox_item_id=?").get(failed!.inbox_item_id)!.n, 100,
      "an unfinished repair remains recoverable with its causal history");
    await store.close();
    store = new SupervisedAgentInboxStore(env.database);
    assert.equal((await store.latestContinuationRepair("large-history"))!.phase, "probing");
    database.prepare("UPDATE provider_continuation_repairs SET phase='committed' WHERE repair_id=?").run(`${failed!.inbox_item_id}:repair:99`);
    seedBoundedMcpEffectRow(database, {
      id: "generation-pin",
      agent_id: "large-history",
      room_id: "room",
      execution_generation_id: "generation",
      provider_turn_id: "native:3",
      mcp_request_id: "request",
      tool_name: "send_message",
      request: {},
      mutation: true,
      state: "executing",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    await store.pruneHistory("large-history");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM provider_continuation_repairs WHERE inbox_item_id=?").get(failed!.inbox_item_id)!.n, 100);
    database.prepare("DELETE FROM effects WHERE id='generation-pin'").run();
    seedBoundedMcpEffectRow(database, {
      id: "generation-pin",
      agent_id: "large-history",
      room_id: "room",
      execution_generation_id: "unrelated-generation",
      provider_turn_id: "native:3",
      mcp_request_id: "request",
      tool_name: "send_message",
      request: {},
      mutation: true,
      state: "executing",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    await store.pruneHistory("large-history");
    assertBounded(failed!.inbox_item_id);
    assert.equal(database.prepare("SELECT state FROM effects WHERE id='generation-pin'").get()!.state, "executing",
      "unrelated generation authority is preserved without pinning this receipt's history");
    assert.deepEqual(database.prepare("SELECT * FROM supervised_agent_terminal_results WHERE inbox_item_id=?").get(failed!.inbox_item_id), failureEvidence);
    assert.equal((await store.get(failed!.inbox_item_id))!.state, "acknowledged_failed");
    await store.close();
    store = new SupervisedAgentInboxStore(env.database);
    await store.pruneHistory("large-history");
    assertBounded(failed!.inbox_item_id);
    await assert.rejects(store.transition(failed!.inbox_item_id, "pending"), /Invalid supervised inbox transition/);
  } finally { database?.close(); await store.close(); await env.cleanup(); }
});

const ACTIVATE = { decision: "activate", reason: "explicit_mention", addressed: true };
function personMessage(id: string, text = `person ${id}`) {
  return { source_message_id: id, source_message: { id, sender: "Dana", source: "browser", agent_identity: null, text }, activation: ACTIVATE };
}
function agentMessage(id: string) {
  return { source_message_id: id, source_message: { id, sender: "Peer | Dana's agent | Codex", source: "agent",
    agent_identity: { agent_key: "dana/peer", actor_label: "Peer" }, text: `agent ${id}` }, activation: ACTIVATE };
}
function boardNotice(id: string, text = `Board intent bi_${id} was approved. Continue the exact approved action.`) {
  return { source_message_id: id, source_message: { id, sender: "letagents", source: "system", agent_identity: null, text,
    timestamp: `2026-10-01 07:00:0${id.slice(-1)}+00` }, activation: ACTIVATE };
}
function taskWakeNotice(id: string, rule: string, task: string, from: string, to: string) {
  return { source_message_id: id, source_message: { id, sender: "letagents", source: "wake_rule", agent_identity: null,
    text: `Your wake rule ${rule} fired: ${task} moved to ${to}.\nYour note: close out ${task}.\n\n- ${task}: ${from} → ${to}\n\nThis rule is finished.` },
  activation: { decision: "activate", reason: "wake_rule", addressed: true } };
}
async function queueOrder(store: SupervisedAgentInboxStore, agentId: string): Promise<string[]> {
  return (await store.receipts(agentId)).filter((item) => !item.acknowledged_at).map((item) => item.source_message_id);
}
let queuedTurn = 0;
/** Start the claimed head's provider turn and finish it without a reply. */
async function runQueuedTurn(store: SupervisedAgentInboxStore, item: { inbox_item_id: string; agent_id: string },
  outcome: "no_reply" | "failed" = "no_reply", turn = `queued-turn-${++queuedTurn}`): Promise<void> {
  if (!(await store.get(item.inbox_item_id))!.provider_turn_id) await store.checkpointTurnStarted(item.inbox_item_id, turn, TEST_PROVIDER_TURN_AUTHORITY);
  await store.checkpointNormalizedTerminal({ inbox_item_id: item.inbox_item_id, agent_id: item.agent_id, execution_generation_id: "generation",
    provider_turn_id: turn, outcome, text: null, evidence: "stream",
    terminal_evidence: { turnId: turn, providerContinuationId: "continuation", outcome, text: null, evidence: "stream" } });
  if (outcome === "failed") return store.transition(item.inbox_item_id, "acknowledged_failed").then(() => undefined);
  await store.transition(item.inbox_item_id, "awaiting_result");
  await store.transition(item.inbox_item_id, "acknowledged_no_reply");
}
type QueuedNoticePayload = { instruction: string; activating_superseded_by: string | null; notices: Array<{ id: string; text: string; superseded_by: string | null }> };

test("a person's message is queued ahead of untouched automated work behind the head, FIFO among people", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-10-01T07:00:00.000Z");
    const [head] = await store.ingestPoll({ agent_id: "busy", room_id: "room", last_observed_message_id: "1", messages: [agentMessage("1")] });
    await store.claimHead("busy");
    await store.ingestPoll({ agent_id: "busy", room_id: "room", last_observed_message_id: "4",
      messages: [boardNotice("2"), agentMessage("3"), personMessage("4")] });
    assert.deepEqual(await queueOrder(store, "busy"), ["1", "4", "2", "3"], "the person passes notices and agent messages, never the head");
    const [person] = (await store.receipts("busy")).filter((item) => item.source_message_id === "4");
    assert.equal(person!.timeline.at(-1)?.detail, "Queued ahead of 2 earlier automated deliveries.");
    const replay = await store.ingestPoll({ agent_id: "busy", room_id: "room", last_observed_message_id: "6",
      messages: [personMessage("4"), agentMessage("5"), personMessage("6")] });
    assert.deepEqual(replay.map((item) => item.source_message_id), ["4", "5", "6"]);
    assert.deepEqual(replay.map((item) => item.fifo_sequence), [2, 6, 3], "returned items carry their committed positions");
    assert.deepEqual(await queueOrder(store, "busy"), ["1", "4", "6", "2", "3", "5"]);
    assert.equal((await store.get(head!.inbox_item_id))!.fifo_sequence, 1);
    assert.equal(await store.claimHead("busy"), null, "the in-flight head keeps FIFO authority");
    await runQueuedTurn(store, head!);
    const claimed: string[] = [];
    for (let item = await store.claimHead("busy"); item; item = await store.claimHead("busy")) {
      claimed.push(item.source_message_id);
      await runQueuedTurn(store, item);
    }
    assert.deepEqual(claimed, ["4", "6", "2", "3", "5"]);
    await store.ingestPoll({ agent_id: "paused", room_id: "room", last_observed_message_id: "1", messages: [agentMessage("1")] });
    await store.ingestPoll({ agent_id: "paused", room_id: "room", last_observed_message_id: "2", messages: [personMessage("2")] });
    assert.deepEqual(await queueOrder(store, "paused"), ["1", "2"], "an unclaimed head is never passed");
    await store.close();
  } finally { await env.cleanup(); }
});

test("people stop overtaking an automated delivery after five later people's messages passed it", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    await store.ingestPoll({ agent_id: "chatty", room_id: "room", last_observed_message_id: "2", messages: [agentMessage("1"), agentMessage("2")] });
    await store.claimHead("chatty");
    for (let id = 3; id <= 9; id += 1) {
      await store.ingestPoll({ agent_id: "chatty", room_id: "room", last_observed_message_id: String(id), messages: [personMessage(String(id))] });
    }
    assert.deepEqual(await queueOrder(store, "chatty"), ["1", "3", "4", "5", "6", "7", "2", "8", "9"]);
    await store.close();
  } finally { await env.cleanup(); }
});

test("a claimed notice carries the notices queued behind it, and they settle only when its turn completes", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database, () => "2026-10-01T07:00:00.000Z");
    const [head] = await store.ingestPoll({ agent_id: "manager", room_id: "room", last_observed_message_id: "1", messages: [agentMessage("1")] });
    await store.claimHead("manager");
    await store.ingestPoll({ agent_id: "manager", room_id: "room", last_observed_message_id: "6", messages: [
      taskWakeNotice("2", "wake_a", "task_4", "in_review", "merged"), boardNotice("3"), agentMessage("4"),
      taskWakeNotice("5", "wake_a", "task_4", "merged", "done"), taskWakeNotice("6", "wake_b", "task_4", "merged", "done"),
    ] });
    assert.deepEqual(await queueOrder(store, "manager"), ["1", "2", "3", "4", "5", "6"], "ingestion settles nothing");
    await runQueuedTurn(store, head!);
    const claimed = (await store.claimHead("manager"))!;
    assert.equal(claimed.source_message_id, "2", "the oldest notice keeps its FIFO turn");
    assert.equal(claimed.activation.reason, "wake_rule", "the server activation is preserved");
    const payload = claimed.activation.queued_notices as QueuedNoticePayload;
    assert.equal(payload.activating_superseded_by, "5", "a newer firing of the same rule about task_4");
    assert.deepEqual(payload.notices.map(({ id, superseded_by }) => [id, superseded_by]), [["3", null], ["5", null], ["6", null]],
      "another agent's message is not a notice; a different rule about the same task is not superseded");
    assert.match(payload.notices[0]!.text, /bi_3 was approved/);
    assert.match(payload.instruction, /Check the current board/);
    assert.deepEqual(await queueOrder(store, "manager"), ["2", "3", "4", "5", "6"], "nothing settles at claim");
    await store.checkpointTurnStarted(claimed.inbox_item_id, "turn-2", TEST_PROVIDER_TURN_AUTHORITY);
    assert.deepEqual(await queueOrder(store, "manager"), ["2", "3", "4", "5", "6"], "nothing settles when the turn starts");
    const terminal = () => store.checkpointNormalizedTerminal({ inbox_item_id: claimed.inbox_item_id, agent_id: "manager",
      execution_generation_id: "generation", provider_turn_id: "turn-2", outcome: "no_reply", text: null, evidence: "stream",
      terminal_evidence: { turnId: "turn-2", providerContinuationId: "continuation", outcome: "no_reply", text: null, evidence: "stream" } });
    await terminal();
    assert.deepEqual(await queueOrder(store, "manager"), ["2", "4"], "the completed turn settles the notices it carried");
    const settled = (await store.getBySourceMessage("manager", "room", "5"))!;
    assert.equal(settled.state, "acknowledged_no_reply");
    assert.equal(settled.provider_turn_id, null);
    assert.equal(settled.attempt_count, 0);
    assert.equal(settled.last_error, "Delivered in the turn for 2 together with other queued notices, so this notice had no separate turn.");
    const timeline = (await store.receipts("manager")).find((item) => item.source_message_id === "5")!.timeline;
    assert.deepEqual(timeline.map((event) => event.phase), ["received", "queued", "no_reply"]);
    await terminal();
    assert.equal((await store.receipts("manager")).find((item) => item.source_message_id === "5")!.timeline.length, 3, "a repeated checkpoint settles nothing twice");
    await assert.rejects(store.transition(settled.inbox_item_id, "pending"), /Invalid supervised inbox transition/);
    await store.close();
  } finally { await env.cleanup(); }
});

test("a notice skipped, reset or retried before its turn starts leaves the notices behind it queued", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    await store.ingestPoll({ agent_id: "skipper", room_id: "room", last_observed_message_id: "3",
      messages: [boardNotice("1"), taskWakeNotice("2", "wake_a", "task_4", "in_review", "merged"), boardNotice("3")] });
    let head = (await store.claimHead("skipper"))!;
    assert.deepEqual(queuedNoticeIdsOf(head), ["2", "3"]);
    await store.resetPreNativeHandoff(head.inbox_item_id);
    await store.ingestPoll({ agent_id: "skipper", room_id: "room", last_observed_message_id: "4", messages: [boardNotice("4")] });
    head = (await store.claimHead("skipper"))!;
    assert.deepEqual(queuedNoticeIdsOf(head), ["2", "3", "4"], "a new claim recomputes the batch");
    await store.transition(head.inbox_item_id, "blocked", { last_error: "provider unavailable" });
    await store.retryBlocked(head.inbox_item_id);
    head = (await store.claimHead("skipper"))!;
    assert.deepEqual(queuedNoticeIdsOf(head), ["2", "3", "4"]);
    await store.transition(head.inbox_item_id, "blocked", { last_error: "provider unavailable" });
    await store.skipBlocked(head.inbox_item_id);
    assert.deepEqual(await queueOrder(store, "skipper"), ["2", "3", "4"], "skipping notice 1 drops only notice 1");
    for (const id of ["2", "3", "4"]) assert.equal((await store.getBySourceMessage("skipper", "room", id))!.last_error, null);
    const next = (await store.claimHead("skipper"))!;
    assert.equal(next.source_message_id, "2");
    assert.deepEqual(queuedNoticeIdsOf(next), ["3", "4"]);
    await store.close();
  } finally { await env.cleanup(); }
});

function queuedNoticeIdsOf(item: { activation: Record<string, unknown> }): string[] {
  return ((item.activation.queued_notices as QueuedNoticePayload | undefined)?.notices ?? []).map((entry) => entry.id);
}

test("a steady stream of agent messages and notices cannot defer an older board intent", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const intent = (id: string) => boardNotice(id, `New board intent bi_${id}: use approve_board_intent or deny_board_intent to decide it.`);
    const ciWake = (id: string) => ({ source_message_id: id, source_message: { id, sender: "letagents", source: "wake_rule", agent_identity: null,
      text: `Your wake rule wake_${id} fired: CI finished on #8: 1 failed.\n\nThis rule keeps watching.` }, activation: ACTIVATE });
    await store.ingestPoll({ agent_id: "m", room_id: "room", last_observed_message_id: "3", messages: [agentMessage("1"), intent("2"), agentMessage("3")] });
    const ran: Array<{ id: string; carried: string[] }> = [];
    const agentIds = ["1", "3"];
    let next = 4;
    for (let cycle = 0; cycle < 18; cycle += 1) {
      const head = (await store.claimHead("m"))!;
      ran.push({ id: head.source_message_id, carried: queuedNoticeIdsOf(head) });
      // While this turn runs, one agent message and one wake notice arrive.
      const agent = String(next++); const wake = String(next++);
      agentIds.push(agent);
      await store.ingestPoll({ agent_id: "m", room_id: "room", last_observed_message_id: wake, messages: [agentMessage(agent), ciWake(wake)] });
      await runQueuedTurn(store, head);
    }
    assert.deepEqual(ran.slice(0, 3), [{ id: "1", carried: [] }, { id: "2", carried: ["5"] }, { id: "3", carried: [] }],
      "the intent runs on turn 2, as in plain FIFO, carrying the wake notice that arrived meanwhile");
    const agentTurns = ran.filter((turn) => agentIds.includes(turn.id)).map((turn) => Number(turn.id));
    assert.deepEqual(agentTurns, agentIds.slice(0, agentTurns.length).map(Number), "agent messages keep FIFO order");
    const pending = await queueOrder(store, "m");
    const oldestPendingAgent = Math.min(...pending.filter((id) => agentIds.includes(id)).map(Number));
    assert.ok(pending.filter((id) => !agentIds.includes(id)).every((id) => Number(id) > oldestPendingAgent),
      "no notice waits behind an agent message that arrived after it");
    const delivered = new Set(ran.flatMap((turn) => [turn.id, ...turn.carried]));
    for (const receipt of await store.receipts("m")) {
      if (!receipt.acknowledged_at) continue;
      assert.ok(delivered.has(receipt.source_message_id), `${receipt.source_message_id} was settled only after a turn carried it`);
    }
    await store.close();
  } finally { await env.cleanup(); }
});

test("at most sixteen notices ride in one turn; the rest wait for the next notice turn and none are dropped", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const [head] = await store.ingestPoll({ agent_id: "m", room_id: "room", last_observed_message_id: "100", messages: [personMessage("100")] });
    await store.claimHead("m");
    await store.ingestPoll({ agent_id: "m", room_id: "room", last_observed_message_id: "118", messages: [
      boardNotice("101"), ...Array.from({ length: 17 }, (_, index) => boardNotice(String(102 + index))),
    ] });
    await runQueuedTurn(store, head!);
    const first = (await store.claimHead("m"))!;
    assert.equal(first.source_message_id, "101");
    assert.deepEqual(queuedNoticeIdsOf(first), Array.from({ length: 16 }, (_, index) => String(102 + index)));
    await runQueuedTurn(store, first);
    assert.deepEqual(await queueOrder(store, "m"), ["118"]);
    await store.close();
  } finally { await env.cleanup(); }
});

const ROW_TOUCHES: Record<string, (database: DatabaseSync, item: { inbox_item_id: string; agent_id: string; room_id: string }) => void> = {
  "a provider-turn binding": (database, item) => database.prepare(`INSERT INTO supervised_agent_provider_turn_bindings
    (inbox_item_id,agent_id,room_id,work_attempt_id,origin_execution_generation_id,provider_continuation_id,provider_turn_id)
    VALUES (?,?,?,'attempt','generation','continuation',?)`).run(item.inbox_item_id, item.agent_id, item.room_id, `bound-${item.agent_id}`),
  "turn-control history": (database, item) => {
    database.prepare(`INSERT INTO agents(agent_id,sort_order,created_by,created_at,display_name,room_id,provider,charter,desired_state,observed_state,condition,turn_control_inbox_item_id,turn_control_status,turn_control_json)
      VALUES (?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM agents),'test','2026-10-01T07:00:00.000Z',?,?,'codex','test','running','working','none',?,'completed',?)`)
      .run(item.agent_id, item.agent_id, item.room_id, item.inbox_item_id, JSON.stringify({ action_id: "touch", status: "completed", inbox_item_id: item.inbox_item_id }));
  },
  "a retry event": (database, item) => database.prepare(`INSERT INTO supervised_agent_inbox_events
    (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail) VALUES (?,3,'retry_failure:pre_dispatch:1','retry_scheduled','2026-10-01T07:00:00.000Z','x')`)
    .run(item.inbox_item_id),
  "a non-pending state": (database, item) => database.prepare("UPDATE inbox_items SET state='retryable' WHERE inbox_item_id=?").run(item.inbox_item_id),
};
for (const [touch, apply] of Object.entries(ROW_TOUCHES)) {
  test(`a queued row with ${touch} is a barrier for people and for notice batches`, async () => {
    const env = await fixture();
    const database = new DatabaseSync(env.database);
    try {
      const store = new SupervisedAgentInboxStore(env.database);
      await store.ingestPoll({ agent_id: "people", room_id: "room", last_observed_message_id: "2", messages: [agentMessage("1"), boardNotice("2")] });
      await store.claimHead("people");
      apply(database, (await store.getBySourceMessage("people", "room", "2"))!);
      await store.ingestPoll({ agent_id: "people", room_id: "room", last_observed_message_id: "4", messages: [boardNotice("3"), personMessage("4")] });
      assert.deepEqual(await queueOrder(store, "people"), ["1", "2", "4", "3"], "the person does not pass the touched row");

      await store.ingestPoll({ agent_id: "batch", room_id: "room", last_observed_message_id: "3", messages: [boardNotice("1"), boardNotice("2"), boardNotice("3")] });
      apply(database, (await store.getBySourceMessage("batch", "room", "2"))!);
      const head = (await store.claimHead("batch"))!;
      assert.equal(head.source_message_id, "1");
      assert.deepEqual(queuedNoticeIdsOf(head), [], "the batch stops at the touched row");
      await store.close();
    } finally { database.close(); await env.cleanup(); }
  });
}

test("a row revived by a room-move rollback and rows from another room are barriers", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    await store.bootstrapCursor({ agent_id: "mover", room_id: "old", last_observed_message_id: "9" });
    const [current] = await store.ingestPoll({ agent_id: "mover", room_id: "old", expected_cursor: "9", last_observed_message_id: "11",
      messages: [agentMessage("10"), boardNotice("11")] });
    await store.claimHead("mover");
    await store.checkpointTurnStarted(current!.inbox_item_id, "turn-move", TEST_PROVIDER_TURN_AUTHORITY);
    await store.commitRoomMoveQueue({ operation_id: "move_1", agent_id: "mover", old_room_id: "old", after_fifo_sequence: current!.fifo_sequence });
    await store.commitRoomMoveCursor({ agent_id: "mover", source_room_id: "old", destination_room_id: "new", last_observed_message_id: "40" });
    await store.rollbackRoomMoveIngress({ operation_id: "move_1", agent_id: "mover", source_room_id: "old", destination_room_id: "new",
      source_cursor_present: true, source_cursor: "11", after_fifo_sequence: current!.fifo_sequence });
    await store.ingestPoll({ agent_id: "mover", room_id: "old", last_observed_message_id: "13", messages: [boardNotice("12"), personMessage("13")] });
    assert.deepEqual(await queueOrder(store, "mover"), ["10", "11", "13", "12"], "the person does not pass the revived row");

    await store.ingestPoll({ agent_id: "rooms", room_id: "a", last_observed_message_id: "2", messages: [agentMessage("1"), boardNotice("2")] });
    const inFlight = await store.claimHead("rooms");
    await store.commitRoomMoveCursor({ agent_id: "rooms", source_room_id: "a", destination_room_id: "b", last_observed_message_id: "10" });
    await store.ingestPoll({ agent_id: "rooms", room_id: "b", last_observed_message_id: "12", messages: [boardNotice("11"), personMessage("12")] });
    assert.deepEqual(await queueOrder(store, "rooms"), ["1", "2", "12", "11"], "a room-b person does not pass a room-a row");
    await runQueuedTurn(store, inFlight!);
    const roomA = (await store.claimHead("rooms"))!;
    assert.equal(roomA.source_message_id, "2");
    assert.deepEqual(queuedNoticeIdsOf(roomA), [], "a room-a notice never carries a room-b notice");
    await store.ingestPoll({ agent_id: "rooms2", room_id: "a", last_observed_message_id: "1", messages: [boardNotice("1")] });
    await store.commitRoomMoveCursor({ agent_id: "rooms2", source_room_id: "a", destination_room_id: "b", last_observed_message_id: "10" });
    await store.ingestPoll({ agent_id: "rooms2", room_id: "b", last_observed_message_id: "11", messages: [boardNotice("11")] });
    assert.deepEqual(queuedNoticeIdsOf((await store.claimHead("rooms2"))!), [], "a room-a notice never carries the room-b notice behind it");
    await store.close();
  } finally { await env.cleanup(); }
});

test("a completed turn settles only untouched notices its own claim listed, never a person's message", async () => {
  const env = await fixture();
  const database = new DatabaseSync(env.database);
  try {
    const store = new SupervisedAgentInboxStore(env.database);
    await store.ingestPoll({ agent_id: "listed", room_id: "room", last_observed_message_id: "2", messages: [boardNotice("1"), boardNotice("2")] });
    const head = (await store.claimHead("listed"))!;
    await store.ingestPoll({ agent_id: "listed", room_id: "room", last_observed_message_id: "3", messages: [personMessage("3")] });
    const activation = { ...head.activation, queued_notices: { notices: [{ id: "2" }, { id: "3" }] } };
    database.prepare("UPDATE inbox_items SET activation_json=? WHERE inbox_item_id=?").run(JSON.stringify(activation), head.inbox_item_id);
    await runQueuedTurn(store, head);
    assert.equal((await store.getBySourceMessage("listed", "room", "2"))!.state, "acknowledged_no_reply");
    assert.equal((await store.getBySourceMessage("listed", "room", "3"))!.state, "pending", "a listed person's message is never settled");

    await store.ingestPoll({ agent_id: "injected", room_id: "room", last_observed_message_id: "2", messages: [
      { ...personMessage("1"), activation: { ...ACTIVATE, queued_notices: { notices: [{ id: "2" }] } } }, boardNotice("2"),
    ] });
    const person = (await store.claimHead("injected"))!;
    assert.equal(person.activation.queued_notices, undefined, "a server-supplied batch is never dispatched");
    await runQueuedTurn(store, person);
    assert.equal((await store.getBySourceMessage("injected", "room", "2"))!.state, "pending");

    await store.ingestPoll({ agent_id: "moved", room_id: "room", last_observed_message_id: "2", messages: [boardNotice("1"), boardNotice("2")] });
    const mover = (await store.claimHead("moved"))!;
    assert.deepEqual(queuedNoticeIdsOf(mover), ["2"]);
    await store.commitRoomMoveQueue({ operation_id: "move_q", agent_id: "moved", old_room_id: "room", after_fifo_sequence: mover.fifo_sequence });
    await runQueuedTurn(store, mover);
    const cancelled = (await store.receipts("moved")).find((item) => item.source_message_id === "2")!;
    assert.equal(cancelled.state, "cancelled_by_room_move");
    assert.equal(cancelled.timeline.at(-1)?.phase, "room_move_cancelled", "a listed row that changed before the turn started is left alone");
    await store.close();
  } finally { database.close(); await env.cleanup(); }
});

test("corrections are barriers, and a recovering turn keeps the batch it started with", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    const correction = (agentId: string) => store.enqueueCorrection({ agent_id: agentId, room_id: "room", source_message_id: "correction:action-1",
      source_message: { text: "use the new plan", sender: { kind: "supervisor_correction" } },
      activation: { decision: "activate", reason: "human_correction", addressed: true } });
    await store.ingestPoll({ agent_id: "corrected", room_id: "room", last_observed_message_id: "1", messages: [agentMessage("1")] });
    await store.claimHead("corrected");
    await correction("corrected");
    await store.ingestPoll({ agent_id: "corrected", room_id: "room", last_observed_message_id: "3", messages: [boardNotice("2"), personMessage("3")] });
    assert.deepEqual(await queueOrder(store, "corrected"), ["1", "correction:action-1", "3", "2"], "a person does not pass a correction");

    await store.ingestPoll({ agent_id: "notified", room_id: "room", last_observed_message_id: "1", messages: [boardNotice("1")] });
    await correction("notified");
    await store.ingestPoll({ agent_id: "notified", room_id: "room", last_observed_message_id: "2", messages: [boardNotice("2")] });
    assert.deepEqual(queuedNoticeIdsOf((await store.claimHead("notified"))!), [], "a notice batch never reaches past a correction");

    await store.ingestPoll({ agent_id: "asked", room_id: "room", last_observed_message_id: "1", messages: [boardNotice("1")] });
    await store.ingestPoll({ agent_id: "asked", room_id: "room", last_observed_message_id: "3", messages: [personMessage("2"), boardNotice("3")] });
    assert.deepEqual(await queueOrder(store, "asked"), ["1", "2", "3"]);
    assert.deepEqual(queuedNoticeIdsOf((await store.claimHead("asked"))!), [], "a notice batch never reaches past a person's message");

    await store.ingestPoll({ agent_id: "recovering", room_id: "room", last_observed_message_id: "2", messages: [boardNotice("1"), boardNotice("2")] });
    const started = (await store.claimHead("recovering"))!;
    await store.checkpointTurnStarted(started.inbox_item_id, "turn-recover", TEST_PROVIDER_TURN_AUTHORITY);
    await store.normalizeStartupRecovery("recovering");
    await store.ingestPoll({ agent_id: "recovering", room_id: "room", last_observed_message_id: "3", messages: [boardNotice("3")] });
    const recovered = (await store.claimHead("recovering"))!;
    assert.equal(recovered.provider_turn_id, "turn-recover");
    assert.deepEqual(recovered.activation, started.activation, "the recovered turn's prompt is not rebuilt");
    assert.deepEqual(await queueOrder(store, "recovering"), ["1", "2", "3"]);
    await runQueuedTurn(store, recovered, "no_reply", "turn-recover");
    assert.deepEqual(await queueOrder(store, "recovering"), ["3"], "the recovered turn settles the notices it started with");
    await store.close();
  } finally { await env.cleanup(); }
});

test("a turn that fails, is stopped, or ends unreadable after it starts leaves its listed notices queued", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    for (const agentId of ["failed", "stopped", "unreadable"]) {
      await store.ingestPoll({ agent_id: agentId, room_id: "room", last_observed_message_id: "3",
        messages: [boardNotice("1"), boardNotice("2"), boardNotice("3")] });
    }
    const failed = (await store.claimHead("failed"))!;
    assert.deepEqual(queuedNoticeIdsOf(failed), ["2", "3"]);
    await runQueuedTurn(store, failed, "failed");
    assert.deepEqual(await queueOrder(store, "failed"), ["2", "3"], "a failed turn keeps its notices for the next turn");

    const stopped = (await store.claimHead("stopped"))!;
    await store.checkpointTurnStarted(stopped.inbox_item_id, "turn-stopped", TEST_PROVIDER_TURN_AUTHORITY);
    await store.cancelInterruptedTurn(stopped.inbox_item_id);
    assert.deepEqual(await queueOrder(store, "stopped"), ["2", "3"], "a turn stopped after it started keeps its notices queued");

    const unreadable = (await store.claimHead("unreadable"))!;
    await store.checkpointTurnStarted(unreadable.inbox_item_id, "turn-unreadable", TEST_PROVIDER_TURN_AUTHORITY);
    const unreadableTerminal = (outcome: "unreadable" | "no_reply") => store.checkpointNormalizedTerminal({ inbox_item_id: unreadable.inbox_item_id,
      agent_id: "unreadable", execution_generation_id: "generation", provider_turn_id: "turn-unreadable", outcome, text: null,
      evidence: outcome === "unreadable" ? "none" : "stream",
      terminal_evidence: { turnId: "turn-unreadable", providerContinuationId: "continuation", outcome, text: null, evidence: outcome === "unreadable" ? "none" : "stream" } });
    await unreadableTerminal("unreadable");
    assert.deepEqual(await queueOrder(store, "unreadable"), ["1", "2", "3"], "an unreadable result settles nothing");
    await unreadableTerminal("no_reply");
    assert.deepEqual(await queueOrder(store, "unreadable"), ["1"], "the re-read completion settles them once");
    await store.close();
  } finally { await env.cleanup(); }
});

test("the pass budget survives head changes: one person per turn passes a peer message at most five times", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    await store.ingestPoll({ agent_id: "m", room_id: "room", last_observed_message_id: "2", messages: [personMessage("1"), agentMessage("2")] });
    const ran: string[] = [];
    let next = 3;
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const head = (await store.claimHead("m"))!;
      ran.push(head.source_message_id);
      const person = String(next++);
      await store.ingestPoll({ agent_id: "m", room_id: "room", last_observed_message_id: person, messages: [personMessage(person)] });
      await runQueuedTurn(store, head);
    }
    assert.deepEqual(ran, ["1", "3", "4", "5", "6", "7", "2", "8", "9", "10"]);
    const peer = (await store.receipts("m")).find((item) => item.source_message_id === "2")!;
    assert.deepEqual(peer.timeline.filter((event) => event.detail?.startsWith("A person's message")).map((event) => event.detail),
      ["3", "4", "5", "6", "7"].map((id) => `A person's message (${id}) was queued ahead of this one.`));
    await store.close();
  } finally { await env.cleanup(); }
});

test("documented limits: a blocked head shows its old batch until Retry, and a person queued after the claim does not unlist a notice", async () => {
  const env = await fixture(); try {
    const store = new SupervisedAgentInboxStore(env.database);
    await store.ingestPoll({ agent_id: "crash", room_id: "room", last_observed_message_id: "3", messages: [boardNotice("1"), boardNotice("2"), boardNotice("3")] });
    const head = (await store.claimHead("crash"))!;
    await store.checkpointDispatchIntent(head.inbox_item_id);
    await store.normalizeStartupRecovery("crash");
    const blocked = (await store.get(head.inbox_item_id))!;
    assert.equal(blocked.state, "blocked");
    assert.deepEqual(queuedNoticeIdsOf(blocked), ["2", "3"], "the blocked head keeps the list it was claimed with");
    await store.ingestPoll({ agent_id: "crash", room_id: "room", last_observed_message_id: "4", messages: [boardNotice("4")] });
    await store.retryBlocked(head.inbox_item_id);
    assert.deepEqual(queuedNoticeIdsOf((await store.claimHead("crash"))!), ["2", "3", "4"], "Retry rebuilds it");

    await store.ingestPoll({ agent_id: "late", room_id: "room", last_observed_message_id: "2", messages: [boardNotice("1"), boardNotice("2")] });
    const claimed = (await store.claimHead("late"))!;
    await store.ingestPoll({ agent_id: "late", room_id: "room", last_observed_message_id: "3", messages: [personMessage("3")] });
    assert.deepEqual(await queueOrder(store, "late"), ["1", "3", "2"]);
    await runQueuedTurn(store, claimed);
    assert.equal((await store.getBySourceMessage("late", "room", "2"))!.state, "acknowledged_no_reply",
      "the turn's prompt already carried notice 2, so it settles even though the person now sits ahead of it");
    await store.close();
  } finally { await env.cleanup(); }
});
