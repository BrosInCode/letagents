import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonStateSchema } from "../daemon-state-database.js";
import { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity, executionStorageIdentity } from "../execution-shadow-store.js";
import { ProviderExecutionObserver } from "#provider-runtime/agents/provider-execution-observer.js";
import type { NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { ProviderActionConnectionRef, ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";
import { projectRoomAgentManifestEntry } from "../room-agent-state-projection.js";
import { archiveExitedRuntimes, archiveExitedUndispatchedCursorRuntime } from "../runtime-recovery-journal.js";
import type { DaemonManifestEntry } from "../types.js";

const now = "2026-08-31T00:00:00.000Z";
const ready: NativeExecutionFact = { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" };
const nativeTurn = { providerContinuationId: "continuation", providerTurnId: "native-turn" };
const active: NativeExecutionFact = { ...nativeTurn, domain: "turn", kind: "state_changed", state: "active", sideEffects: "none" };
const terminal: NativeExecutionFact = { ...active, state: "terminal", turnOutcome: "completed" };
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function delay(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function successor(f: ReturnType<typeof fixture>, birth: string): ProviderActionHandle {
  const handle = { ...f.handle, appliedConfigurationRevision: 2,
    providerConnection: { ...f.handle.providerConnection!, processIdentity: birth } };
  f.handles.set("agent", handle);
  f.db.prepare("UPDATE agents SET provider_connection_json=? WHERE agent_id='agent'").run(JSON.stringify(handle.providerConnection));
  new ExecutionShadowStore(f.db).registerRuntime({ agentId: "agent", executionGenerationId: "generation",
    runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", handle.providerConnection!.kind,
      handle.providerConnection!.pid!, birth),
    provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
  return handle;
}

function fixture(kind: ProviderActionConnectionRef["kind"] = "codex_app_server", onExecution?: NonNullable<ProviderActionPort["onExecution"]>, changed?: (agentId: string) => void,
  db = new DatabaseSync(":memory:"), authorityMode: "typed" = "typed") {
  db.exec("PRAGMA foreign_keys=ON");
  new DaemonStateSchema().createSchema(db);
  const connection = { kind, pid: 42, processIdentity: "birth-secret", url: "http://localhost/runtime", serverAuthPath: "/private/auth" } as ProviderActionConnectionRef;
  db.prepare(`INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
    VALUES('workspace','task','lease',1,'/private/workspace','repo','remote','revision','/private/bare','active',?)`).run(now);
  db.prepare(`INSERT INTO work_attempt_executions VALUES('generation','workspace',?,'test',1,NULL)`).run(now);
  db.prepare(`INSERT INTO agents(
    agent_id,sort_order,version,created_by,created_at,display_name,room_id,provider,charter,
    config_revision,runtime_configuration_revision,desired_state,observed_state,condition,
    work_attempt_id,provider_work_attempt_id,provider_continuation_id,provider_execution_generation_id,provider_connection_json
  ) VALUES('agent',0,1,'owner',?,'Agent','room','claude-code','charter',9,2,'running','working','none','workspace','workspace','continuation','generation',?)`)
    .run(now, JSON.stringify(connection));
  const handle: ProviderActionHandle = { workAttemptId: "workspace", pid: 42, providerContinuationId: "continuation", observedState: "working", providerConnection: connection, appliedConfigurationRevision: 2 };
  const handles = new Map([["agent", handle]]);
  const provider = { codex_app_server: "codex", claude_cli: "claude-code", cursor_cli: "cursor", opencode_server: "open-model" } as const;
  new ExecutionShadowStore(db).registerRuntime({
    agentId: "agent",
    executionGenerationId: "generation",
    runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", kind, 42, "birth-secret"),
    provider: provider[kind],
    authorityMode,
    configRevision: 2,
    createdAtMs: Date.parse(now),
  });
  const observer = new ProviderExecutionObserver(() => now);
  const diagnostics: string[] = [];
  const stopped: string[] = [];
  const capture = new ExecutionCaptureCoordinator(db, { provider: { onExecution: onExecution ?? ((_handle, listener) => observer.subscribe(listener)) },
    currentHandle: id => handles.get(id), daemonGeneration: () => 1, diagnostic: (_id, code) => diagnostics.push(code),
    recordStopped: id => stopped.push(id), changed });
  const tokens = new WeakMap<ProviderActionHandle, { identity: string; token: ProviderInstallationToken }>();
  const tokenFor = (current = handles.get("agent")!, generation = "generation"): ProviderInstallationToken => {
    const tokenAuthorityMode = current.providerConnection?.kind === "cursor_cli"
      && current.providerConnection.pid === null
      && current.providerConnection.processIdentity === null
      ? null
      : authorityMode;
    const identity = JSON.stringify([generation, current.appliedConfigurationRevision, current.providerConnection, tokenAuthorityMode]);
    const existing = tokens.get(current);
    if (existing?.identity === identity) return existing.token;
    const token = Object.freeze({ nonce: Symbol("test-installation"), listenerLeaseNonce: Symbol("test-listener-lease"),
      entryId: "agent", handle: current,
      executionGenerationId: generation, workAttemptId: current.workAttemptId,
      providerContinuationId: current.providerContinuationId!, providerConnection: { ...current.providerConnection! },
      configurationRevision: current.appliedConfigurationRevision!, authorityMode: tokenAuthorityMode });
    tokens.set(current, { identity, token });
    return token;
  };
  const install = (current = handles.get("agent")!, generation = "generation") => capture.install(tokenFor(current, generation));
  const advance = (current = handles.get("agent")!, generation = "generation") => capture.advance(tokenFor(current, generation));
  const admission = (current = handles.get("agent")!, generation = "generation") => capture.captureAdmission(tokenFor(current, generation));
  const typedAdmission = (current = handles.get("agent")!, generation = "generation") => capture.typedLifecycleAdmission(tokenFor(current, generation));
  const emit = (fact: NativeExecutionFact, birth = "birth-secret", pid = 42) => observer.emit(fact, birth, pid);
  const facts = () => db.prepare("SELECT * FROM execution_facts ORDER BY sequence").all();
  const position = () => db.prepare("SELECT last_source_sequence,max_observed_sequence FROM execution_observers").get();
  const bindTurn = (turn = "native-turn", source = "message",
    state: "pending" | "dispatching" | "awaiting_result" | "result_recovery" | "retryable" | "blocked" = "awaiting_result") => {
    db.prepare(`INSERT INTO inbox_items(inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,created_at,updated_at)
      VALUES(?,'agent','room',?,'{"text":"PRIVATE PROMPT"}','{}',?,?,1,?,?,?, ?,?)`)
      .run(turn, source, Number(db.prepare("SELECT COUNT(*) n FROM inbox_items").get()!.n) + 1, state, `action-${turn}`, `reply-${turn}`, turn, now, now);
    db.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES(?,'agent','room','workspace','generation','continuation',?)").run(turn, turn);
  };
  return { db, handle, handles, observer, capture, diagnostics, stopped, install, advance, admission, typedAdmission, tokenFor, emit, facts, position, bindTurn };
}

// A second independent capture lane in the same real store/coordinator.
function secondCaptureLane(f: ReturnType<typeof fixture>) {
  const agentId = "second-agent";
  const generation = "second-generation";
  const workspace = "second-workspace";
  for (const [table, key, original] of [
    ["work_attempts", "work_attempt_id", "workspace"],
    ["work_attempt_executions", "execution_generation_id", "generation"],
    ["agents", "agent_id", "agent"],
  ]) {
    const row = f.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(original)!;
    if ("agent_id" in row) row.agent_id = agentId;
    if ("work_attempt_id" in row) row.work_attempt_id = workspace;
    if (table === "work_attempts") { row.task_id = agentId; row.lease_id = agentId; row.workspace_path = "/private/second-workspace"; }
    if (table === "work_attempt_executions") row.execution_generation_id = generation;
    if (table === "agents") { row.sort_order = 1; row.provider_execution_generation_id = generation; row.provider_work_attempt_id = workspace; }
    const columns = Object.keys(row);
    f.db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(row));
  }
  const handle = { ...f.handle, workAttemptId: workspace, providerConnection: { ...f.handle.providerConnection! } };
  f.handles.set(agentId, handle);
  const token = Object.freeze({ ...f.tokenFor(), entryId: agentId, workAttemptId: workspace,
    executionGenerationId: generation, handle, nonce: Symbol("second-installation") });
  new ExecutionShadowStore(f.db).registerRuntime({ agentId, executionGenerationId: generation,
    runtimeGenerationId: executionRuntimeStorageIdentity(agentId, generation, "codex_app_server", 42, "birth-secret"),
    provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
  return { agentId, handle, token };
}

test("capture admission is exact, fail-closed, and never promoted by elapsed time", async () => {
  const f = fixture();
  try {
    assert.equal(f.admission(), "unavailable");
    await f.install();
    assert.equal(f.admission(), "pending");
    await flush();
    assert.equal(f.admission(), "ready",
      "an exact empty source is admitted once its durable observer exists");
    f.emit(ready); await flush();
    assert.equal(f.admission(), "ready");
    assert.equal(f.admission(f.handle, "other-generation"), "unavailable");
    assert.equal(f.admission({ ...f.handle }, "generation"), "unavailable");
    f.db.exec("DELETE FROM execution_observer_sources");
    assert.equal(f.admission(), "unavailable",
      "ready is re-derived from the durable source row on every read");
  } finally { f.capture.close(); }

  const waiting = fixture("codex_app_server", () => new Promise<NativeExecutionSubscription>(() => {}));
  try {
    void waiting.install(); await flush();
    assert.equal(waiting.admission(), "pending",
      "an unresolved subscription stays pending without elapsed-time promotion");
  } finally { waiting.capture.close(); }
});

test("Codex reattach admission requires the exact durable outstanding turn", async () => {
  const exact = fixture();
  try {
    exact.bindTurn();
    await exact.install(); await flush();
    assert.equal(exact.admission(), "unavailable",
      "an empty reattach source cannot erase a durable outstanding turn");
    exact.emit(ready); await flush();
    assert.equal(exact.admission(), "unavailable",
      "runtime readiness alone cannot prove the native turn boundary");
    exact.emit(active); await flush();
    assert.equal(exact.admission(), "ready");
    assert.equal(exact.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'")
      .get()?.observed_state, "working", "capture reconstruction alone cannot mutate runtime deployment state");
  } finally { exact.capture.close(); }

  const mismatched = fixture();
  try {
    mismatched.bindTurn();
    mismatched.bindTurn("another-native-turn", "another-message");
    await mismatched.install();
    mismatched.emit(ready);
    mismatched.emit({ ...active, providerTurnId: "another-native-turn" });
    await flush();
    assert.deepEqual({ ...mismatched.position() }, { last_source_sequence: 2, max_observed_sequence: 2 },
      "the unrelated turn is durably mappable and the observer is fully caught up");
    assert.deepEqual(mismatched.diagnostics, [],
      "the rejection comes from the missing exact expected turn, not incidental identity failure");
    assert.equal(mismatched.admission(), "unavailable",
      "an unrelated latest transcript turn cannot satisfy the durable binding");
  } finally { mismatched.capture.close(); }

  for (const state of ["pending", "dispatching", "awaiting_result", "result_recovery", "retryable", "blocked"] as const) {
    const retained = fixture();
    try {
      retained.bindTurn("native-turn", `message-${state}`, state);
      await retained.install(); await flush();
      assert.equal(retained.admission(), "unavailable",
        `a ${state} inbox item retaining a provider-turn binding cannot be admitted from an empty reattach source`);
    } finally { retained.capture.close(); }
  }
});

test("typed lifecycle admission requires a caught-up source and projects lifecycle directly onto agents", async () => {
  const typed = fixture("codex_app_server", undefined, undefined, new DatabaseSync(":memory:"), "typed");
  try {
    typed.db.prepare("UPDATE agents SET observed_state='idle' WHERE agent_id='agent'").run();
    await typed.install(); await flush();
    assert.equal(typed.typedAdmission(), "ready", "an exact empty typed source is immediately ready");
    typed.bindTurn(); typed.emit(active); await flush();
    assert.equal(typed.typedAdmission(), "ready", "direct in-transaction projection leaves no pending effect queue");
    assert.equal(typed.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "working");
    typed.db.prepare("DELETE FROM execution_observer_sources").run();
    assert.equal(typed.typedAdmission(), "unavailable", "a missing observer source fails closed");
  } finally { typed.capture.close(); }
});

test("Cursor identity retirement synchronously captures the exact child tail", async () => {
  const f = fixture("cursor_cli", undefined, undefined, new DatabaseSync(":memory:"), "typed");
  try {
    f.bindTurn();
    await f.install();
    f.emit(active);
    f.emit(terminal);
    f.emit({ domain: "runtime", kind: "state_changed", state: "exited",
      controlEvidence: "process_exit", sideEffects: "none" });
    f.capture.flush(f.tokenFor());
    assert.deepEqual(f.facts().map(row => ({ domain: row.domain, state: row.state })), [
      { domain: "turn", state: "active" },
      { domain: "turn", state: "terminal" },
      { domain: "runtime", state: "exited" },
    ]);
    assert.equal(f.admission(), "unavailable",
      "an exited child is never delivery-ready even though its source tail is durably settled");
    assert.throws(() => f.capture.flush(f.tokenFor({ ...f.handle })), /identity_mismatch/,
      "the barrier cannot settle a copied or successor handle");
  } finally { f.capture.close(); }
});

test("drain remembers a found runtime birth but never a missing one", async (t) => {
  const f = fixture();
  try {
    const statement = Object.getPrototypeOf(f.db.prepare("SELECT 1")) as StatementSync;
    const get = statement.get;
    let lookups = 0;
    t.mock.method(statement, "get", function (this: StatementSync, ...values: SQLInputValue[]) {
      if (this.sourceSQL.startsWith("SELECT runtime_generation_id,authority_mode,config_revision FROM execution_runtime_generations")) lookups++;
      return get.apply(this, values);
    });
    f.bindTurn(); await f.install();
    f.emit(ready); f.emit(active);
    for (let index = 0; index < 20; index++) {
      f.emit({ ...nativeTurn, domain: "execution", kind: "started", executionId: `command-${index}`, operation: "command", sideEffects: "possible" });
    }
    await flush();
    assert.equal(f.facts().length, 22);
    assert.ok(lookups <= 2, `a found birth is looked up once, not per fact (${lookups} lookups for 22 facts)`);

    // A birth with no runtime row yet is refused, and looked up again once it exists.
    const late = "late-birth";
    f.emit({ domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" }, late);
    await flush();
    assert.equal(f.facts().length, 22, "an unknown birth is refused");
    assert.ok(f.diagnostics.includes("identity_unavailable"));
    const before = lookups;
    new ExecutionShadowStore(f.db).registerRuntime({ agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", "codex_app_server", 42, late),
      provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
    f.capture.refresh("agent"); await flush();
    assert.ok(lookups > before, "the earlier miss was not remembered");
    assert.equal(f.facts().length, 23, "the late birth's fact is captured");
  } finally { f.capture.close(); }
});

test("capture admission fails closed on durable reads and live source positions", async (t) => {
  const readFailure = fixture();
  try {
    await readFailure.install(); readFailure.emit(ready); await flush();
    assert.equal(readFailure.admission(), "ready");
    const prepare = readFailure.db.prepare.bind(readFailure.db);
    t.mock.method(readFailure.db, "prepare", (sql: string) => {
      if (sql.includes("FROM execution_observers o")) throw new Error("injected admission read failure");
      return prepare(sql);
    });
    assert.equal(readFailure.admission(), "unavailable");
  } finally { readFailure.capture.close(); }

  const observer = new ProviderExecutionObserver(() => now);
  let position: "valid" | "ahead" | "throws" | "malformed" | "null" = "valid";
  const sourcePosition = fixture("codex_app_server", (_handle, listener) => {
    const subscription = observer.subscribe(listener);
    return { ...subscription, position: () => {
      if (position === "throws") throw new Error("injected position failure");
      if (position === "malformed") return { firstRetainedSequence: 3, latestSequence: 0 };
      if (position === "null") return null as never;
      const current = subscription.position();
      return position === "ahead" ? { ...current, latestSequence: current.latestSequence + 1 } : current;
    } };
  });
  try {
    await sourcePosition.install(); observer.emit(ready, "birth-secret", 42); await flush();
    assert.equal(sourcePosition.admission(), "ready");
    position = "ahead";
    assert.equal(sourcePosition.admission(), "unavailable",
      "Codex cannot admit while the live source is ahead of its durable cursor");
    position = "throws";
    assert.equal(sourcePosition.admission(), "unavailable");
    position = "malformed";
    assert.equal(sourcePosition.admission(), "unavailable");
    position = "null";
    assert.equal(sourcePosition.admission(), "unavailable");
    position = "valid";
    assert.equal(sourcePosition.admission(), "ready",
      "read-time source evidence can recover without elapsed-time inference");
  } finally { sourcePosition.capture.close(); }
});

test("capture admission recovers from durable observer rows after coordinator restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-capture-admission-"));
  const path = join(root, "daemon.sqlite");
  const first = fixture("codex_app_server", undefined, undefined, new DatabaseSync(path));
  try {
    await first.install(); first.emit(ready); await flush();
    assert.equal(first.admission(), "ready");
    first.capture.close();

    const database = new DatabaseSync(path);
    const observer = new ProviderExecutionObserver(() => now);
    const restarted = new ExecutionCaptureCoordinator(database, {
      provider: { onExecution: (_handle, listener) => observer.subscribe(listener) },
      currentHandle: () => first.handle,
      daemonGeneration: () => 2,
      diagnostic: () => {},
    });
    try {
      await restarted.install(first.tokenFor());
      assert.equal(restarted.captureAdmission(first.tokenFor()), "pending");
      await flush();
      assert.equal(restarted.captureAdmission(first.tokenFor()), "ready");
      assert.equal(database.prepare("SELECT daemon_generation_id FROM execution_observers WHERE agent_id='agent'").get()!.daemon_generation_id, "2",
        "restart readiness is re-derived from a newly committed observer, not the old in-memory lane");
    } finally { restarted.close(); if (database.isOpen) database.close(); }
  } finally {
    first.capture.close();
    if (first.db.isOpen) first.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture admission fences a replaced handle before admitting its successor", async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  const f = fixture("codex_app_server", (handle, listener) => sources.get(handle)!.subscribe(listener));
  const original = new ProviderExecutionObserver(() => now);
  sources.set(f.handle, original);
  try {
    await f.install(); original.emit(ready, "birth-secret", 42); await flush();
    assert.equal(f.admission(), "ready");
    const previous = f.handle;
    const next = successor(f, "successor-birth");
    const replacement = new ProviderExecutionObserver(() => now);
    sources.set(next, replacement);
    await f.install(next);
    assert.equal(f.admission(previous), "unavailable");
    assert.equal(f.admission(next), "pending");
    replacement.emit(ready, "successor-birth", 42); await flush();
    assert.equal(f.admission(next), "ready");
    assert.equal(f.admission(previous), "unavailable");
  } finally { f.capture.close(); }
});

test("capture replays native facts only after the exact committed turn binding, without delivery mutations", async () => {
  const f = fixture();
  try {
    f.emit(ready); f.emit(active);
    f.emit({ ...nativeTurn, domain: "execution", kind: "completed", executionId: "read", operation: "file_read", outcome: "failed", sideEffects: "none" });
    f.emit(terminal);
    await f.install(); await flush();
    assert.equal(f.facts().length, 1);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 4 });
    assert.deepEqual(f.diagnostics, ["identity_unavailable"]);
    f.bindTurn();
    const receipt = f.db.prepare("SELECT * FROM inbox_items").all();
    f.capture.refresh(); await flush();
    assert.equal(f.facts().length, 4);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 4, max_observed_sequence: 4 });
    assert.deepEqual(f.db.prepare("SELECT * FROM inbox_items").all(), receipt);
    assert.deepEqual({ ...f.db.prepare("SELECT provider,config_revision,runtime_state,authority_mode FROM execution_runtime_generations").get() },
      { provider: "codex", config_revision: 2, runtime_state: "ready", authority_mode: "typed" }, "actual running provider/applied revision, not desired configuration");
    assert.equal(f.db.prepare("SELECT state FROM runs").get()!.state, "terminal");
    assert.doesNotMatch(JSON.stringify(f.facts()), /PRIVATE|birth-secret|localhost|private/);
    await f.install(); await flush();
    assert.equal(f.facts().length, 4, "same-source reconnect skips the committed replay prefix");
  } finally { f.capture.close(); }
});

test("steady control probes coalesce while real control transitions remain durable", async () => {
  const f = fixture();
  try {
    await f.install();
    f.emit(ready);
    f.emit({ domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" });
    f.emit({ domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" });
    f.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" });
    f.emit({ domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" });
    f.emit({ domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" });
    await flush();
    assert.deepEqual(f.facts().map(row => [row.domain, row.state]), [
      ["runtime", "ready"], ["control", "responsive"], ["control", "degraded"], ["control", "responsive"],
    ]);
    assert.equal(f.db.prepare("SELECT control_state FROM execution_runtime_generations").get()!.control_state, "responsive");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 4, max_observed_sequence: 4 });
  } finally { f.capture.close(); }
});

test("control coalescing preserves changed evidence, native events, exact process birth, and bounded replay", () => {
  const observer = new ProviderExecutionObserver(() => now);
  const seen: NativeExecutionObservation[] = [];
  observer.subscribe(event => seen.push(event));
  const responsive: NativeExecutionFact = { domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" };
  observer.emit(responsive, "birth-one", 41);
  observer.emit(responsive, "birth-one", 41);
  observer.emit(responsive, "birth-one", 42);
  observer.emit(responsive, "birth-two", 42);
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_exit" }, "birth-two", 42);
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_exit" }, "birth-two", 42);
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_birth_changed" }, "birth-two", 42);
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_birth_changed", nativeEventId: "native-one" }, "birth-two", 42);
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_birth_changed", nativeEventId: "native-two" }, "birth-two", 42);
  assert.deepEqual(seen.map(event => ({ sequence: event.sequence, pid: event.nativeProcessPid, identity: event.nativeProcessIdentity,
    state: event.fact.domain === "control" ? event.fact.state : null,
    evidence: event.fact.domain === "control" && "controlEvidence" in event.fact ? event.fact.controlEvidence : undefined,
    nativeEventId: event.fact.nativeEventId })), [
    { sequence: 1, pid: 41, identity: "birth-one", state: "responsive", evidence: undefined, nativeEventId: undefined },
    { sequence: 2, pid: 42, identity: "birth-one", state: "responsive", evidence: undefined, nativeEventId: undefined },
    { sequence: 3, pid: 42, identity: "birth-two", state: "responsive", evidence: undefined, nativeEventId: undefined },
    { sequence: 4, pid: 42, identity: "birth-two", state: "lost", evidence: "process_exit", nativeEventId: undefined },
    { sequence: 5, pid: 42, identity: "birth-two", state: "lost", evidence: "process_birth_changed", nativeEventId: undefined },
    { sequence: 6, pid: 42, identity: "birth-two", state: "lost", evidence: "process_birth_changed", nativeEventId: "native-one" },
    { sequence: 7, pid: 42, identity: "birth-two", state: "lost", evidence: "process_birth_changed", nativeEventId: "native-two" },
  ]);
});

test("scoped refresh settles receipts independently of capture gaps and late native outcomes", async () => {
  for (const gap of [false, true]) {
    let hints = 0;
    const f = fixture("codex_app_server", undefined, () => { hints++; });
    try {
      f.bindTurn(); await f.install(); f.emit(ready); f.emit(active); await flush();
      if (gap) {
        for (let index = 0; index < 300; index++) f.emit(ready);
        await flush(); assert.ok(f.diagnostics.includes("source_gap"));
      }
      assert.equal(f.db.prepare("SELECT state FROM execution_message_attempts").get()!.state, "active");
      f.db.prepare(`UPDATE inbox_items SET state='acknowledged_no_reply',
        outcome=?,acknowledged_at=?,updated_at=?`).run(JSON.stringify({ kind: "no_reply", text: null }), now, now);
      const operational = f.db.prepare("SELECT * FROM inbox_items").all();
      const beforeSettlement = hints;
      f.capture.refresh("agent"); await flush();
      assert.equal(hints, beforeSettlement + 1, "receipt-only progress notifies even when capture is suspended");
      const settled = f.db.prepare("SELECT state,conclusion,settled_at_ms FROM execution_message_attempts").get();
      assert.deepEqual({ ...settled }, { state: "cleanly_concluded", conclusion: "acknowledged_no_reply", settled_at_ms: Date.parse(now) });
      assert.equal(f.db.prepare("SELECT state FROM runs").get()!.state, "active", "receipt settlement is not native-turn lifecycle authority");
      if (!gap) {
        f.emit(terminal);
        f.emit({ ...nativeTurn, domain: "execution", kind: "completed", executionId: "late-read", operation: "file_read", outcome: "failed", sideEffects: "none" });
        await flush(); assert.equal(f.facts().length, 4, "late exact native evidence remains ingestible after logical settlement");
      }
      const beforeRefresh = hints;
      f.capture.refresh("agent"); await flush();
      assert.equal(hints, beforeRefresh, "already settled receipts do not notify again");
      assert.deepEqual(f.db.prepare("SELECT state,conclusion,settled_at_ms FROM execution_message_attempts").get(), settled);
      assert.deepEqual(f.db.prepare("SELECT * FROM inbox_items").all(), operational);
    } finally { f.capture.close(); }
  }
});

test("scoped refresh leaves unrelated capture lanes untouched while unscoped hints still sweep", async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  const reads = new Map<ProviderActionHandle, number>();
  const f = fixture("codex_app_server", (handle, listener) => {
    const subscription = sources.get(handle)!.subscribe(listener);
    return { ...subscription, position: () => {
      reads.set(handle, (reads.get(handle) ?? 0) + 1);
      return subscription.position();
    } };
  });
  const second = secondCaptureLane(f);
  sources.set(f.handle, f.observer);
  sources.set(second.handle, new ProviderExecutionObserver(() => now));
  try {
    f.install(); f.capture.install(second.token); await flush();
    assert.equal(f.admission(), "ready");
    assert.equal(f.capture.captureAdmission(second.token), "ready");
    const before = f.db.prepare("SELECT * FROM execution_observers ORDER BY agent_id").all();
    reads.clear();
    f.capture.refresh("agent"); await flush();
    assert.ok((reads.get(f.handle) ?? 0) > 0);
    assert.equal(reads.get(second.handle) ?? 0, 0, "one agent's commit never rereads its peer's source");
    reads.clear();
    f.capture.refresh("unknown-agent"); await flush();
    assert.equal(reads.size, 0, "an exact missing agent is not an unscoped hint");
    f.capture.refresh(); await flush();
    assert.ok((reads.get(f.handle) ?? 0) > 0);
    assert.ok((reads.get(second.handle) ?? 0) > 0);
    assert.deepEqual(f.db.prepare("SELECT * FROM execution_observers ORDER BY agent_id").all(), before);
    assert.deepEqual(f.diagnostics, []);
  } finally { f.capture.close(); }
});

test("capture change hints follow fact and receipt commits, survive callback failure and never run on close", async () => {
  const snapshots: Array<{ agentId: string; facts: number; state: unknown; transaction: boolean }> = [];
  const f = fixture("codex_app_server", undefined, agentId => {
    snapshots.push({ agentId, facts: f.facts().length,
      state: f.db.prepare("SELECT state FROM execution_message_attempts").get()?.state, transaction: f.db.isTransaction });
    throw new Error("optional summary observer unavailable");
  });
  try {
    f.bindTurn();
    f.db.prepare("UPDATE inbox_items SET state='acknowledged_no_reply',outcome=?,acknowledged_at=?")
      .run(JSON.stringify({ kind: "no_reply", text: null }), now);
    await f.install(); f.emit(ready); f.emit(active); f.emit(terminal); await flush();
    assert.deepEqual(snapshots.at(-1), { agentId: "agent", facts: 3, state: "cleanly_concluded", transaction: false },
      "the hint sees both captured evidence and receipt settlement after their transactions");
    assert.ok(snapshots.every(snapshot => !snapshot.transaction));
    f.emit({ ...nativeTurn, domain: "execution", kind: "completed", executionId: "late-read", operation: "file_read", outcome: "succeeded", sideEffects: "none" });
    await flush(); assert.equal(f.facts().length, 4, "a throwing hint cannot suspend subsequent capture");
    assert.deepEqual(f.diagnostics, []);
    const calls = snapshots.length;
    for (let index = 0; index < 3; index++) { f.capture.refresh(); await flush(); }
    assert.equal(snapshots.length, calls, "unchanged refreshes do not announce another state change");
    f.emit(ready); f.capture.close(); f.emit(ready); await flush();
    assert.equal(snapshots.length, calls, "shutdown frontier preservation and queued facts never request publication");
  } finally { f.capture.close(); }
});

test("a lost last observation that the source reports as a gap suspends capture with no later observation", async () => {
  for (const reportGap of [false, true]) {
    let latestSequence = 0;
    let gap: (() => void) | undefined;
    const f = fixture("codex_app_server", async (_handle, _listener, onGap) => {
      gap = onGap;
      return { sourceId: "source-lost-tail", position: () => ({ firstRetainedSequence: latestSequence + 1, latestSequence }), dispose() {} };
    });
    try {
      await f.install(); await flush();
      assert.equal(f.diagnostics.includes("source_gap"), false);
      // The source made observation 1 and could not deliver it. Nothing follows it.
      latestSequence = 1;
      if (reportGap) gap!();
      await flush();
      assert.equal(f.diagnostics.includes("source_gap"), reportGap, reportGap ? "the gap call wakes capture" : "with no gap call nothing wakes capture");
    } finally { f.capture.close(); f.db.close(); }
  }
});

test("an empty capture source announces admission once, then stays quiet until progress", async () => {
  let hints = 0;
  const f = fixture("codex_app_server", undefined, () => { hints++; });
  try {
    await f.install(); await flush();
    assert.equal(f.admission(), "ready");
    assert.equal(hints, 1);
    const observer = f.db.prepare("SELECT * FROM execution_observers").get();
    for (let index = 0; index < 3; index++) { f.capture.refresh(); await flush(); }
    assert.deepEqual(f.db.prepare("SELECT * FROM execution_observers").get(), observer);
    assert.equal(hints, 1, "no facts, receipt settlement, or admission change means no notification");
    f.emit(ready); await flush();
    assert.equal(hints, 2);
    f.bindTurn(); // External commit changes admission without a new native fact.
    f.capture.refresh(); await flush();
    assert.equal(f.admission(), "unavailable");
    assert.equal(hints, 3);
    f.capture.refresh(); await flush();
    assert.equal(hints, 3);
    f.emit(active); await flush();
    assert.equal(f.admission(), "ready");
    assert.equal(hints, 4);
  } finally { f.capture.close(); }
});

test("capture announces partial committed progress but not repeated failed no-op retries", async () => {
  let hints = 0;
  const f = fixture("codex_app_server", undefined, () => { hints++; });
  try {
    await f.install(); await flush();
    f.bindTurn(); f.capture.refresh(); await flush();
    const before = hints;
    f.db.exec(`CREATE TRIGGER reject_native_turn BEFORE INSERT ON runs
      BEGIN SELECT RAISE(ABORT,'native turn unavailable'); END`);
    f.emit(active); await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_message_attempts").get()!.n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_attempt_generations").get()!.n, 1);
    assert.equal(f.facts().length, 0);
    assert.equal(hints, before + 1, "the attempt committed before the native-turn write failed");
    f.capture.refresh(); await flush();
    assert.equal(hints, before + 1, "idempotent attempt tracking and the same diagnostic are not new progress");
    f.db.exec("DROP TRIGGER reject_native_turn");
    f.capture.refresh(); await flush();
    assert.equal(f.facts().length, 1);
    assert.equal(f.admission(), "ready");
    assert.equal(hints, before + 2);
  } finally { f.capture.close(); }
});

test("scoped receipt batches revisit corrected earlier receipts and settle late native attempts", async () => {
  const f = fixture();
  try {
    await f.install(); f.emit(ready); await flush();
    const runtime = String(f.db.prepare("SELECT runtime_generation_id FROM execution_runtime_generations").get()!.runtime_generation_id);
    f.bindTurn("native-late", "late-message");
    f.db.prepare(`UPDATE inbox_items SET state='acknowledged_no_reply',outcome=?,acknowledged_at=? WHERE inbox_item_id='native-late'`)
      .run(JSON.stringify({ kind: "no_reply", text: null }), now);
    for (let index = 0; index < 40; index++) {
      const turn = `native-${index}`; const source = `message-${index}`; const attempt = `attempt-${index}`;
      f.bindTurn(turn, source);
      f.db.prepare(`UPDATE inbox_items SET state='acknowledged_no_reply',outcome=?,acknowledged_at=? WHERE inbox_item_id=?`)
        .run(JSON.stringify({ kind: index === 0 ? "unreadable" : "no_reply", text: null }), now, turn);
      f.db.prepare(`INSERT INTO execution_message_attempts(attempt_id,agent_id,room_id,source_message_id,state,created_at_ms)
        VALUES(?,'agent','room',?,'active',?)`).run(attempt, source, Date.parse(now));
      f.db.prepare(`INSERT INTO execution_attempt_generations VALUES(?,'agent','room','generation','workspace',?)`).run(attempt, Date.parse(now));
      f.db.prepare(`INSERT INTO runs(turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,
        provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms)
        VALUES(?,?,'agent','room','generation',?,'continuation',?,'terminal','none',?,?)`)
        .run(turn, attempt, runtime, turn, Date.parse(now), Date.parse(now));
    }
    f.capture.refresh("agent"); await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_message_attempts WHERE state='cleanly_concluded'").get()!.n, 39);
    assert.equal(f.db.prepare("SELECT state FROM execution_message_attempts WHERE attempt_id='attempt-0'").get()!.state, "active");
    assert.ok(f.diagnostics.includes("settlement_unavailable"));
    assert.equal(f.admission(), "ready",
      "downstream settlement diagnostics do not revoke native capture admission");
    // A later authoritative correction rechecks earlier receipts rather than
    // treating the in-memory scan cursor as durable settlement authority.
    f.db.prepare("UPDATE inbox_items SET outcome=? WHERE inbox_item_id='native-0'").run(JSON.stringify({ kind: "no_reply", text: null }));
    f.capture.refresh("agent"); await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_message_attempts WHERE state='cleanly_concluded'").get()!.n, 40);
    // No new operational mutation: native capture itself must reconsider the
    // older receipt once its previously missing attempt becomes available.
    f.emit({ ...active, providerTurnId: "native-late" }); await flush();
    assert.deepEqual({ ...f.db.prepare("SELECT state,conclusion FROM execution_message_attempts WHERE source_message_id='late-message'").get() },
      { state: "cleanly_concluded", conclusion: "acknowledged_no_reply" });
  } finally { f.capture.close(); }
});

test("settlement diagnostics never hide a native capture failure", async () => {
  const f = fixture();
  try {
    f.bindTurn(); await f.install(); f.emit(ready); f.emit(active); await flush();
    assert.equal(f.admission(), "ready");
    f.db.prepare("UPDATE inbox_items SET state='acknowledged_no_reply',outcome=?,acknowledged_at=?")
      .run(JSON.stringify({ kind: "no_reply", text: null }), now);
    f.db.exec(`CREATE TRIGGER reject_capture_fact BEFORE INSERT ON execution_facts
      BEGIN SELECT RAISE(ABORT,'injected capture failure'); END;
      CREATE TRIGGER reject_attempt_settlement BEFORE UPDATE OF state ON execution_message_attempts
      BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END;`);
    f.emit(ready); await flush();
    assert.ok(f.diagnostics.includes("storage_unavailable"));
    assert.equal(f.diagnostics.at(-1), "settlement_unavailable");
    assert.equal(f.admission(), "unavailable",
      "a downstream settlement warning cannot erase the native capture failure");
    f.db.exec("DROP TRIGGER reject_capture_fact; DROP TRIGGER reject_attempt_settlement");
    f.capture.refresh(); await flush();
    assert.equal(f.admission(), "ready",
      "successful exact capture recovers admission from current evidence without a cached failure status");
  } finally { f.capture.close(); }
});

test("scoped refresh drains a detached exit before its paused successor source", async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  const f = fixture("codex_app_server", (handle, listener) => sources.get(handle)!.subscribe(listener));
  const old = new ProviderExecutionObserver(() => now);
  sources.set(f.handle, old);
  const exec = f.db.exec.bind(f.db);
  try {
    f.handle.appliedConfigurationRevision = 2;
    const detach = await f.install(); old.emit(ready, "birth-secret", 42); await flush();
    let blocked = 0;
    f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") { blocked++; throw new Error("database is busy"); } return exec(sql); };
    old.emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "process_exit", sideEffects: "none" }, "birth-secret", 42);
    detach();
    f.db.exec = exec;
    const next = successor(f, "fresh-birth");
    const fresh = new ProviderExecutionObserver(() => now); sources.set(next, fresh);
    f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") { blocked++; throw new Error("database is busy"); } return exec(sql); };
    await f.install(next); fresh.emit(ready, "fresh-birth", 42);
    await flush();
    assert.ok(blocked >= 1); assert.equal(f.facts().length, 1);
    await flush(); assert.equal(f.facts().length, 1, "optional diagnostics cannot timer-retry operational fact capture");
    f.db.exec = exec;
    f.capture.refresh("unknown-agent"); await flush();
    assert.equal(f.facts().length, 1, "another agent's hint cannot retry the retained exit or paused successor");
    f.capture.refresh("agent"); await flush();
    assert.equal(f.facts().length, 3);
    const rows = f.facts();
    assert.equal(rows[0].runtime_generation_id, rows[1].runtime_generation_id);
    assert.notEqual(rows[1].runtime_generation_id, rows[2].runtime_generation_id);
    assert.deepEqual(f.db.prepare("SELECT runtime_state FROM execution_runtime_generations ORDER BY rowid").all().map(row => row.runtime_state), ["exited", "ready"]);
    const witness = fresh.subscribe(() => {}); witness.dispose();
    assert.equal(f.db.prepare("SELECT source_id FROM execution_observers").get()!.source_id, witness.sourceId);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 1 });
  } finally { f.db.exec = exec; f.capture.close(); }
});

test("rapid replacement suspends capture instead of accumulating retired subscriptions", async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  let subscriptions = 0; let live = 0; let maximum = 0;
  const f = fixture("codex_app_server", (handle, listener) => {
    subscriptions++; live++; maximum = Math.max(maximum, live);
    const subscription = sources.get(handle)!.subscribe(listener);
    let disposed = false;
    return { ...subscription, dispose() { if (!disposed) { disposed = true; live--; subscription.dispose(); } } };
  });
  sources.set(f.handle, new ProviderExecutionObserver(() => now));
  const exec = f.db.exec.bind(f.db);
  try {
    await f.install(); sources.get(f.handle)!.emit(ready, "birth-secret", 42); await flush();
    f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
    sources.get(f.handle)!.emit(ready, "birth-secret", 42);
    f.db.exec = exec;
    const second = successor(f, "second"); sources.set(second, new ProviderExecutionObserver(() => now));
    f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
    await f.install(second); await flush();
    assert.equal(subscriptions, 2);
    for (let index = 0; index < 20; index++) {
      f.db.exec = exec;
      const next = successor(f, `replacement-${index}`); sources.set(next, new ProviderExecutionObserver(() => now));
      f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
      await f.install(next);
    }
    await flush();
    assert.equal(subscriptions, 2); assert.equal(live, 0); assert.equal(maximum, 1);
    assert.ok(f.diagnostics.includes("source_gap"));
    f.db.exec = exec; f.capture.refresh(); await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_observer_sources").get()!.n, 1, "no skipped intermediate source is admitted");
    assert.equal(f.facts().length, 2, "only the retained oldest lane can finish draining");
  } finally { f.db.exec = exec; f.capture.close(); }
});

test("planned handoff drains a valid tail and freezes its boundary before cleanup callbacks", async () => {
  const f = fixture("codex_app_server", undefined, undefined, new DatabaseSync(":memory:"), "typed");
  const close = f.db.close.bind(f.db);
  let replacement: ExecutionCaptureCoordinator | undefined;
  try {
    f.install(); f.emit(ready); await flush();
    f.emit({ domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" });
    f.capture.sealForPlannedHandoff();
    f.emit({ domain: "control", kind: "state_changed", state: "unprobeable", sideEffects: "none" });
    f.db.close = () => {};
    f.capture.close();
    assert.equal(f.facts().length, 2);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 2, max_observed_sequence: 2 });
    const fresh = new ProviderExecutionObserver(() => now);
    const diagnostics: string[] = [];
    replacement = new ExecutionCaptureCoordinator(f.db, {
      provider: { onExecution: (_handle, listener) => fresh.subscribe(listener) },
      currentHandle: id => f.handles.get(id), daemonGeneration: () => 2,
      diagnostic: (_id, code) => diagnostics.push(code),
    });
    replacement.install(f.tokenFor()); fresh.emit(ready, "birth-secret", 42); await flush();
    assert.equal(replacement.captureAdmission(f.tokenFor()), "ready");
    assert.deepEqual(diagnostics, [], "the preserved process can adopt a new source without a fabricated gap");
  } finally { replacement?.close(); f.db.close = close; f.capture.close(); close(); }
});

test("planned capture handoff defers on a real storage lock without detaching observation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-handoff-lock-"));
  const path = join(directory, "synthetic.sqlite");
  const f = fixture("codex_app_server", undefined, undefined, new DatabaseSync(path), "typed");
  const competing = new DatabaseSync(path);
  try {
    f.install(); f.emit(ready); await flush();
    competing.exec("BEGIN IMMEDIATE");
    f.emit(ready);
    assert.throws(() => f.capture.sealForPlannedHandoff(), /Update deferred/);
    competing.exec("ROLLBACK");
    f.emit(ready);
    f.capture.sealForPlannedHandoff();
    assert.equal(f.facts().length, 3, "failure preserved the old owner's subscription and queued tail");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 3, max_observed_sequence: 3 });
  } finally {
    if (competing.isTransaction) competing.exec("ROLLBACK");
    competing.close(); f.capture.close(); if (f.db.isOpen) f.db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("a record that stops is reported for its owner once, and one that is only waiting is not", async () => {
  const f = fixture();
  try {
    f.install();
    // A turn the record cannot place yet: it may still be bound, so nothing has stopped.
    f.emit(ready); f.emit(active); await flush();
    assert.deepEqual(f.diagnostics, ["identity_unavailable"]);
    assert.deepEqual(f.stopped, []);
    assert.equal(f.capture.recordBlock(f.tokenFor()), "identity_unavailable", "though it holds delivery for as long as it lasts");
    f.bindTurn(); f.capture.refresh("agent"); await flush();
    assert.equal(f.capture.recordBlock(f.tokenFor()), null);

    // A position that was used up without a fact: the record stops here.
    f.observer.markUnavailable(); f.emit(terminal); await flush();
    f.emit(ready); await flush();
    assert.deepEqual(f.stopped, ["agent"]);
    assert.equal(f.capture.recordBlock(f.tokenFor()), "source_gap");
    assert.equal(f.capture.recordBlock({ ...f.tokenFor() }), null, "only for the exact runtime the record belongs to");
  } finally { f.capture.close(); }
});

/** One execution source per runtime, as each provider process has. */
function perRuntimeSources() {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  const f = fixture("codex_app_server", (handle, listener) => {
    if (!sources.has(handle)) sources.set(handle, new ProviderExecutionObserver(() => now));
    return sources.get(handle)!.subscribe(listener);
  });
  sources.set(f.handle, f.observer);
  const entry = (overrides: Partial<DaemonManifestEntry> = {}) => ({ id: "agent", room_id: "room", delivery_mode: "daemon_inbox",
    desired_state: "running", provider: "codex", provider_ref: null, ...overrides }) as DaemonManifestEntry;
  /** What the daemon does before it starts a successor, in the fenced transaction it uses. */
  const archive = (manifestEntry = entry(), identity?: Parameters<typeof archiveExitedRuntimes>[2]) => {
    f.db.exec("BEGIN IMMEDIATE");
    try { const archived = archiveExitedRuntimes(f.db, manifestEntry, identity); f.db.exec("COMMIT"); return archived; }
    catch (error) { f.db.exec("ROLLBACK"); throw error; }
  };
  const endGeneration = (death?: { pid: number; processIdentity: string }) => f.db.prepare("UPDATE work_attempt_executions SET terminal_json=?")
    .run(JSON.stringify({ ended_at: now, exit_code: null, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "crashed",
      actor: "test", generation: 1, provider_continuation_id: "continuation",
      ...(death ? { native_runtime_death: { kind: "codex_app_server", ...death } } : {}) }));
  const runtimeOf = (handle: ProviderActionHandle) => executionRuntimeStorageIdentity("agent", "generation", handle.providerConnection!.kind,
    handle.providerConnection!.pid!, handle.providerConnection!.processIdentity!);
  const emitFrom = (handle: ProviderActionHandle, fact: NativeExecutionFact) => sources.get(handle)!.emit(fact,
    handle.providerConnection!.processIdentity!, handle.providerConnection!.pid!);
  return { ...f, sources, entry, archive, endGeneration, runtimeOf, emitFrom };
}

test("the daemon archives an exited runtime only when nothing else can complete its record, once, and never invents its ending", async () => {
  const f = perRuntimeSources();
  try {
    f.install(); f.emit(ready); await flush();
    f.bindTurn(); f.emit(active); await flush();
    const first = f.runtimeOf(f.handle);
    f.observer.markUnavailable(); f.emit(terminal); await flush();
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 2, max_observed_sequence: 4 }, "a gap under an open turn");

    assert.deepEqual(f.archive(), [], "a generation that has not ended is left alone");
    f.endGeneration({ pid: 42, processIdentity: "birth-secret" });
    f.db.prepare("INSERT INTO agent_runtime_recoveries VALUES('manual','agent','room','generation','another-runtime','resume','prepared','{}',NULL,?,?)").run(now, now);
    assert.deepEqual(f.archive(), [], "a recovery a person started is theirs to finish");
    f.db.prepare("DELETE FROM agent_runtime_recoveries").run();
    assert.deepEqual(f.archive(f.entry({ delivery_mode: "mcp_polling" })), [], "a lane that polls for itself has no such record to continue");

    const before = { ...f.db.prepare("SELECT * FROM execution_observers").get()! };
    assert.deepEqual(f.archive(), [first]);
    const row = f.db.prepare("SELECT * FROM agent_runtime_recoveries").get()!;
    assert.deepEqual([row.agent_id, row.room_id, row.execution_generation_id, row.runtime_generation_id, row.mode, row.phase],
      ["agent", "room", "generation", first, "resume", "complete"]);
    assert.deepEqual(JSON.parse(String(row.observer_json)), before, "the observer is kept as it stood, gap included");
    assert.deepEqual(JSON.parse(String(row.provider_ref_json)), { work_attempt_id: "workspace", execution_generation_id: "generation",
      provider_continuation_id: "continuation", provider_connection: null,
      native_runtime_death: { kind: "codex_app_server", pid: 42, processIdentity: "birth-secret" } });
    assert.equal(f.db.prepare("SELECT observer_epoch FROM execution_observers").get()!.observer_epoch, Number(before.observer_epoch) + 1);
    assert.deepEqual({ ...f.db.prepare("SELECT runtime_state,control_state FROM execution_runtime_generations WHERE runtime_generation_id=?").get(first) },
      { runtime_state: "exited", control_state: "lost" });
    assert.deepEqual(f.db.prepare("SELECT state FROM runs").all().map(turn => turn.state), ["lost"], "its open turn is lost, not finished");
    assert.equal(f.facts().length, 2, "no fact is added");
    assert.equal(f.db.prepare("SELECT state FROM inbox_items").get()!.state, "awaiting_result", "and no message is cancelled");
    assert.equal(f.db.prepare("SELECT state FROM execution_message_attempts").get()!.state, "active", "nor any attempt marked lost");
    assert.deepEqual(f.archive(), [], "one boundary per runtime");
  } finally { f.capture.close(); }
});

