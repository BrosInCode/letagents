import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyExecutionStorageSchema, validateExecutionStorageSchema } from "../execution-storage-schema.js";
import { ExecutionProtocolError, parseExecutionFact, type ExecutionFact } from "../execution-protocol.js";
import { emptyExecutionProjection, publicApprovalState, reduceDeliveryEvidence, reduceExecutionFact, waitingForApproval, type DeliveryEvidence } from "../execution-reducer.js";
import { ExecutionShadowStore, type ShadowObserver } from "../execution-shadow-store.js";

function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  applyExecutionStorageSchema(db);
  const store = new ExecutionShadowStore(db);
  return { db, store };
}
const native = { turnId: "turn", providerContinuationId: "conversation", providerTurnId: "native-turn" };
function seed(store: ExecutionShadowStore, suffix = "") {
  const runtime = {
    agentId: `agent${suffix}`, executionGenerationId: `generation${suffix}`, runtimeGenerationId: `runtime${suffix}`,
    provider: "codex" as const, configRevision: 1, createdAtMs: 100,
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
    store.ingest(token, fact(1)); store.ingest(token, turnFact(2));
    store.ingest(token, operationFact(3, { sideEffects: "possible" }));
    store.ingest(token, operationFact(4, { kind: "completed", outcome: "failed", exitCode: 1, sideEffects: "observed" }));
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
    store.ingest(token, fact(1, { observedAtMs: 1000 }));
    store.ingest(token, turnFact(2, { observedAtMs: 0 }));
    const output = operationFact(3, { kind: "output", outputBytes: 42, observedAtMs: 1 });
    assert.equal(store.ingest(token, output).status, "accepted");
    assert.equal(store.ingest(token, output).status, "duplicate");
    assert.throws(() => store.ingest(token, { ...output, outputBytes: 43 }), /sequence_conflict/);
    assert.throws(() => store.ingest(token, { ...output, factId: "replacement" }), /sequence_conflict/);
    assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 42);
    assert.deepEqual(db.prepare("SELECT sequence FROM execution_facts ORDER BY sequence").all().map(r => r.sequence), [1, 2, 3]);
  } finally { db.close(); }
});

test("source gaps persist diagnostics, never fabricate terminals, and can be filled", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    assert.deepEqual(store.ingest(token, turnFact(3)), { status: "gap", expectedSourceSequence: 1, observedSourceSequence: 3 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 0);
    assert.equal(db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()?.runtime_state, "starting");
    assert.equal((store.ingest(token, fact(1)) as { gapPending: boolean }).gapPending, true);
    store.ingest(token, fact(2, { domain: "control", state: "responsive" }));
    assert.equal((store.ingest(token, turnFact(3)) as { gapPending: boolean }).gapPending, false);
    assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.state, "active");
  } finally { db.close(); }
});

test("native event replay across observers advances the cursor without duplicating projection effects", () => {
  const { db, store } = fixture();
  try {
    seed(store); const first = observer(store);
    store.ingest(first, fact(1)); store.ingest(first, turnFact(2));
    const output = operationFact(3, { kind: "output", outputBytes: 42, nativeEventId: "native-output" });
    store.ingest(first, output);
    const second = observer(store, { expectedEpoch: 1 });
    const replay = { ...output, factId: "replayed-output", observerEpoch: 2, sourceSequence: 1, observedAtMs: 200 };
    assert.equal(store.ingest(second, replay).status, "duplicate");
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 1);
    assert.throws(() => store.ingest(second, { ...replay, factId: "changed-native", sourceSequence: 2, outputBytes: 43 }), /sequence_conflict/);
    store.ingest(second, operationFact(2, { factId: "next-output", observerEpoch: 2, kind: "output", outputBytes: 5, nativeEventId: "next-native-output" }));
    // A new store reconstructs from durable observations, not a process cache.
    const projection = new ExecutionShadowStore(db).projectRuntime("runtime").projection;
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
      store.ingest(first, active); store.ingest(first, output);
      store.ingest(first, turnFact(3, { state, ...(state === "terminal" ? { turnOutcome: "completed" } : {}) }));
      assert.equal(store.ingest(first, output).status, "duplicate");
      const second = observer(store, { expectedEpoch: 1 });
      assert.equal(store.ingest(second, { ...active, factId: "replayed-active", observerEpoch: 2 }).status, "duplicate");
      assert.equal(store.ingest(second, { ...output, factId: "replayed-output", observerEpoch: 2 }).status, "duplicate");
      assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 2);
      assert.equal(db.prepare("SELECT state FROM execution_turns").get()?.state, state);
      assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.state, state);
      assert.equal(store.projectRuntime("runtime").projection.turns.get("turn")?.operations.get("command")?.outputBytes, 42);
    } finally { db.close(); }
  }
});

