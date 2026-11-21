import type { DatabaseSync } from "node:sqlite";

/**
 * Structural storage for transparent execution (schema v1). No provider output,
 * command, absolute path, approval reason, diff, credential, or arbitrary JSON
 * belongs here. One bounded projection JSON slot is validated by its sole
 * writer and revalidated on read. Native payloads remain forbidden.
 */
const tables: Record<string, string> = {
  // Execution fencing survives multiple native child lifetimes (Cursor starts
  // a child per turn). Neither identity substitutes for the other.
  execution_generations: `CREATE TABLE execution_generations (
    execution_generation_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    UNIQUE(agent_id,execution_generation_id)
  ) STRICT`,
  execution_runtime_generations: `CREATE TABLE execution_runtime_generations (
    runtime_generation_id TEXT PRIMARY KEY,
    execution_generation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code','cursor','open-model')),
    authority_mode TEXT NOT NULL DEFAULT 'typed' CHECK(authority_mode='typed'),
    runtime_state TEXT NOT NULL CHECK(runtime_state IN ('starting','ready','stopping','exited')),
    control_state TEXT NOT NULL CHECK(control_state IN ('connecting','responsive','degraded','lost','unprobeable')),
    continuation_state TEXT NOT NULL CHECK(continuation_state IN ('available','repairing','unavailable')),
    config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    ended_at_ms INTEGER CHECK(ended_at_ms >= created_at_ms),
    CHECK((runtime_state='exited') = (ended_at_ms IS NOT NULL)),
    UNIQUE(agent_id,execution_generation_id,runtime_generation_id),
    FOREIGN KEY(agent_id,execution_generation_id) REFERENCES execution_generations(agent_id,execution_generation_id)
  ) STRICT`,
  execution_message_attempts: `CREATE TABLE execution_message_attempts (
    attempt_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','cleanly_concluded','failed','interrupted','lost')),
    conclusion TEXT CHECK(conclusion IN ('replied','acknowledged_no_reply','failed','interrupted','lost')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    settled_at_ms INTEGER CHECK(settled_at_ms >= created_at_ms),
    CHECK((state='active') = (conclusion IS NULL)),
    CHECK((state='active' AND conclusion IS NULL AND settled_at_ms IS NULL)
      OR (state='cleanly_concluded' AND conclusion IN ('replied','acknowledged_no_reply') AND settled_at_ms IS NOT NULL)
      OR (state IN ('failed','interrupted','lost') AND conclusion=state AND settled_at_ms IS NOT NULL)),
    UNIQUE(agent_id,room_id,source_message_id),
    UNIQUE(attempt_id,agent_id,room_id)
  ) STRICT`,
  execution_attempt_generations: `CREATE TABLE execution_attempt_generations (
    attempt_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    PRIMARY KEY(attempt_id,execution_generation_id),
    UNIQUE(attempt_id,agent_id,room_id,execution_generation_id),
    FOREIGN KEY(attempt_id,agent_id,room_id) REFERENCES execution_message_attempts(attempt_id,agent_id,room_id),
    FOREIGN KEY(agent_id,execution_generation_id) REFERENCES execution_generations(agent_id,execution_generation_id)
  ) STRICT`,
  runs: `CREATE TABLE runs (
    turn_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    runtime_generation_id TEXT NOT NULL,
    provider_continuation_id TEXT,
    provider_turn_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('none','active','terminal','lost')),
    side_effects TEXT NOT NULL CHECK(side_effects IN ('none','possible','observed')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    ended_at_ms INTEGER CHECK(ended_at_ms >= created_at_ms),
    CHECK((provider_continuation_id IS NULL) = (provider_turn_id IS NULL)),
    CHECK(state <> 'active' OR provider_turn_id IS NOT NULL),
    CHECK((state IN ('terminal','lost')) = (ended_at_ms IS NOT NULL)),
    UNIQUE(agent_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id),
    UNIQUE(turn_id,agent_id,execution_generation_id),
    UNIQUE(turn_id,agent_id,execution_generation_id,runtime_generation_id),
    UNIQUE(turn_id,agent_id,room_id,execution_generation_id),
    UNIQUE(turn_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id),
    FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)
      REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
    FOREIGN KEY(attempt_id,agent_id,room_id,execution_generation_id)
      REFERENCES execution_attempt_generations(attempt_id,agent_id,room_id,execution_generation_id)
  ) STRICT`,
  // runtime_generation_id identifies the subject turn's original native lifetime;
  // observer_execution_generation_id / observer_runtime_generation_id record the
  // exact runtime that observed the fact (preventing successor-process facts from
  // claiming authority over an earlier native birth's prompts).
  execution_facts: `CREATE TABLE execution_facts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    runtime_generation_id TEXT NOT NULL,
    observer_execution_generation_id TEXT NOT NULL,
    observer_runtime_generation_id TEXT NOT NULL,
    observer_epoch INTEGER NOT NULL CHECK(observer_epoch >= 1),
    source_sequence INTEGER NOT NULL CHECK(source_sequence >= 1),
    native_event_id TEXT,
    turn_id TEXT,
    execution_id TEXT,
    domain TEXT NOT NULL CHECK(domain IN ('runtime','control','continuation','turn','execution')),
    kind TEXT NOT NULL CHECK(kind IN ('state_changed','started','output','completed')),
    state TEXT,
    operation TEXT CHECK(operation IN ('command','file_read','file_change','network','question','other')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed','denied_before_start','cancelled_before_start','interrupted_after_start','lost_after_start')),
    side_effects TEXT NOT NULL CHECK(side_effects IN ('none','possible','observed')),
    output_bytes INTEGER CHECK(output_bytes >= 0),
    exit_code INTEGER,
    signal_number INTEGER CHECK(signal_number > 0),
    observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
    turn_outcome TEXT CHECK(turn_outcome IS NULL OR (turn_outcome IN ('completed','failed','interrupted','unreadable') AND domain='turn' AND state='terminal')),
    control_evidence TEXT CHECK(control_evidence IS NULL OR (control_evidence IN ('process_exit','process_birth_changed','transport_refused','control_epoch_gone','native_session_terminated') AND ((domain='control' AND state='lost') OR (domain='runtime' AND state='exited')))),
    CHECK((domain='execution' AND execution_id IS NOT NULL AND turn_id IS NOT NULL
        AND kind IN ('started','output','completed') AND state IS NULL AND operation IS NOT NULL)
      OR (domain <> 'execution' AND execution_id IS NULL AND kind='state_changed' AND state IS NOT NULL
        AND operation IS NULL AND outcome IS NULL AND output_bytes IS NULL AND exit_code IS NULL AND signal_number IS NULL
        AND ((domain='runtime' AND state IN ('starting','ready','stopping','exited'))
          OR (domain='control' AND state IN ('connecting','responsive','degraded','lost','unprobeable'))
          OR (domain='continuation' AND state IN ('available','repairing','unavailable'))
          OR (domain='turn' AND turn_id IS NOT NULL AND state IN ('none','active','terminal','lost'))))),
    CHECK((kind='completed') = (outcome IS NOT NULL)),
    CHECK((kind='output') = (output_bytes IS NOT NULL)),
    CHECK(kind='completed' OR (exit_code IS NULL AND signal_number IS NULL)),
    CHECK(outcome NOT IN ('denied_before_start','cancelled_before_start') OR side_effects='none'),
    CHECK(outcome NOT IN ('denied_before_start','cancelled_before_start') OR (exit_code IS NULL AND signal_number IS NULL)),
    UNIQUE(sequence,agent_id),
    UNIQUE(runtime_generation_id,observer_epoch,source_sequence),
    FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)
      REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
    FOREIGN KEY(agent_id,observer_execution_generation_id,observer_runtime_generation_id)
      REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
    FOREIGN KEY(turn_id,agent_id,execution_generation_id,runtime_generation_id)
      REFERENCES runs(turn_id,agent_id,execution_generation_id,runtime_generation_id)
  ) STRICT`,
  execution_observers: `CREATE TABLE execution_observers (
    agent_id TEXT PRIMARY KEY,
    execution_generation_id TEXT NOT NULL,
    runtime_generation_id TEXT NOT NULL,
    observer_execution_generation_id TEXT NOT NULL,
    observer_runtime_generation_id TEXT NOT NULL,
    daemon_generation_id TEXT NOT NULL,
    observer_epoch INTEGER NOT NULL CHECK(observer_epoch >= 1),
    last_source_sequence INTEGER NOT NULL CHECK(last_source_sequence >= 0),
    max_observed_sequence INTEGER NOT NULL CHECK(max_observed_sequence >= last_source_sequence),
    recovery_turn_id TEXT,
    bound_at_ms INTEGER NOT NULL CHECK(bound_at_ms >= 0),
    source_id TEXT CHECK(source_id IS NULL OR (length(source_id) BETWEEN 1 AND 512 AND source_id GLOB '[A-Za-z0-9]*' AND source_id NOT GLOB '*[^A-Za-z0-9_.:/-]*' AND instr(source_id,char(0))=0)),
    pending_lifecycle_fact_id TEXT CHECK(pending_lifecycle_fact_id IS NULL OR length(pending_lifecycle_fact_id) BETWEEN 1 AND 512),
    FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)
      REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
    FOREIGN KEY(agent_id,observer_execution_generation_id,observer_runtime_generation_id)
      REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
    FOREIGN KEY(recovery_turn_id,agent_id,execution_generation_id,runtime_generation_id)
      REFERENCES runs(turn_id,agent_id,execution_generation_id,runtime_generation_id)
  ) STRICT`,
  execution_observer_sources: `CREATE TABLE execution_observer_sources (
    agent_id TEXT NOT NULL,
    source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 512 AND source_id GLOB '[A-Za-z0-9]*' AND source_id NOT GLOB '*[^A-Za-z0-9_.:/-]*' AND instr(source_id,char(0))=0),
    PRIMARY KEY(agent_id,source_id),
    FOREIGN KEY(agent_id) REFERENCES execution_observers(agent_id)
  ) STRICT`,
  execution_local_delegations: `CREATE TABLE execution_local_delegations (
    delegation_instance_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    owner_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    scope_key TEXT NOT NULL CHECK(scope_key='owner'),
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    agent_key TEXT NOT NULL,
    approver_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category='file_change'),
    risk_ceiling TEXT NOT NULL CHECK(risk_ceiling='low'),
    grant_id TEXT NOT NULL,
    scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
    revoked_at_ms INTEGER CHECK(revoked_at_ms >= created_at_ms),
    PRIMARY KEY(delegation_instance_id,revision),
    UNIQUE(delegation_instance_id,revision,scope_sha256,agent_id,approver_id)
  ) STRICT`,
  execution_approval_requests: `CREATE TABLE execution_approval_requests (
    request_id TEXT NOT NULL,
    request_version INTEGER NOT NULL CHECK(request_version >= 1),
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    runtime_generation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider_continuation_id TEXT NOT NULL,
    provider_turn_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    native_request_id_type TEXT NOT NULL CHECK(native_request_id_type IN ('string','number')),
    native_request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('command','file_change','network','question')),
    risk TEXT NOT NULL CHECK(risk IN ('low','medium','high')),
    delegatable INTEGER NOT NULL CHECK(delegatable IN (0,1)),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK(state IN ('requested','decision_recorded','dispatching','resolved','superseded','lost')),
    recovery_boundary TEXT NOT NULL CHECK(recovery_boundary IN ('none','connection','runtime')),
    application_certainty TEXT CHECK(application_certainty IN ('impossible','unknown')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
    CHECK(native_request_id_type='string' OR (json_valid(native_request_id) AND json_type(native_request_id) IN ('integer','real'))),
    CHECK(delegatable=0 OR (kind='file_change' AND risk='low')),
    CHECK((state='lost') = (application_certainty IS NOT NULL)),
    PRIMARY KEY(request_id,request_version),
    UNIQUE(agent_id,execution_generation_id,runtime_generation_id,connection_id,native_request_id_type,native_request_id,request_version),
    UNIQUE(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,delegatable,request_sha256),
    FOREIGN KEY(turn_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id)
      REFERENCES runs(turn_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id)
  ) STRICT`,
  execution_approval_decisions: `CREATE TABLE execution_approval_decisions (
    decision_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    request_version INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    request_delegatable INTEGER NOT NULL CHECK(request_delegatable IN (0,1)),
    request_sha256 TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allow_once','deny')),
    source TEXT NOT NULL CHECK(source IN ('host','delegate')),
    actor_id TEXT NOT NULL,
    delegation_instance_id TEXT,
    delegation_revision INTEGER,
    delegation_scope_sha256 TEXT CHECK(delegation_scope_sha256 IS NULL OR (length(delegation_scope_sha256)=64 AND delegation_scope_sha256 NOT GLOB '*[^0-9a-f]*')),
    dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('not_dispatched','dispatching','uncertain','acknowledged','lost')),
    dispatch_id TEXT UNIQUE,
    application_certainty TEXT CHECK(application_certainty IN ('impossible','unknown')),
    decided_at_ms INTEGER NOT NULL CHECK(decided_at_ms >= 0),
    dispatch_started_at_ms INTEGER CHECK(dispatch_started_at_ms >= decided_at_ms),
    resolved_at_ms INTEGER CHECK(resolved_at_ms >= decided_at_ms),
    projection_sha256 TEXT CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK((source='host' AND delegation_instance_id IS NULL AND delegation_revision IS NULL AND delegation_scope_sha256 IS NULL)
      OR (source='delegate' AND request_delegatable=1 AND delegation_instance_id IS NOT NULL
        AND delegation_revision IS NOT NULL AND delegation_scope_sha256 IS NOT NULL)),
    CHECK((dispatch_state='not_dispatched' AND dispatch_id IS NULL AND dispatch_started_at_ms IS NULL)
      OR (dispatch_state IN ('dispatching','uncertain','acknowledged') AND dispatch_id IS NOT NULL AND dispatch_started_at_ms IS NOT NULL)
      OR dispatch_state='lost'),
    CHECK((dispatch_id IS NULL) = (dispatch_started_at_ms IS NULL)),
    CHECK((dispatch_state IN ('acknowledged','lost')) = (resolved_at_ms IS NOT NULL)),
    CHECK((dispatch_state='lost') = (application_certainty IS NOT NULL)),
    UNIQUE(request_id,request_version),
    FOREIGN KEY(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256)
      REFERENCES execution_approval_requests(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,delegatable,request_sha256),
    FOREIGN KEY(delegation_instance_id,delegation_revision,delegation_scope_sha256,agent_id,actor_id)
      REFERENCES execution_local_delegations(delegation_instance_id,revision,scope_sha256,agent_id,approver_id)
  ) STRICT`,
  execution_approval_projections: `CREATE TABLE execution_approval_projections (
    request_id TEXT NOT NULL,
    request_version INTEGER NOT NULL CHECK(request_version >= 1),
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    request_delegatable INTEGER NOT NULL CHECK(request_delegatable=1),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
    projection_version INTEGER NOT NULL CHECK(projection_version=1),
    projection_json TEXT NOT NULL CHECK(json_valid(projection_json) AND json_type(projection_json)='object'
      AND length(CAST(projection_json AS BLOB)) <= 24576),
    projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
    produced_at_ms INTEGER NOT NULL CHECK(produced_at_ms >= 0),
    PRIMARY KEY(request_id,request_version),
    FOREIGN KEY(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256)
      REFERENCES execution_approval_requests(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,delegatable,request_sha256)
      ON DELETE CASCADE
  ) STRICT`,
  execution_retention_watermarks: `CREATE TABLE execution_retention_watermarks (
    agent_id TEXT PRIMARY KEY,
    compacted_through_sequence INTEGER NOT NULL CHECK(compacted_through_sequence >= 0),
    retired_at_ms INTEGER CHECK(retired_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
  ) STRICT`,
  execution_retention_pins: `CREATE TABLE execution_retention_pins (
    pin_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    from_sequence INTEGER NOT NULL CHECK(from_sequence > 0),
    reason TEXT NOT NULL CHECK(reason IN ('active_turn','active_execution','pending_approval','uncertain_dispatch','replay_authority')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    FOREIGN KEY(from_sequence,agent_id) REFERENCES execution_facts(sequence,agent_id)
  ) STRICT`,
};

