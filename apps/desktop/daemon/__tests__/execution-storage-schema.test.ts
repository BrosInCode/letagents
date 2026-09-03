import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyExecutionStorageSchema, migrateExecutionStorageV20ToV21, migrateExecutionStorageV21ToV22,
  migrateExecutionStorageV22ToV23, validateExecutionStorageSchema } from "../execution-storage-schema.js";

type Values = Record<string, string | number | null>;
const digest = "a".repeat(64);

function insert(db: DatabaseSync, table: string, values: Values): void {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(values));
}
function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  applyExecutionStorageSchema(db);
  return db;
}
function runtime(db: DatabaseSync, extra: Values = {}): void {
  db.prepare("INSERT OR IGNORE INTO execution_generations(execution_generation_id,agent_id,created_at_ms) VALUES(?,?,?)")
    .run(extra.execution_generation_id ?? "generation", extra.agent_id ?? "agent", 100);
  insert(db, "execution_runtime_generations", {
    runtime_generation_id: extra.execution_generation_id ?? "runtime",
    execution_generation_id: "generation", agent_id: "agent", provider: "codex",
    runtime_state: "ready", control_state: "responsive", continuation_state: "available",
    config_revision: 1, created_at_ms: 100, ...extra,
  });
}
function attempt(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_message_attempts", {
    attempt_id: "attempt", agent_id: "agent", room_id: "room", source_message_id: "message",
    state: "active", created_at_ms: 100, ...extra,
  });
}
function attemptGeneration(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_attempt_generations", {
    attempt_id: "attempt", agent_id: "agent", room_id: "room", execution_generation_id: "generation",
    workspace_id: "workspace", created_at_ms: 100, ...extra,
  });
}
function turn(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_turns", {
    turn_id: "turn", attempt_id: "attempt", agent_id: "agent", room_id: "room", execution_generation_id: "generation",
    runtime_generation_id: "runtime",
    provider_continuation_id: "continuation", provider_turn_id: "native-turn", state: "active",
    side_effects: "none", created_at_ms: 100, ...extra,
  });
}
function seed(db: DatabaseSync): void { runtime(db); attempt(db); attemptGeneration(db); turn(db); }
function fact(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_facts", {
    fact_id: "fact", agent_id: "agent", execution_generation_id: "generation", turn_id: "turn",
    runtime_generation_id: "runtime", observer_epoch: 1,
    source_sequence: Number(db.prepare("SELECT COALESCE(MAX(source_sequence),0)+1 AS next FROM execution_facts").get()?.next),
    execution_id: "execution", domain: "execution", kind: "completed", operation: "command",
    outcome: "succeeded", side_effects: "none", observed_at_ms: 101, ...extra,
  });
}
function request(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_approval_requests", {
    request_id: "request", request_version: 1, agent_id: "agent", room_id: "room",
    execution_generation_id: "generation", turn_id: "turn", provider_continuation_id: "continuation",
    runtime_generation_id: "runtime",
    provider_turn_id: "native-turn", connection_id: "connection", native_request_id_type: "number", native_request_id: "1",
    kind: "file_change", risk: "low", delegatable: 1, request_sha256: digest, state: "requested",
    recovery_boundary: "connection", created_at_ms: 100, expires_at_ms: 200, ...extra,
  });
}
function delegation(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_local_delegations", {
    delegation_instance_id: "delegation", revision: 1, owner_id: "owner", host_id: "host", installation_id: "installation",
    scope_key: "owner", agent_id: "agent", room_id: "room", agent_key: "owner/agent", approver_id: "delegate", category: "file_change", risk_ceiling: "low",
    grant_id: "transport-grant", scope_sha256: digest, created_at_ms: 100, expires_at_ms: 200, ...extra,
  });
}
function decision(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_approval_decisions", {
    decision_id: "decision", request_id: "request", request_version: 1, agent_id: "agent", room_id: "room",
    execution_generation_id: "generation", turn_id: "turn", request_delegatable: 1, request_sha256: digest,
    decision: "allow_once", source: "host", actor_id: "owner", dispatch_state: "not_dispatched", decided_at_ms: 110, ...extra,
  });
}
function cutover(db: DatabaseSync, extra: Values = {}): void {
  insert(db, "execution_cutover_v2", {
    operation_id: "cutover", request_id: "cutover-request", agent_id: "agent", execution_generation_id: "generation",
    from_mode: "mcp_polling", to_mode: "daemon_inbox", strategy: "drain", phase: "prepared",
    created_at_ms: 100, updated_at_ms: 100, ...extra,
  });
}