test("a turn whose message is still to be settled is left for its replacement, and a process that is still running is never archived", async () => {
  const f = perRuntimeSources();
  try {
    f.install(); f.emit(ready); await flush();
    f.bindTurn("native-turn", "message", "result_recovery"); f.emit(active); await flush();
    f.emit({ ...active, state: "lost" }); await flush();
    f.endGeneration();
    assert.deepEqual(f.archive(), [], "the replacement reads this turn's ending back and records it");
    f.db.prepare("UPDATE inbox_items SET state='acknowledged_failed'").run();
    const first = f.runtimeOf(f.handle);

    // The runtime the manifest still names is checked against the operating system.
    const birth = "Mon Jan  5 10:00:00 2026";
    const identity = (alive: boolean) => ({ probe: () => { if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
      readBirthIdentity: () => birth, sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() });
    const second = successor(f, birth);
    f.install(second); f.emitFrom(second, ready); await flush();
    f.sources.get(second)!.markUnavailable(); f.emitFrom(second, ready); await flush();
    const saved = f.entry({ provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
      provider_continuation_id: "continuation", provider_connection: second.providerConnection! } });
    assert.deepEqual(f.archive(saved, identity(true)), [first], "the settled turn's runtime is archived; the running process is not");
    assert.deepEqual(f.archive(saved, identity(false)), [f.runtimeOf(second)], "once the process is gone its gap is archived too");
    const boundaries = f.db.prepare("SELECT runtime_generation_id,observer_json,provider_ref_json FROM agent_runtime_recoveries ORDER BY rowid").all();
    assert.equal(boundaries[0]!.observer_json, null, "a runtime the observer has left carries no observer");
    assert.equal(JSON.parse(String(boundaries[1]!.observer_json)).observer_runtime_generation_id, f.runtimeOf(second));
    assert.equal("native_runtime_death" in JSON.parse(String(boundaries[1]!.provider_ref_json)), false,
      "an ending recorded without process evidence is archived without any");
  } finally { f.capture.close(); }
});