test("append and projection/cursor updates are atomic across a failed write", () => {
  const { db, store } = fixture();
  try {
    seed(store); const token = observer(store);
    db.exec("CREATE TRIGGER refuse_shadow_update BEFORE UPDATE ON execution_runtime_generations BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => store.ingest(token, fact(1)), /injected/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_facts").get()?.n, 0);
    assert.equal(db.prepare("SELECT last_source_sequence FROM execution_observers").get()?.last_source_sequence, 0);
    db.exec("DROP TRIGGER refuse_shadow_update");
    assert.equal(store.ingest(token, fact(1)).status, "accepted");
  } finally { db.close(); }
});

test("recovery fences stale observers and binds the exact retained native turn across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-shadow-"));
  const path = join(root, "state.sqlite");
  let db: DatabaseSync | undefined;
  try {
    const first = fixture(path); db = first.db;
    seed(first.store); const old = observer(first.store);
    first.store.ingest(old, fact(1)); first.store.ingest(old, turnFact(2));
    first.store.ingest(old, turnFact(3, { state: "lost" }));
    first.store.ingest(old, fact(4, { domain: "control", state: "lost", controlEvidence: "process_exit" }));
    first.store.registerRuntime({ agentId: "agent", executionGenerationId: "next-generation", runtimeGenerationId: "next-runtime", provider: "codex", configRevision: 1, createdAtMs: 200 });
    const second = new ExecutionShadowStore(db);
    assert.throws(() => observer(second, { expectedEpoch: 1, subjectRuntimeGenerationId: "runtime", observerRuntimeGenerationId: "next-runtime" }), /identity_mismatch/);
    assert.throws(() => observer(second, { expectedEpoch: 1, observerRuntimeGenerationId: "next-runtime", recovery: { ...native, providerTurnId: "different" } }), /identity_mismatch/);
    const rebound = observer(second, { expectedEpoch: 1, observerRuntimeGenerationId: "next-runtime", daemonGenerationId: "daemon2", recovery: native });
    assert.throws(() => first.store.ingest(old, fact(5)), /stale_observer/);
    assert.throws(() => second.ingest({ ...rebound }, turnFact(1, { observerEpoch: 2 })), /stale_observer/);
    second.ingest(rebound, turnFact(1, { factId: "recovered-active", observerEpoch: 2 }));
    assert.throws(() => second.ingest(rebound, turnFact(2, { factId: "wrong-native", observerEpoch: 2, providerTurnId: "wrong" })), /identity_mismatch/);
    second.ingest(rebound, turnFact(2, { factId: "recovered-terminal", observerEpoch: 2, state: "terminal", turnOutcome: "failed" }));
    second.ingest(rebound, fact(3, { factId: "new-runtime-ready", observerEpoch: 2, runtimeGenerationId: "next-runtime", executionGenerationId: "next-generation" }));
    second.ingest(rebound, fact(4, { factId: "new-control-responsive", domain: "control", state: "responsive", observerEpoch: 2, runtimeGenerationId: "next-runtime", executionGenerationId: "next-generation" }));
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
    store.ingest(token, turnFact(1));
    store.ingest(token, turnFact(2, { state: "terminal", turnOutcome: "failed" }));
    store.ingest(token, fact(3, { state: "exited", controlEvidence: "process_exit" }));
    // Simulate preserved v18 evidence: terminal state was recorded but its
    // native outcome/proof wasn't. Migration must not invent those fields.
    db.exec("DROP TRIGGER execution_facts_immutable; UPDATE execution_facts SET turn_outcome=NULL,control_evidence=NULL");
    applyExecutionStorageSchema(db);
    assert.equal(store.projectRuntime("runtime").unverifiedFacts, 2);
    assert.throws(() => store.ingest(token, turnFact(4)), /invalid_transition/);
    assert.throws(() => store.ingest(token, fact(4)), /invalid_transition/);
    store.ingest(token, fact(4, { domain: "control", state: "lost", controlEvidence: "process_exit" }));
    const retained = db.prepare("SELECT state,ended_at_ms FROM execution_turns").get();
    store.ingest(token, operationFact(5, { kind: "completed", outcome: "failed", sideEffects: "observed" }));
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
    store.ingest(token, turnFact(1)); store.ingest(token, turnFact(2, { state: "lost" }));
    const attemptId = store.trackMessage({ agentId: "agent", roomId: "new-room", sourceMessageId: "message", executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: 200 });
    const otherTurn = { ...native, turnId: "other-turn", providerTurnId: "other-native", attemptId, agentId: "agent", roomId: "new-room", executionGenerationId: "generation", runtimeGenerationId: "runtime", createdAtMs: 200 };
    assert.throws(() => store.trackNativeTurn(otherTurn), /invalid_transition/);
    const recover = observer(store, { expectedEpoch: 1, recovery: native });
    store.ingest(recover, turnFact(1, { factId: "terminal", observerEpoch: 2, state: "terminal", turnOutcome: "failed" }));
    assert.doesNotThrow(() => store.trackNativeTurn(otherTurn));
    assert.equal(db.prepare("SELECT room_id FROM execution_turns WHERE turn_id='turn'").get()?.room_id, "room");
  } finally { db.close(); }
});

