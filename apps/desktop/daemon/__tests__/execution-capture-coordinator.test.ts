import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonStateSchema } from "../daemon-state-database.js";
import { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import { ExecutionShadowStore, executionRuntimeStorageIdentity, executionStorageIdentity } from "../execution-shadow-store.js";
import { TypedLifecycleEffectCoordinator } from "../typed-lifecycle-effect-coordinator.js";
import { ProviderExecutionObserver } from "../../electron/main/agents/provider-execution-observer.js";
import type { NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { ProviderActionConnectionRef, ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";
import type { ProviderInstallationToken } from "../provider-stream-coordinator.js";

const now = "2026-08-31T00:00:00.000Z";
const ready: NativeExecutionFact = { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" };
const nativeTurn = { providerContinuationId: "continuation", providerTurnId: "native-turn" };
const active: NativeExecutionFact = { ...nativeTurn, domain: "turn", kind: "state_changed", state: "active", sideEffects: "none" };
const terminal: NativeExecutionFact = { ...active, state: "terminal", turnOutcome: "completed" };
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function delay(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }

function successor(f: ReturnType<typeof fixture>, birth: string): ProviderActionHandle {
  const handle = { ...f.handle, appliedConfigurationRevision: 2,
    providerConnection: { ...f.handle.providerConnection!, processIdentity: birth } };
  f.handles.set("agent", handle);
  f.db.prepare("UPDATE runtime_deployments SET provider_process_identity=?").run(birth);
  new ExecutionShadowStore(f.db).registerRuntime({ agentId: "agent", executionGenerationId: "generation",
    runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", handle.providerConnection!.kind,
      handle.providerConnection!.pid!, birth),
    provider: "codex", authorityMode: "typed_shadow", configRevision: 2, createdAtMs: Date.parse(now) });
  return handle;
}

function fixture(kind: ProviderActionConnectionRef["kind"] = "codex_app_server", onExecution?: NonNullable<ProviderActionPort["onExecution"]>, changed?: (agentId: string) => void,
  db = new DatabaseSync(":memory:"), authorityMode: "typed_shadow" | "typed" = "typed_shadow") {
  db.exec("PRAGMA foreign_keys=ON");
  new DaemonStateSchema().createSchema(db);
  db.exec(`INSERT INTO agent_identities VALUES('agent','owner','${now}',0);
    INSERT INTO agent_configurations(agent_id,provider,charter,delivery_mode,provider_launch_policy_present,provider_launch_policy_undefined,config_revision,runtime_configuration_revision)
      VALUES('agent','claude-code','charter','daemon_inbox',0,0,9,2);
    INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
      VALUES('workspace','task','lease',1,'/private/workspace','repo','remote','revision','/private/bare','active','${now}');
    INSERT INTO work_attempt_executions VALUES('generation','workspace','${now}','test',1,NULL);
    INSERT INTO runtime_deployments(agent_id,observed_state,workspace_path_present,work_attempt_id_present,work_attempt_id,
      provider_ref_present,provider_work_attempt_id,provider_continuation_id,provider_connection_kind,provider_connection_url,provider_server_auth_path,
      provider_connection_pid,provider_process_identity_present,provider_process_identity,provider_execution_generation_id,
      workplace_liveness_present,native_liveness_present,activity_present)
      VALUES('agent','working',0,1,'workspace',1,'workspace','continuation','${kind}','http://localhost/runtime','/private/auth',42,1,'birth-secret','generation',0,0,0);`);
  const connection = { kind, pid: 42, processIdentity: "birth-secret", url: "http://localhost/runtime", serverAuthPath: "/private/auth" } as ProviderActionConnectionRef;
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
  const capture = new ExecutionCaptureCoordinator(db, { provider: { onExecution: onExecution ?? ((_handle, listener) => observer.subscribe(listener)) },
    currentHandle: id => handles.get(id), daemonGeneration: () => 1, diagnostic: (_id, code) => diagnostics.push(code), changed });
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
  const bindTurn = (turn = "native-turn", source = "message") => {
    db.prepare(`INSERT INTO supervised_agent_inbox(inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,created_at,updated_at)
      VALUES(?,'agent','room',?,'{"text":"PRIVATE PROMPT"}','{}',?,'awaiting_result',1,?,?,?, ?,?)`)
      .run(turn, source, Number(db.prepare("SELECT COUNT(*) n FROM supervised_agent_inbox").get()!.n) + 1, `action-${turn}`, `reply-${turn}`, turn, now, now);
    db.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES(?,'agent','room','workspace','generation','continuation',?)").run(turn, turn);
  };
  return { db, handle, handles, observer, capture, diagnostics, install, advance, admission, typedAdmission, tokenFor, emit, facts, position, bindTurn };
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

test("typed lifecycle admission requires a caught-up source and fully disposed fact journal", async () => {
  const shadow = fixture();
  try {
    await shadow.install(); await flush();
    assert.equal(shadow.typedAdmission(), "unavailable", "typed-shadow observation never grows authority");
  } finally { shadow.capture.close(); }

  const typed = fixture("codex_app_server", undefined, undefined, new DatabaseSync(":memory:"), "typed");
  try {
    await typed.install(); await flush();
    assert.equal(typed.typedAdmission(), "ready", "an exact empty typed source is fully disposed");
    typed.bindTurn(); typed.emit(active); await flush();
    assert.equal(typed.typedAdmission(), "pending", "capture alone cannot outrun its durable effect");
    typed.db.prepare(`UPDATE execution_lifecycle_effects SET state='applied',disposed_at_ms=created_at_ms
      WHERE state='pending'`).run();
    assert.equal(typed.typedAdmission(), "ready");
    typed.db.prepare("DELETE FROM execution_lifecycle_effects").run();
    assert.equal(typed.typedAdmission(), "unavailable", "a missing disposition fails closed");
  } finally { typed.capture.close(); }
});

test("typed lifecycle startup scan advances past a full unavailable batch", async () => {
  const effects = Array.from({ length: 33 }, (_, index) => ({
    factId: `fact-${index + 1}`, agentId: index < 32 ? "unavailable-agent" : "later-agent",
    factSequence: index + 1, observerExecutionGenerationId: "generation",
    observerRuntimeGenerationId: "runtime", effectKind: "manifest_working" as const, observedAtMs: 100,
  }));
  const visited: string[] = [];
  const coordinator = new TypedLifecycleEffectCoordinator({
    store: {
      listPendingTypedLifecycleEffects: async (agentId, limit, after) => effects
        .filter(effect => (!agentId || effect.agentId === agentId) && effect.factSequence > (after ?? 0))
        .slice(0, limit),
      applyTypedLifecycleEffect: async (_generation, effect) => {
        visited.push(effect.factId);
        return { generation: 0, disposition: "pending" as const };
      },
    },
    currentInstallation: () => undefined,
    authority: { serialize: operation => operation(), assertCurrent: async () => {},
      currentManifestGeneration: () => 0, acceptManifestGeneration: () => {}, fenceCommit: commit => commit() },
    isClosing: () => false, nowMs: () => 200, diagnostic: (_agentId, error) => { throw error; },
  });
  try {
    coordinator.start(); await delay(10); await flush();
    assert.deepEqual(visited, effects.map(effect => effect.factId));
  } finally { await coordinator.close(); }
});

test("capture preserves a pre-existing birth mode and rejects policy mismatch", async () => {
  const f = fixture();
  try {
    const runtimeGenerationId = executionRuntimeStorageIdentity("agent", "generation", "codex_app_server", 42, "birth-secret");
    const shadow = new ExecutionShadowStore(f.db);
    f.db.prepare("DELETE FROM execution_runtime_generations WHERE runtime_generation_id=?").run(runtimeGenerationId);
    assert.equal(shadow.registerRuntime({ agentId: "agent", executionGenerationId: "generation", runtimeGenerationId,
      provider: "codex", authorityMode: "typed", configRevision: 2, createdAtMs: 100 }), "typed");
    await f.install(); f.emit(ready); await flush();
    assert.equal(f.db.prepare("SELECT authority_mode FROM execution_runtime_generations WHERE runtime_generation_id=?")
      .get(runtimeGenerationId)?.authority_mode, "typed", "capture cannot rewrite the exact birth to the current release policy");
    assert.equal(f.admission(), "unavailable",
      "the installed typed-shadow expectation never silently adopts a different frozen mode");
  } finally { f.capture.close(); }
});

test("Open Model births use the same closed typed-shadow release policy", async () => {
  const f = fixture("opencode_server");
  try {
    await f.install(); f.emit(ready); await flush();
    assert.deepEqual({ ...f.db.prepare("SELECT provider,authority_mode FROM execution_runtime_generations").get() },
      { provider: "open-model", authority_mode: "typed_shadow" });
    assert.equal(f.admission(), "ready");
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
  let position: "valid" | "throws" | "malformed" | "null" = "valid";
  const sourcePosition = fixture("codex_app_server", (_handle, listener) => {
    const subscription = observer.subscribe(listener);
    return { ...subscription, position: () => {
      if (position === "throws") throw new Error("injected position failure");
      if (position === "malformed") return { firstRetainedSequence: 3, latestSequence: 0 };
      if (position === "null") return null as never;
      return subscription.position();
    } };
  });
  try {
    await sourcePosition.install(); observer.emit(ready, "birth-secret", 42); await flush();
    assert.equal(sourcePosition.admission(), "ready");
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
    } finally { restarted.close(); }
  } finally {
    first.capture.close();
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
    const receipt = f.db.prepare("SELECT * FROM supervised_agent_inbox").all();
    f.capture.refresh(); await flush();
    assert.equal(f.facts().length, 4);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 4, max_observed_sequence: 4 });
    assert.deepEqual(f.db.prepare("SELECT * FROM supervised_agent_inbox").all(), receipt);
    assert.deepEqual({ ...f.db.prepare("SELECT provider,config_revision,runtime_state,authority_mode FROM execution_runtime_generations").get() },
      { provider: "codex", config_revision: 2, runtime_state: "ready", authority_mode: "typed_shadow" }, "actual running provider/applied revision, not desired configuration");
    assert.equal(f.db.prepare("SELECT state FROM execution_turns").get()!.state, "terminal");
    assert.doesNotMatch(JSON.stringify(f.facts()), /PRIVATE|birth-secret|localhost|private/);
    await f.install(); await flush();
    assert.equal(f.facts().length, 4, "same-source reconnect skips the committed replay prefix");
  } finally { f.capture.close(); }
});

test("typed and legacy lifecycle checkpoints meet in the durable comparator without changing execution", async () => {
  const f = fixture();
  try {
    f.bindTurn(); await f.install(); f.emit(ready);
    f.emit({ ...active, nativeEventId: "native-active" });
    f.capture.recordLegacyLifecycle({ agentId: "agent", provider: "codex", workAttemptId: "workspace",
      executionGenerationId: "generation", nativeEventId: "native-active", phase: "turn_active", state: "working" });
    f.emit({ ...terminal, nativeEventId: "native-terminal" });
    f.capture.recordLegacyLifecycle({ agentId: "agent", provider: "codex", workAttemptId: "workspace",
      executionGenerationId: "generation", nativeEventId: "native-terminal", phase: "turn_terminal", state: "terminal" });
    await flush();
    assert.deepEqual(f.capture.lifecycleProjectionDiagnostics().providers.codex, {
      comparedSegments: 1, matched: 2, missingInTyped: 0, missingInLegacy: 0,
      pairedButDifferent: 0, conflicts: 0, observationUnavailable: 0,
    });
    assert.equal(f.db.prepare("SELECT observed_state FROM runtime_deployments WHERE agent_id='agent'").get()!.observed_state, "working");
  } finally { f.capture.close(); }
});

test("busy lifecycle storage retries the bounded raw witness without blocking or losing it", async () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  let busy = true;
  try {
    f.db.exec = sql => {
      if (busy && sql === "BEGIN IMMEDIATE") { busy = false; throw new Error("database is locked"); }
      return exec(sql);
    };
    f.capture.recordLegacyLifecycle({ agentId: "agent", provider: "codex", workAttemptId: "workspace",
      executionGenerationId: "generation", nativeEventId: "raw-active", phase: "turn_active", state: "working" });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 0,
      "the provider callback performs no synchronous SQLite write");
    await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 0);
    f.db.exec = exec;
    await delay(40); await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 1);
    assert.equal(f.capture.lifecycleProjectionDiagnostics().providers.codex.observationUnavailable, 0,
      "a retained witness is retried rather than declared lost");
  } finally { f.db.exec = exec; f.capture.close(); }
});