test("the runtime the saved reference names is archived only once its process is known to have ended, never while that cannot be told", async () => {
  const birth = "Mon Jan  5 10:00:00 2026";
  /** What the operating system answers for the saved process. */
  const identities = {
    "still running": { probe: () => {}, readBirthIdentity: () => birth, sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() },
    "not readable (EPERM)": { probe: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); }, readBirthIdentity: () => birth,
      sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() },
    "running, with a birth that cannot be read": { probe: () => {}, readBirthIdentity: (): string => { throw new Error("ps failed"); },
      sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() },
    "gone": { probe: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, readBirthIdentity: () => birth,
      sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() },
    "another process under its id": { probe: () => {}, readBirthIdentity: () => "Tue Jan  6 11:00:00 2026",
      sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() },
  } as const;
  for (const [answer, identity] of Object.entries(identities)) for (const witnessed of [false, true]) {
    const f = perRuntimeSources();
    try {
      // The saved runtime has a gap, and its generation has a recorded terminal.
      const saved = successor(f, birth);
      f.install(saved); f.emitFrom(saved, ready); await flush();
      f.sources.get(saved)!.markUnavailable(); f.emitFrom(saved, ready); await flush();
      f.endGeneration(witnessed ? { pid: saved.providerConnection!.pid!, processIdentity: birth } : undefined);
      const entry = f.entry({ provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
        provider_continuation_id: "continuation", provider_connection: saved.providerConnection! } });
      const verified = answer === "gone" || answer === "another process under its id" || (witnessed && answer !== "still running");
      assert.deepEqual(f.archive(entry, identity).includes(f.runtimeOf(saved)), verified,
        `${answer}, ${witnessed ? "with" : "without"} the death in its terminal: ${verified ? "archived" : "left alone"}`);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE runtime_generation_id=?").get(f.runtimeOf(saved))!.n, verified ? 1 : 0);
    } finally { f.capture.close(); }
  }
});

