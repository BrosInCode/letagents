import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DaemonStateSchema } from "../daemon-state-database.js";
import { ExecutionCaptureCoordinator } from "../execution-capture-coordinator.js";
import { ProviderExecutionObserver } from "../../electron/main/agents/provider-execution-observer.js";
import type { NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription } from "../../shared/execution-protocol.js";
import type { ProviderActionConnectionRef, ProviderActionHandle, ProviderActionPort } from "../provider-action-port.js";

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
  return handle;
}

function fixture(kind: ProviderActionConnectionRef["kind"] = "codex_app_server", onExecution?: NonNullable<ProviderActionPort["onExecution"]>, changed?: (agentId: string) => void) {
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
    currentHandle: id => handles.get(id), daemonGeneration: () => 1, diagnostic: (_id, code) => diagnostics.push(code), changed });
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

test("typed and legacy lifecycle checkpoints meet in the durable comparator without changing execution", async () => {
  const f = fixture();
  try {
    f.bindTurn(); f.install(); f.emit(ready);
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
    f.install();
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

test("control coalescing preserves changed evidence, native events, process identity, and bounded replay", () => {
  const observer = new ProviderExecutionObserver(() => now);
  const seen: NativeExecutionObservation[] = [];
  observer.subscribe(event => seen.push(event));
  const responsive: NativeExecutionFact = { domain: "control", kind: "state_changed", state: "responsive", sideEffects: "none" };
  observer.emit(responsive, "birth-one");
  observer.emit(responsive, "birth-one");
  observer.emit(responsive, "birth-two");
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_exit" }, "birth-two");
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_exit" }, "birth-two");
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_birth_changed" }, "birth-two");
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_birth_changed", nativeEventId: "native-one" }, "birth-two");
  observer.emit({ ...responsive, state: "lost", controlEvidence: "process_birth_changed", nativeEventId: "native-two" }, "birth-two");
  assert.deepEqual(seen.map(event => ({ sequence: event.sequence, identity: event.nativeProcessIdentity,
    state: event.fact.domain === "control" ? event.fact.state : null,
    evidence: event.fact.domain === "control" && "controlEvidence" in event.fact ? event.fact.controlEvidence : undefined,
    nativeEventId: event.fact.nativeEventId })), [
    { sequence: 1, identity: "birth-one", state: "responsive", evidence: undefined, nativeEventId: undefined },
    { sequence: 2, identity: "birth-two", state: "responsive", evidence: undefined, nativeEventId: undefined },
    { sequence: 3, identity: "birth-two", state: "lost", evidence: "process_exit", nativeEventId: undefined },
    { sequence: 4, identity: "birth-two", state: "lost", evidence: "process_birth_changed", nativeEventId: undefined },
    { sequence: 5, identity: "birth-two", state: "lost", evidence: "process_birth_changed", nativeEventId: "native-one" },
    { sequence: 6, identity: "birth-two", state: "lost", evidence: "process_birth_changed", nativeEventId: "native-two" },
  ]);
});

test("committed receipts settle captured attempts independently of capture gaps and late native outcomes", async () => {
  for (const gap of [false, true]) {
    const f = fixture();
    try {
      f.bindTurn(); f.install(); f.emit(ready); f.emit(active); await flush();
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
    f.install(); f.emit(ready); f.emit(active); f.emit(terminal); await flush();
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
    f.install(); f.emit(ready); await flush();
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
    const detach = f.install(); await Promise.resolve(); await Promise.resolve();
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