const indexes: Record<string, string> = {
  runs_one_active: "CREATE UNIQUE INDEX runs_one_active ON runs(agent_id) WHERE state='active'",
  execution_facts_agent_sequence: "CREATE INDEX execution_facts_agent_sequence ON execution_facts(agent_id,sequence)",
  execution_facts_turn_sequence: "CREATE INDEX execution_facts_turn_sequence ON execution_facts(turn_id,sequence)",
  execution_approval_pending: "CREATE INDEX execution_approval_pending ON execution_approval_requests(agent_id,state,expires_at_ms)",
  execution_retention_pin_agent: "CREATE INDEX execution_retention_pin_agent ON execution_retention_pins(agent_id,from_sequence)",
};

const triggers: Record<string, string> = {
  execution_facts_immutable: `CREATE TRIGGER execution_facts_immutable BEFORE UPDATE ON execution_facts
    BEGIN SELECT RAISE(ABORT,'Execution facts are immutable.'); END`,
  execution_retention_no_regression: `CREATE TRIGGER execution_retention_no_regression BEFORE UPDATE ON execution_retention_watermarks
    WHEN NEW.agent_id <> OLD.agent_id OR NEW.compacted_through_sequence < OLD.compacted_through_sequence
    BEGIN SELECT RAISE(ABORT,'Execution retention cannot regress.'); END`,
  execution_delegation_scope_immutable: `CREATE TRIGGER execution_delegation_scope_immutable
    BEFORE UPDATE OF delegation_instance_id,revision,owner_id,host_id,installation_id,scope_key,agent_id,approver_id,category,risk_ceiling,scope_sha256,created_at_ms,expires_at_ms
    ON execution_local_delegations
    BEGIN SELECT RAISE(ABORT,'Delegation scope requires a new revision.'); END`,
  execution_delegation_revocation_final: `CREATE TRIGGER execution_delegation_revocation_final BEFORE UPDATE OF revoked_at_ms ON execution_local_delegations
    WHEN OLD.revoked_at_ms IS NOT NULL AND NEW.revoked_at_ms IS NOT OLD.revoked_at_ms
    BEGIN SELECT RAISE(ABORT,'Delegation revocation is final.'); END`,
  execution_approval_request_immutable: `CREATE TRIGGER execution_approval_request_immutable
    BEFORE UPDATE OF request_id,request_version,agent_id,room_id,execution_generation_id,runtime_generation_id,turn_id,provider_continuation_id,provider_turn_id,connection_id,native_request_id_type,native_request_id,kind,risk,delegatable,request_sha256,recovery_boundary,created_at_ms,expires_at_ms
    ON execution_approval_requests
    BEGIN SELECT RAISE(ABORT,'Approval request changes require a new version.'); END`,
  execution_approval_decision_immutable: `CREATE TRIGGER execution_approval_decision_immutable
    BEFORE UPDATE OF decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256,projection_sha256,decision,source,actor_id,delegation_instance_id,delegation_revision,delegation_scope_sha256,decided_at_ms
    ON execution_approval_decisions
    BEGIN SELECT RAISE(ABORT,'Approval decisions are immutable.'); END`,
  execution_approval_projection_immutable: `CREATE TRIGGER execution_approval_projection_immutable
    BEFORE UPDATE ON execution_approval_projections
    BEGIN SELECT RAISE(ABORT,'Approval projections are immutable.'); END`,
};

export function applyExecutionStorageSchema(database: DatabaseSync): void {
  for (const statement of Object.values(tables)) {
    database.exec(statement.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
  }
  for (const statement of Object.values(indexes)) {
    database.exec(statement.replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ").replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "));
  }
  for (const statement of Object.values(triggers)) {
    database.exec(statement.replace("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS "));
  }
}

function normalizedSchema(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? [])
    .map((part) => (part.startsWith("'") ? part : part.replaceAll('"', "").replace(/\s+/g, "").toLowerCase()))
    .join("");
}

export function validateExecutionStorageSchema(database: DatabaseSync): void {
  for (const [type, objects] of [["table", tables], ["index", indexes], ["trigger", triggers]] as const) {
    for (const [name, statement] of Object.entries(objects)) {
      const row = database.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(type, name) as { sql: string } | undefined;
      if (!row || normalizedSchema(row.sql) !== normalizedSchema(statement)) {
        throw new Error(`Execution storage schema mismatch: ${name}.`);
      }
    }
  }
  for (const name of Object.keys(tables)) {
    if (database.prepare(`PRAGMA foreign_key_check(${name})`).get()) {
      throw new Error(`Execution storage ownership mismatch: ${name}.`);
    }
  }
}