test("a Cursor child whose turn a replaced daemon left open is archived once the lane has moved off it and its message is settled", async () => {
  // Cursor runs a child per turn in one generation, which has no terminal while the lane lives.
  const f = fixture("cursor_cli");
  try {
    f.install(); f.emit(ready); await flush();
    f.bindTurn(); f.emit(active); await flush();
    const child = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 42, "birth-secret");
    assert.deepEqual(f.db.prepare("SELECT state FROM runs").all().map(turn => turn.state), ["active"],
      "the daemon that saw the turn start was replaced before it saw the turn end");
    const lane = (connection: ProviderActionConnectionRef) => ({ id: "agent", room_id: "room", delivery_mode: "daemon_inbox",
      desired_state: "running", provider: "cursor", provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation",
        provider_continuation_id: "continuation", provider_connection: connection } }) as DaemonManifestEntry;
    const idle = lane({ kind: "cursor_cli", pid: null, processIdentity: null });
    const archive = (entry: DaemonManifestEntry, identity?: Parameters<typeof archiveExitedRuntimes>[2]) => {
      f.db.exec("BEGIN IMMEDIATE");
      try { const archived = archiveExitedRuntimes(f.db, entry, identity); f.db.exec("COMMIT"); return archived; }
      catch (error) { f.db.exec("ROLLBACK"); throw error; }
    };

    assert.deepEqual(archive(lane(f.handle.providerConnection!)), [], "the child the saved reference names is the lane's own");
    assert.deepEqual(archive(idle), [], "a turn whose message is still to be settled is left for its recovery to read back");
    f.db.prepare("UPDATE inbox_items SET state='acknowledged'").run();
    assert.deepEqual(archive(lane(f.handle.providerConnection!)), [], "nor while the saved reference still names the child");
    assert.deepEqual(archive(idle), [child],
      "once the lane is idle again and the message is settled, the child is archived");
    assert.deepEqual(f.db.prepare("SELECT state FROM runs").all().map(turn => turn.state), ["lost"], "its open turn is lost, not finished");
    assert.deepEqual({ ...f.db.prepare("SELECT runtime_state FROM execution_runtime_generations WHERE runtime_generation_id=?").get(child) },
      { runtime_state: "exited" });
    assert.equal(f.db.prepare("SELECT terminal_json FROM work_attempt_executions").get()!.terminal_json, null, "the lane's generation goes on");
    assert.equal(f.db.prepare("SELECT state FROM inbox_items").get()!.state, "acknowledged", "and no message is changed");
    assert.deepEqual(archive(idle), [], "one boundary per child");

    // A child the saved reference still names is the lane's own until the lane has settled its exit, even once its
    // process is gone: the lane may still be recording that child's last facts, which a boundary would refuse.
    const store = new ExecutionShadowStore(f.db);
    const birth = "Mon Jan  5 10:00:00 2026";
    const gone = { probe: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, readBirthIdentity: () => birth,
      sameBirthIdentity: (actual: string, expected: string) => actual.trim() === expected.trim() };
    const ended = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 44, birth);
    store.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: ended,
      provider: "cursor", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
    store.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation", runtimeGenerationId: ended,
      attemptId: store.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "ended-message", executionGenerationId: "generation",
        workspaceId: "workspace", createdAtMs: Date.parse(now) }),
      turnId: "ended-turn", providerContinuationId: "continuation", providerTurnId: "ended-native-turn", createdAtMs: Date.parse(now) });
    assert.deepEqual(archive(lane({ kind: "cursor_cli", pid: 44, processIdentity: birth }), gone), [], "the child the saved reference names is not archived");
    assert.deepEqual(archive(idle, gone), [ended], "once the lane has moved off it, it is");

    // The next child's turn is no longer refused by the one left open, and that child is the lane's own.
    const next = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 43, "birth-next");
    store.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: next,
      provider: "cursor", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
    f.bindTurn("next-native-turn", "next-message", "dispatching");
    const attemptId = store.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "next-message",
      executionGenerationId: "generation", workspaceId: "workspace", createdAtMs: Date.parse(now) });
    assert.doesNotThrow(() => store.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation",
      runtimeGenerationId: next, attemptId, turnId: "next-turn", providerContinuationId: "continuation", providerTurnId: "next-native-turn",
      createdAtMs: Date.parse(now) }));
    assert.deepEqual(archive(lane({ kind: "cursor_cli", pid: 43, processIdentity: "birth-next" })), [], "the running child is never archived");
  } finally { f.capture.close(); }
});