test("raw lifecycle queue overflow is bounded and becomes durable unavailability", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 257; index++) f.capture.recordLegacyLifecycle({
      agentId: "agent", provider: "codex", workAttemptId: "workspace", executionGenerationId: "generation",
      nativeEventId: `raw-${index}`, phase: "turn_active", state: "working",
    });
    assert.equal(f.capture.lifecycleProjectionDiagnostics().providers.codex.observationUnavailable, 1);
    for (let attempt = 0; attempt < 30
      && Number(f.db.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count) < 256; attempt++) {
      await delay(5);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM lifecycle_projection_pairs").get()!.count, 256);
    assert.equal(f.capture.lifecycleProjectionDiagnostics().providers.codex.observationUnavailable, 1);
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

test("committed receipts settle captured attempts independently of capture gaps and late native outcomes", async () => {
  for (const gap of [false, true]) {
    const f = fixture();
    try {
      f.bindTurn(); await f.install(); f.emit(ready); f.emit(active); await flush();
      if (gap) {
        for (let index = 0; index < 300; index++) f.emit(ready);
        await flush(); assert.ok(f.diagnostics.includes("source_gap"));
      }
      assert.equal(f.db.prepare("SELECT state FROM execution_message_attempts").get()!.state, "active");
      f.db.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',
        outcome=?,acknowledged_at=?,updated_at=?`).run(JSON.stringify({ kind: "no_reply", text: null }), now, now);
      const operational = f.db.prepare("SELECT * FROM supervised_agent_inbox").all();
      f.capture.refresh(); await flush();
      const settled = f.db.prepare("SELECT state,conclusion,settled_at_ms FROM execution_message_attempts").get();
      assert.deepEqual({ ...settled }, { state: "cleanly_concluded", conclusion: "acknowledged_no_reply", settled_at_ms: Date.parse(now) });
      assert.equal(f.db.prepare("SELECT state FROM execution_turns").get()!.state, "active", "receipt settlement is not native-turn lifecycle authority");
      if (!gap) {
        f.emit(terminal);
        f.emit({ ...nativeTurn, domain: "execution", kind: "completed", executionId: "late-read", operation: "file_read", outcome: "failed", sideEffects: "none" });
        await flush(); assert.equal(f.facts().length, 4, "late exact native evidence remains ingestible after logical settlement");
      }
      f.capture.refresh(); await flush();
      assert.deepEqual(f.db.prepare("SELECT state,conclusion,settled_at_ms FROM execution_message_attempts").get(), settled);
      assert.deepEqual(f.db.prepare("SELECT * FROM supervised_agent_inbox").all(), operational);
    } finally { f.capture.close(); }
  }
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
    f.db.prepare("UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',outcome=?,acknowledged_at=?")
      .run(JSON.stringify({ kind: "no_reply", text: null }), now);
    await f.install(); f.emit(ready); f.emit(active); f.emit(terminal); await flush();
    assert.deepEqual(snapshots.at(-1), { agentId: "agent", facts: 3, state: "cleanly_concluded", transaction: false },
      "the hint sees both captured evidence and receipt settlement after their transactions");
    assert.ok(snapshots.every(snapshot => !snapshot.transaction));
    f.emit({ ...nativeTurn, domain: "execution", kind: "completed", executionId: "late-read", operation: "file_read", outcome: "succeeded", sideEffects: "none" });
    await flush(); assert.equal(f.facts().length, 4, "a throwing hint cannot suspend subsequent capture");
    assert.deepEqual(f.diagnostics, []);
    const calls = snapshots.length;
    f.emit(ready); f.capture.close(); f.emit(ready); await flush();
    assert.equal(snapshots.length, calls, "shutdown frontier preservation and queued facts never request publication");
  } finally { f.capture.close(); }
});

test("scheduled receipt batches advance past unavailable proof without starving later attempts", async () => {
  const f = fixture();
  try {
    await f.install(); f.emit(ready); await flush();
    const runtime = String(f.db.prepare("SELECT runtime_generation_id FROM execution_runtime_generations").get()!.runtime_generation_id);
    f.bindTurn("native-late", "late-message");
    f.db.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',outcome=?,acknowledged_at=? WHERE inbox_item_id='native-late'`)
      .run(JSON.stringify({ kind: "no_reply", text: null }), now);
    for (let index = 0; index < 40; index++) {
      const turn = `native-${index}`; const source = `message-${index}`; const attempt = `attempt-${index}`;
      f.bindTurn(turn, source);
      f.db.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',outcome=?,acknowledged_at=? WHERE inbox_item_id=?`)
        .run(JSON.stringify({ kind: index === 0 ? "unreadable" : "no_reply", text: null }), now, turn);
      f.db.prepare(`INSERT INTO execution_message_attempts(attempt_id,agent_id,room_id,source_message_id,state,created_at_ms)
        VALUES(?,'agent','room',?,'active',?)`).run(attempt, source, Date.parse(now));
      f.db.prepare(`INSERT INTO execution_attempt_generations VALUES(?,'agent','room','generation','workspace',?)`).run(attempt, Date.parse(now));
      f.db.prepare(`INSERT INTO execution_turns(turn_id,attempt_id,agent_id,room_id,execution_generation_id,runtime_generation_id,
        provider_continuation_id,provider_turn_id,state,side_effects,created_at_ms,ended_at_ms)
        VALUES(?,?,'agent','room','generation',?,'continuation',?,'terminal','none',?,?)`)
        .run(turn, attempt, runtime, turn, Date.parse(now), Date.parse(now));
    }
    f.capture.refresh(); await flush();
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_message_attempts WHERE state='cleanly_concluded'").get()!.n, 39);
    assert.equal(f.db.prepare("SELECT state FROM execution_message_attempts WHERE attempt_id='attempt-0'").get()!.state, "active");
    assert.ok(f.diagnostics.includes("settlement_unavailable"));
    assert.equal(f.admission(), "ready",
      "downstream settlement diagnostics do not revoke native capture admission");
    // A later authoritative correction rechecks earlier receipts rather than
    // treating the in-memory scan cursor as durable settlement authority.
    f.db.prepare("UPDATE supervised_agent_inbox SET outcome=? WHERE inbox_item_id='native-0'").run(JSON.stringify({ kind: "no_reply", text: null }));
    f.capture.refresh(); await flush();
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
    f.db.prepare("UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',outcome=?,acknowledged_at=?")
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

test("detached exit drains before a fresh source and storage-busy retirement retries only on a hint", async () => {
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
    f.db.exec = exec; f.capture.refresh(); await flush();
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

test("administrative close records only the admitted source frontier and tolerates storage failure", async () => {
  for (const busy of [false, true]) {
    const f = fixture(); const close = f.db.close.bind(f.db); const exec = f.db.exec.bind(f.db);
    try {
      await f.install(); f.emit(ready); await flush();
      const operational = f.db.prepare("SELECT * FROM runtime_deployments").all();
      f.emit(ready); f.emit(ready);
      let closes = 0; f.db.close = () => { closes++; };
      if (busy) f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
      assert.doesNotThrow(() => f.capture.close());
      assert.equal(f.admission(), "unavailable");
      assert.equal(closes, 1);
      assert.equal(f.facts().length, 1, "shutdown must not drain queued facts");
      assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: busy ? 1 : 3 });
      assert.deepEqual(f.db.prepare("SELECT * FROM runtime_deployments").all(), operational);
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
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_turns").get()!.n, 0);
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
    f.db.exec("UPDATE runtime_deployments SET provider_connection_pid=NULL,provider_process_identity=NULL");
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

test("same-source Cursor advance keeps identical process evidence separate when the child PID changes", async () => {
  const f = fixture("cursor_cli");
  try {
    await f.install(); f.emit(ready); f.emit({ ...ready, state: "exited", controlEvidence: "process_exit" }); await flush();
    const next = { kind: "cursor_cli" as const, pid: 43, processIdentity: "birth-secret" };
    f.handle.providerConnection = next;
    f.db.exec("UPDATE runtime_deployments SET provider_connection_pid=43,provider_process_identity='birth-secret'");
    new ExecutionShadowStore(f.db).registerRuntime({ agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", "cursor_cli", 43, "birth-secret"),
      provider: "cursor", authorityMode: "typed_shadow", configRevision: 2, createdAtMs: Date.parse(now) });
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
    f.db.exec("UPDATE runtime_deployments SET provider_connection_pid=NULL,provider_process_identity=NULL");
    await f.install(); await flush();
    assert.equal(subscriptions, 1);
    f.handle.providerConnection = connection;
    f.db.exec("UPDATE runtime_deployments SET provider_connection_pid=42,provider_process_identity='birth-secret'");
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
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_turns").get()!.n, 0);
    assert.equal(f.diagnostics.at(-1), "identity_unavailable");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 2 });
  } finally { f.capture.close(); }
});

test("optional storage failure retains queued facts and retries only on a later hint", async (t) => {
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
    f.db.prepare(`UPDATE supervised_agent_inbox SET state='acknowledged_no_reply',outcome=?,acknowledged_at=?`)
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
    assert.equal(f.db.prepare("SELECT observed_state FROM runtime_deployments").get()!.observed_state, "working");
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
  assert.throws(() => db.prepare("SELECT 1"), /not open/);
  await capture.install(f.tokenFor()); await flush(); assert.equal(subscribed, 1);
});
