import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { applyExecutionStorageSchema, validateExecutionStorageSchema } from "../execution-storage-schema.js";
import { ExecutionProtocolError, parseExecutionFact, type ExecutionFact } from "../execution-protocol.js";
import { emptyExecutionProjection, publicApprovalState, reduceDeliveryEvidence, reduceExecutionFact, waitingForApproval, type DeliveryEvidence } from "../execution-reducer.js";
import { ExecutionShadowStore, type ShadowObserver } from "../execution-shadow-store.js";
import { lifecycleAuthorityModeForProvider } from "../lifecycle-authority-mode.js";
import { applyLifecycleProjectionLedgerSchema } from "../lifecycle-projection-ledger.js";
import { parseRoomAgentWorkSummary, type RoomAgentWorkSummary } from "../../../../shared/room-agent-work.mjs";

function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  applyExecutionStorageSchema(db);
  applyLifecycleProjectionLedgerSchema(db);
  const store = new ExecutionShadowStore(db);
  return { db, store };
}

test("typed lifecycle witnesses commit atomically with their exact execution fact", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    const active = turnFact(1, { nativeEventId: "native-active" });
    assert.equal(store.ingest(token.sourceId, token, active).status, "accepted");
    assert.equal(store.ingest(token.sourceId, token, active).status, "duplicate");
    assert.deepEqual({ ...db.prepare(`SELECT native_event_id,typed_phase,typed_state,legacy_state,classification
      FROM lifecycle_projection_pairs`).get() }, {
      native_event_id: "native-active",
      typed_phase: "turn_active",
      typed_state: "working",
      legacy_state: null,
      classification: "incomplete",
    });

    db.exec(`CREATE TEMP TRIGGER fail_lifecycle_projection BEFORE INSERT ON lifecycle_projection_pairs
      BEGIN SELECT RAISE(ABORT,'injected lifecycle write failure'); END`);
    assert.throws(() => store.ingest(token.sourceId, token,
      turnFact(2, { factId: "fact-terminal", nativeEventId: "native-terminal", state: "terminal", turnOutcome: "completed" })),
    /injected lifecycle write failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_facts WHERE fact_id='fact-terminal'").get()!.count, 0);
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers WHERE agent_id='agent'").get()!.last_source_sequence, 1);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test("replaying a pre-ledger execution fact cannot manufacture typed comparison history", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    const active = turnFact(1, { nativeEventId: "historical-active" });
    db.prepare(`INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,
      observer_epoch,source_sequence,native_event_id,turn_id,domain,kind,state,side_effects,observed_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      active.factId, active.agentId, active.executionGenerationId, active.runtimeGenerationId,
      active.observerEpoch, active.sourceSequence, active.nativeEventId!, active.turnId,
      active.domain, active.kind, active.state, active.sideEffects, active.observedAtMs,
    );
    db.prepare("UPDATE execution_observers SET last_source_sequence=1,max_observed_sequence=1 WHERE agent_id='agent'").run();
    assert.equal(store.ingest(token.sourceId, token, active).status, "duplicate");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 0,
      "only facts committed by the current typed-shadow implementation may enter the comparison ledger");
  } finally { db.close(); }
});

test("lifecycle facts receive atomic shadow or pending dispositions while tool facts do not", () => {
  const shadow = fixture();
  try {
    seed(shadow.store); const token = observer(shadow.store);
    shadow.store.ingest(token.sourceId, token, turnFact(1));
    shadow.store.ingest(token.sourceId, token, operationFact(2));
    assert.deepEqual(shadow.db.prepare(`SELECT effect_kind,state,subject_authority_mode,observer_authority_mode
      FROM execution_lifecycle_effects ORDER BY fact_sequence`).all().map(row => ({ ...row })), [{
      effect_kind: "manifest_working", state: "shadowed",
      subject_authority_mode: "typed_shadow", observer_authority_mode: "typed_shadow",
    }]);
  } finally { shadow.db.close(); }

  const typed = fixture();
  try {
    seed(typed.store, "", "typed"); const token = observer(typed.store);
    assert.equal(typed.store.ingest(token.sourceId, token, turnFact(1)).status, "accepted");
    assert.deepEqual({ ...typed.db.prepare(`SELECT effect_kind,state,disposed_at_ms
      FROM execution_lifecycle_effects`).get() }, {
      effect_kind: "manifest_working", state: "pending", disposed_at_ms: null,
    });
    typed.db.exec(`CREATE TEMP TRIGGER reject_lifecycle_effect BEFORE INSERT ON execution_lifecycle_effects
      BEGIN SELECT RAISE(ABORT,'injected disposition failure'); END`);
    assert.throws(() => typed.store.ingest(token.sourceId, token,
      turnFact(2, { state: "terminal", turnOutcome: "completed" })), /injected disposition failure/);
    assert.equal(typed.db.prepare("SELECT COUNT(*) AS count FROM execution_facts").get()?.count, 1,
      "a fact cannot commit without its disposition");
    assert.equal(typed.db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 1);
  } finally { typed.db.close(); }
});
function countHistoryReads(t: TestContext, db: DatabaseSync): () => number {
  const prepare = db.prepare.bind(db);
  let count = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    if (sql.includes("WHERE f.runtime_generation_id=? ORDER BY f.sequence")) count++;
    return prepare(sql);
  });
  return () => count;
}
function countBudgetReads(t: TestContext, db: DatabaseSync): () => number {
  const prepare = db.prepare.bind(db);
  let count = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    if (sql.includes("SELECT COUNT(*) AS facts,COALESCE(SUM(")) {
      assert.match(sql, /FROM \(SELECT .* FROM execution_facts WHERE agent_id=\? LIMIT 10001\)/s,
        "the row bound must apply before aggregation");
      count++;
    }
    return prepare(sql);
  });
  return () => count;
}
// Real retained-row limits, seeded without 10,000 separate store transactions.
// The rows are the same strict runtime facts emitted by fact(sequence).
function retainFacts(db: DatabaseSync, from: number, through: number): void {
  db.prepare(`WITH RECURSIVE positions(value) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT value+1 FROM positions WHERE value<?)
    INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,
      source_sequence,domain,kind,state,side_effects,observed_at_ms)
    SELECT 'fact-'||value,'agent','generation','runtime',1,value,'runtime','state_changed','ready','none',100+value
    FROM positions`).run(from, through);
  db.prepare("UPDATE execution_observers SET last_source_sequence=?,max_observed_sequence=? WHERE agent_id='agent'").run(through, through);
}
const native = { turnId: "turn", providerContinuationId: "conversation", providerTurnId: "native-turn" };
function seed(store: ExecutionShadowStore, suffix = "", authorityMode: "typed_shadow" | "typed" = "typed_shadow") {
  const runtime = {
    agentId: `agent${suffix}`, executionGenerationId: `generation${suffix}`, runtimeGenerationId: `runtime${suffix}`,
    provider: "codex" as const, authorityMode, configRevision: 1, createdAtMs: 100,
  };
  store.registerRuntime(runtime);
  const attemptId = store.trackMessage({
    agentId: runtime.agentId, roomId: "room", sourceMessageId: "message", executionGenerationId: runtime.executionGenerationId,
    workspaceId: `workspace${suffix}`, createdAtMs: 100,
  });
  const turn = { turnId: `turn${suffix}`, providerContinuationId: `conversation${suffix}`, providerTurnId: `native-turn${suffix}` };
  store.trackNativeTurn({ agentId: runtime.agentId, executionGenerationId: runtime.executionGenerationId,
    runtimeGenerationId: runtime.runtimeGenerationId, ...turn, attemptId, roomId: "room", createdAtMs: 100 });
  return { runtime, attemptId, turn };
}
function observer(store: ExecutionShadowStore, extra: Record<string, unknown> = {}): ShadowObserver {
  return store.bindObserver({
    agentId: "agent", subjectRuntimeGenerationId: "runtime", observerRuntimeGenerationId: "runtime",
    sourceId: extra.expectedEpoch ? `replacement-source-${extra.expectedEpoch}` : "source",
    daemonGenerationId: "daemon", expectedEpoch: 0, boundAtMs: 100, ...extra,
  });
}
function fact(sequence: number, values: Record<string, unknown> = {}): ExecutionFact {
  return parseExecutionFact({
    factId: `fact-${sequence}`, agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "runtime",
    observerEpoch: 1, sourceSequence: sequence, observedAtMs: 100 + sequence,
    domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none", ...values,
  });
}
function turnFact(sequence: number, values: Record<string, unknown> = {}): ExecutionFact {
  return fact(sequence, { ...native, domain: "turn", state: "active", ...values });
}
function operationFact(sequence: number, values: Record<string, unknown> = {}): ExecutionFact {
  const { state: _state, ...base } = fact(sequence) as Extract<ExecutionFact, { domain: "runtime" }>;
  return parseExecutionFact({ ...base, ...native, domain: "execution", kind: "started", executionId: "command", operation: "command", ...values });
}
function roomSummary(store: ExecutionShadowStore): RoomAgentWorkSummary {
  const result = store.roomWorkSummary("agent", "room", "message");
  if (result.availability !== "available") assert.fail(JSON.stringify(result));
  assert.deepEqual(parseRoomAgentWorkSummary(result.summary), result.summary);
  return result.summary;
}

test("runtime authority freezes on first exact materialization and successor births may differ", () => {
  const { db, store } = fixture();
  try {
    const first = { agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "runtime",
      provider: "codex" as const, authorityMode: "typed_shadow" as const, configRevision: 1, createdAtMs: 100 };
    assert.equal(store.registerRuntime(first), "typed_shadow");
    assert.equal(store.registerRuntime({ ...first, authorityMode: "typed", createdAtMs: 200 }), "typed_shadow",
      "a changed release request cannot relabel the same exact birth");
    assert.deepEqual({ ...db.prepare("SELECT authority_mode,created_at_ms FROM execution_runtime_generations WHERE runtime_generation_id='runtime'").get() },
      { authority_mode: "typed_shadow", created_at_ms: 100 });
    assert.throws(() => store.registerRuntime({ ...first, provider: "cursor" }), /identity_mismatch/);
    assert.throws(() => store.registerRuntime({ ...first, configRevision: 2 }), /identity_mismatch/);
    assert.equal(store.registerRuntime({ ...first, executionGenerationId: "successor-generation",
      runtimeGenerationId: "successor-runtime", authorityMode: "typed", createdAtMs: 300 }), "typed");
    assert.equal(db.prepare("SELECT authority_mode FROM execution_runtime_generations WHERE runtime_generation_id='successor-runtime'").get()?.authority_mode, "typed");
  } finally { db.close(); }
});

test("the closed production release policy keeps every provider in typed shadow", () => {
  for (const provider of ["codex", "claude-code", "cursor", "open-model"] as const) {
    assert.equal(lifecycleAuthorityModeForProvider(provider), "typed_shadow");
  }
});

test("typed capture accepts typed runtimes and Cursor recovery preserves each child's frozen mode", () => {
  const { db, store } = fixture();
  try {
    const subject = { agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "cursor-shadow",
      provider: "cursor" as const, authorityMode: "typed_shadow" as const, configRevision: 1, createdAtMs: 100 };
    store.registerRuntime(subject);
    const attemptId = store.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "message",
      executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
    store.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation",
      runtimeGenerationId: "cursor-shadow", attemptId, ...native, createdAtMs: 100 });
    store.registerRuntime({ ...subject, executionGenerationId: "successor-generation", runtimeGenerationId: "cursor-typed",
      authorityMode: "typed", createdAtMs: 200 });
    assert.doesNotThrow(() => store.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: "cursor-shadow",
      observerRuntimeGenerationId: "cursor-typed", daemonGenerationId: "daemon", sourceId: "cursor-source",
      expectedEpoch: 0, boundAtMs: 200, recovery: native }));

    const typed = { agentId: "typed-agent", executionGenerationId: "typed-generation", runtimeGenerationId: "typed-runtime",
      provider: "codex" as const, authorityMode: "typed" as const, configRevision: 1, createdAtMs: 100 };
    assert.equal(store.registerRuntime(typed), "typed");
    const typedAttempt = store.trackMessage({ agentId: typed.agentId, roomId: "room", sourceMessageId: "typed-message",
      executionGenerationId: typed.executionGenerationId, workspaceId: "typed-workspace", createdAtMs: 100 });
    assert.doesNotThrow(() => store.trackNativeTurn({ agentId: typed.agentId, roomId: "room",
      executionGenerationId: typed.executionGenerationId, runtimeGenerationId: typed.runtimeGenerationId,
      attemptId: typedAttempt, turnId: "typed-turn", providerContinuationId: "typed-continuation",
      providerTurnId: "typed-native-turn", createdAtMs: 100 }));

    const legacy = { ...typed, agentId: "legacy-agent", executionGenerationId: "legacy-generation",
      runtimeGenerationId: "legacy-runtime", authorityMode: "legacy" as const };
    store.registerRuntime(legacy);
    const legacyAttempt = store.trackMessage({ agentId: legacy.agentId, roomId: "room", sourceMessageId: "legacy-message",
      executionGenerationId: legacy.executionGenerationId, workspaceId: "legacy-workspace", createdAtMs: 100 });
    assert.throws(() => store.trackNativeTurn({ agentId: legacy.agentId, roomId: "room",
      executionGenerationId: legacy.executionGenerationId, runtimeGenerationId: legacy.runtimeGenerationId,
      attemptId: legacyAttempt, turnId: "legacy-turn", providerContinuationId: "legacy-continuation",
      providerTurnId: "legacy-native-turn", createdAtMs: 100 }), /invalid_transition/);
    store.registerRuntime({ ...subject, executionGenerationId: "legacy-observer-generation",
      runtimeGenerationId: "cursor-legacy", authorityMode: "legacy", createdAtMs: 300 });
    assert.throws(() => store.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: "cursor-shadow",
      observerRuntimeGenerationId: "cursor-legacy", daemonGenerationId: "daemon", sourceId: "legacy-observer",
      expectedEpoch: 1, boundAtMs: 300, recovery: native }), /identity_mismatch/);
    assert.throws(() => store.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: "cursor-legacy",
      observerRuntimeGenerationId: "cursor-typed", daemonGenerationId: "daemon", sourceId: "legacy-subject",
      expectedEpoch: 1, boundAtMs: 300, recovery: native }), /identity_mismatch/);
  } finally { db.close(); }
});

test("retained message execution exposes only exact recorded structural facts", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    assert.deepEqual(store.retainedMessageExecution("agent", "room", "message"), { availability: "not_captured" });
    assert.deepEqual(store.roomWorkSummary("agent", "room", "message"), { availability: "not_captured" });
    store.ingest("source", token, fact(1));
    assert.deepEqual(store.retainedMessageExecution("agent", "room", "message"), { availability: "not_captured" }, "runtime evidence is not turn evidence");
    assert.deepEqual(store.roomWorkSummary("agent", "room", "message"), { availability: "not_captured" });
    store.ingest("source", token, turnFact(2));
    store.ingest("source", token, operationFact(3));
    store.ingest("source", token, operationFact(4, { kind: "output", outputBytes: 12 }));
    const detail = store.retainedMessageExecution("agent", "room", "message");
    assert.deepEqual(detail, { availability: "available", truncated: false, evidenceIncomplete: false, turns: [{
      turnId: "turn", state: "active", outcome: null, operations: [{ executionId: "command", operation: "command",
        outcome: null, startObserved: true, outputBytes: 12, sideEffects: "none", exitCode: null, signalNumber: null }],
    }] });
    for (const coordinates of [["other", "room", "message"], ["agent", "other", "message"], ["agent", "room", "other"]]) {
      assert.deepEqual(store.retainedMessageExecution(...coordinates as [string, string, string]), { availability: "not_captured" });
      assert.deepEqual(store.roomWorkSummary(...coordinates as [string, string, string]), { availability: "not_captured" });
    }
    assert.equal(roomSummary(store).operation_counts.unresolved, 1);
    assert.equal(roomSummary(store).evidence_incomplete, false);
    store.observeSourcePosition("source", token, 6);
    const gap = store.retainedMessageExecution("agent", "room", "message");
    assert.equal(gap.availability === "available" && gap.evidenceIncomplete, true);
    assert.equal(roomSummary(store).evidence_incomplete, true);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test("retained message execution bounds operations and isolates optional read failures", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store); store.ingest("source", token, turnFact(1));
    for (let index = 0; index < 129; index++) store.ingest("source", token, operationFact(index + 2, { executionId: `operation-${index}` }));
    const detail = store.retainedMessageExecution("agent", "room", "message");
    assert.equal(detail.availability, "available");
    if (detail.availability !== "available") assert.fail();
    assert.equal(detail.truncated, true); assert.equal(detail.turns[0]!.operations.length, 128);
    assert.equal(roomSummary(store).operation_counts.unresolved, 129, "room counts are not limited by the Inspector");
    assert.equal(roomSummary(store).evidence_incomplete, false);
    db.exec("DROP TABLE execution_observer_sources; DROP TABLE execution_observers");
    assert.deepEqual(store.retainedMessageExecution("agent", "room", "message"), { availability: "unavailable" });
    assert.deepEqual(store.roomWorkSummary("agent", "room", "message"), { availability: "unavailable" });
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_turns").get()!.n, 1);
  } finally { db.close(); }
});

test("retained message execution bounds candidate scans before joining uncaptured identities", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    for (let index = 0; index < 1000; index++) {
      db.prepare(`INSERT INTO execution_turns(turn_id,agent_id,execution_generation_id,runtime_generation_id,attempt_id,
        room_id,provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms)
        SELECT ?,agent_id,execution_generation_id,runtime_generation_id,attempt_id,room_id,
          provider_continuation_id,?,'terminal','none',?,? FROM execution_turns WHERE turn_id='turn'`)
        .run(`uncaptured-${index}`, `uncaptured-native-${index}`, 1000 + index, 1000 + index);
    }
    const prepare = db.prepare.bind(db);
    let queryPlan = "";
    t.mock.method(db, "prepare", (sql: string) => {
      if (sql.includes("WITH captured AS MATERIALIZED")) {
        const args = sql.includes("AS message_attempt_id") ? ["agent"] : ["agent", "room", "message"];
        queryPlan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join("\n");
      }
      return prepare(sql);
    });
    assert.deepEqual(store.retainedMessageExecution("agent", "room", "message"), { availability: "not_captured" });
    assert.deepEqual(store.roomWorkSummary("agent", "room", "message"), { availability: "not_captured" });
    store.ingest("source", token, turnFact(1));
    const detail = store.retainedMessageExecution("agent", "room", "message");
    assert.equal(detail.availability, "available");
    assert.equal(detail.availability === "available" && detail.turns.length, 1);
    assert.equal(store.roomWorkSummary("agent", "room", "message").availability, "available");
    assert.match(queryPlan, /MATERIALIZE captured/);
    assert.match(queryPlan, /execution_facts_agent_sequence \(agent_id=\?\)/);
    assert.match(queryPlan, /SEARCH t USING INDEX \S+ \(turn_id=\?(?: AND |\))/);
    assert.doesNotMatch(queryPlan, /SCAN t\b|SEARCH t .*\(agent_id=/);
    retainFacts(db, 2, 10001);
    assert.deepEqual(store.retainedMessageExecution("agent", "room", "absent"), { availability: "unavailable" },
      "an oversized journal cannot claim that a turn beyond its bounded prefix was never captured");
    assert.deepEqual(store.roomWorkSummary("agent", "room", "message"), { availability: "unavailable" });
  } finally { db.close(); }
});

test("retained message execution follows historical generations and bounds turns and runtimes", () => {
  for (const multipleRuntimes of [false, true]) {
    const { db, store } = fixture();
    try {
      for (let index = 0; index < (multipleRuntimes ? 9 : 33); index++) {
        const runtime = multipleRuntimes ? `runtime-${index}` : "runtime";
        const generation = multipleRuntimes ? `generation-${index}` : "generation";
        store.registerRuntime({ agentId: "agent", executionGenerationId: generation, runtimeGenerationId: runtime,
          provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 100 });
        const attemptId = store.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "message", executionGenerationId: generation, workspaceId: "workspace", createdAtMs: 100 });
        const turn = { turnId: `turn-${index}`, providerContinuationId: "conversation", providerTurnId: `native-${index}` };
        store.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: generation, runtimeGenerationId: runtime, attemptId, ...turn, createdAtMs: 100 + index });
        const token = store.bindObserver({ agentId: "agent", subjectRuntimeGenerationId: runtime, observerRuntimeGenerationId: runtime,
          daemonGenerationId: "daemon", expectedEpoch: index, sourceId: `source-${index}`, boundAtMs: 100 + index });
        store.ingest(`source-${index}`, token, turnFact(1, { ...turn, factId: `terminal-${index}`, executionGenerationId: generation,
          runtimeGenerationId: runtime, observerEpoch: token.epoch, state: "terminal", turnOutcome: "completed" }));
        store.ingest(`source-${index}`, token, operationFact(2, { ...turn, factId: `operation-${index}`, executionGenerationId: generation,
          runtimeGenerationId: runtime, observerEpoch: token.epoch, kind: "completed", outcome: "succeeded" }));
      }
      const detail = store.retainedMessageExecution("agent", "room", "message");
      if (detail.availability !== "available") assert.fail(JSON.stringify(detail));
      assert.equal(detail.truncated, true); assert.equal(detail.turns.length, multipleRuntimes ? 8 : 32);
      assert.equal(detail.turns[0]!.turnId, multipleRuntimes ? "turn-8" : "turn-32", "newest retained evidence is presented first");
      assert.equal(detail.turns[1]!.turnId, multipleRuntimes ? "turn-7" : "turn-31", "current observer runtime must not hide historical turns");
      assert.equal(detail.turns.every(turn => turn.state === "terminal" && turn.outcome === "completed"), true);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_message_attempts").get()!.n, 1);
      const summary = roomSummary(store);
      assert.equal(summary.recorded_state, "active", "native completion alone is not a delivery receipt");
      assert.equal(summary.operation_counts.succeeded, multipleRuntimes ? 9 : 33);
      assert.equal(summary.evidence_incomplete, false);
      db.exec("DROP TRIGGER execution_facts_immutable; UPDATE execution_facts SET turn_outcome=NULL");
      const legacy = store.retainedMessageExecution("agent", "room", "message");
      assert.equal(legacy.availability === "available" && legacy.evidenceIncomplete, true);
      assert.equal(legacy.availability === "available" && legacy.turns.every(turn => turn.outcome === null), true,
        "unverified turn terminals do not invent outcomes even when operations were observed");
      assert.equal(roomSummary(store).evidence_incomplete, true);
    } finally { db.close(); }
  }
});

test("retained message execution keeps selection and projection in one WAL snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "retained-execution-snapshot-"));
  const { db, store } = fixture(join(directory, "state.sqlite")); db.exec("PRAGMA journal_mode=WAL");
  const peer = new DatabaseSync(join(directory, "state.sqlite"));
  try {
    seed(store); const token = observer(store); store.ingest("source", token, turnFact(1));
    const project = store.projectRuntime.bind(store);
    let wrote = false;
    t.mock.method(store, "projectRuntime", (runtime: string) => {
      if (!wrote) {
        wrote = true;
        peer.exec(`INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,
          source_sequence,domain,kind,state,side_effects,observed_at_ms,turn_id,turn_outcome)
          VALUES('terminal','agent','generation','runtime',1,2,'turn','state_changed','terminal','none',102,'turn','completed');
          UPDATE execution_observers SET last_source_sequence=2,max_observed_sequence=2 WHERE agent_id='agent'`);
      }
      return project(runtime);
    });
    const first = store.retainedMessageExecution("agent", "room", "message");
    const second = store.retainedMessageExecution("agent", "room", "message");
    assert.equal(first.availability === "available" && first.turns[0]!.state, "active");
    assert.equal(second.availability === "available" && second.turns[0]!.outcome, "completed");
  } finally { peer.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("room summary preserves exact message identity, operation outcomes and durable receipt conclusions across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "room-work-summary-"));
  const file = join(directory, "state.sqlite");
  const { db, store } = fixture(file);
  let serialized = "";
  let closed = false;
  try {
    const { attemptId } = seed(store); const token = observer(store);
    store.ingest("source", token, turnFact(1));
    let sequence = 2;
    for (const outcome of ["succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start"]) {
      store.ingest("source", token, operationFact(sequence++, { executionId: outcome, kind: "completed", outcome }));
    }
    // Output can be the first retained witness. Re-observation of that native
    // event must not create another operation or attempt.
    for (let repeat = 0; repeat < 2; repeat++) store.ingest("source", token, operationFact(sequence++, {
      executionId: "output-only", kind: "output", outputBytes: 42, nativeEventId: "native-output",
    }));
    store.ingest("source", token, turnFact(sequence++, { state: "terminal", turnOutcome: "completed" }));
    assert.equal(roomSummary(store).recorded_state, "active", "a native completion does not prove reply publication");
    for (const [roomId, sourceMessageId] of [["room", "other-message"], ["other-room", "message"]]) {
      const other = { turnId: `turn-${roomId}-${sourceMessageId}`, providerContinuationId: "conversation", providerTurnId: `native-${roomId}-${sourceMessageId}` };
      const otherAttempt = store.trackMessage({ agentId: "agent", roomId, sourceMessageId, executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
      store.trackNativeTurn({ agentId: "agent", roomId, executionGenerationId: "generation", runtimeGenerationId: "runtime", attemptId: otherAttempt, ...other, createdAtMs: 100 });
      store.ingest("source", token, operationFact(sequence++, { ...other, executionId: "foreign", kind: "completed", outcome: "failed" }));
      store.ingest("source", token, turnFact(sequence++, { ...other, state: "terminal", turnOutcome: "completed" }));
    }
    const peer = seed(store, "-peer");
    const peerObserver = observer(store, { agentId: "agent-peer", subjectRuntimeGenerationId: "runtime-peer", observerRuntimeGenerationId: "runtime-peer" });
    store.ingest("source", peerObserver, operationFact(1, { agentId: "agent-peer", executionGenerationId: "generation-peer",
      runtimeGenerationId: "runtime-peer", ...peer.turn, factId: "peer-op", kind: "completed", outcome: "failed" }));
    const before = db.prepare("SELECT total_changes() AS n").get()!.n;
    const summary = roomSummary(store);
    assert.deepEqual(summary, { version: 1, recorded_state: "active", evidence_incomplete: false, elapsed_ms: null,
      operation_counts: { unresolved: 1, succeeded: 1, failed: 1, denied_before_start: 1, cancelled_before_start: 1, interrupted_after_start: 1, lost_after_start: 1 } });
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, before, "projection never writes lifecycle or delivery state");
    assert.doesNotMatch(JSON.stringify(summary), /turnId|executionId|runtime|workspace|conversation|native-output|outputBytes|sideEffects/);
    for (const [state, conclusion, expected] of [
      ["cleanly_concluded", "replied", "completed"], ["cleanly_concluded", "acknowledged_no_reply", "completed_no_reply"],
      ["failed", "failed", "failed"], ["interrupted", "interrupted", "interrupted"], ["lost", "lost", "lost"],
    ]) {
      db.prepare("UPDATE execution_message_attempts SET state=?,conclusion=?,settled_at_ms=1000 WHERE attempt_id=?").run(state, conclusion, attemptId);
      assert.equal(roomSummary(store).recorded_state, expected);
      assert.equal(roomSummary(store).elapsed_ms, null, "publication timestamps are not execution duration");
    }
    serialized = JSON.stringify(store.roomWorkSummary("agent", "room", "message"));
    db.close(); closed = true;
    const reopened = fixture(file);
    try { assert.equal(JSON.stringify(reopened.store.roomWorkSummary("agent", "room", "message")), serialized); }
    finally { reopened.db.close(); }
  } finally { if (!closed) db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("room summary reads receipt, watermark and operations in one WAL snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "room-work-snapshot-"));
  const { db, store } = fixture(join(directory, "state.sqlite")); db.exec("PRAGMA journal_mode=WAL");
  const peer = new DatabaseSync(join(directory, "state.sqlite"));
  try {
    seed(store); const token = observer(store); store.ingest("source", token, turnFact(1));
    const prepare = db.prepare.bind(db);
    let wrote = false;
    t.mock.method(db, "prepare", (sql: string) => {
      if (!wrote && sql.includes("AS message_attempt_id")) {
        wrote = true;
        peer.exec(`INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,
          source_sequence,domain,kind,side_effects,observed_at_ms,turn_id,execution_id,operation,outcome)
          VALUES('terminal','agent','generation','runtime',1,2,'execution','completed','none',102,'turn','op','command','failed');
          UPDATE execution_message_attempts SET state='failed',conclusion='failed',settled_at_ms=200;
          UPDATE execution_observers SET last_source_sequence=2,max_observed_sequence=3 WHERE agent_id='agent'`);
      }
      return prepare(sql);
    });
    const first = roomSummary(store); const second = roomSummary(store);
    assert.equal(first.recorded_state, "active"); assert.equal(first.evidence_incomplete, false); assert.equal(first.operation_counts.failed, 0);
    assert.equal(second.recorded_state, "failed"); assert.equal(second.evidence_incomplete, true); assert.equal(second.operation_counts.failed, 1);
    assert.equal(db.isTransaction, false);
  } finally { peer.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("strict facts cannot smuggle content or infer loss from work duration", () => {
  for (const extra of [{ output: "secret" }, { command: "rm file" }, { path: "/Users/private" }, { reason: "trust me" }, { sideEffects: "possible" }]) {
    assert.throws(() => fact(1, extra), ExecutionProtocolError);
  }
  assert.throws(() => fact(1, { domain: "control", state: "lost" }), /invalid_fact/);
  assert.throws(() => fact(1, { state: "exited", controlEvidence: "timeout" }), /invalid_fact/);
  assert.throws(() => turnFact(1, { state: "terminal" }), /invalid_fact/);
  assert.throws(() => turnFact(1, { turnOutcome: "failed" }), /invalid_fact/);
  assert.throws(() => operationFact(1, { kind: "completed", outcome: "denied_before_start", sideEffects: "observed" }), /invalid_fact/);
  assert.throws(() => operationFact(1, { kind: "completed", outcome: "cancelled_before_start", exitCode: 1 }), /invalid_fact/);
  assert.throws(() => fact(1, { factId: "\u001b[31mspoof" }), /invalid_fact/);
  assert.doesNotThrow(() => fact(1, { domain: "control", state: "degraded" }));
  assert.doesNotThrow(() => fact(1, { state: "exited", controlEvidence: "process_exit" }));
});

test("a failed tool leaves its native turn, runtime and continuation alive", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, fact(1)); store.ingest(token.sourceId, token, turnFact(2));
    store.ingest(token.sourceId, token, operationFact(3, { sideEffects: "possible" }));
    store.ingest(token.sourceId, token, operationFact(4, { kind: "completed", outcome: "failed", exitCode: 1, sideEffects: "observed" }));
    const { projection } = store.projectRuntime("runtime");
    assert.equal(projection.runtime, "ready");
    assert.equal(projection.continuation, "available");
    assert.equal(projection.turns.get("turn")?.state, "active");
    assert.equal(projection.turns.get("turn")?.operations.get("command")?.outcome, "failed");
    assert.equal(projection.turns.get("turn")?.sideEffects, "observed");
    assert.equal(db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()?.runtime_state, "ready");
    assert.equal(db.prepare("SELECT state FROM execution_turns").get()?.state, "active");
  } finally { db.close(); }
});

test("all six operation terminals remain distinct without promoting to a runtime terminal", () => {
  for (const outcome of ["succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start"]) {
    let projection = reduceExecutionFact(emptyExecutionProjection(), fact(1));
    projection = reduceExecutionFact(projection, turnFact(2));
    projection = reduceExecutionFact(projection, operationFact(3, { kind: "completed", outcome }));
    assert.equal(projection.runtime, "ready");
    assert.equal(projection.turns.get("turn")?.operations.get("command")?.outcome, outcome);
  }
});

test("journal ordering ignores clock order; duplicate observations have no repeated output", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, fact(1, { observedAtMs: 1000 }));
    store.ingest(token.sourceId, token, turnFact(2, { observedAtMs: 0 }));
    const output = operationFact(3, { kind: "output", outputBytes: 42, observedAtMs: 1 });
    assert.equal(store.ingest(token.sourceId, token, output).status, "accepted");
    assert.equal(store.ingest(token.sourceId, token, output).status, "duplicate");
    assert.throws(() => store.ingest(token.sourceId, token, { ...output, outputBytes: 43 }), /sequence_conflict/);
    assert.throws(() => store.ingest(token.sourceId, token, { ...output, factId: "replacement" }), /sequence_conflict/);
    assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 42);
    assert.deepEqual(db.prepare("SELECT sequence FROM execution_facts ORDER BY sequence").all().map(r => r.sequence), [1, 2, 3]);
  } finally { db.close(); }
});

test("warm ingestion reuses projection history and matches cold replay", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const peer = seed(store, "peer"); const token = observer(store);
    const peerToken = observer(store, { agentId: peer.runtime.agentId, subjectRuntimeGenerationId: peer.runtime.runtimeGenerationId,
      observerRuntimeGenerationId: peer.runtime.runtimeGenerationId });
    const reads = countHistoryReads(t, db);
    const budgetReads = countBudgetReads(t, db);
    store.ingest(token.sourceId, token, fact(1)); store.ingest(token.sourceId, token, turnFact(2));
    store.ingest(peerToken.sourceId, peerToken, fact(1, { agentId: peer.runtime.agentId, executionGenerationId: peer.runtime.executionGenerationId,
      runtimeGenerationId: peer.runtime.runtimeGenerationId, factId: "peer-ready" }));
    for (let sequence = 3; sequence <= 100; sequence++) {
      store.trackMessage({ agentId: "agent", executionGenerationId: "generation", workspaceId: "workspace", roomId: "room",
        sourceMessageId: `metadata-${sequence}`, createdAtMs: sequence });
      store.ingest(token.sourceId, token, operationFact(sequence, { kind: "output", outputBytes: 1 }));
      store.ingest(peerToken.sourceId, peerToken, fact(sequence - 1, { agentId: peer.runtime.agentId, executionGenerationId: peer.runtime.executionGenerationId,
        runtimeGenerationId: peer.runtime.runtimeGenerationId, factId: `peer-${sequence}`, domain: "control", state: "responsive" }));
    }
    const warm = store.projectRuntime("runtime");
    assert.equal(reads(), 2, "only each runtime's initial projection should replay journal history");
    assert.equal(budgetReads(), 2, "hot appends and own metadata writes must not rescan per-agent history");
    assert.equal(warm.projection.turns.get("turn")?.operations.get("command")?.outputBytes, 98);
    assert.equal(warm.lastJournalSequence, 198);
    assert.deepEqual(warm, new ExecutionShadowStore(db).projectRuntime("runtime"));
    assert.deepEqual(store.projectRuntime("runtimepeer"), new ExecutionShadowStore(db).projectRuntime("runtimepeer"));
    assert.equal(reads(), 4);
    assert.equal(budgetReads(), 4);
  } finally { db.close(); }
});

test("retention caps physical witnesses without deleting evidence, advancing accepted cursors, or affecting peers", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    retainFacts(db, 1, 9999);
    const last = fact(10000, { nativeEventId: "last-ready" });
    assert.equal(store.ingest(token.sourceId, token, last).status, "accepted");
    for (const reason of ["active_turn", "active_execution", "pending_approval", "uncertain_dispatch", "unresolved_cutover", "replay_authority"]) {
      db.prepare("INSERT INTO execution_retention_pins VALUES(?,'agent',1,?,100)").run(reason, reason);
    }
    db.exec("CREATE TABLE supervised_agent_inbox(id TEXT PRIMARY KEY,state TEXT); INSERT INTO supervised_agent_inbox VALUES('message','dispatching')");
    const before = store.projectRuntime("runtime");
    const protectedRows = ["execution_runtime_generations", "execution_turns", "execution_message_attempts", "execution_retention_pins", "supervised_agent_inbox"]
      .map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const reads = countBudgetReads(t, db);
    assert.deepEqual(store.ingest(token.sourceId, token, fact(10001, { nativeEventId: "last-ready" })), {
      status: "retention_limit", limit: "facts", expectedSourceSequence: 10001, observedSourceSequence: 10001,
    }, "native-event re-observation at a new source position still requires a physical witness");
    assert.deepEqual(store.ingest(token.sourceId, token, last), { status: "duplicate", journalSequence: 10000, gapPending: true });
    assert.deepEqual(store.ingest(token.sourceId, token, fact(10005)), {
      status: "retention_limit", limit: "facts", expectedSourceSequence: 10001, observedSourceSequence: 10005,
    });
    assert.equal(reads(), 0, "repeated cap markers and exact duplicates keep the committed budget cache");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 10000);
    assert.deepEqual({ ...db.prepare("SELECT last_source_sequence,max_observed_sequence FROM execution_observers").get() },
      { last_source_sequence: 10000, max_observed_sequence: 10005 });
    assert.deepEqual(store.projectRuntime("runtime"), before);
    assert.deepEqual(["execution_runtime_generations", "execution_turns", "execution_message_attempts", "execution_retention_pins", "supervised_agent_inbox"]
      .map(table => db.prepare(`SELECT * FROM ${table}`).all()), protectedRows);
    assert.throws(() => observer(store, { expectedEpoch: 1 }), /source_gap/, "a replacement source must not erase suspended capture");
    store.registerRuntime({ agentId: "agent", executionGenerationId: "generation2", runtimeGenerationId: "runtime2",
      provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 200 });
    const rebound = observer(store, { sourceId: token.sourceId, expectedEpoch: 1, subjectRuntimeGenerationId: "runtime2", observerRuntimeGenerationId: "runtime2" });
    assert.equal(rebound.lastSourceSequence, 10000); assert.equal(rebound.maxObservedSequence, 10005);
    assert.equal(store.ingest(rebound.sourceId, rebound, fact(10006, { observerEpoch: 2, runtimeGenerationId: "runtime2", executionGenerationId: "generation2" })).status,
      "retention_limit", "a new runtime cannot reset its agent's budget");
    const peer = seed(store, "peer");
    const peerToken = observer(store, { agentId: peer.runtime.agentId, subjectRuntimeGenerationId: peer.runtime.runtimeGenerationId, observerRuntimeGenerationId: peer.runtime.runtimeGenerationId });
    assert.equal(store.ingest(peerToken.sourceId, peerToken, fact(1, { factId: "peer-ready", agentId: peer.runtime.agentId,
      runtimeGenerationId: peer.runtime.runtimeGenerationId, executionGenerationId: peer.runtime.executionGenerationId })).status, "accepted");
  } finally { db.close(); }
});

test("capacity candidates and suspended-source markers roll back with a failed commit", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store); retainFacts(db, 1, 9999);
    const before = store.projectRuntime("runtime");
    const exec = db.exec.bind(db);
    let failCommit = true;
    t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("injected commit failure"); }
      exec(sql);
    });
    assert.throws(() => store.ingest(token.sourceId, token, fact(10000)), /injected commit failure/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 9999);
    assert.deepEqual(store.projectRuntime("runtime"), before);
    assert.equal(store.ingest(token.sourceId, token, fact(10000)).status, "accepted", "a rolled-back candidate did not consume capacity");
    failCommit = true;
    assert.throws(() => store.ingest(token.sourceId, token, fact(10001)), /injected commit failure/);
    assert.equal(db.prepare("SELECT max_observed_sequence FROM execution_observers").get()?.max_observed_sequence, 10000);
    assert.equal(store.ingest(token.sourceId, token, fact(10001)).status, "retention_limit");
    assert.equal(db.prepare("SELECT max_observed_sequence FROM execution_observers").get()?.max_observed_sequence, 10001);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 10000);
  } finally { db.close(); }
});

test("retained budgets invalidate on shared and external commits but never cache caller-owned transactions", async () => {
  for (const sharedConnection of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "execution-budget-cache-"));
    const { db, store } = fixture(join(root, "state.sqlite"));
    const writer = sharedConnection ? db : new DatabaseSync(join(root, "state.sqlite"));
    try {
      seed(store); const token = observer(store); retainFacts(db, 1, 9999);
      store.projectRuntime("runtime");
      db.exec("BEGIN");
      retainFacts(db, 10000, 10001);
      assert.throws(() => store.projectRuntime("runtime"), /retention_limit/);
      db.exec("ROLLBACK");
      assert.equal(store.projectRuntime("runtime").lastJournalSequence, 9999, "uncommitted oversize was not cached");
      retainFacts(writer, 10000, 10000);
      assert.equal(store.ingest(token.sourceId, token, fact(10001)).status, "retention_limit");
      // A separate writer grows an already warm history past the cap. Reading
      // must fail, not return the previously cached healthy projection.
      retainFacts(writer, 10001, 10002);
      assert.throws(() => store.projectRuntime("runtime"), /retention_limit/);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 10002);
    } finally {
      if (!sharedConnection) writer.close();
      db.close(); await rm(root, { recursive: true, force: true });
    }
  }
});

test("cold replay aggregates a bounded prefix and never materializes an unbounded history array", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); observer(store); retainFacts(db, 1, 10000);
    const budgetReads = countBudgetReads(t, db);
    const prepare = db.prepare.bind(db);
    let historyReads = 0;
    t.mock.method(db, "prepare", (sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("WHERE f.runtime_generation_id=? ORDER BY f.sequence")) {
        historyReads++;
        assert.match(sql, /LIMIT 10001$/);
        t.mock.method(statement, "all", () => { throw new Error("unbounded history allocation"); });
      }
      return statement;
    });
    assert.equal(new ExecutionShadowStore(db).projectRuntime("runtime").lastJournalSequence, 10000);
    assert.equal(historyReads, 1); assert.equal(budgetReads(), 1);
    retainFacts(db, 10001, 10002);
    assert.throws(() => new ExecutionShadowStore(db).projectRuntime("runtime"), { name: "ExecutionProtocolError", code: "retention_limit" });
    assert.equal(historyReads, 1, "oversized history is rejected before any fact-row replay");
    assert.equal(budgetReads(), 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 10002);
  } finally { db.close(); }
});

test("public replay reads one WAL snapshot across agent capacity and every runtime, then invalidates it", async (t) => {
  for (const [sameRuntime, rejectReadCommit] of [[true, false], [false, false], [false, true]]) {
    const root = await mkdtemp(join(tmpdir(), "execution-budget-snapshot-"));
    const path = join(root, "state.sqlite");
    const { db, store } = fixture(path);
    db.exec("PRAGMA journal_mode=WAL");
    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA foreign_keys=ON");
    try {
      seed(store); observer(store); retainFacts(db, 1, 9999);
      store.registerRuntime({ agentId: "agent", executionGenerationId: "generation-b", runtimeGenerationId: "runtime-b",
        provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 200 });
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
      let growBeforeReplay = true;
      let failCommit = rejectReadCommit;
      t.mock.method(db, "exec", (sql: string) => {
        if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("injected read commit failure"); }
        exec(sql);
      });
      t.mock.method(db, "prepare", (sql: string) => {
        if (growBeforeReplay && sql.includes("WHERE f.runtime_generation_id=? ORDER BY f.sequence")) {
          growBeforeReplay = false;
          assert.equal(db.isTransaction, true);
          writer.prepare(`WITH positions(value) AS (VALUES(10000),(10001))
            INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,
              source_sequence,domain,kind,state,side_effects,observed_at_ms)
            SELECT 'fact-'||value,'agent',?,?,1,value,'runtime','state_changed','ready','none',100+value FROM positions`)
            .run(sameRuntime ? "generation" : "generation-b", sameRuntime ? "runtime" : "runtime-b");
        }
        return prepare(sql);
      });
      if (rejectReadCommit) assert.throws(() => store.projectRuntime("runtime"), /injected read commit failure/);
      else assert.equal(store.projectRuntime("runtime").lastJournalSequence, 9999, "the entire read uses the pre-write snapshot");
      assert.equal(growBeforeReplay, false, "the other connection committed after budget admission, before replay");
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 10001);
      assert.throws(() => store.projectRuntime("runtime"), /retention_limit/, "a pre-commit view cannot be cached under the newer writer's stamp");
      assert.equal(db.isTransaction, false, "failed reads release their snapshots too");
    } finally { writer.close(); db.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("byte capacity counts persisted UTF-8 including embedded NUL, not characters or output counters", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    const ceiling = 50 * 1024 * 1024;
    const fixedFactBytes = 256 + Buffer.byteLength("fact-1agentgenerationruntimeruntimestate_changedreadynone", "utf8");
    const payloadBytes = ceiling - 2 * fixedFactBytes + 1;
    // An old DB may contain text beyond the protocol's current identity bound.
    // The next valid fact would cross the byte cap, even though character-count
    // accounting (or SQLite length(TEXT), which stops at NUL) would allow it.
    const payload = "é".repeat(Math.floor((payloadBytes - 1) / 2)) + ((payloadBytes - 1) % 2 ? "x" : "");
    assert.equal(1 + Buffer.byteLength(payload), payloadBytes);
    db.prepare(`INSERT INTO execution_facts(fact_id,agent_id,execution_generation_id,runtime_generation_id,observer_epoch,
      source_sequence,native_event_id,domain,kind,state,side_effects,observed_at_ms)
      VALUES('fact-1','agent','generation','runtime',1,1,char(0)||?,'runtime','state_changed','ready','none',101)`).run(payload);
    db.exec("UPDATE execution_observers SET last_source_sequence=1,max_observed_sequence=1 WHERE agent_id='agent'");
    assert.equal(db.prepare("SELECT length(CAST(native_event_id AS BLOB)) n FROM execution_facts").get()?.n, payloadBytes);
    const reads = countHistoryReads(t, db);
    assert.deepEqual(store.ingest(token.sourceId, token, fact(2)), {
      status: "retention_limit", limit: "bytes", expectedSourceSequence: 2, observedSourceSequence: 2,
    });
    assert.equal(reads(), 0, "capacity rejection precedes decoding the oversized historical value");
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 1);
    retainFacts(db, 2, 2);
    assert.throws(() => store.projectRuntime("runtime"), /retention_limit/);
    assert.equal(reads(), 0, "oversized cold byte history fails before row replay too");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 2);
  } finally { db.close(); }
});

test("public projections cannot mutate cached nested maps or subsequent ingestion", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, turnFact(1));
    store.ingest(token.sourceId, token, operationFact(2, { kind: "output", outputBytes: 42 }));
    const exposed = store.projectRuntime("runtime");
    const turn = exposed.projection.turns.get("turn")!;
    turn.operations.get("command")!.outputBytes = 9000;
    turn.providerTurnId = "spoofed";
    (turn.operations as Map<string, unknown>).clear();
    (exposed.projection.turns as Map<string, unknown>).clear();
    exposed.projection.runtime = "exited";
    exposed.lastJournalSequence = 999;
    store.ingest(token.sourceId, token, operationFact(3, { kind: "output", outputBytes: 5 }));
    const actual = store.projectRuntime("runtime");
    assert.equal(actual.projection.runtime, "starting");
    assert.equal(actual.projection.turns.get("turn")?.providerTurnId, "native-turn");
    assert.equal(actual.projection.turns.get("turn")?.operations.get("command")?.outputBytes, 47);
    assert.deepEqual(actual, new ExecutionShadowStore(db).projectRuntime("runtime"));
  } finally { db.close(); }
});

test("cache invalidates other stores on shared and separate connections", async () => {
  for (const sharedConnection of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "execution-shadow-cache-"));
    const path = join(root, "state.sqlite");
    const { db, store } = fixture(path);
    const writerDb = sharedConnection ? db : new DatabaseSync(path);
    try {
      seed(store); const first = observer(store);
      store.ingest(first.sourceId, first, turnFact(1));
      store.ingest(first.sourceId, first, operationFact(2, { kind: "output", outputBytes: 42 }));
      store.projectRuntime("runtime");
      const writer = new ExecutionShadowStore(writerDb);
      const rebound = observer(writer, { expectedEpoch: 1 });
      writer.ingest(rebound.sourceId, rebound, operationFact(1, { factId: "new-output", observerEpoch: 2, kind: "output", outputBytes: 5 }));
      assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 47);
      assert.throws(() => store.ingest(first.sourceId, first, fact(3)), /stale_observer/);
      // Prefix deletion does not change MAX(sequence). It must still invalidate
      // the read cache; this is not a new retention/compaction implementation.
      writerDb.prepare("DELETE FROM execution_facts WHERE sequence=2").run();
      const afterDelete = store.projectRuntime("runtime");
      assert.equal(afterDelete.lastJournalSequence, 3);
      assert.equal(afterDelete.projection.turns.get("turn")?.operations.get("command")?.outputBytes, 5);
      assert.deepEqual(afterDelete, new ExecutionShadowStore(db).projectRuntime("runtime"));
    } finally {
      if (!sharedConnection) writerDb.close();
      db.close(); await rm(root, { recursive: true, force: true });
    }
  }
});

test("caller-owned rollback and same-connection schema changes cannot poison cache", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, fact(1));
    assert.equal(store.projectRuntime("runtime").projection.runtime, "ready");
    db.exec("BEGIN; DELETE FROM execution_facts");
    assert.equal(store.projectRuntime("runtime").projection.runtime, "starting");
    db.exec("ROLLBACK");
    assert.equal(store.projectRuntime("runtime").projection.runtime, "ready");
    db.exec("ALTER TABLE execution_facts RENAME TO unavailable_facts");
    assert.throws(() => store.projectRuntime("runtime"), /no such table/);
    db.exec("ALTER TABLE unavailable_facts RENAME TO execution_facts");
    assert.equal(store.projectRuntime("runtime").projection.runtime, "ready");
  } finally { db.close(); }
});

test("runtime cache evicts least-recently-used projections and reconstructs them", (t) => {
  const { db, store } = fixture();
  try {
    for (let index = 0; index < 17; index++) seed(store, String(index));
    const reads = countHistoryReads(t, db);
    const budgets = countBudgetReads(t, db);
    for (let index = 0; index < 16; index++) store.projectRuntime(`runtime${index}`);
    store.projectRuntime("runtime0"); // Make runtime1 the oldest.
    store.projectRuntime("runtime16");
    assert.equal(reads(), 17);
    assert.equal(budgets(), 17);
    store.projectRuntime("runtime0");
    assert.equal(reads(), 17);
    assert.equal(budgets(), 17);
    assert.deepEqual(store.projectRuntime("runtime1").projection, emptyExecutionProjection());
    assert.equal(reads(), 18);
    assert.equal(budgets(), 18, "retained per-agent budget entries must be bounded too");
  } finally { db.close(); }
});

test("a single oversized runtime cannot stay in the bounded projection cache", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, turnFact(1));
    for (let index = 0; index < 4096; index++) {
      store.ingest(token.sourceId, token, operationFact(index + 2, { executionId: `command-${index}` }));
    }
    const reads = countHistoryReads(t, db);
    const first = store.projectRuntime("runtime");
    assert.equal(first.projection.turns.get("turn")?.operations.size, 4096);
    assert.deepEqual(first, store.projectRuntime("runtime"));
    assert.equal(reads(), 2, "oversized projections must use durable replay, not a retained cache entry");
  } finally { db.close(); }
});

test("source gaps persist diagnostics, never fabricate terminals, and can be filled", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    assert.deepEqual(store.ingest(token.sourceId, token, turnFact(3)), { status: "gap", expectedSourceSequence: 1, observedSourceSequence: 3 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 0);
    assert.equal(db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()?.runtime_state, "starting");
    const before = db.prepare("SELECT * FROM execution_observers").get();
    assert.throws(() => observer(store, { expectedEpoch: 1 }), /source_gap/, "replacement source cannot erase a known missing range");
    assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), before);
    const resumed = observer(store, { expectedEpoch: 1, sourceId: token.sourceId });
    assert.equal(resumed.lastSourceSequence, 0); assert.equal(resumed.maxObservedSequence, 3);
    assert.throws(() => store.ingest(token.sourceId, token, fact(1)), /stale_observer/);
    assert.equal((store.ingest(resumed.sourceId, resumed, fact(1, { observerEpoch: 2 })) as { gapPending: boolean }).gapPending, true);
    store.ingest(resumed.sourceId, resumed, fact(2, { observerEpoch: 2, domain: "control", state: "responsive" }));
    assert.equal((store.ingest(resumed.sourceId, resumed, turnFact(3, { observerEpoch: 2 })) as { gapPending: boolean }).gapPending, false);
    assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.state, "active");
    const replaced = observer(store, { expectedEpoch: 2 });
    assert.notEqual(replaced.sourceId, resumed.sourceId);
    assert.equal(replaced.lastSourceSequence, 0); assert.equal(replaced.maxObservedSequence, 0);
    assert.throws(() => store.ingest(resumed.sourceId, replaced, fact(1, { factId: "new-source", observerEpoch: 3 })), /identity_mismatch/);
    assert.equal(store.ingest(replaced.sourceId, replaced, fact(1, { factId: "new-source", observerEpoch: 3 })).status, "accepted",
      "a new helper starts at sequence one even when the native runtime has not changed");
  } finally { db.close(); }
});

test("source watermarks preserve unaccepted tails without minting facts and remain exact and atomic", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, fact(1));
    const projection = store.projectRuntime("runtime");
    const before = db.prepare("SELECT * FROM execution_observers").get();
    assert.throws(() => store.observeSourcePosition("wrong-source", token, 4), /identity_mismatch/);
    assert.throws(() => store.observeSourcePosition(token.sourceId, { ...token }, 4), /stale_observer/);
    assert.throws(() => store.observeSourcePosition(token.sourceId, token, -1), /invalid_fact/);
    assert.throws(() => store.observeSourcePosition(token.sourceId, token, 0), /source_gap/);
    assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), before);
    const exec = db.exec.bind(db);
    let failCommit = true;
    t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("injected watermark commit failure"); }
      exec(sql);
    });
    assert.throws(() => store.observeSourcePosition(token.sourceId, token, 4), /injected watermark commit failure/);
    assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), before);
    store.observeSourcePosition(token.sourceId, token, 4);
    store.observeSourcePosition(token.sourceId, token, 2);
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 1);
    assert.equal(db.prepare("SELECT max_observed_sequence FROM execution_observers").get()?.max_observed_sequence, 4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 1);
    assert.deepEqual(store.projectRuntime("runtime"), projection);
    assert.throws(() => observer(store, { expectedEpoch: 1 }), /source_gap/);
    const resumed = observer(store, { expectedEpoch: 1, sourceId: token.sourceId });
    assert.equal(resumed.lastSourceSequence, 1); assert.equal(resumed.maxObservedSequence, 4);
    assert.throws(() => store.observeSourcePosition(token.sourceId, token, 5), /stale_observer/);
    store.observeSourcePosition(resumed.sourceId, resumed, 5);
    assert.equal(db.prepare("SELECT max_observed_sequence FROM execution_observers").get()?.max_observed_sequence, 5);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 1);
    assert.deepEqual(store.projectRuntime("runtime"), projection);
  } finally { db.close(); }
});

test("same-source admission survives store replacement and database reopen without replaying the prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-source-"));
  const path = join(root, "state.sqlite");
  let db: DatabaseSync | undefined;
  try {
    const first = fixture(path); db = first.db;
    seed(first.store); const old = observer(first.store);
    first.store.ingest(old.sourceId, old, fact(1));
    const second = new ExecutionShadowStore(db);
    const rebound = observer(second, { expectedEpoch: 1, sourceId: old.sourceId });
    assert.equal(rebound.lastSourceSequence, 1); assert.equal(rebound.maxObservedSequence, 1);
    assert.throws(() => first.store.ingest(old.sourceId, old, fact(2)), /stale_observer/);
    assert.throws(() => second.ingest(rebound.sourceId, { ...rebound }, fact(2, { observerEpoch: 2 })), /stale_observer/);
    assert.throws(() => second.ingest(rebound.sourceId, rebound, fact(1, { factId: "replay", observerEpoch: 2 })), /sequence_conflict/,
      "admission cursor tells the consumer to skip committed replay, not renumber it");
    second.ingest(rebound.sourceId, rebound, turnFact(2, { observerEpoch: 2 }));
    db.close(); db = undefined;
    const third = fixture(path); db = third.db;
    const reopened = observer(third.store, { expectedEpoch: 2, sourceId: old.sourceId, daemonGenerationId: "new-daemon" });
    assert.equal(reopened.lastSourceSequence, 2); assert.equal(reopened.maxObservedSequence, 2);
    third.store.ingest(reopened.sourceId, reopened, operationFact(3, { observerEpoch: 3, kind: "output", outputBytes: 7 }));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 3);
    assert.equal(third.store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 7);
    const before = db.prepare("SELECT * FROM execution_observers").get();
    db.exec("CREATE TRIGGER reject_rebind BEFORE UPDATE ON execution_observers BEGIN SELECT RAISE(ABORT,'injected rebind failure'); END");
    assert.throws(() => observer(third.store, { expectedEpoch: 3, sourceId: old.sourceId }), /injected rebind failure/);
    assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), before);
    db.exec("DROP TRIGGER reject_rebind");
    third.store.ingest(reopened.sourceId, reopened, operationFact(4, { observerEpoch: 3, kind: "output", outputBytes: 5 }));
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 4);
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});

test("unknown migrated source provenance suspends admission without erasing evidence", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, fact(1));
    db.exec("UPDATE execution_observers SET source_id=NULL");
    const before = db.prepare("SELECT * FROM execution_observers").get();
    for (const sourceId of [token.sourceId, "replacement"]) {
      assert.throws(() => observer(store, { expectedEpoch: 1, sourceId }), /source_unverified/);
    }
    assert.throws(() => store.ingest(token.sourceId, token, fact(2)), /stale_observer/);
    assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 1);
    assert.equal(store.projectRuntime("runtime").projection.runtime, "ready");
  } finally { db.close(); }
});

test("admitted source IDs cannot return as fresh after replacement or fact retention", async () => {
  for (const withFacts of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "execution-retired-source-"));
    const path = join(root, "state.sqlite");
    let db: DatabaseSync | undefined;
    try {
      const first = fixture(path); db = first.db;
      seed(first.store); const a = observer(first.store);
      if (withFacts) {
        first.store.ingest(a.sourceId, a, turnFact(1));
        first.store.ingest(a.sourceId, a, operationFact(2, { kind: "output", outputBytes: 7 }));
      }
      const beforeFailure = db.prepare("SELECT * FROM execution_observers").get();
      db.exec("CREATE TRIGGER reject_source BEFORE INSERT ON execution_observer_sources WHEN NEW.source_id='source-b' BEGIN SELECT RAISE(ABORT,'injected source failure'); END");
      assert.throws(() => observer(first.store, { expectedEpoch: 1, sourceId: "source-b" }), /injected source failure/);
      assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), beforeFailure, "failed registry insert rolls the cursor and epoch back");
      assert.equal(db.prepare("SELECT 1 FROM execution_observer_sources WHERE source_id='source-b'").get(), undefined);
      db.exec("DROP TRIGGER reject_source");
      const b = observer(first.store, { expectedEpoch: 1, sourceId: "source-b" });
      const before = db.prepare("SELECT * FROM execution_observers").get();
      assert.throws(() => observer(first.store, { expectedEpoch: 2, sourceId: a.sourceId }), /stale_observer/);
      assert.deepEqual(db.prepare("SELECT * FROM execution_observers").get(), before);
      if (withFacts) {
        assert.equal(first.store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 7);
      }
      // Admission fences outlive ordinary fact retention, including sources
      // retired before their first observation was recorded.
      db.exec("DELETE FROM execution_facts");
      db.close(); db = undefined;
      const reopened = fixture(path); db = reopened.db;
      assert.throws(() => observer(reopened.store, { expectedEpoch: 2, sourceId: a.sourceId }), /stale_observer/);
      const resumed = observer(reopened.store, { expectedEpoch: 2, sourceId: b.sourceId });
      assert.equal(resumed.lastSourceSequence, 0);
      const peer = seed(reopened.store, "peer");
      assert.doesNotThrow(() => observer(reopened.store, { agentId: peer.runtime.agentId,
        subjectRuntimeGenerationId: peer.runtime.runtimeGenerationId, observerRuntimeGenerationId: peer.runtime.runtimeGenerationId, sourceId: a.sourceId }),
      "admission fencing is agent-scoped");
      db.exec("DELETE FROM execution_observer_sources WHERE agent_id='agent'");
      assert.throws(() => observer(reopened.store, { expectedEpoch: 3, sourceId: b.sourceId }), /source_unverified/,
        "lost admission history must not be recreated silently");
      assert.throws(() => reopened.store.ingest(resumed.sourceId, resumed, fact(1, { observerEpoch: 3 })), /source_unverified/);
    } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("one source follows distinct child lifetimes without misattributing a late old-child exit", () => {
  const { db, store } = fixture();
  try {
    seed(store); const first = observer(store);
    store.ingest(first.sourceId, first, fact(1)); store.ingest(first.sourceId, first, turnFact(2));
    store.ingest(first.sourceId, first, turnFact(3, { state: "terminal", turnOutcome: "completed" }));
    store.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "child2",
      provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 100 });
    const attemptId = store.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "message2", executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 100 });
    const turn2 = { turnId: "turn2", providerContinuationId: "conversation", providerTurnId: "native-turn2" };
    store.trackNativeTurn({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "child2", ...turn2, attemptId, roomId: "room", createdAtMs: 100 });
    const second = observer(store, { expectedEpoch: 1, sourceId: first.sourceId, subjectRuntimeGenerationId: "child2", observerRuntimeGenerationId: "child2" });
    assert.equal(second.lastSourceSequence, 3);
    store.ingest(second.sourceId, second, fact(4, { observerEpoch: 2, runtimeGenerationId: "child2" }));
    store.ingest(second.sourceId, second, turnFact(5, { observerEpoch: 2, runtimeGenerationId: "child2", ...turn2 }));
    const oldExit = fact(6, { observerEpoch: 2, domain: "control", state: "lost", controlEvidence: "process_exit" });
    assert.throws(() => store.ingest(second.sourceId, second, oldExit), /identity_mismatch/);
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 5);
    // The consumer must independently map the captured birth to the retained
    // child. Rebind that exact runtime; never relabel the old exit as child2.
    const late = observer(store, { expectedEpoch: 2, sourceId: first.sourceId });
    assert.equal(late.lastSourceSequence, 5);
    store.ingest(late.sourceId, late, { ...oldExit, observerEpoch: 3 });
    store.ingest(late.sourceId, late, fact(7, { observerEpoch: 3, state: "exited", controlEvidence: "process_exit" }));
    const current = observer(store, { expectedEpoch: 3, sourceId: first.sourceId, subjectRuntimeGenerationId: "child2", observerRuntimeGenerationId: "child2" });
    assert.equal(current.lastSourceSequence, 7);
    assert.throws(() => store.ingest(second.sourceId, second, fact(8)), /stale_observer/);
    store.ingest(current.sourceId, current, turnFact(8, { observerEpoch: 4, runtimeGenerationId: "child2", ...turn2, state: "terminal", turnOutcome: "completed" }));
    assert.equal(store.projectRuntime("runtime").projection.runtime, "exited");
    assert.equal(store.projectRuntime("child2").projection.runtime, "ready");
    assert.equal(store.projectRuntime("child2").projection.turns.get("turn2")?.outcome, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 8);
  } finally { db.close(); }
});

test("native event replay across observers advances the cursor without duplicating projection effects", () => {
  const { db, store } = fixture();
  try {
    seed(store); const first = observer(store);
    store.ingest(first.sourceId, first, fact(1)); store.ingest(first.sourceId, first, turnFact(2));
    const output = operationFact(3, { kind: "output", outputBytes: 42, nativeEventId: "native-output" });
    store.ingest(first.sourceId, first, output);
    const second = observer(store, { expectedEpoch: 1 });
    const replay = { ...output, factId: "replayed-output", observerEpoch: 2, sourceSequence: 1, observedAtMs: 200 };
    assert.equal(store.ingest(second.sourceId, second, replay).status, "duplicate");
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 1);
    assert.throws(() => store.ingest(second.sourceId, second, { ...replay, factId: "changed-native", sourceSequence: 2, outputBytes: 43 }), /sequence_conflict/);
    store.ingest(second.sourceId, second, operationFact(2, { factId: "next-output", observerEpoch: 2, kind: "output", outputBytes: 5, nativeEventId: "next-native-output" }));
    // A new store reconstructs from durable observations, not a process cache.
    const warm = store.projectRuntime("runtime");
    const cold = new ExecutionShadowStore(db).projectRuntime("runtime");
    assert.deepEqual(warm, cold);
    const projection = cold.projection;
    assert.equal(projection.turns.get("turn")?.operations.get("command")?.outputBytes, 47);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 5);
  } finally { db.close(); }
});

test("replaying earlier native facts after terminal or lost state does not request lifecycle transitions", () => {
  for (const state of ["terminal", "lost"] as const) {
    const { db, store } = fixture();
    try {
      seed(store); const first = observer(store);
      const active = turnFact(1, { nativeEventId: "native-active" });
      const output = operationFact(2, { kind: "output", outputBytes: 42, nativeEventId: "native-output" });
      store.ingest(first.sourceId, first, active); store.ingest(first.sourceId, first, output);
      store.ingest(first.sourceId, first, turnFact(3, { state, ...(state === "terminal" ? { turnOutcome: "completed" } : {}) }));
      assert.equal(store.ingest(first.sourceId, first, output).status, "duplicate");
      const second = observer(store, { expectedEpoch: 1 });
      assert.equal(store.ingest(second.sourceId, second, { ...active, factId: "replayed-active", observerEpoch: 2 }).status, "duplicate");
      assert.equal(store.ingest(second.sourceId, second, { ...output, factId: "replayed-output", observerEpoch: 2 }).status, "duplicate");
      assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 2);
      assert.equal(db.prepare("SELECT state FROM execution_turns").get()?.state, state);
      assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.state, state);
      assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 42);
    } finally { db.close(); }
  }
});

test("append and projection/cursor updates are atomic across a failed write or commit", (t) => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, fact(1));
    const before = store.projectRuntime("runtime");
    db.exec("CREATE TRIGGER refuse_shadow_update BEFORE UPDATE ON execution_runtime_generations BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => store.ingest(token.sourceId, token, fact(2, { state: "stopping" })), /injected/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 1);
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 1);
    assert.deepEqual(store.projectRuntime("runtime"), before);
    db.exec("DROP TRIGGER refuse_shadow_update");
    assert.equal(store.ingest(token.sourceId, token, fact(2, { state: "stopping" })).status, "accepted");
    assert.equal(store.projectRuntime("runtime").projection.runtime, "stopping");
    const after = store.projectRuntime("runtime");
    const exec = db.exec.bind(db);
    let failCommit = true;
    t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("injected commit failure"); }
      exec(sql);
    });
    const exit = fact(3, { state: "exited", controlEvidence: "process_exit" });
    assert.throws(() => store.ingest(token.sourceId, token, exit), /injected commit failure/);
    assert.deepEqual(store.projectRuntime("runtime"), after);
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 2);
    assert.equal(store.ingest(token.sourceId, token, exit).status, "accepted");
    assert.equal(store.projectRuntime("runtime").projection.runtime, "exited");
  } finally { db.close(); }
});

test("recovery fences stale observers and binds the exact retained native turn across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-shadow-"));
  const path = join(root, "state.sqlite");
  let db: DatabaseSync | undefined;
  try {
    const first = fixture(path); db = first.db;
    seed(first.store); const old = observer(first.store);
    first.store.ingest(old.sourceId, old, fact(1)); first.store.ingest(old.sourceId, old, turnFact(2));
    first.store.ingest(old.sourceId, old, turnFact(3, { state: "lost" }));
    first.store.ingest(old.sourceId, old, fact(4, { domain: "control", state: "lost", controlEvidence: "process_exit" }));
    first.store.registerRuntime({ agentId: "agent", executionGenerationId: "next-generation", runtimeGenerationId: "next-runtime",
      provider: "codex", authorityMode: "typed_shadow", configRevision: 1, createdAtMs: 200 });
    const second = new ExecutionShadowStore(db);
    assert.throws(() => observer(second, { expectedEpoch: 1, subjectRuntimeGenerationId: "runtime", observerRuntimeGenerationId: "next-runtime" }), /identity_mismatch/);
    assert.throws(() => observer(second, { expectedEpoch: 1, observerRuntimeGenerationId: "next-runtime", recovery: { ...native, providerTurnId: "different" } }), /identity_mismatch/);
    const rebound = observer(second, { expectedEpoch: 1, observerRuntimeGenerationId: "next-runtime", daemonGenerationId: "daemon2", recovery: native });
    assert.throws(() => first.store.ingest(old.sourceId, old, fact(5)), /stale_observer/);
    assert.throws(() => second.ingest(rebound.sourceId, { ...rebound }, turnFact(1, { observerEpoch: 2 })), /stale_observer/);
    second.ingest(rebound.sourceId, rebound, turnFact(1, { factId: "recovered-active", observerEpoch: 2 }));
    assert.throws(() => second.ingest(rebound.sourceId, rebound, turnFact(2, { factId: "wrong-native", observerEpoch: 2, providerTurnId: "wrong" })), /identity_mismatch/);
    second.ingest(rebound.sourceId, rebound, turnFact(2, { factId: "recovered-terminal", observerEpoch: 2, state: "terminal", turnOutcome: "failed" }));
    second.ingest(rebound.sourceId, rebound, fact(3, { factId: "new-runtime-ready", observerEpoch: 2, runtimeGenerationId: "next-runtime", executionGenerationId: "next-generation" }));
    second.ingest(rebound.sourceId, rebound, fact(4, { factId: "new-control-responsive", domain: "control", state: "responsive", observerEpoch: 2, runtimeGenerationId: "next-runtime", executionGenerationId: "next-generation" }));
    assert.equal(second.projectRuntime("runtime").projection.turns.get("turn")?.outcome, "failed");
    assert.equal(second.projectRuntime("runtime").projection.control, "lost");
    assert.equal(second.projectRuntime("next-runtime").projection.control, "responsive");
    assert.equal(second.projectRuntime("next-runtime").projection.turns.size, 0);
    db.close(); db = undefined;
    const third = fixture(path); db = third.db;
    assert.throws(() => observer(third.store, { expectedEpoch: 1 }), /stale_observer/);
    assert.equal(third.store.projectRuntime("runtime").projection.turns.get("turn")?.state, "terminal");
    assert.equal(db.prepare("SELECT runtime_generation_id FROM execution_facts WHERE fact_id='recovered-terminal'").get()?.runtime_generation_id, "runtime");
    validateExecutionStorageSchema(db);
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});

test("unknown historical terminal evidence cannot resurrect a terminal turn or exited runtime", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, turnFact(1));
    store.ingest(token.sourceId, token, turnFact(2, { state: "terminal", turnOutcome: "failed" }));
    store.ingest(token.sourceId, token, fact(3, { state: "exited", controlEvidence: "process_exit" }));
    // Simulate preserved v18 evidence: terminal state was recorded but its
    // native outcome/proof wasn't. Migration must not invent those fields.
    db.exec("DROP TRIGGER execution_facts_immutable; UPDATE execution_facts SET turn_outcome=NULL,control_evidence=NULL");
    applyExecutionStorageSchema(db);
    assert.equal(store.projectRuntime("runtime").unverifiedFacts, 2);
    assert.throws(() => store.ingest(token.sourceId, token, turnFact(4)), /invalid_transition/);
    assert.throws(() => store.ingest(token.sourceId, token, fact(4)), /invalid_transition/);
    store.ingest(token.sourceId, token, fact(4, { domain: "control", state: "lost", controlEvidence: "process_exit" }));
    const retained = db.prepare("SELECT state,ended_at_ms FROM execution_turns").get();
    store.ingest(token.sourceId, token, operationFact(5, { kind: "completed", outcome: "failed", sideEffects: "observed" }));
    assert.deepEqual(db.prepare("SELECT state,ended_at_ms FROM execution_turns").get(), retained);
    assert.equal(db.prepare("SELECT side_effects FROM execution_turns").get()?.side_effects, "observed");
    assert.equal(db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()?.runtime_state, "exited");
    assert.equal(db.prepare("SELECT state FROM execution_turns").get()?.state, "terminal");
  } finally { db.close(); }
});

test("five agents on one message and repo keep independent attempts; retries coalesce", () => {
  const { db, store } = fixture();
  try {
    const attempts = new Set<string>();
    for (let index = 0; index < 5; index++) {
      const { runtime, attemptId } = seed(store, String(index));
      attempts.add(attemptId);
      const retry = { ...runtime, executionGenerationId: `retry${index}`, runtimeGenerationId: `retry-runtime${index}` };
      store.registerRuntime(retry);
      assert.equal(store.trackMessage({ agentId: runtime.agentId, roomId: "room", sourceMessageId: "message", executionGenerationId: retry.executionGenerationId, workspaceId: `retry-workspace${index}`, createdAtMs: 200 }), attemptId);
      assert.throws(() => store.trackMessage({ agentId: runtime.agentId, roomId: "room", sourceMessageId: "message", executionGenerationId: retry.executionGenerationId, workspaceId: "wrong-workspace", createdAtMs: 200 }), /identity_mismatch/);
    }
    assert.equal(attempts.size, 5);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_message_attempts").get()?.n, 5);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_attempt_generations").get()?.n, 10);
  } finally { db.close(); }
});

test("one execution lane follows the agent across rooms and lost turns cannot release it", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, turnFact(1)); store.ingest(token.sourceId, token, turnFact(2, { state: "lost" }));
    const attemptId = store.trackMessage({ agentId: "agent", roomId: "new-room", sourceMessageId: "message", executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 200 });
    const otherTurn = { ...native, turnId: "other-turn", providerTurnId: "other-native", attemptId, agentId: "agent", roomId: "new-room", executionGenerationId: "generation", runtimeGenerationId: "runtime", createdAtMs: 200 };
    assert.throws(() => store.trackNativeTurn(otherTurn), /invalid_transition/);
    const recover = observer(store, { expectedEpoch: 1, recovery: native });
    store.ingest(recover.sourceId, recover, turnFact(1, { factId: "terminal", observerEpoch: 2, state: "terminal", turnOutcome: "failed" }));
    assert.doesNotThrow(() => store.trackNativeTurn(otherTurn));
    assert.equal(db.prepare("SELECT room_id FROM execution_turns WHERE turn_id='turn'").get()?.room_id, "room");
  } finally { db.close(); }
});

test("shadow projections cannot mutate the legacy inbox or invoke effects", () => {
  const { db, store } = fixture();
  try {
    db.exec("CREATE TABLE supervised_agent_inbox(id TEXT PRIMARY KEY,state TEXT); INSERT INTO supervised_agent_inbox VALUES('head','blocked')");
    seed(store); const token = observer(store);
    store.ingest(token.sourceId, token, turnFact(1));
    store.ingest(token.sourceId, token, turnFact(2, { state: "terminal", turnOutcome: "failed" }));
    assert.equal(db.prepare("SELECT state FROM supervised_agent_inbox").get()?.state, "blocked");
    for (const name of ["settle", "publish", "stop", "restart", "approve", "dispatch"]) assert.equal(name in store, false);
    assert.equal(db.prepare("SELECT authority_mode FROM execution_runtime_generations").get()?.authority_mode, "typed_shadow");
  } finally { db.close(); }
});

const pending: DeliveryEvidence = {
  dispatch: "not_dispatched", nativeTurn: null, nativeTerminal: null, completion: null, published: false,
  userInterrupted: false, authority: "valid", continuation: "available", preDispatchFailures: 0, resultReadFailures: 0, publicationFailures: 0,
};
test("retry domains distinguish proven pre-dispatch from ambiguity, exact recovery, and native failure", () => {
  for (const preDispatchFailures of [0, 1, 2, 3]) {
    assert.equal(reduceDeliveryEvidence({ ...pending, preDispatchFailures }).action,
      preDispatchFailures === 0 ? "dispatch" : preDispatchFailures < 3 ? "retry_provider" : "attention_required");
  }
  assert.equal(reduceDeliveryEvidence({ ...pending, continuation: "unavailable" }).action, "restore_continuation");
  for (const e of [{ dispatch: "possible" as const }, { authority: "ambiguous" as const }, { nativeTerminal: "failed" as const }]) {
    const view = reduceDeliveryEvidence({ ...pending, ...e }); assert.equal(view.action, "attention_required"); assert.equal(view.fifo, "hold");
  }
  const active: DeliveryEvidence = { ...pending, dispatch: "native_bound", nativeTurn: native };
  assert.equal(reduceDeliveryEvidence(active).action, "recover_exact_turn");
  for (const nativeTerminal of ["failed", "interrupted"] as const) {
    const view = reduceDeliveryEvidence({ ...active, nativeTerminal }); assert.equal(view.state, "acknowledged_failed"); assert.equal(view.fifo, "advance");
    assert.deepEqual(reduceDeliveryEvidence({ ...active, nativeTerminal, userInterrupted: true }), view,
      "accepted native failure wins a later Stop without being relabeled user cancellation");
  }
  for (const resultReadFailures of [0, 1, 2, 3]) {
    assert.equal(reduceDeliveryEvidence({ ...active, nativeTerminal: "unreadable", resultReadFailures,
      preDispatchFailures: 99, publicationFailures: 99 }).action,
    resultReadFailures < 3 ? "recover_exact_turn" : "attention_required");
  }
  assert.equal(reduceDeliveryEvidence({ ...active, userInterrupted: true }).fifo, "hold");
  assert.equal(reduceDeliveryEvidence({ ...pending, userInterrupted: true }).state, "cancelled_by_user");
});

test("publication-only retries never invoke providers, and no-reply maps to the settled vocabulary", () => {
  const active: DeliveryEvidence = { ...pending, dispatch: "native_bound", nativeTurn: native };
  for (const nativeTerminal of [null, "completed", "failed", "interrupted", "unreadable"] as const) {
    for (const publicationFailures of [0, 1, 2, 3]) {
      const evidence: DeliveryEvidence = { ...active, completion: "reply", nativeTerminal,
        preDispatchFailures: 99, resultReadFailures: 99, publicationFailures };
      const view = reduceDeliveryEvidence(evidence);
      assert.equal(view.action, publicationFailures < 3 ? "retry_publication" : "attention_required");
      assert.equal(view.fifo, "hold");
      assert.equal(reduceDeliveryEvidence({ ...evidence, published: true }).state, "acknowledged",
        "confirmed publication wins debt without an additional provider checkpoint");
      assert.equal(reduceDeliveryEvidence({ ...evidence, completion: "no_reply", userInterrupted: true }).state,
        "acknowledged_no_reply", "saved no-reply wins without another provider read");
    }
  }
  assert.equal(reduceDeliveryEvidence({ ...active, completion: "reply", published: true }).fifo, "advance");
  assert.equal(reduceDeliveryEvidence({ ...active, completion: "reply", published: true, nativeTerminal: "completed" }).state, "acknowledged");
  assert.deepEqual(reduceDeliveryEvidence({ ...active, completion: "no_reply", nativeTerminal: "completed" }), {
    state: "acknowledged_no_reply", action: "none", fifo: "advance", conclusion: "cleanly_concluded",
  });
});

test("approval waiting is derived, and lost is unavailable rather than denied or expired", () => {
  assert.equal(waitingForApproval("active", ["requested"]), true);
  assert.equal(waitingForApproval("terminal", ["requested"]), false);
  assert.equal(waitingForApproval("active", ["resolved", "lost"]), false);
  assert.equal(publicApprovalState("lost", "deny"), "unavailable");
  assert.equal(publicApprovalState("dispatching", "allow_once"), "decision_recorded");
  assert.equal(publicApprovalState("resolved", "allow_once"), "applied");
  assert.equal(publicApprovalState("resolved", "deny"), "denied");
});