test("outside Cursor, a runtime of a generation without a recorded terminal is never archived", async () => {
  for (const kind of ["codex_app_server", "claude_cli", "opencode_server"] as const) {
    const f = fixture(kind);
    try {
      // Another runtime of the agent's live generation, with a turn left open for a message that is settled.
      const store = new ExecutionShadowStore(f.db);
      const provider = { codex_app_server: "codex", claude_cli: "claude-code", opencode_server: "open-model" } as const;
      const other = executionRuntimeStorageIdentity("agent", "generation", kind, 43, "birth-other");
      store.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: other,
        provider: provider[kind], authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
      store.trackNativeTurn({ agentId: "agent", roomId: "room", executionGenerationId: "generation", runtimeGenerationId: other,
        attemptId: store.trackMessage({ agentId: "agent", roomId: "room", sourceMessageId: "settled-message", executionGenerationId: "generation",
          workspaceId: "workspace", createdAtMs: Date.parse(now) }),
        turnId: "open-turn", providerContinuationId: "continuation", providerTurnId: "open-native-turn", createdAtMs: Date.parse(now) });
      const entry = { id: "agent", room_id: "room", delivery_mode: "daemon_inbox", desired_state: "running", provider: provider[kind],
        provider_ref: { work_attempt_id: "workspace", execution_generation_id: "generation", provider_continuation_id: "continuation",
          provider_connection: f.handle.providerConnection! } } as DaemonManifestEntry;
      const archive = () => {
        f.db.exec("BEGIN IMMEDIATE");
        try { const archived = archiveExitedRuntimes(f.db, entry); f.db.exec("COMMIT"); return archived; }
        catch (error) { f.db.exec("ROLLBACK"); throw error; }
      };
      assert.deepEqual(archive(), [], `${kind}: its generation has not ended`);
      f.db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='generation'").run(JSON.stringify({
        ended_at: now, exit_code: 0, signal: null, stdio_archive_ref: null, stdio_tail: "", terminal_cause: "exited", actor: "test", generation: 1,
        provider_continuation_id: "continuation" }));
      assert.deepEqual(archive(), [other], `${kind}: once it has, that runtime is archived`);
    } finally { f.capture.close(); }
  }
});

test("a recovery boundary lifts an agent's suspended record for the runtime that starts behind it", async () => {
  const f = perRuntimeSources();
  try {
    f.install(); f.emit(ready); await flush();
    f.observer.markUnavailable(); f.emit(ready); await flush();
    // Two replacements in quick succession: the second is installed while the first lane is still retiring.
    const second = successor(f, "birth-2"); f.install(second);
    const third = successor(f, "birth-3"); f.install(third);
    await flush();
    assert.equal(f.admission(third), "unavailable", "the agent's record is suspended");
    assert.equal(f.capture.recordBlock(f.tokenFor(third)), "suspended", "which holds the delivery of a runtime that was given no lane at all");

    f.endGeneration();
    assert.deepEqual(f.archive(), [f.runtimeOf(f.handle)]);
    const fourth = successor(f, "birth-4");
    f.install(fourth); f.emitFrom(fourth, ready); await flush();
    assert.equal(f.admission(fourth), "ready", "the next runtime is recorded");
    assert.equal(f.db.prepare("SELECT observer_runtime_generation_id FROM execution_observers").get()!.observer_runtime_generation_id, f.runtimeOf(fourth));
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 1 });
  } finally { f.capture.close(); }
});

test("planned capture handoff preserves a preexisting suspended gap without requiring recovery", async () => {
  const f = fixture();
  try {
    f.install(); f.emit(ready); await flush();
    f.observer.markUnavailable(); f.emit(ready); await flush();
    const before = { facts: f.facts(), position: f.position(), diagnostics: [...f.diagnostics] };
    assert.equal(before.position!.last_source_sequence, 1);
    assert.equal(before.position!.max_observed_sequence, 3);
    assert.doesNotThrow(() => f.capture.sealForPlannedHandoff());
    assert.deepEqual({ facts: f.facts(), position: f.position(), diagnostics: f.diagnostics }, before);
    assert.equal(f.admission(), "unavailable");
  } finally { f.capture.close(); }
});

test("planned handoff keeps every current subscription when a later lane fails preparation", async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  let failing: ProviderActionHandle | undefined;
  const f = fixture("codex_app_server", (handle, listener) => {
    const subscription = sources.get(handle)!.subscribe(listener);
    return { ...subscription, position: () => {
      if (failing === handle) throw new Error("source position temporarily unavailable");
      return subscription.position();
    } };
  });
  const second = secondCaptureLane(f);
  const other = new ProviderExecutionObserver(() => now);
  sources.set(f.handle, f.observer); sources.set(second.handle, other);
  try {
    f.install(); f.capture.install(second.token);
    f.emit(ready); other.emit(ready, "birth-secret", 42); await flush();
    f.emit(ready); other.emit(ready, "birth-secret", 42); failing = second.handle;
    assert.throws(() => f.capture.sealForPlannedHandoff(), /Update deferred/);
    assert.equal(f.facts().filter(row => row.agent_id === "agent").length, 2,
      "useful progress committed before the later failure is retained");
    failing = undefined;
    f.emit(ready); other.emit(ready, "birth-secret", 42);
    f.capture.sealForPlannedHandoff();
    for (const agentId of ["agent", second.agentId]) {
      assert.equal(f.facts().filter(row => row.agent_id === agentId).length, 3,
        "both original subscriptions survived the rejected preparation");
    }
  } finally { failing = undefined; f.capture.close(); }
});

test("planned handoff drains a healthy lane alongside an unchanged historical source gap", async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  const f = fixture("codex_app_server", (handle, listener) => sources.get(handle)!.subscribe(listener));
  const second = secondCaptureLane(f);
  const other = new ProviderExecutionObserver(() => now);
  sources.set(f.handle, f.observer); sources.set(second.handle, other);
  try {
    f.install(); f.capture.install(second.token);
    f.emit(ready); other.emit(ready, "birth-secret", 42); await flush();
    other.markUnavailable(); other.emit(ready, "birth-secret", 42); await flush();
    const damaged = () => f.db.prepare("SELECT * FROM execution_observers WHERE agent_id=?").get(second.agentId);
    const before = damaged();
    assert.equal(before!.last_source_sequence, 1); assert.equal(before!.max_observed_sequence, 3);
    f.emit(ready); f.capture.sealForPlannedHandoff();
    assert.equal(f.facts().filter(row => row.agent_id === "agent").length, 2);
    assert.equal(f.facts().filter(row => row.agent_id === second.agentId).length, 1);
    assert.deepEqual(damaged(), before, "planned update cannot rewrite or repair the historical gap");
  } finally { f.capture.close(); }
});

for (const damaged of [false, true]) test(`planned handoff preserves predecessor ordering with ${damaged ? "a source gap" : "a queued exit"}`, async () => {
  const sources = new Map<ProviderActionHandle, ProviderExecutionObserver>();
  const f = fixture("codex_app_server", (handle, listener) => sources.get(handle)!.subscribe(listener));
  sources.set(f.handle, f.observer);
  try {
    const detach = f.install(); f.emit(ready); await flush();
    if (damaged) { f.observer.markUnavailable(); f.emit(ready); await flush(); }
    else f.emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "process_exit", sideEffects: "none" });
    detach();
    const next = successor(f, "successor-birth");
    const fresh = new ProviderExecutionObserver(() => now); sources.set(next, fresh);
    f.install(next); fresh.emit(ready, "successor-birth", 42);
    await Promise.resolve(); // resolve subscription without running the scheduled capture drain
    f.capture.sealForPlannedHandoff();
    assert.equal(f.facts().length, damaged ? 1 : 3);
    assert.deepEqual({ ...f.position() }, damaged
      ? { last_source_sequence: 1, max_observed_sequence: 3 }
      : { last_source_sequence: 1, max_observed_sequence: 1 });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_observer_sources").get()!.n, damaged ? 1 : 2,
      "a successor may bind only after its predecessor's retained tail is complete");
  } finally { f.capture.close(); }
});

test("planned capture handoff defers an unresolved subscription without dropping its queued facts", async () => {
  const pending = deferred<NativeExecutionSubscription>();
  let subscription!: NativeExecutionSubscription;
  const f = fixture("codex_app_server", (_handle, listener) => {
    subscription = f.observer.subscribe(listener);
    return pending.promise;
  });
  try {
    f.install(); f.emit(ready);
    assert.throws(() => f.capture.sealForPlannedHandoff(), /Update deferred/);
    pending.resolve(subscription); await flush();
    f.capture.sealForPlannedHandoff();
    assert.equal(f.facts().length, 1);
  } finally { f.capture.close(); }
});