test("schema is additive, empty, idempotent, content-free, and does not own version/transaction policy", () => {
  const db = fixture();
  try {
    db.exec("PRAGMA user_version=17; BEGIN IMMEDIATE");
    applyExecutionStorageSchema(db);
    validateExecutionStorageSchema(db);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 17);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_%'").all() as Array<{ name: string }>;
    assert.equal(tables.length, 15);
    for (const { name } of tables) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count, 0);
      const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
      assert.ok(columns.every(({ name }) => !/payload|output_text|command_text|reason|path|token|secret|_json$/.test(name) || name === "reason"), name);
      const foreign = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string }>;
      assert.ok(foreign.every(({ table }) => table.startsWith("execution_")), name);
    }
    runtime(db);
    db.exec("ROLLBACK");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM execution_runtime_generations").get() as { count: number }).count, 0);
  } finally { db.close(); }
});

test("lifecycle dispositions are final, fact-owned, and historical migration never replays effects", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    applyExecutionStorageSchema(db, 21);
    seed(db);
    insert(db, "execution_facts", {
      fact_id: "historical-active", agent_id: "agent", execution_generation_id: "generation",
      runtime_generation_id: "runtime", observer_epoch: 1, source_sequence: 1, turn_id: "turn",
      domain: "turn", kind: "state_changed", state: "active", side_effects: "none", observed_at_ms: 101,
    });
    assert.throws(() => migrateExecutionStorageV21ToV22(db), /requires a transaction/);
    db.exec("BEGIN IMMEDIATE");
    migrateExecutionStorageV21ToV22(db);
    db.exec("COMMIT");
    assert.deepEqual({ ...db.prepare(`SELECT effect_kind,state,observer_runtime_generation_id,disposed_at_ms
      FROM execution_lifecycle_effects WHERE fact_id='historical-active'`).get() }, {
      effect_kind: "manifest_working", state: "superseded", observer_runtime_generation_id: null, disposed_at_ms: 101,
    });
    assert.throws(() => db.exec("UPDATE execution_lifecycle_effects SET state='applied'"), /final/);
    db.exec("DELETE FROM execution_facts WHERE fact_id='historical-active'");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_lifecycle_effects").get()?.count, 0,
      "fact compaction cascades its disposition");
    validateExecutionStorageSchema(db, 22);
  } finally { db.close(); }
});

test("runtime-failure effect storage migration preserves every prior disposition", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    applyExecutionStorageSchema(db, 22);
    seed(db);
    for (const [index, state] of ["pending", "shadowed", "applied", "superseded"].entries()) {
      const factId = `fact-${state}`;
      insert(db, "execution_facts", {
        fact_id: factId, agent_id: "agent", execution_generation_id: "generation",
        runtime_generation_id: "runtime", observer_epoch: 1, source_sequence: index + 1, turn_id: "turn",
        domain: "turn", kind: "state_changed", state: index % 2 ? "terminal" : "active",
        side_effects: "none", observed_at_ms: 101 + index,
      });
      const factSequence = Number(db.prepare("SELECT sequence FROM execution_facts WHERE fact_id=?").get(factId)?.sequence);
      insert(db, "execution_lifecycle_effects", {
        fact_id: factId, fact_sequence: factSequence, agent_id: "agent",
        observer_execution_generation_id: state === "pending" ? "generation" : null,
        observer_runtime_generation_id: state === "pending" ? "runtime" : null,
        observer_epoch: 1, subject_authority_mode: "typed",
        observer_authority_mode: state === "pending" ? "typed" : null,
        effect_kind: index % 2 ? "manifest_idle" : "manifest_working", state,
        created_at_ms: 110 + index, disposed_at_ms: state === "pending" ? null : 120 + index,
      });
    }
    const before = db.prepare("SELECT rowid,* FROM execution_lifecycle_effects ORDER BY rowid").all();
    assert.throws(() => migrateExecutionStorageV22ToV23(db), /requires a transaction/);
    db.exec("CREATE TRIGGER unexpected_lifecycle_extension AFTER INSERT ON execution_lifecycle_effects BEGIN SELECT 1; END; BEGIN IMMEDIATE");
    assert.throws(() => migrateExecutionStorageV22ToV23(db), /Unexpected lifecycle effect storage dependency/);
    db.exec("ROLLBACK; DROP TRIGGER unexpected_lifecycle_extension");
    db.exec("BEGIN IMMEDIATE");
    migrateExecutionStorageV22ToV23(db);
    db.exec("COMMIT");
    assert.deepEqual(db.prepare("SELECT rowid,* FROM execution_lifecycle_effects ORDER BY rowid").all(), before);
    assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='execution_lifecycle_effects'").get()?.sql), /'manifest_failed'/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("DELETE FROM execution_facts WHERE fact_id='fact-applied'");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_lifecycle_effects WHERE fact_id='fact-applied'").get()?.count, 0);
    validateExecutionStorageSchema(db, 23);
  } finally { db.close(); }
});

