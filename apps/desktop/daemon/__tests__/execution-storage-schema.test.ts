import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyExecutionStorageSchema, validateExecutionStorageSchema } from "../execution-storage-schema.js";

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
    scope_key: "scope", agent_id: "agent", room_id: "room", approver_id: "delegate", category: "file_change", risk_ceiling: "low",
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
    assert.equal(tables.length, 13);
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

test("delegated decisions require exact locally recorded scope revision, room, approver and eligibility", () => {
  const db = fixture(); try {
    seed(db); request(db); delegation(db);
    const remote = { source: "delegate", actor_id: "delegate", delegation_instance_id: "delegation", delegation_revision: 1 };
    assert.throws(() => decision(db, { ...remote, actor_id: "server-invented-user" }), /FOREIGN KEY/);
    assert.throws(() => decision(db, { ...remote, delegation_revision: 2 }), /FOREIGN KEY/);
    assert.throws(() => decision(db, { ...remote, room_id: "other-room" }), /FOREIGN KEY/);
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
      delegation_instance_id: "delegation", delegation_revision: 1,
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
    assert.throws(() => cutover(db, { operation_id: "wrong-target", request_id: "wrong-target-request", target_turn_id: "other-turn" }), /FOREIGN KEY/);
    assert.throws(() => cutover(db, { operation_id: "no-change", request_id: "no-change-request", from_mode: "daemon_inbox" }), /CHECK/);
    validateExecutionStorageSchema(db);
  } finally { db.close(); }
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
