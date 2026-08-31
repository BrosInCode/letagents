import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DaemonStateSchema } from "../daemon-state-database.js";
import { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import { ProviderExecutionObserver } from "../../electron/main/agents/provider-execution-observer.js";
import type { NativeExecutionFact, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { ProviderActionConnectionRef, ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";

const now = "2026-08-31T00:00:00.000Z";
const ready: NativeExecutionFact = { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" };
const nativeTurn = { providerContinuationId: "continuation", providerTurnId: "native-turn" };
const active: NativeExecutionFact = { ...nativeTurn, domain: "turn", kind: "state_changed", state: "active", sideEffects: "none" };
const terminal: NativeExecutionFact = { ...active, state: "terminal", turnOutcome: "completed" };
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

function successor(f: ReturnType<typeof fixture>, birth: string): ProviderActionHandle {
  const handle = { ...f.handle, appliedConfigurationRevision: 2,
    providerConnection: { ...f.handle.providerConnection!, processIdentity: birth } };
  f.handles.set("agent", handle);
  f.db.prepare("UPDATE runtime_deployments SET provider_process_identity=?").run(birth);
  return handle;
}

function fixture(kind: ProviderActionConnectionRef["kind"] = "codex_app_server", onExecution?: NonNullable<ProviderActionPort["onExecution"]>) {
  const db = new DatabaseSync(":memory:");
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
  const handle: ProviderActionHandle = { workAttemptId: "workspace", pid: 42, providerContinuationId: "continuation", observedState: "working", providerConnection: connection };
  const handles = new Map([["agent", handle]]);
  const observer = new ProviderExecutionObserver(() => now);
  const diagnostics: string[] = [];
  const capture = new ExecutionCaptureCoordinator(db, { provider: { onExecution: onExecution ?? ((_handle, listener) => observer.subscribe(listener)) },
    currentHandle: id => handles.get(id), daemonGeneration: () => 1, diagnostic: (_id, code) => diagnostics.push(code) });
  const install = () => capture.install("agent", handle, "generation");
  const emit = (fact: NativeExecutionFact, birth = "birth-secret") => observer.emit(fact, birth);
  const facts = () => db.prepare("SELECT * FROM execution_facts ORDER BY sequence").all();
  const position = () => db.prepare("SELECT last_source_sequence,max_observed_sequence FROM execution_observers").get();
  const bindTurn = (turn = "native-turn", source = "message") => {
    db.prepare(`INSERT INTO supervised_agent_inbox(inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,created_at,updated_at)
      VALUES(?,'agent','room',?,'{"text":"PRIVATE PROMPT"}','{}',?,'awaiting_result',1,?,?,?, ?,?)`)
      .run(turn, source, Number(db.prepare("SELECT COUNT(*) n FROM supervised_agent_inbox").get()!.n) + 1, `action-${turn}`, `reply-${turn}`, turn, now, now);
    db.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES(?,'agent','room','workspace','generation','continuation',?)").run(turn, turn);
  };
  return { db, handle, handles, observer, capture, diagnostics, install, emit, facts, position, bindTurn };
}

test("capture replays native facts only after the exact committed turn binding, without delivery mutations", async () => {
  const f = fixture();
  try {
    f.emit(ready); f.emit(active);
    f.emit({ ...nativeTurn, domain: "execution", kind: "completed", executionId: "read", operation: "file_read", outcome: "failed", sideEffects: "none" });
    f.emit(terminal);
    f.install(); await flush();
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
    f.install(); await flush();
    assert.equal(f.facts().length, 4, "same-source reconnect skips the committed replay prefix");
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
    const detach = f.install(); old.emit(ready, "birth-secret"); await flush();
    let blocked = 0;
    f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") { blocked++; throw new Error("database is busy"); } return exec(sql); };
    old.emit({ domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "process_exit", sideEffects: "none" }, "birth-secret");
    detach();
    const next = successor(f, "fresh-birth");
    const fresh = new ProviderExecutionObserver(() => now); sources.set(next, fresh);
    f.capture.install("agent", next, "generation"); fresh.emit(ready, "fresh-birth");
    await flush();
    assert.equal(blocked, 1); assert.equal(f.facts().length, 1);
    await flush(); assert.equal(blocked, 1, "no timer or immediate-loop storage retry");
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
    f.install(); sources.get(f.handle)!.emit(ready, "birth-secret"); await flush();
    f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
    sources.get(f.handle)!.emit(ready, "birth-secret");
    const second = successor(f, "second"); sources.set(second, new ProviderExecutionObserver(() => now));
    f.capture.install("agent", second, "generation"); await flush();
    assert.equal(subscriptions, 2);
    for (let index = 0; index < 20; index++) {
      const next = successor(f, `replacement-${index}`); sources.set(next, new ProviderExecutionObserver(() => now));
      f.capture.install("agent", next, "generation");
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
      f.install(); f.emit(ready); await flush();
      const operational = f.db.prepare("SELECT * FROM runtime_deployments").all();
      f.emit(ready); f.emit(ready);
      let closes = 0; f.db.close = () => { closes++; };
      if (busy) f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") throw new Error("database is busy"); return exec(sql); };
      assert.doesNotThrow(() => f.capture.close());
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
    f.install(); await flush(); assert.equal(f.facts().length, 0);
    f.install(); observer.emit(ready, "birth-secret"); await flush();
    assert.equal(calls, 2); assert.equal(f.facts().length, 1);
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 1 });
  } finally { f.capture.close(); }
});

test("unverified process birth and a wrong binding cannot borrow the current FIFO identity", async () => {
  const f = fixture();
  try {
    f.bindTurn("other-turn"); f.install(); f.emit(ready); f.emit(active, "unknown-birth"); await flush();
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
    f.bindTurn(); f.install();
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
      if (!beforeSubscribe) { f.install(); await flush(); }
      for (let i = 0; i < 300; i++) f.emit(ready);
      if (beforeSubscribe) f.install();
      await flush();
      assert.equal(f.facts().length, 0);
      assert.deepEqual({ ...f.position() }, { last_source_sequence: 0, max_observed_sequence: 300 });
      assert.equal(f.diagnostics.at(-1), "source_gap");
      f.install(); await flush();
      assert.equal(f.facts().length, 0);
      assert.equal(f.position()!.max_observed_sequence, 300);
    } finally { f.capture.close(); }
  }
});

test("same-source Cursor reinstall skips an exited child's committed prefix before binding the next child", async () => {
  const f = fixture("cursor_cli");
  try {
    f.install(); f.emit(ready); f.emit({ ...ready, state: "exited", controlEvidence: "process_exit" }); await flush();
    const next = { kind: "cursor_cli" as const, pid: 43, processIdentity: "second-birth" };
    f.handle.providerConnection = next;
    f.db.exec("UPDATE runtime_deployments SET provider_connection_pid=43,provider_process_identity='second-birth'");
    f.install(); f.capture.prepared({ agentId: "agent", handle: f.handle, executionGenerationId: "generation", connection: next, configurationRevision: 2 });
    f.emit(ready, "second-birth"); await flush();
    assert.equal(f.facts().length, 3);
    assert.deepEqual(f.db.prepare("SELECT runtime_state FROM execution_runtime_generations ORDER BY rowid").all().map(r => r.runtime_state), ["exited", "ready"]);
    assert.deepEqual(f.diagnostics, []);
    assert.equal(f.position()!.last_source_sequence, 3);
  } finally { f.capture.close(); }
});

test("reinstalling an empty idle Cursor observer does not strand its first real child", async () => {
  const f = fixture("cursor_cli");
  try {
    const connection = { ...f.handle.providerConnection! };
    f.handle.providerConnection = { kind: "cursor_cli", pid: null, processIdentity: null };
    f.db.exec("UPDATE runtime_deployments SET provider_connection_pid=NULL,provider_process_identity=NULL");
    f.install(); await flush();
    f.install(); await flush();
    f.capture.prepared({ agentId: "agent", handle: f.handle, executionGenerationId: "generation", connection, configurationRevision: 2 });
    f.emit(ready); await flush();
    assert.equal(f.facts().length, 1);
    assert.equal(f.position()!.last_source_sequence, 1);
  } finally { f.capture.close(); }
});

test("older-generation recovery without captured original runtime proof stays unavailable", async () => {
  const f = fixture();
  try {
    f.bindTurn();
    f.db.exec("UPDATE supervised_agent_provider_turn_bindings SET origin_execution_generation_id='uncaptured-old-generation'");
    f.install(); f.emit(ready); f.emit(active); await flush();
    assert.equal(f.facts().length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_turns").get()!.n, 0);
    assert.equal(f.diagnostics.at(-1), "identity_unavailable");
    assert.deepEqual({ ...f.position() }, { last_source_sequence: 1, max_observed_sequence: 2 });
  } finally { f.capture.close(); }
});

test("optional storage failure retains queued facts and retries only on a later hint", async (t) => {
  const f = fixture();
  try {
    f.install(); await flush();
    const exec = f.db.exec.bind(f.db);
    let failures = 0;
    const mock = t.mock.method(f.db, "exec", (sql: string) => {
      if (sql === "BEGIN IMMEDIATE") { failures++; throw new Error("database is locked"); }
      return exec(sql);
    });
    assert.doesNotThrow(() => f.emit(ready)); await flush();
    assert.equal(failures, 1, "no self-retry loop on busy storage");
    assert.equal(f.diagnostics.at(-1), "storage_unavailable");
    mock.mock.restore(); f.capture.refresh(); await flush();
    assert.equal(f.facts().length, 1);
  } finally { f.capture.close(); }
});

test("synchronous exit cleanup keeps final facts ahead of successor observation admission", async () => {
  const f = fixture();
  try {
    f.handle.appliedConfigurationRevision = 2;
    const detach = f.install(); await Promise.resolve(); await Promise.resolve();
    f.emit(ready);
    f.emit({ domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "process_exit" });
    f.emit({ ...ready, state: "exited", controlEvidence: "process_exit" });
    f.handles.delete("agent"); detach();
    assert.equal(f.facts().length, 0, "exit cleanup performs no inline SQLite capture");
    await flush();
    assert.equal(f.facts().length, 3);
    assert.equal(f.db.prepare("SELECT runtime_state FROM execution_runtime_generations").get()!.runtime_state, "exited");
    assert.equal(f.position()!.last_source_sequence, 3);
    assert.deepEqual(f.diagnostics, []);
  } finally { f.capture.close(); }
});

test("terminal detach with uncommitted turn mapping records a gap rather than dropping its tail", async () => {
  const f = fixture();
  try {
    const detach = f.install(); f.emit(ready); await flush();
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
    f.install(); f.emit({ ...ready, command: "PRIVATE TOKEN" } as NativeExecutionFact); await flush();
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
  capture.install("agent", f.handle, "generation"); await Promise.resolve();
  assert.equal(subscribed, 1); capture.close();
  resolve({ sourceId: "source", position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => { disposed++; } });
  await flush(); assert.equal(disposed, 1);
  assert.throws(() => db.prepare("SELECT 1"), /not open/);
  capture.install("agent", f.handle, "generation"); await flush(); assert.equal(subscribed, 1);
});