test("predecessor repair settles missing dispositions even when the physical journal is already current", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    applyExecutionStorageSchema(db, 23);
    seed(db);
    insert(db, "execution_facts", {
      fact_id: "unsettled-active", agent_id: "agent", execution_generation_id: "generation",
      runtime_generation_id: "runtime", observer_epoch: 1, source_sequence: 1, turn_id: "turn",
      domain: "turn", kind: "state_changed", state: "active", side_effects: "none", observed_at_ms: 101,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_lifecycle_effects").get()?.count, 0);
    db.exec("BEGIN IMMEDIATE");
    migrateExecutionStorageV21ToV22(db);
    db.exec("COMMIT");
    const effect = db.prepare("SELECT effect_kind,state FROM execution_lifecycle_effects WHERE fact_id='unsettled-active'").get();
    assert.deepEqual({ ...effect }, { effect_kind: "manifest_working", state: "superseded" });
    validateExecutionStorageSchema(db, 23);
  } finally { db.close(); }
});

test("one source-message attempt survives retries, with generation and workspace as internal bindings", () => {
  const db = fixture(); try {
    runtime(db); runtime(db, { execution_generation_id: "retry-generation" });
    attempt(db); attemptGeneration(db); attemptGeneration(db, { execution_generation_id: "retry-generation", workspace_id: "retry-workspace" });
    assert.throws(() => attempt(db, { attempt_id: "duplicate-attempt" }), /UNIQUE/);
    attempt(db, { attempt_id: "other-room-attempt", room_id: "other-room" });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM execution_message_attempts WHERE room_id='room'").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM execution_attempt_generations").get() as { count: number }).count, 2);
    assert.throws(() => attemptGeneration(db, { attempt_id: "other-room-attempt" }), /FOREIGN KEY/);
    assert.throws(() => attempt(db, { attempt_id: "null-outcome", source_message_id: "other", state: "cleanly_concluded", settled_at_ms: 110 }), /CHECK/);
    db.exec("UPDATE execution_message_attempts SET state='cleanly_concluded',conclusion='acknowledged_no_reply',settled_at_ms=110 WHERE attempt_id='attempt'");
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("separate state axes and exact turn ownership do not collapse tool failure into runtime death", () => {
  const db = fixture(); try {
    seed(db);
    runtime(db, { agent_id: "other", execution_generation_id: "other-generation" });
    assert.throws(() => attemptGeneration(db, { execution_generation_id: "other-generation" }), /FOREIGN KEY/);
    assert.throws(() => turn(db, { turn_id: "wrong-room", room_id: "wrong", state: "none", provider_continuation_id: null, provider_turn_id: null }), /FOREIGN KEY/);
    assert.throws(() => turn(db, { turn_id: "overlap", provider_turn_id: "second-native-turn" }), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE execution_turns SET state='waiting_approval'"), /CHECK/);
    db.exec("UPDATE execution_runtime_generations SET control_state='degraded'");
    fact(db, { outcome: "failed", exit_code: 1, side_effects: "possible" });
    assert.deepEqual({ ...db.prepare("SELECT runtime_state,control_state FROM execution_runtime_generations WHERE agent_id='agent'").get() },
      { runtime_state: "ready", control_state: "degraded" });
    assert.throws(() => db.exec("UPDATE execution_runtime_generations SET runtime_state='exited' WHERE agent_id='agent'"), /CHECK/);
    assert.throws(() => db.exec("UPDATE execution_runtime_generations SET authority_mode='invented'"), /CHECK/);
    assert.equal(db.prepare("SELECT authority_mode FROM execution_runtime_generations WHERE agent_id='agent'").get()?.authority_mode, "legacy");
  } finally { db.close(); }
});

test("fact sequencing survives deletion and immutable facts carry six honest outcomes", () => {
  const db = fixture(); try {
    seed(db);
    const outcomes = ["succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start"];
    for (const outcome of outcomes) fact(db, { fact_id: outcome, outcome });
    assert.throws(() => fact(db, { fact_id: "succeeded" }), /UNIQUE/);
    assert.throws(() => fact(db, { outcome: "denied_before_start", side_effects: "observed" }), /CHECK/);
    assert.throws(() => fact(db, { outcome: "cancelled_before_start", exit_code: 1 }), /CHECK/);
    assert.throws(() => fact(db, { outcome: "unknown" }), /CHECK/);
    assert.throws(() => fact(db, { kind: "started" }), /CHECK/);
    assert.throws(() => fact(db, { turn_id: "not-a-turn" }), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE execution_facts SET outcome='succeeded' WHERE fact_id='failed'"), /immutable/);
    db.exec("DELETE FROM execution_facts");
    fact(db, { fact_id: "later", kind: "output", outcome: null, output_bytes: 42 });
    assert.equal(db.prepare("SELECT sequence FROM execution_facts").get()?.sequence, 7);
    assert.throws(() => fact(db, { fact_id: "bad-state", execution_id: null, domain: "runtime", kind: "state_changed", outcome: null, operation: null }), /CHECK/);
    fact(db, { fact_id: "runtime-fact", execution_id: null, turn_id: null, domain: "runtime", kind: "state_changed", outcome: null, operation: null, state: "ready" });
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("native lifetimes and observer ordering remain distinct from execution and journal generations", () => {
  const db = fixture(); try {
    seed(db);
    runtime(db, { runtime_generation_id: "second-runtime" });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_generations").get()?.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_runtime_generations").get()?.count, 2);
    db.exec("UPDATE execution_turns SET state='terminal',ended_at_ms=110 WHERE turn_id='turn'");
    turn(db, { turn_id: "second-turn", runtime_generation_id: "second-runtime" });
    fact(db, { source_sequence: 1, native_event_id: "native-event" });
    assert.throws(() => fact(db, { fact_id: "duplicate-source", source_sequence: 1 }), /UNIQUE/);
    fact(db, { fact_id: "new-observer", observer_epoch: 2, source_sequence: 1, native_event_id: "native-event" });
    fact(db, { fact_id: "new-runtime", runtime_generation_id: "second-runtime", turn_id: "second-turn", source_sequence: 1 });
    assert.throws(() => fact(db, { fact_id: "wrong-runtime", runtime_generation_id: "second-runtime", source_sequence: 2 }), /FOREIGN KEY/);
    assert.throws(() => fact(db, { fact_id: "invalid-epoch", observer_epoch: 0 }), /CHECK/);
    assert.throws(() => fact(db, { fact_id: "invalid-source", source_sequence: 0 }), /CHECK/);
    request(db);
    assert.throws(() => request(db, { request_id: "wrong-runtime", runtime_generation_id: "second-runtime", native_request_id: "2" }), /FOREIGN KEY/);
    request(db, { request_id: "second-runtime-request", runtime_generation_id: "second-runtime", turn_id: "second-turn" });
    assert.deepEqual(db.prepare("SELECT sequence,observer_epoch,source_sequence FROM execution_facts ORDER BY sequence").all().map((row) => ({ ...row })), [
      { sequence: 1, observer_epoch: 1, source_sequence: 1 },
      { sequence: 2, observer_epoch: 2, source_sequence: 1 },
      { sequence: 3, observer_epoch: 1, source_sequence: 1 },
    ]);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("observer bindings fence subject and current observer lifetimes to the same agent", () => {
  const db = fixture(); try {
    seed(db);
    runtime(db, { execution_generation_id: "observer-generation", runtime_generation_id: "observer-runtime" });
    runtime(db, { agent_id: "other-agent", execution_generation_id: "other-generation", runtime_generation_id: "other-runtime" });
    const observer = {
      agent_id: "agent", execution_generation_id: "generation", runtime_generation_id: "runtime",
      observer_execution_generation_id: "observer-generation", observer_runtime_generation_id: "observer-runtime",
      daemon_generation_id: "daemon-generation", observer_epoch: 2, last_source_sequence: 1,
      max_observed_sequence: 2, recovery_turn_id: "turn", bound_at_ms: 100,
    };
    for (const invalid of [
      { runtime_generation_id: "observer-runtime" },
      { observer_runtime_generation_id: "runtime" },
      { observer_execution_generation_id: "other-generation", observer_runtime_generation_id: "other-runtime" },
      { execution_generation_id: "observer-generation", runtime_generation_id: "observer-runtime" },
      { recovery_turn_id: "missing-turn" },
    ]) assert.throws(() => insert(db, "execution_observers", { ...observer, ...invalid }), /FOREIGN KEY/);
    for (const invalid of [{ observer_epoch: 0 }, { last_source_sequence: -1 }, { max_observed_sequence: 0 }, { bound_at_ms: -1 }]) {
      assert.throws(() => insert(db, "execution_observers", { ...observer, ...invalid }), /CHECK/);
    }
    insert(db, "execution_observers", observer);
    assert.equal(db.prepare("SELECT source_id FROM execution_observers").get()!.source_id, null, "unknown legacy source stays unknown");
    const setSource = db.prepare("UPDATE execution_observers SET source_id=?");
    for (const source of ["", "a".repeat(513), " bad", "a b", "_bad", "a\n", "a\0hidden", "é", "a?b"]) {
      assert.throws(() => setSource.run(source), /CHECK/, JSON.stringify(source));
      assert.throws(() => insert(db, "execution_observer_sources", { agent_id: "agent", source_id: source }), /CHECK/);
    }
    for (const source of ["uuid-source", "1a_./:-", "a".repeat(512), null]) setSource.run(source);
    assert.throws(() => insert(db, "execution_observer_sources", { agent_id: "agent", source_id: null }), /NOT NULL/);
    insert(db, "execution_observer_sources", { agent_id: "agent", source_id: "first-source" });
    assert.throws(() => insert(db, "execution_observer_sources", { agent_id: "agent", source_id: "first-source" }), /UNIQUE/);
    assert.throws(() => insert(db, "execution_observer_sources", { agent_id: "other-agent", source_id: "first-source" }), /FOREIGN KEY/);
    insert(db, "execution_observers", { ...observer, agent_id: "other-agent", execution_generation_id: "other-generation",
      runtime_generation_id: "other-runtime", observer_execution_generation_id: "other-generation",
      observer_runtime_generation_id: "other-runtime", recovery_turn_id: null });
    insert(db, "execution_observer_sources", { agent_id: "other-agent", source_id: "first-source" });
    assert.throws(() => db.exec("DELETE FROM execution_observers WHERE agent_id='agent'"), /FOREIGN KEY/);
    const sourceKeys = db.prepare("PRAGMA foreign_key_list(execution_observer_sources)").all();
    assert.equal(sourceKeys.length, 1);
    assert.equal(sourceKeys[0].table, "execution_observers", "source memory must not pin old runtime generations");
    assert.equal(sourceKeys[0].on_delete, "NO ACTION");
    assert.throws(() => insert(db, "execution_observers", observer), /UNIQUE/);
    assert.throws(() => db.exec("DELETE FROM execution_turns WHERE turn_id='turn'"), /FOREIGN KEY/);
    db.exec("UPDATE execution_observers SET recovery_turn_id=NULL");
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("v19 evidence fields are nullable for history and constrained to their fact domains", () => {
  const db = fixture(); try {
    seed(db);
    const stateFact = { execution_id: null, kind: "state_changed", operation: null, outcome: null };
    fact(db, { ...stateFact, domain: "turn", state: "terminal", fact_id: "historical-terminal" });
    for (const turn_outcome of ["completed", "failed", "interrupted", "unreadable"]) {
      fact(db, { ...stateFact, domain: "turn", state: "terminal", fact_id: turn_outcome, turn_outcome });
    }
    assert.throws(() => fact(db, { turn_outcome: "completed" }), /CHECK/);
    assert.throws(() => fact(db, { ...stateFact, domain: "turn", state: "active", turn_outcome: "completed" }), /CHECK/);
    assert.throws(() => fact(db, { ...stateFact, domain: "turn", state: "terminal", turn_outcome: "invented" }), /CHECK/);
    for (const control_evidence of ["process_exit", "process_birth_changed", "transport_refused", "control_epoch_gone", "native_session_terminated"]) {
      fact(db, { ...stateFact, domain: "control", state: "lost", fact_id: control_evidence, control_evidence });
    }
    fact(db, { ...stateFact, domain: "runtime", state: "exited", fact_id: "exited", control_evidence: "process_exit" });
    assert.throws(() => fact(db, { control_evidence: "process_exit" }), /CHECK/);
    assert.throws(() => fact(db, { ...stateFact, domain: "control", state: "degraded", control_evidence: "transport_refused" }), /CHECK/);
    assert.throws(() => fact(db, { ...stateFact, domain: "control", state: "lost", control_evidence: "silence" }), /CHECK/);
    request(db);
    for (const projection_sha256 of ["short", "g".repeat(64), "A".repeat(64)]) {
      assert.throws(() => decision(db, { projection_sha256 }), /CHECK/);
    }
    decision(db, { projection_sha256: digest });
    assert.throws(() => db.exec("UPDATE execution_approval_decisions SET projection_sha256=NULL"), /immutable/);
    assert.throws(() => db.exec("UPDATE execution_facts SET turn_outcome='failed' WHERE fact_id='historical-terminal'"), /immutable/);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("approval identity preserves native request type, connection and exact native turn", () => {
  const db = fixture(); try {
    seed(db); request(db);
    request(db, { request_id: "string-id", native_request_id_type: "string" });
    request(db, { request_id: "reconnected", connection_id: "new-connection" });
    assert.throws(() => request(db, { request_id: "duplicate" }), /UNIQUE/);
    assert.throws(() => request(db, { request_id: "wrong-turn", native_request_id: "2", provider_turn_id: "wrong-native-turn" }), /FOREIGN KEY/);
    assert.throws(() => request(db, { request_id: "number-type-lie", native_request_id: '"1"' }), /CHECK/);
    assert.throws(() => request(db, { request_id: "unsafe-command", native_request_id: "2", kind: "command" }), /CHECK/);
    assert.throws(() => request(db, { request_id: "unsafe-risk", native_request_id: "2", risk: "high" }), /CHECK/);
    assert.throws(() => db.exec("UPDATE execution_approval_requests SET request_sha256='b' WHERE request_id='request'"), /new version/);
    request(db, { request_version: 2 });
  } finally { db.close(); }
});

test("decision, dispatch uncertainty, and lost application certainty have distinct durable fields", () => {
  const db = fixture(); try {
    seed(db); request(db);
    assert.throws(() => decision(db, { request_version: 2 }), /FOREIGN KEY/);
    assert.throws(() => decision(db, { request_sha256: "b".repeat(64) }), /FOREIGN KEY/);
    decision(db);
    assert.throws(() => decision(db, { decision_id: "opposite", decision: "deny" }), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE execution_approval_decisions SET decision='deny'"), /immutable/);
    assert.throws(() => db.exec("UPDATE execution_approval_decisions SET dispatch_state='uncertain'"), /CHECK/);
    db.exec("UPDATE execution_approval_decisions SET dispatch_state='dispatching',dispatch_id='dispatch',dispatch_started_at_ms=111");
    db.exec("UPDATE execution_approval_decisions SET dispatch_state='uncertain'");
    assert.throws(() => db.exec("UPDATE execution_approval_decisions SET dispatch_state='lost',resolved_at_ms=120"), /CHECK/);
    db.exec("UPDATE execution_approval_decisions SET dispatch_state='lost',resolved_at_ms=120,application_certainty='unknown'");
    assert.throws(() => db.exec("UPDATE execution_approval_requests SET state='lost'"), /CHECK/);
    db.exec("UPDATE execution_approval_requests SET state='lost',application_certainty='unknown'");
    request(db, { request_id: "impossible", native_request_id: "2", state: "lost", application_certainty: "impossible" });
    decision(db, { decision_id: "lost-before-dispatch", request_id: "impossible", dispatch_state: "lost", application_certainty: "impossible", resolved_at_ms: 120 });
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("delegated decisions bind exact immutable scope identity while aliases remain presentation", () => {
  const db = fixture(); try {
    seed(db); request(db); delegation(db);
    assert.throws(() => delegation(db, { delegation_instance_id: "wrong-scope", scope_key: "rental:session" }), /CHECK/);
    const remote = { source: "delegate", actor_id: "delegate", delegation_instance_id: "delegation",
      delegation_revision: 1, delegation_scope_sha256: digest };
    assert.throws(() => decision(db, { ...remote, actor_id: "server-invented-user" }), /FOREIGN KEY/);
    assert.throws(() => decision(db, { ...remote, delegation_revision: 2 }), /FOREIGN KEY/);
    assert.throws(() => decision(db, { ...remote, delegation_scope_sha256: "b".repeat(64) }), /FOREIGN KEY/);
    db.exec("UPDATE execution_local_delegations SET room_id='renamed-room',agent_key='owner/renamed-agent'");
    decision(db, remote);
    db.exec("UPDATE execution_local_delegations SET grant_id='rotated-grant'");
    assert.equal(db.prepare("SELECT delegation_instance_id FROM execution_approval_decisions").get()?.delegation_instance_id, "delegation");
    assert.throws(() => db.exec("UPDATE execution_local_delegations SET approver_id='new-approver'"), /new revision/);
    db.exec("UPDATE execution_local_delegations SET revoked_at_ms=120");
    assert.throws(() => db.exec("UPDATE execution_local_delegations SET revoked_at_ms=NULL"), /final/);
    delegation(db, { revision: 2 });
    request(db, { request_id: "host-only", native_request_id: "2", kind: "command", delegatable: 0 });
    assert.throws(() => decision(db, { ...remote, decision_id: "unsafe", request_id: "host-only", request_delegatable: 0 }), /CHECK/);
    assert.throws(() => decision(db, { ...remote, decision_id: "lying-eligibility", request_id: "host-only" }), /FOREIGN KEY/);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("a same-room agent cannot borrow another agent's local delegation", () => {
  const db = fixture(); try {
    seed(db); delegation(db);
    const other = { agent_id: "other-agent", execution_generation_id: "other-generation", runtime_generation_id: "other-runtime" };
    runtime(db, other);
    attempt(db, { agent_id: other.agent_id, attempt_id: "other-attempt" });
    attemptGeneration(db, { agent_id: other.agent_id, execution_generation_id: other.execution_generation_id, attempt_id: "other-attempt" });
    turn(db, { ...other, turn_id: "other-turn", attempt_id: "other-attempt" });
    request(db, { ...other, request_id: "other-request", turn_id: "other-turn" });
    const otherDecision = {
      agent_id: other.agent_id, execution_generation_id: other.execution_generation_id,
      request_id: "other-request", turn_id: "other-turn", source: "delegate", actor_id: "delegate",
      delegation_instance_id: "delegation", delegation_revision: 1, delegation_scope_sha256: digest,
    };
    assert.throws(() => decision(db, otherDecision), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE execution_local_delegations SET agent_id='other-agent'"), /new revision/);
    delegation(db, { delegation_instance_id: "other-delegation", agent_id: other.agent_id });
    decision(db, { ...otherDecision, delegation_instance_id: "other-delegation" });
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("cutover-v2 cannot overlap an unresolved operation; reverse is a distinct operation", () => {
  const db = fixture(); try {
    seed(db); cutover(db, { phase: "uncertain", strategy: "force", target_turn_id: "turn" });
    assert.throws(() => cutover(db, { operation_id: "overlap", request_id: "overlap-request" }), /UNIQUE/);
    db.exec("UPDATE execution_cutover_v2 SET phase='complete'");
    cutover(db, { operation_id: "reverse", request_id: "reverse-request", predecessor_operation_id: "cutover", from_mode: "daemon_inbox", to_mode: "mcp_polling" });
    db.exec("UPDATE execution_cutover_v2 SET phase='cancelled' WHERE operation_id='reverse'");
    assert.throws(() => cutover(db, { operation_id: "no-target", request_id: "no-target-request", strategy: "force", phase: "dispatching" }), /CHECK/);
    assert.throws(() => cutover(db, { operation_id: "wrong-predecessor", request_id: "wrong-predecessor-request", predecessor_operation_id: "missing-operation" }), /FOREIGN KEY/);
    assert.throws(() => cutover(db, { operation_id: "no-change", request_id: "no-change-request", from_mode: "daemon_inbox" }), /CHECK/);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("native cutover identity is complete, immutable, and independent of optional activity rows", () => {
  const db = fixture(); try {
    const authority = {
      authority_version: 1, room_id: "room", work_attempt_id: "work-attempt", provider: "codex",
      native_continuation_id: "native-thread", native_connection_kind: "codex_app_server",
      native_connection_sha256: digest, native_pid: 123, native_process_identity: "process-birth",
    };
    for (const key of Object.keys(authority)) {
      assert.throws(() => cutover(db, { ...authority, [key]: null }), /CHECK/, `missing ${key}`);
    }
    for (const invalid of [
      { authority_version: 2 }, { target_turn_id: "shadow-turn" },
      { native_pid: 0 }, { native_connection_sha256: "short" }, { native_connection_sha256: "G".repeat(64) },
      { provider: "claude-code" }, { native_connection_kind: "invented" },
      { room_id: "" }, { work_attempt_id: " " }, { native_continuation_id: "" }, { native_process_identity: " " },
      { native_target_turn_id: " " }, { admitted_inbox_item_id: "inbox" },
    ]) assert.throws(() => cutover(db, { ...authority, ...invalid }), /CHECK/, JSON.stringify(invalid));
    assert.throws(() => cutover(db, { native_target_turn_id: "native-turn" }), /CHECK/, "history cannot acquire native authority");
    assert.throws(() => cutover(db, { ...authority, strategy: "force", phase: "dispatching" }), /CHECK/);
    cutover(db, authority);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_generations").get()!.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_turns").get()!.count, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(execution_cutover_v2)").all().map((key) => key.table),
      ["execution_cutover_v2", "execution_cutover_v2"], "only same-agent predecessor ownership remains");
    for (const key of [...Object.keys(authority), "agent_id", "execution_generation_id", "request_id", "target_turn_id", "from_mode", "strategy", "admitted_action_id"]) {
      assert.throws(() => db.exec(`UPDATE execution_cutover_v2 SET ${key}=${key}`), /new operation/, key);
    }
    db.exec("UPDATE execution_cutover_v2 SET phase='draining',native_target_turn_id='native-turn'");
    db.exec("UPDATE execution_cutover_v2 SET native_target_turn_id='native-turn'");
    assert.throws(() => db.exec("UPDATE execution_cutover_v2 SET native_target_turn_id='replacement'"), /cannot be replaced/);
    assert.throws(() => db.exec("UPDATE execution_cutover_v2 SET native_target_turn_id=NULL"), /cannot be replaced/);
    db.exec("UPDATE execution_cutover_v2 SET phase='complete'");
    const admission = { admitted_inbox_item_id: "inbox-A", admitted_source_message_id: "message-A", admitted_action_id: "claim-A" };
    for (const key of Object.keys(admission)) {
      assert.throws(() => cutover(db, { ...authority, ...admission, [key]: null,
        operation_id: "reverse", request_id: "reverse", from_mode: "daemon_inbox", to_mode: "mcp_polling" }), /CHECK/);
    }
    assert.throws(() => cutover(db, { ...authority, ...admission, operation_id: "wrong-lane", request_id: "wrong-lane" }), /CHECK/);
    assert.throws(() => cutover(db, { ...authority, operation_id: "wrong-owner", request_id: "wrong-owner",
      agent_id: "other-agent", predecessor_operation_id: "cutover" }), /FOREIGN KEY/);
    cutover(db, { ...authority, ...admission, operation_id: "reverse", request_id: "reverse",
      predecessor_operation_id: "cutover", from_mode: "daemon_inbox", to_mode: "mcp_polling",
      strategy: "force", phase: "dispatching", native_target_turn_id: "native-turn" });
    assert.throws(() => db.exec("UPDATE execution_cutover_v2 SET admitted_inbox_item_id='inbox-B' WHERE operation_id='reverse'"), /new operation/);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("cutover migration refuses unknown dependencies and requires an outer transaction", () => {
  for (const extension of ["index", "trigger", "foreign-key"]) {
    const db = new DatabaseSync(":memory:"); try {
      db.exec("PRAGMA foreign_keys=ON");
      applyExecutionStorageSchema(db, 20);
      assert.throws(() => migrateExecutionStorageV20ToV21(db), /requires a transaction/);
      if (extension === "index") db.exec("CREATE INDEX extra_cutover_index ON execution_cutover_v2(request_id)");
      if (extension === "trigger") db.exec("CREATE TRIGGER extra_cutover_trigger AFTER INSERT ON execution_cutover_v2 BEGIN SELECT 1; END");
      if (extension === "foreign-key") db.exec("CREATE TABLE extra_cutover_owner(operation_id TEXT REFERENCES execution_cutover_v2(operation_id))");
      const before = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      db.exec("BEGIN IMMEDIATE");
      assert.throws(() => migrateExecutionStorageV20ToV21(db), /Unexpected cutover storage dependency/, extension);
      db.exec("ROLLBACK");
      assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), before);
      validateExecutionStorageSchema(db, 20);
    } finally { db.close(); }
  }
});

test("retention pins preserve owned evidence and compaction watermarks cannot regress", () => {
  const db = fixture(); try {
    seed(db); fact(db);
    assert.throws(() => insert(db, "execution_retention_pins", { pin_id: "wrong-agent", agent_id: "other", from_sequence: 1, reason: "active_turn", created_at_ms: 100 }), /FOREIGN KEY/);
    insert(db, "execution_retention_pins", { pin_id: "pin", agent_id: "agent", from_sequence: 1, reason: "uncertain_dispatch", created_at_ms: 100 });
    assert.throws(() => db.exec("DELETE FROM execution_facts"), /FOREIGN KEY/);
    assert.throws(() => db.exec("DELETE FROM execution_turns"), /FOREIGN KEY/);
    insert(db, "execution_retention_watermarks", { agent_id: "agent", compacted_through_sequence: 0, updated_at_ms: 100 });
    db.exec("DELETE FROM execution_retention_pins; DELETE FROM execution_facts; UPDATE execution_retention_watermarks SET compacted_through_sequence=1");
    assert.throws(() => db.exec("UPDATE execution_retention_watermarks SET compacted_through_sequence=0"), /cannot regress/);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
});

test("reopen validation rejects weakened constraints, indexes, triggers and cross-agent orphan evidence", () => {
  for (const corruption of ["index", "trigger", "check", "foreign-key"]) {
    const db = fixture(); try {
      seed(db);
      if (corruption === "index") db.exec("DROP INDEX execution_cutover_one_unresolved");
      if (corruption === "trigger") db.exec("DROP TRIGGER execution_approval_decision_immutable");
      if (corruption === "check") db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'''legacy''','''LEGACY''') WHERE name='execution_runtime_generations'; PRAGMA writable_schema=OFF");
      if (corruption === "foreign-key") {
        db.exec("PRAGMA foreign_keys=OFF");
        fact(db, { agent_id: "other-agent" });
        db.exec("PRAGMA foreign_keys=ON");
      }
      assert.throws(() => validateExecutionStorageSchema(db), /Execution storage (schema|ownership) mismatch/, corruption);
    } finally { db.close(); }
  }
});