test("administrative close records only the admitted source frontier and tolerates storage failure", async () => {
  for (const busy of [false, true]) {
    const f = fixture(); const close = f.db.close.bind(f.db); const exec = f.db.exec.bind(f.db);
    try {
      await f.install(); f.emit(ready); await flush();
      const operational = f.db.prepare("SELECT * FROM agents").all();
      f.emit(ready); f.emit(ready);
      let closes = 0; f.db.close = () => { closes++; };
      if (busy) f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
      assert.doesNotThrow(() => f.capture.close());
      assert.equal(f.admission(), "unavailable");
      assert.equal(closes, 0, "coordinator borrows the shared database handle and never closes it");
      assert.equal(f.facts().length, 1, "shutdown must not drain queued facts");
      assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: busy ? 1 : 3 });
      assert.deepEqual(f.db.prepare("SELECT * FROM agents").all(), operational);
      assert.equal(f.handles.get("agent"), f.handle);
      assert.equal(f.handle.observedState, "working");
      if (busy) assert.ok(f.diagnostics.includes("storage_unavailable"));
      f.emit(ready); await flush(); assert.equal(f.facts().length, 1);
    } finally { f.db.exec = exec; f.db.close = close; f.capture.close(); if (f.db.isOpen) close(); }
  }
});

test("an empty rejected subscription does not strand a later installation", async () => {
  let calls = 0;
  const observer = new ProviderExecutionObserver(() => now);
  const f = fixture("codex_app_server", (_handle, listener) => {
    if (++calls === 1) return Promise.reject(new Error("subscription unavailable"));
    return observer.subscribe(listener);
  });
  try {
    await f.install(); await flush(); assert.equal(f.facts().length, 0);
    assert.equal(f.admission(), "unavailable");
    await f.install(); observer.emit(ready, "birth-secret", 42); await flush();
    assert.equal(calls, 2); assert.equal(f.facts().length, 1);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 1 });
    assert.equal(f.admission(), "ready");
  } finally { f.capture.close(); }
});

test("unverified process birth and a wrong binding cannot borrow the current FIFO identity", async () => {
  const f = fixture();
  try {
    f.bindTurn("other-turn"); await f.install(); f.emit(ready); f.emit(active, "unknown-birth"); await flush();
    assert.equal(f.facts().length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 0);
    assert.equal(f.position()!.max_observed_sequence, 2);
    f.capture.refresh(); await flush();
    assert.equal(f.facts().length, 1);
  } finally { f.capture.close(); }
});

test("paused Cursor checkpoint preserves a completed child birth after the handle advances to idle", async () => {
  const f = fixture("cursor_cli");
  try {
    const child = { ...f.handle.providerConnection! };
    f.bindTurn(); await f.install();
    f.capture.prepared({ agentId: "agent", handle: f.handle, executionGenerationId: "generation", connection: child, configurationRevision: 2 });
    f.emit(ready); f.emit(active); f.emit(terminal);
    f.emit({ domain: "control", kind: "state_changed", state: "lost", controlEvidence: "process_exit", sideEffects: "none" });
    f.emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "process_exit", sideEffects: "none" });
    f.handle.providerConnection = { kind: "cursor_cli", pid: null, processIdentity: null };
    f.db.prepare("UPDATE agents SET provider_connection_json=? WHERE agent_id='agent'").run(JSON.stringify(f.handle.providerConnection));
    await flush();
    assert.equal(f.facts().length, 5);
    assert.equal(f.db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()!.runtime_state, "exited");
    assert.deepEqual(f.diagnostics, []);
  } finally { f.capture.close(); }
});

test("bounded replay and queue loss preserve the missing frontier across source replacement", async () => {
  for (const beforeSubscribe of [true, false]) {
    const f = fixture();
    try {
      if (!beforeSubscribe) { await f.install(); await flush(); }
      for (let i = 0; i < 300; i++) f.emit(ready);
      if (beforeSubscribe) await f.install();
      await flush();
      assert.equal(f.facts().length, 0);
      assert.deepEqual({ ...f.position() }, { last_source_sequence: 0, max_observed_sequence: 300 });
      assert.equal(f.diagnostics.at(-1), "source_gap");
      assert.equal(f.admission(), "unavailable");
      await f.install(); await flush();
      assert.equal(f.facts().length, 0);
      assert.equal(f.position()!.max_observed_sequence, 300);
    } finally { f.capture.close(); }
  }
});

test("a bootstrap-ready replacement with a retired source gap stays visibly blocked without rewriting history", async () => {
  const f = fixture("claude_cli", undefined, undefined, new DatabaseSync(":memory:"), "typed");
  const close = f.db.close.bind(f.db);
  let replacement: ExecutionCaptureCoordinator | undefined;
  try {
    f.install(); f.emit(ready); await flush();
    for (let sequence = 2; sequence <= 8; sequence++) f.emit(ready);
    f.db.close = () => {};
    f.capture.close();
    const oldObserver = f.db.prepare("SELECT * FROM execution_observers").get();
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 8 });

    const current = { ...f.handle, providerConnection: { ...f.handle.providerConnection!, pid: 43, processIdentity: "replacement-birth" } };
    f.handles.set("agent", current);
    f.db.prepare("UPDATE work_attempt_executions SET terminal_json=? WHERE execution_generation_id='generation'")
      .run(JSON.stringify({ ended_at: now, terminal_cause: "stopped", actor: "test", generation: 1,
        provider_continuation_id: "continuation", native_runtime_death: { kind: "claude_cli", pid: 42, processIdentity: "birth-secret" } }));
    f.db.prepare("INSERT INTO work_attempt_executions VALUES('replacement-generation','workspace',?,'test',2,NULL)").run(now);
    f.db.prepare("UPDATE agents SET observed_state='recovering',provider_connection_json=?,provider_execution_generation_id='replacement-generation' WHERE agent_id='agent'")
      .run(JSON.stringify(current.providerConnection));
    new ExecutionShadowStore(f.db).registerRuntime({ agentId: "agent", executionGenerationId: "replacement-generation",
      runtimeGenerationId: executionRuntimeStorageIdentity("agent", "replacement-generation", "claude_cli", 43, "replacement-birth"),
      provider: "claude-code", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
    const source = new ProviderExecutionObserver(() => now);
    source.emit(ready, "replacement-birth", 43);
    const diagnostics: string[] = [];
    replacement = new ExecutionCaptureCoordinator(f.db, {
      provider: { onExecution: (_handle, listener) => source.subscribe(listener) },
      currentHandle: id => f.handles.get(id), daemonGeneration: () => 2,
      diagnostic: (_id, code) => diagnostics.push(code),
    });
    const token = f.tokenFor(current, "replacement-generation");
    replacement.install(token); await flush();
    assert.equal(replacement.typedLifecycleAdmission(token), "unavailable");
    assert.deepEqual(diagnostics, ["source_gap"]);
    const projected = projectRoomAgentManifestEntry({
      entry: { id: "agent", room_id: "room", display_name: "Agent", provider: "claude-code", model: null,
        charter: "Help", permission_profile_id: null, created_by: "owner", created_at: now,
        desired_state: "running", observed_state: "recovering", condition: "none", delivery_mode: "daemon_inbox",
        work_attempt_id: "workspace", provider_ref: { work_attempt_id: "workspace", provider_continuation_id: "continuation",
          execution_generation_id: "replacement-generation", provider_connection: current.providerConnection } },
      lifecycleAdmission: replacement.typedLifecycleAdmission(token),
      binding: null, credentialAvailable: false, currentHostGrantAvailable: true, liveHandle: current,
      ingressHealth: null, continuationRepair: null, receipts: [], activeTurn: null,
      nowMs: Date.parse(now), workplaceLivenessStaleAfterMs: 210_000, nativeLivenessStaleAfterMs: 90_000,
    });
    assert.equal(projected.condition, "coordination_blocked");
    assert.match(projected.last_error ?? "", /readiness evidence is unavailable/);
    for (let index = 0; index < 3; index++) { replacement.refresh(); await flush(); }
    assert.deepEqual(diagnostics, ["source_gap"], "unchanged evidence does not repeat the diagnostic");
    assert.deepEqual(f.db.prepare("SELECT * FROM execution_observers").get(), oldObserver);
    assert.equal(f.facts().length, 1, "the replacement ready fact cannot cross the missing history");
    assert.equal(f.db.prepare("SELECT observed_state FROM agents").get()?.observed_state, "recovering");
  } finally {
    replacement?.close(); f.capture.close(); f.db.close = close; if (f.db.isOpen) close();
  }
});

test("same-source Cursor advance keeps identical process evidence separate when the child PID changes", async () => {
  const f = fixture("cursor_cli");
  try {
    await f.install(); f.emit(ready); f.emit({ ...ready, state: "exited", controlEvidence: "process_exit" }); await flush();
    const next = { kind: "cursor_cli" as const, pid: 43, processIdentity: "birth-secret" };
    f.handle.providerConnection = next;
    f.db.prepare("UPDATE agents SET provider_connection_json=? WHERE agent_id='agent'").run(JSON.stringify(next));
    new ExecutionShadowStore(f.db).registerRuntime({ agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 43, "birth-secret"),
      provider: "cursor", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) });
    f.advance(); f.capture.prepared({ agentId: "agent", handle: f.handle, executionGenerationId: "generation", connection: next, configurationRevision: 2 });
    f.emit(ready, "birth-secret", 43); await flush();
    assert.equal(f.facts().length, 3);
    assert.deepEqual(f.db.prepare("SELECT runtime_state FROM execution_runtime_generations ORDER BY rowid").all().map(r => r.runtime_state), ["exited", "ready"]);
    assert.deepEqual(f.diagnostics, []);
    assert.equal(f.position()!.last_source_sequence, 3);
  } finally { f.capture.close(); }
});

test("one idle Cursor observer advances to its first committed child without reinstalling", async () => {
  let subscriptions = 0;
  const observer = new ProviderExecutionObserver(() => now);
  const f = fixture("cursor_cli", (_handle, listener) => {
    subscriptions += 1;
    return observer.subscribe(listener);
  });
  try {
    const connection = { ...f.handle.providerConnection! };
    f.handle.providerConnection = { kind: "cursor_cli", pid: null, processIdentity: null };
    f.db.prepare("UPDATE agents SET provider_connection_json=? WHERE agent_id='agent'").run(JSON.stringify(f.handle.providerConnection));
    await f.install(); await flush();
    assert.equal(subscriptions, 1);
    f.handle.providerConnection = connection;
    f.db.prepare("UPDATE agents SET provider_connection_json=? WHERE agent_id='agent'").run(JSON.stringify(connection));
    f.advance();
    f.capture.prepared({ agentId: "agent", handle: f.handle, executionGenerationId: "generation", connection, configurationRevision: 2 });
    observer.emit(ready, "birth-secret", 42); await flush();
    assert.equal(f.facts().length, 1);
    assert.equal(f.position()!.last_source_sequence, 1);
    assert.equal(subscriptions, 1, "advancing the committed child birth keeps the physical observation subscription");
  } finally { f.capture.close(); }
});

test("older-generation recovery without captured original runtime proof stays unavailable", async () => {
  const f = fixture();
  try {
    f.bindTurn();
    f.db.exec("UPDATE supervised_agent_provider_turn_bindings SET origin_execution_generation_id='uncaptured-old-generation'");
    await f.install(); f.emit(ready); f.emit(active); await flush();
    assert.equal(f.facts().length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM runs").get()!.n, 0);
    assert.equal(f.diagnostics.at(-1), "identity_unavailable");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 2 });
  } finally { f.capture.close(); }
});

for (const initialFact of [false, true]) test(`capture automatically revalidates after a SQLite lock with ${initialFact ? "queued ready evidence" : "an empty exact source"}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = mkdtempSync(join(tmpdir(), "capture-storage-retry-"));
  const path = join(directory, "synthetic.sqlite");
  const f = fixture("codex_app_server", undefined, undefined, new DatabaseSync(path), "typed");
  const competing = new DatabaseSync(path);
  try {
    if (initialFact) f.emit(ready);
    competing.exec("BEGIN IMMEDIATE");
    f.install(); await flush();
    assert.equal(f.admission(), "unavailable");
    assert.equal(f.facts().length, 0);
    competing.exec("ROLLBACK");
    t.mock.timers.tick(25); await flush();
    assert.equal(f.facts().length, initialFact ? 1 : 0);
    assert.equal(f.admission(), "ready", "storage recovery must not require another provider fact or human action");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: initialFact ? 1 : 0, max_observed_sequence: initialFact ? 1 : 0 });
    const before = f.facts();
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(f.facts(), before, "the successful frontier is not repeatedly ingested");
  } finally {
    if (competing.isTransaction) competing.exec("ROLLBACK");
    competing.close(); f.capture.close(); if (f.db.isOpen) f.db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

for (const release of ["close", "replace"] as const) test(`capture storage retry cannot outlive ${release}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const close = f.db.close.bind(f.db);
  const exec = f.db.exec.bind(f.db);
  let closed = false;
  f.db.close = () => { closed = true; };
  try {
    f.db.exec = sql => {
      if (sql === "BEGIN IMMEDIATE") throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 6 });
      return exec(sql);
    };
    f.emit(ready); f.install(); await flush();
    assert.equal(f.admission(), "unavailable");
    if (release === "close") f.capture.close();
    else f.handles.set("agent", { ...f.handle });
    f.db.exec = exec;
    t.mock.timers.tick(30_000); await flush();
    assert.equal(f.facts().length, 0, "a retry cannot admit observations for a closed or replaced owner");
    assert.equal(f.admission(), "unavailable");
    assert.equal(closed, false, "coordinator never closes the shared database handle");
  } finally { f.db.exec = exec; f.capture.close(); f.db.close = close; close(); }
});