test("shadow projections cannot mutate the legacy inbox or invoke effects", () => {
  const { db, store } = fixture();
  try {
    db.exec("CREATE TABLE supervised_agent_inbox(id TEXT PRIMARY KEY,state TEXT); INSERT INTO supervised_agent_inbox VALUES('head','blocked')");
    seed(store); const token = observer(store);
    store.ingest(token, turnFact(1));
    store.ingest(token, turnFact(2, { state: "terminal", turnOutcome: "failed" }));
    assert.equal(db.prepare("SELECT state FROM supervised_agent_inbox").get()?.state, "blocked");
    for (const name of ["settle", "publish", "stop", "restart", "approve", "dispatch"]) assert.equal(name in store, false);
    assert.equal(db.prepare("SELECT authority_mode FROM execution_runtime_generations").get()?.authority_mode, "typed_shadow");
  } finally { db.close(); }
});

const pending: DeliveryEvidence = {
  dispatch: "not_dispatched", nativeTurn: null, nativeTerminal: null, completion: null, published: false,
  userInterrupted: false, authority: "valid", continuation: "available", preDispatchFailures: 0, resultReadFailures: 0,
};
test("retry domains distinguish proven pre-dispatch from ambiguity, exact recovery, and native failure", () => {
  assert.equal(reduceDeliveryEvidence(pending).action, "dispatch");
  assert.equal(reduceDeliveryEvidence({ ...pending, preDispatchFailures: 1 }).action, "retry_provider");
  assert.equal(reduceDeliveryEvidence({ ...pending, preDispatchFailures: 4 }).action, "attention_required");
  assert.equal(reduceDeliveryEvidence({ ...pending, continuation: "unavailable" }).action, "restore_continuation");
  for (const e of [{ dispatch: "possible" as const }, { authority: "ambiguous" as const }, { nativeTerminal: "failed" as const }]) {
    const view = reduceDeliveryEvidence({ ...pending, ...e }); assert.equal(view.action, "attention_required"); assert.equal(view.fifo, "hold");
  }
  const active: DeliveryEvidence = { ...pending, dispatch: "native_bound", nativeTurn: native };
  assert.equal(reduceDeliveryEvidence(active).action, "recover_exact_turn");
  for (const nativeTerminal of ["failed", "interrupted"] as const) {
    const view = reduceDeliveryEvidence({ ...active, nativeTerminal }); assert.equal(view.state, "acknowledged_failed"); assert.equal(view.fifo, "advance");
  }
  assert.equal(reduceDeliveryEvidence({ ...active, nativeTerminal: "unreadable", resultReadFailures: 3 }).action, "recover_exact_turn");
  assert.equal(reduceDeliveryEvidence({ ...active, nativeTerminal: "unreadable", resultReadFailures: 4 }).action, "attention_required");
  assert.equal(reduceDeliveryEvidence({ ...active, userInterrupted: true }).fifo, "hold");
  assert.equal(reduceDeliveryEvidence({ ...active, userInterrupted: true, nativeTerminal: "interrupted" }).state, "cancelled_by_user");
});

test("publication-only retries never invoke providers, and no-reply maps to the settled vocabulary", () => {
  const active: DeliveryEvidence = { ...pending, dispatch: "native_bound", nativeTurn: native };
  for (const nativeTerminal of [null, "completed", "failed", "interrupted", "unreadable"] as const) {
    const view = reduceDeliveryEvidence({ ...active, completion: "reply", nativeTerminal, preDispatchFailures: 99 });
    assert.equal(view.action, "retry_publication"); assert.equal(view.fifo, "hold");
  }
  assert.equal(reduceDeliveryEvidence({ ...active, completion: "reply", published: true }).fifo, "hold");
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