test("non-retryable storage failure retains queued facts and requires a later hint", async (t) => {
  const f = fixture();
  try {
    await f.install(); await flush();
    const exec = f.db.exec.bind(f.db);
    let failures = 0;
    const mock = t.mock.method(f.db, "exec", (sql: string) => {
      if (sql === "BEGIN IMMEDIATE") { failures++; throw new Error("database is locked"); }
      return exec(sql);
    });
    assert.doesNotThrow(() => f.emit(ready)); await flush();
    assert.ok(failures >= 1);
    assert.equal(f.facts().length, 0, "diagnostic retry cannot timer-retry operational fact capture");
    assert.equal(f.diagnostics.at(-1), "storage_unavailable");
    await delay(40); await flush();
    assert.equal(f.facts().length, 0, "operational capture resumes only from an explicit later hint");
    mock.mock.restore(); f.capture.refresh(); await flush();
    assert.equal(f.facts().length, 1);
  } finally { f.capture.close(); }
});

test("synchronous exit cleanup keeps final facts ahead of successor observation admission", async () => {
  const f = fixture();
  try {
    f.handle.appliedConfigurationRevision = 2;
    f.bindTurn();
    f.db.prepare(`UPDATE inbox_items SET state='acknowledged_no_reply',outcome=?,acknowledged_at=?`)
      .run(JSON.stringify({ kind: "no_reply", text: null }), now);
    const detach = await f.install(); await Promise.resolve(); await Promise.resolve();
    f.emit(ready);
    f.emit(active); f.emit(terminal);
    f.emit({ domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "process_exit" });
    f.emit({ ...ready, state: "exited", controlEvidence: "process_exit" });
    f.handles.delete("agent"); detach();
    assert.equal(f.facts().length, 0, "exit cleanup performs no inline SQLite capture");
    await flush();
    assert.equal(f.facts().length, 5);
    assert.equal(f.db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()!.runtime_state, "exited");
    assert.equal(f.position()!.last_source_sequence, 5);
    assert.equal(f.db.prepare("SELECT conclusion FROM execution_message_attempts").get()!.conclusion, "acknowledged_no_reply",
      "the detached exit tail must settle its late-captured attempt before the lane is removed");
    assert.deepEqual(f.diagnostics, []);
  } finally { f.capture.close(); }
});

test("terminal detach with uncommitted turn mapping records a gap rather than dropping its tail", async () => {
  const f = fixture();
  try {
    const detach = await f.install(); f.emit(ready); await flush();
    f.emit(active); f.emit({ ...ready, state: "exited", controlEvidence: "process_exit" });
    f.handles.delete("agent"); detach(); await flush();
    assert.equal(f.facts().length, 1);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 3 });
    assert.equal(f.diagnostics.at(-1), "identity_unavailable");
  } finally { f.capture.close(); }
});

test("raw content is rejected, not persisted or promoted to an operational failure", async () => {
  const f = fixture();
  try {
    await f.install(); f.emit({ ...ready, command: "PRIVATE TOKEN" } as NativeExecutionFact); await flush();
    assert.equal(f.facts().length, 0);
    assert.equal(f.position()!.max_observed_sequence, 1);
    assert.equal(f.diagnostics.at(-1), "invalid_observation");
    assert.equal(f.db.prepare("SELECT observed_state FROM agents").get()!.observed_state, "working");
  } finally { f.capture.close(); }
});

test("shutdown fences queued work and disposes a subscription that arrives late", async () => {
  const f = fixture();
  f.capture.close();
  let resolve!: (value: NativeExecutionSubscription) => void;
  const pending = new Promise<NativeExecutionSubscription>(r => { resolve = r; });
  const db = new DatabaseSync(":memory:");
  let disposed = 0; let subscribed = 0;
  const capture = new ExecutionCaptureCoordinator(db, { provider: { onExecution: () => { subscribed++; return pending; } },
    currentHandle: () => f.handle, daemonGeneration: () => 1, diagnostic: () => { throw new Error("must not run"); } });
  await capture.install(f.tokenFor()); await Promise.resolve();
  assert.equal(subscribed, 1); capture.close();
  resolve({ sourceId: "source", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => { disposed++; } });
  await flush(); assert.equal(disposed, 1);
  assert.doesNotThrow(() => db.prepare("SELECT 1").get(), "shared database stays open for its owner to close");
  await capture.install(f.tokenFor()); await flush(); assert.equal(subscribed, 1);
  db.close();
});

test("pending lifecycle projection keeps typedLifecycleAdmission pending until installation aligns and retries on refresh and advance", async () => {
  // 1. Refresh path: agent row temporarily lags installation continuation id, then aligns and retries on refresh().
  const f = fixture();
  try {
    f.db.prepare("UPDATE agents SET observed_state='idle', provider_continuation_id='lagging-continuation' WHERE agent_id='agent'").run();
    f.bindTurn();
    await f.install();
    f.emit(ready);
    f.emit(active);
    await flush();

    assert.equal(f.admission(), "ready", "capture admission is ready once the source cursor is durable");
    assert.equal(f.capture.typedLifecycleAdmission(f.tokenFor()), "pending",
      "typedLifecycleAdmission must remain pending while a non-stale lifecycle projection awaits alignment");
    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle",
      "mismatched projection must not prematurely overwrite agents.observed_state");

    // Align the manifest row and refresh; retryLifecycleProjection must apply the held transition.
    f.db.prepare("UPDATE agents SET provider_continuation_id='continuation' WHERE agent_id='agent'").run();
    f.capture.refresh("agent");
    await flush();

    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "working");
    assert.equal(f.capture.typedLifecycleAdmission(f.tokenFor()), "ready");
  } finally {
    f.capture.close();
    if (f.db.isOpen) f.db.close();
  }

  // 2. Advance path: Cursor installation starts idle (pid: null) while facts arrive, then advances to the committed child token.
  const c = fixture("cursor_cli");
  try {
    const committed = { ...c.handle.providerConnection! };
    c.db.prepare("UPDATE agents SET observed_state='idle' WHERE agent_id='agent'").run();
    c.bindTurn();
    const laggingToken = { ...c.tokenFor(), providerContinuationId: "lagging-cursor-continuation" };
    await c.capture.install(laggingToken);
    c.emit(ready);
    c.emit(active);
    await flush();

    assert.equal(c.capture.typedLifecycleAdmission(laggingToken), "pending");
    assert.equal(c.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");

    const alignedToken = { ...laggingToken, providerContinuationId: "continuation", providerConnection: committed };
    c.capture.advance(alignedToken);
    await flush();

    assert.equal(c.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "working");
    assert.equal(c.capture.typedLifecycleAdmission(alignedToken), "ready");
  } finally {
    c.capture.close();
    if (c.db.isOpen) c.db.close();
  }
});

test("superseded runtime ready fact does not erase an unrelated pending active-turn projection", async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE agents SET observed_state='idle', provider_continuation_id='lagging-continuation' WHERE agent_id='agent'").run();
    f.bindTurn();
    await f.install();
    f.emit(ready);
    f.emit(active);
    await flush();

    assert.equal(f.capture.typedLifecycleAdmission(f.tokenFor()), "pending");
    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");

    // Emit another runtime ready fact while alignment is still lagging:
    // runtime/ready is superseded (agent is already idle), but MUST NOT clear the pending active-turn projection.
    f.emit(ready);
    await flush();

    assert.equal(f.capture.typedLifecycleAdmission(f.tokenFor()), "pending",
      "superseded runtime/ready must not clear an unrelated pending turn/active projection");
    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");

    // Align continuation and refresh: the preserved pending turn/active projection must apply.
    f.db.prepare("UPDATE agents SET provider_continuation_id='continuation' WHERE agent_id='agent'").run();
    f.capture.refresh("agent");
    await flush();

    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "working");
    assert.equal(f.capture.typedLifecycleAdmission(f.tokenFor()), "ready");
    assert.equal(f.db.prepare("SELECT pending_lifecycle_fact_id FROM execution_observers WHERE agent_id='agent'").get()?.pending_lifecycle_fact_id, null);
  } finally {
    f.capture.close();
    if (f.db.isOpen) f.db.close();
  }
});

test("pending lifecycle projection survives coordinator restart and reconciles once alignment completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-pending-restart-"));
  const dbPath = join(root, "daemon.sqlite");
  const first = fixture("claude_cli", undefined, undefined, new DatabaseSync(dbPath));
  try {
    first.db.prepare("UPDATE agents SET observed_state='idle', provider_continuation_id='lagging-continuation' WHERE agent_id='agent'").run();
    first.bindTurn();
    await first.install();
    first.emit(ready);
    first.emit(active);
    await flush();

    assert.equal(first.capture.typedLifecycleAdmission(first.tokenFor()), "pending");
    assert.equal(first.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");
    assert.notEqual(first.db.prepare("SELECT pending_lifecycle_fact_id FROM execution_observers WHERE agent_id='agent'").get()?.pending_lifecycle_fact_id, null);
    first.capture.close();

    // Restart coordinator on a fresh handle against the same durable SQLite file.
    const database = new DatabaseSync(dbPath);
    const observer = new ProviderExecutionObserver(() => now);
    const projected: string[] = [];
    const restarted = new ExecutionCaptureCoordinator(database, {
      provider: { onExecution: (_handle, listener) => observer.subscribe(listener) },
      currentHandle: () => first.handle,
      daemonGeneration: () => 2,
      diagnostic: () => {},
      lifecycleProjected: (_agentId, observedState) => { projected.push(observedState); },
    });
    try {
      await restarted.install(first.tokenFor());
      await flush();

      assert.equal(restarted.captureAdmission(first.tokenFor()), "ready");
      assert.equal(restarted.typedLifecycleAdmission(first.tokenFor()), "pending",
        "restarted coordinator must keep typedLifecycleAdmission pending while durable pending_lifecycle_json awaits alignment");
      assert.equal(database.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");

      // Complete manifest alignment and refresh on the restarted coordinator.
      database.prepare("UPDATE agents SET provider_continuation_id='continuation' WHERE agent_id='agent'").run();
      restarted.refresh("agent");
      await flush();

      assert.equal(database.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "working");
      assert.deepEqual(projected, ["working"]);
      assert.equal(restarted.typedLifecycleAdmission(first.tokenFor()), "ready");
      assert.equal(database.prepare("SELECT pending_lifecycle_fact_id FROM execution_observers WHERE agent_id='agent'").get()?.pending_lifecycle_fact_id, null);
    } finally {
      restarted.close();
      if (database.isOpen) database.close();
    }
  } finally {
    first.capture.close();
    if (first.db.isOpen) first.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached-lane runtimeFailure stays pending until both subject and observer runtimes are exited", () => {
  // 1. Cursor turn/lost (manifest_failed) with liveInstallation: null while runtime is still live -> pending until runtime exits.
  const c = fixture("cursor_cli");
  try {
    c.db.prepare("UPDATE agents SET observed_state='idle' WHERE agent_id='agent'").run();
    const store = new ExecutionShadowStore(c.db);
    const runtimeId = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 42, "birth-secret");
    const attemptId = store.trackMessage({
      agentId: "agent",
      roomId: "room",
      sourceMessageId: "msg_1",
      executionGenerationId: "generation",
      workspaceId: "workspace",
      createdAtMs: Date.parse(now),
    });
    store.trackNativeTurn({
      agentId: "agent",
      roomId: "room",
      executionGenerationId: "generation",
      runtimeGenerationId: runtimeId,
      attemptId,
      turnId: "turn-cursor-lost",
      providerContinuationId: "continuation",
      providerTurnId: "provider-turn-lost",
      createdAtMs: Date.parse(now),
    });
    const observer = store.bindObserver({
      agentId: "agent",
      subjectRuntimeGenerationId: runtimeId,
      observerRuntimeGenerationId: runtimeId,
      sourceId: "detached-cursor-source",
      daemonGenerationId: "1",
      expectedEpoch: 0,
      boundAtMs: Date.parse(now),
    });
    const lostFact = {
      factId: "detached-cursor-turn-lost",
      agentId: "agent",
      executionGenerationId: "generation",
      runtimeGenerationId: runtimeId,
      observerEpoch: observer.epoch,
      sourceSequence: 1,
      observedAtMs: Date.parse(now) + 10,
      domain: "turn" as const,
      kind: "state_changed" as const,
      state: "lost" as const,
      sideEffects: "none" as const,
      turnId: "turn-cursor-lost",
      providerContinuationId: "continuation",
      providerTurnId: "provider-turn-lost",
    };
    const first = store.ingest("detached-cursor-source", observer, lostFact, { liveInstallation: null });
    assert.equal(first.status, "accepted");
    assert.deepEqual(first.lifecycleProjection, { status: "pending" },
      "detached runtimeFailure must stay pending while runtime is not yet exited");
    assert.equal(c.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");

    c.db.prepare("UPDATE execution_runtime_generations SET runtime_state='exited', ended_at_ms=? WHERE runtime_generation_id=?")
      .run(Date.parse(now) + 20, runtimeId);
    const retried = store.retryLifecycleProjection({
      fact: lostFact,
      observerExecutionGenerationId: observer.observerExecutionGenerationId,
      observerRuntimeGenerationId: observer.observerRuntimeGenerationId,
    }, null);
    assert.deepEqual(retried, { status: "applied", observedState: "failed" });
    assert.equal(c.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "failed");
  } finally {
    c.capture.close();
    if (c.db.isOpen) c.db.close();
  }

  // 2. Cross-runtime recovery: subject runtime is exited while observer runtime is still ready -> pending until observer also exits.
  const f = fixture("cursor_cli");
  try {
    f.db.prepare("UPDATE agents SET observed_state='idle' WHERE agent_id='agent'").run();
    const store = new ExecutionShadowStore(f.db);
    const subjectRuntimeId = executionRuntimeStorageIdentity("agent", "subject-generation", "cursor_cli", 99, "subject-birth");
    const observerRuntimeId = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 42, "birth-secret");
    store.registerRuntime({
      agentId: "agent",
      executionGenerationId: "subject-generation",
      runtimeGenerationId: subjectRuntimeId,
      provider: "cursor",
      authorityMode: "typed",
      configRevision: 2,
      createdAtMs: Date.parse(now),
    });
    const attemptId = store.trackMessage({
      agentId: "agent",
      roomId: "room",
      sourceMessageId: "msg_2",
      executionGenerationId: "subject-generation",
      workspaceId: "workspace",
      createdAtMs: Date.parse(now),
    });
    const recovery = {
      turnId: "turn-cross-runtime",
      providerContinuationId: "continuation",
      providerTurnId: "provider-turn-cross",
    };
    store.trackNativeTurn({
      agentId: "agent",
      roomId: "room",
      executionGenerationId: "subject-generation",
      runtimeGenerationId: subjectRuntimeId,
      attemptId,
      ...recovery,
      createdAtMs: Date.parse(now),
    });
    f.db.prepare("UPDATE execution_runtime_generations SET runtime_state='exited', ended_at_ms=? WHERE runtime_generation_id=?")
      .run(Date.parse(now) + 5, subjectRuntimeId);
    const observer = store.bindObserver({
      agentId: "agent",
      subjectRuntimeGenerationId: subjectRuntimeId,
      observerRuntimeGenerationId: observerRuntimeId,
      sourceId: "detached-source",
      daemonGenerationId: "1",
      expectedEpoch: 0,
      boundAtMs: Date.parse(now),
      recovery,
    });
    const lostTurnFact = {
      factId: "detached-cross-turn-lost",
      agentId: "agent",
      executionGenerationId: "subject-generation",
      runtimeGenerationId: subjectRuntimeId,
      observerEpoch: observer.epoch,
      sourceSequence: 1,
      observedAtMs: Date.parse(now) + 10,
      domain: "turn" as const,
      kind: "state_changed" as const,
      state: "lost" as const,
      sideEffects: "none" as const,
      ...recovery,
    };
    const first = store.ingest("detached-source", observer, lostTurnFact, { liveInstallation: null });
    assert.equal(first.status, "accepted");
    assert.deepEqual(first.lifecycleProjection, { status: "pending" },
      "detached runtimeFailure must remain pending while observer runtime is not yet exited");
    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "idle");

    f.db.prepare("UPDATE execution_runtime_generations SET runtime_state='exited', ended_at_ms=? WHERE runtime_generation_id=?")
      .run(Date.parse(now) + 20, observerRuntimeId);
    const retried = store.retryLifecycleProjection({
      fact: lostTurnFact,
      observerExecutionGenerationId: observer.observerExecutionGenerationId,
      observerRuntimeGenerationId: observer.observerRuntimeGenerationId,
    }, null);
    assert.deepEqual(retried, { status: "applied", observedState: "failed" });
    assert.equal(f.db.prepare("SELECT observed_state FROM agents WHERE agent_id='agent'").get()?.observed_state, "failed");
  } finally {
    f.capture.close();
    if (f.db.isOpen) f.db.close();
  }
});

test("capture flush stays fail-closed on a suspended lane and reused-handle archival fences late facts from the archived child", async () => {
  // 1. Suspended lane must fail closed on flush() (never bypass suspension).
  {
    const f = fixture("cursor_cli");
    try {
      f.install();
      f.emit(ready);
      await flush();
      f.observer.markUnavailable();
      f.emit(ready);
      await flush();
      assert.equal(f.admission(), "unavailable");
      assert.equal(f.capture.recordBlock(f.tokenFor()), "source_gap");
      assert.throws(() => f.capture.flush(f.tokenFor()), /identity_mismatch/);
    } finally {
      f.capture.close();
      if (f.db.isOpen) f.db.close();
    }
  }

  // 2. After archiving an exited undispatched Cursor runtime on a reused handle, a late fact from the
  //    archived child still fails closed, while a new child advances cleanly to ready with recordBlock=null.
  {
    const f = fixture("cursor_cli");
    try {
      f.bindTurn("turn-1", "msg-1", "dispatching");
      f.install();
      await flush();
      f.emit({ domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none", providerContinuationId: "continuation", providerTurnId: "turn-1" });
      f.emit({ domain: "control", kind: "state_changed", state: "lost", controlEvidence: "process_exit", sideEffects: "none" });
      f.emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "process_exit", sideEffects: "none" });
      f.capture.flush(f.tokenFor());
      const child1 = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 42, "birth-secret");

      // Move live manifest off child1 before archiving (exact post-compensation state).
      f.db.prepare("UPDATE agents SET provider='cursor', provider_connection_json=? WHERE agent_id='agent'")
        .run(JSON.stringify({ kind: "cursor_cli", pid: null, processIdentity: null }));
      f.db.exec("BEGIN IMMEDIATE");
      try {
        const archived = archiveExitedUndispatchedCursorRuntime(f.db, {
          inbox_item_id: "inbox-1",
          agent_id: "agent",
          room_id: "room",
          work_attempt_id: "workspace",
          origin_execution_generation_id: "generation",
          provider_continuation_id: "continuation",
          provider_turn_id: "turn-1",
        }, now);
        assert.equal(archived, child1);
        f.db.exec("COMMIT");
      } catch (error) {
        f.db.exec("ROLLBACK");
        throw error;
      }

      // Advance the SAME lane to a fresh child (pid 43, birth-next) on the same source.
      const nextConnection = { kind: "cursor_cli" as const, pid: 43, processIdentity: "birth-next" };
      const child2 = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 43, "birth-next");
      new ExecutionShadowStore(f.db).registerRuntime({
        agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: child2,
        provider: "cursor", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) + 100,
      });
      f.db.prepare("UPDATE agents SET provider_connection_json=? WHERE agent_id='agent'").run(JSON.stringify(nextConnection));
      f.handle.pid = 43;
      f.handle.providerConnection = nextConnection;
      const nextToken = f.tokenFor();
      f.capture.advance(nextToken);
      f.observer.emit(ready, "birth-next", 43);
      await flush();

      assert.equal(f.capture.captureAdmission(nextToken), "ready", "reused lane admits the next Cursor child cleanly");
      assert.equal(f.capture.recordBlock(nextToken), null);
      const observer = f.db.prepare("SELECT observer_runtime_generation_id,observer_epoch FROM execution_observers WHERE agent_id='agent'")
        .get() as { observer_runtime_generation_id: string; observer_epoch: number };
      assert.deepEqual({ ...observer }, { observer_runtime_generation_id: child2, observer_epoch: 3 });

      // A late fact claiming the archived exited child1 still fails closed.
      f.observer.emit(ready, "birth-secret", 42);
      await flush();
      assert.equal(f.capture.captureAdmission(nextToken), "unavailable");
      assert.equal(f.capture.recordBlock(nextToken), "invalid_observation");
      assert.throws(() => f.capture.flush(nextToken), /identity_mismatch/);
    } finally {
      f.capture.close();
      if (f.db.isOpen) f.db.close();
    }
  }

  // 3. A detached+suspended lane whose cached observer was archived never calls bind() or mutates execution_observers.
  {
    const f = fixture("cursor_cli");
    try {
      f.bindTurn("turn-ds", "msg-ds", "dispatching");
      const detach = f.install();
      await flush();
      f.emit({ domain: "turn", kind: "state_changed", state: "lost", sideEffects: "none", providerContinuationId: "continuation", providerTurnId: "turn-ds" });
      f.emit({ domain: "control", kind: "state_changed", state: "lost", controlEvidence: "process_exit", sideEffects: "none" });
      f.emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "process_exit", sideEffects: "none" });
      f.capture.flush(f.tokenFor());
      const child1 = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 42, "birth-secret");

      // Suspend the lane cleanly with a genuine source gap on a fresh fact, then register child2 and archive child1
      // after detaching so schedule() still drains the detached+suspended lane to preserve frontier.
      const child2 = executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 45, "birth-ds-next");
      new ExecutionShadowStore(f.db).registerRuntime({
        agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: child2,
        provider: "cursor", authorityMode: "typed", configRevision: 2, createdAtMs: Date.parse(now) + 100,
      });
      f.observer.markUnavailable();
      f.observer.emit(ready, "birth-ds-next", 45);
      await flush();
      assert.equal(f.capture.recordBlock(f.tokenFor()), "source_gap");

      // Manually record a recovery boundary for child1 (simulating operator archival) and detach the suspended lane.
      f.db.exec("BEGIN IMMEDIATE");
      try {
        f.db.prepare("INSERT INTO agent_runtime_recoveries VALUES(?,?,?,?,?,'resume','complete',?,NULL,?,?)")
          .run("op-detached-suspended", "agent", "room", "generation", child1,
            JSON.stringify({ work_attempt_id: "workspace", execution_generation_id: "generation", provider_continuation_id: "continuation", provider_connection: null }),
            now, now);
        f.db.prepare("UPDATE execution_observers SET observer_epoch=observer_epoch+1 WHERE agent_id='agent' AND observer_runtime_generation_id=?")
          .run(child1);
        f.db.exec("COMMIT");
      } catch (error) {
        f.db.exec("ROLLBACK");
        throw error;
      }
      const beforeObserver = f.db.prepare("SELECT observer_runtime_generation_id,observer_epoch FROM execution_observers WHERE agent_id='agent'")
        .get() as { observer_runtime_generation_id: string; observer_epoch: number };
      detach();
      f.capture.refresh("agent");
      await flush();
      const afterObserver = f.db.prepare("SELECT observer_runtime_generation_id,observer_epoch FROM execution_observers WHERE agent_id='agent'")
        .get() as { observer_runtime_generation_id: string; observer_epoch: number };
      assert.deepEqual({ ...afterObserver }, { ...beforeObserver },
        "a detached+suspended lane must never rebind execution_observers even after its cached observer was archived");
    } finally {
      f.capture.close();
      if (f.db.isOpen) f.db.close();
    }
  }
});

test("healthy fact drain does not record max_observed_sequence ahead of last_source_sequence before ingest", async () => {
  const f = fixture("opencode_server");
  const originalTrackNativeTurn = ExecutionShadowStore.prototype.trackNativeTurn;
  let positionBeforeIngest: Record<string, unknown> | undefined;
  let simulateMidDrainCrash = true;
  try {
    await f.install();
    f.emit(ready);
    await flush();
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 1 });

    f.bindTurn("turn-healthy", "msg-healthy", "dispatching");
    ExecutionShadowStore.prototype.trackNativeTurn = function patchedTrackNativeTurn(...args) {
      const result = originalTrackNativeTurn.apply(this, args);
      if (simulateMidDrainCrash) {
        simulateMidDrainCrash = false;
        positionBeforeIngest = { ...f.position() };
        const busy = Object.assign(new Error("simulated crash before ingest"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
        throw busy;
      }
      return result;
    };

    f.emit({ ...active, providerTurnId: "turn-healthy" });
    await flush();

    assert.deepEqual(positionBeforeIngest, { last_source_sequence: 1, max_observed_sequence: 1 },
      "drain must not advance max_observed_sequence ahead of last_source_sequence before ingest commits");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 1 },
      "an abrupt stop before ingest leaves no synthetic source_gap on disk");

    // A restarted daemon binding a fresh source on the same surviving runtime must succeed without source_gap.
    const runtimeId = executionRuntimeStorageIdentity("agent", "generation", "opencode_server", 42, "birth-secret");
    const replacement = new ExecutionShadowStore(f.db);
    assert.doesNotThrow(() => replacement.bindObserver({
      agentId: "agent",
      subjectRuntimeGenerationId: runtimeId,
      observerRuntimeGenerationId: runtimeId,
      sourceId: "restarted-daemon-source",
      daemonGenerationId: "2",
      expectedEpoch: 1,
      boundAtMs: Date.parse(now) + 1_000,
    }));
  } finally {
    ExecutionShadowStore.prototype.trackNativeTurn = originalTrackNativeTurn;
    f.capture.close();
    if (f.db.isOpen) f.db.close();
  }
});
