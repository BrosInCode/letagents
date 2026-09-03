import { DatabaseSync } from "node:sqlite";

/**
 * Dormant, structural storage for transparent execution. No provider output,
 * command, path, approval reason, diff, credential, or arbitrary JSON belongs
 * here: content persistence must wait for the separately reviewed sanitizer.
 *
 * These journals intentionally have no foreign key to manifest projections or
 * the legacy inbox. Manifest updates delete/reinsert their projection graph;
 * inbox retention has a different lifetime. Only this independent graph may
 * own its rows. Applying the schema neither imports evidence nor runs reducers.
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
    authority_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(authority_mode IN ('legacy','typed_shadow','typed')),
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
  execution_turns: `CREATE TABLE execution_turns (
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
  // runtime_generation_id identifies the subject turn's original native lifetime,
  // not the observer's current child. observer_epoch separates re-observation;
  // ingestion must still prove the exact retained turn and current observer fence.
  execution_facts: `CREATE TABLE execution_facts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    runtime_generation_id TEXT NOT NULL,
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
    FOREIGN KEY(turn_id,agent_id,execution_generation_id,runtime_generation_id)
      REFERENCES execution_turns(turn_id,agent_id,execution_generation_id,runtime_generation_id)
  ) STRICT`,
  execution_local_delegations: `CREATE TABLE execution_local_delegations (
    delegation_instance_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    owner_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    approver_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category='file_change'),
    risk_ceiling TEXT NOT NULL CHECK(risk_ceiling='low'),
    grant_id TEXT NOT NULL,
    scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
    revoked_at_ms INTEGER CHECK(revoked_at_ms >= created_at_ms),
    PRIMARY KEY(delegation_instance_id,revision),
    UNIQUE(delegation_instance_id,revision,agent_id,room_id,approver_id)
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
      REFERENCES execution_turns(turn_id,agent_id,room_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id)
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
    dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('not_dispatched','dispatching','uncertain','acknowledged','lost')),
    dispatch_id TEXT UNIQUE,
    application_certainty TEXT CHECK(application_certainty IN ('impossible','unknown')),
    decided_at_ms INTEGER NOT NULL CHECK(decided_at_ms >= 0),
    dispatch_started_at_ms INTEGER CHECK(dispatch_started_at_ms >= decided_at_ms),
    resolved_at_ms INTEGER CHECK(resolved_at_ms >= decided_at_ms),
    CHECK((source='host' AND delegation_instance_id IS NULL AND delegation_revision IS NULL)
      OR (source='delegate' AND request_delegatable=1 AND delegation_instance_id IS NOT NULL AND delegation_revision IS NOT NULL)),
    CHECK((dispatch_state='not_dispatched' AND dispatch_id IS NULL AND dispatch_started_at_ms IS NULL)
      OR (dispatch_state IN ('dispatching','uncertain','acknowledged') AND dispatch_id IS NOT NULL AND dispatch_started_at_ms IS NOT NULL)
      OR dispatch_state='lost'),
    CHECK((dispatch_id IS NULL) = (dispatch_started_at_ms IS NULL)),
    CHECK((dispatch_state IN ('acknowledged','lost')) = (resolved_at_ms IS NOT NULL)),
    CHECK((dispatch_state='lost') = (application_certainty IS NOT NULL)),
    UNIQUE(request_id,request_version),
    FOREIGN KEY(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256)
      REFERENCES execution_approval_requests(request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,delegatable,request_sha256),
    FOREIGN KEY(delegation_instance_id,delegation_revision,agent_id,room_id,actor_id)
      REFERENCES execution_local_delegations(delegation_instance_id,revision,agent_id,room_id,approver_id)
  ) STRICT`,
  execution_cutover_v2: `CREATE TABLE execution_cutover_v2 (
    operation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    execution_generation_id TEXT NOT NULL,
    target_turn_id TEXT,
    predecessor_operation_id TEXT,
    from_mode TEXT NOT NULL CHECK(from_mode IN ('mcp_polling','daemon_inbox')),
    to_mode TEXT NOT NULL CHECK(to_mode IN ('mcp_polling','daemon_inbox')),
    strategy TEXT NOT NULL CHECK(strategy IN ('drain','force')),
    phase TEXT NOT NULL CHECK(phase IN ('prepared','draining','dispatching','uncertain','complete','cancelled','failed')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    CHECK(from_mode <> to_mode),
    CHECK(predecessor_operation_id IS NULL OR predecessor_operation_id <> operation_id),
    CHECK(strategy <> 'force' OR phase NOT IN ('dispatching','uncertain') OR target_turn_id IS NOT NULL),
    UNIQUE(operation_id,agent_id),
    FOREIGN KEY(agent_id,execution_generation_id) REFERENCES execution_generations(agent_id,execution_generation_id),
    FOREIGN KEY(target_turn_id,agent_id,execution_generation_id) REFERENCES execution_turns(turn_id,agent_id,execution_generation_id),
    FOREIGN KEY(predecessor_operation_id,agent_id) REFERENCES execution_cutover_v2(operation_id,agent_id)
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
    reason TEXT NOT NULL CHECK(reason IN ('active_turn','active_execution','pending_approval','uncertain_dispatch','unresolved_cutover','replay_authority')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    FOREIGN KEY(from_sequence,agent_id) REFERENCES execution_facts(sequence,agent_id)
  ) STRICT`,
};

// V24 removes mutable canonical aliases from delegation authority. The server
// digest and immutable provenance identify the admitted revision; room/agent
// names remain current presentation only. Decisions may retain their room
// snapshot for audit, but bind authority through the exact admitted digest.
const executionLocalDelegationsV24 = `CREATE TABLE execution_local_delegations (
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
) STRICT`;

const executionApprovalDecisionsV24 = `CREATE TABLE execution_approval_decisions (
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
) STRICT`;

// `sequence` is daemon journal order. The source tuple is independent: future
// ingestion validates observer freshness, increasing source order and gaps;
// storage prevents the same observer position being journaled twice. Native
// event IDs are correlation evidence, not assumed globally unique.

const indexes: Record<string, string> = {
  // agent_id is the stable manifest entry, preserved across room moves. One
  // execution lane spans those moves; each attempt retains its source room.
  execution_turn_one_active: "CREATE UNIQUE INDEX execution_turn_one_active ON execution_turns(agent_id) WHERE state='active'",
  execution_facts_agent_sequence: "CREATE INDEX execution_facts_agent_sequence ON execution_facts(agent_id,sequence)",
  execution_facts_turn_sequence: "CREATE INDEX execution_facts_turn_sequence ON execution_facts(turn_id,sequence)",
  execution_approval_pending: "CREATE INDEX execution_approval_pending ON execution_approval_requests(agent_id,state,expires_at_ms)",
  execution_cutover_one_unresolved: "CREATE UNIQUE INDEX execution_cutover_one_unresolved ON execution_cutover_v2(agent_id) WHERE phase NOT IN ('complete','cancelled','failed')",
  execution_retention_pin_agent: "CREATE INDEX execution_retention_pin_agent ON execution_retention_pins(agent_id,from_sequence)",
};

// Immutable identities are storage contracts, not lifecycle reducers. Request
// changes require a new version; grant scope changes require a new revision.
// Grant rotation and one-way revocation do not change delegation identity.
const triggers: Record<string, string> = {
  execution_facts_immutable: `CREATE TRIGGER execution_facts_immutable BEFORE UPDATE ON execution_facts
    BEGIN SELECT RAISE(ABORT,'Execution facts are immutable.'); END`,
  execution_retention_no_regression: `CREATE TRIGGER execution_retention_no_regression BEFORE UPDATE ON execution_retention_watermarks
    WHEN NEW.agent_id <> OLD.agent_id OR NEW.compacted_through_sequence < OLD.compacted_through_sequence
    BEGIN SELECT RAISE(ABORT,'Execution retention cannot regress.'); END`,
  execution_delegation_scope_immutable: `CREATE TRIGGER execution_delegation_scope_immutable
    BEFORE UPDATE OF delegation_instance_id,revision,owner_id,host_id,installation_id,scope_key,agent_id,room_id,approver_id,category,risk_ceiling,scope_sha256,created_at_ms,expires_at_ms
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
    BEFORE UPDATE OF decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256,decision,source,actor_id,delegation_instance_id,delegation_revision,decided_at_ms
    ON execution_approval_decisions
    BEGIN SELECT RAISE(ABORT,'Approval decisions are immutable.'); END`,
};

const delegationTriggersV24 = {
  execution_delegation_scope_immutable: `CREATE TRIGGER execution_delegation_scope_immutable
    BEFORE UPDATE OF delegation_instance_id,revision,owner_id,host_id,installation_id,scope_key,agent_id,approver_id,category,risk_ceiling,scope_sha256,created_at_ms,expires_at_ms
    ON execution_local_delegations
    BEGIN SELECT RAISE(ABORT,'Delegation scope requires a new revision.'); END`,
  execution_approval_decision_immutable: `CREATE TRIGGER execution_approval_decision_immutable
    BEFORE UPDATE OF decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,request_delegatable,request_sha256,projection_sha256,decision,source,actor_id,delegation_instance_id,delegation_revision,delegation_scope_sha256,decided_at_ms
    ON execution_approval_decisions
    BEGIN SELECT RAISE(ABORT,'Approval decisions are immutable.'); END`,
};

// Nullable evidence preserves v18 history. Ingestion, not migration, requires
// these fields on new terminal/control facts and projection-bound decisions.
const v19Columns: Record<string, string[]> = {
  execution_facts: [
    "turn_outcome TEXT CHECK(turn_outcome IS NULL OR (turn_outcome IN ('completed','failed','interrupted','unreadable') AND domain='turn' AND state='terminal'))",
    "control_evidence TEXT CHECK(control_evidence IS NULL OR (control_evidence IN ('process_exit','process_birth_changed','transport_refused','control_epoch_gone','native_session_terminated') AND ((domain='control' AND state='lost') OR (domain='runtime' AND state='exited'))))",
  ],
  execution_approval_decisions: [
    "projection_sha256 TEXT CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*')",
  ],
};
const observerTable = `CREATE TABLE execution_observers (
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
  FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)
    REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
  FOREIGN KEY(agent_id,observer_execution_generation_id,observer_runtime_generation_id)
    REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id),
  FOREIGN KEY(recovery_turn_id,agent_id,execution_generation_id,runtime_generation_id)
    REFERENCES execution_turns(turn_id,agent_id,execution_generation_id,runtime_generation_id)
) STRICT`;
// Match executionIdentity without inventing provenance for pre-source observers.
const observerSourceColumn = "source_id TEXT CHECK(source_id IS NULL OR (length(source_id) BETWEEN 1 AND 512 AND source_id GLOB '[A-Za-z0-9]*' AND source_id NOT GLOB '*[^A-Za-z0-9_.:/-]*' AND instr(source_id,char(0))=0))";
// Keep admission memory independent of fact retention and native lifetimes.
const observerSourcesTable = `CREATE TABLE execution_observer_sources (
  agent_id TEXT NOT NULL,
  ${observerSourceColumn.replace("TEXT CHECK", "TEXT NOT NULL CHECK")},
  PRIMARY KEY(agent_id,source_id),
  FOREIGN KEY(agent_id) REFERENCES execution_observers(agent_id)
) STRICT`;

// Journal-before-effect: every accepted lifecycle fact receives one durable
// disposition in the same transaction as the fact. The FK cascade makes the
// journal follow retained-fact compaction instead of growing independently.
// Historical rows cannot recover their exact observer birth, so migration
// settles them as superseded rather than manufacturing operational authority.
const lifecycleEffectsTable = `CREATE TABLE execution_lifecycle_effects (
  fact_id TEXT PRIMARY KEY,
  fact_sequence INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  observer_execution_generation_id TEXT,
  observer_runtime_generation_id TEXT,
  observer_epoch INTEGER NOT NULL CHECK(observer_epoch >= 1),
  subject_authority_mode TEXT NOT NULL CHECK(subject_authority_mode IN ('legacy','typed_shadow','typed')),
  observer_authority_mode TEXT CHECK(observer_authority_mode IS NULL OR observer_authority_mode IN ('legacy','typed_shadow','typed')),
  effect_kind TEXT NOT NULL CHECK(effect_kind IN ('none','manifest_working','manifest_idle')),
  state TEXT NOT NULL CHECK(state IN ('pending','shadowed','applied','superseded')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  disposed_at_ms INTEGER CHECK(disposed_at_ms >= created_at_ms),
  CHECK((state='pending' AND effect_kind <> 'none'
      AND subject_authority_mode='typed' AND observer_authority_mode='typed'
      AND observer_execution_generation_id IS NOT NULL AND observer_runtime_generation_id IS NOT NULL
      AND disposed_at_ms IS NULL)
    OR (state <> 'pending' AND disposed_at_ms IS NOT NULL)),
  UNIQUE(fact_sequence,agent_id),
  FOREIGN KEY(fact_id) REFERENCES execution_facts(fact_id) ON DELETE CASCADE,
  FOREIGN KEY(fact_sequence,agent_id) REFERENCES execution_facts(sequence,agent_id) ON DELETE CASCADE,
  FOREIGN KEY(agent_id,observer_execution_generation_id,observer_runtime_generation_id)
    REFERENCES execution_runtime_generations(agent_id,execution_generation_id,runtime_generation_id)
) STRICT`;
const lifecycleEffectsTableV23 = lifecycleEffectsTable.replace(
  "effect_kind IN ('none','manifest_working','manifest_idle')",
  "effect_kind IN ('none','manifest_working','manifest_idle','manifest_failed')",
);
const lifecycleEffectIndexes = {
  execution_lifecycle_effect_pending: "CREATE INDEX execution_lifecycle_effect_pending ON execution_lifecycle_effects(state,agent_id,fact_sequence)",
};
const lifecycleEffectTriggers = {
  execution_lifecycle_effect_identity_immutable: `CREATE TRIGGER execution_lifecycle_effect_identity_immutable
    BEFORE UPDATE OF fact_id,fact_sequence,agent_id,observer_execution_generation_id,observer_runtime_generation_id,observer_epoch,
      subject_authority_mode,observer_authority_mode,effect_kind,created_at_ms
    ON execution_lifecycle_effects
    BEGIN SELECT RAISE(ABORT,'Lifecycle effect identity is immutable.'); END`,
  execution_lifecycle_effect_disposition_final: `CREATE TRIGGER execution_lifecycle_effect_disposition_final
    BEFORE UPDATE OF state,disposed_at_ms ON execution_lifecycle_effects
    WHEN OLD.state <> 'pending' OR NEW.state NOT IN ('applied','superseded')
    BEGIN SELECT RAISE(ABORT,'Lifecycle effect disposition is final.'); END`,
};

// Cutover authority must not depend on optional activity capture. Historical
// generation/target values remain untouched, but are not native authority.
// The connection digest binds the complete private connection reference without
// copying URLs, auth paths, or credentials into this structural journal.
const cutoverAuthorityColumns = {
  authority_version: "INTEGER CHECK(authority_version IS NULL OR authority_version=1)",
  room_id: "TEXT",
  work_attempt_id: "TEXT",
  provider: "TEXT CHECK(provider IN ('codex','claude-code','cursor','open-model'))",
  native_continuation_id: "TEXT",
  native_connection_kind: "TEXT CHECK(native_connection_kind IN ('codex_app_server','claude_cli','cursor_cli','opencode_server'))",
  native_connection_sha256: "TEXT CHECK(length(native_connection_sha256)=64 AND native_connection_sha256 NOT GLOB '*[^0-9a-f]*')",
  native_pid: "INTEGER CHECK(native_pid > 0)",
  native_process_identity: "TEXT",
  native_target_turn_id: "TEXT",
  admitted_inbox_item_id: "TEXT",
  admitted_source_message_id: "TEXT",
  admitted_action_id: "TEXT",
};
const cutoverAuthorityRequired = Object.keys(cutoverAuthorityColumns).filter((name) =>
  name !== "authority_version" && name !== "native_target_turn_id" && !name.startsWith("admitted_"));
const cutoverNativeTable = tables.execution_cutover_v2
  .replace("    CHECK(from_mode", `    ${Object.entries(cutoverAuthorityColumns).map(([name, type]) => `${name} ${type}`).join(",\n    ")},
    CHECK((authority_version IS NULL AND ${Object.keys(cutoverAuthorityColumns).slice(1).map((name) => `${name} IS NULL`).join(" AND ")})
      OR (authority_version IS 1 AND target_turn_id IS NULL
        AND ${cutoverAuthorityRequired.map((name) => `${name} IS NOT NULL`).join(" AND ")})),
    CHECK(authority_version IS NULL OR (
      length(trim(room_id)) > 0 AND length(trim(work_attempt_id)) > 0
      AND length(trim(native_continuation_id)) > 0 AND length(trim(native_process_identity)) > 0
      AND ((provider='codex' AND native_connection_kind='codex_app_server')
        OR (provider='claude-code' AND native_connection_kind='claude_cli')
        OR (provider='cursor' AND native_connection_kind='cursor_cli')
        OR (provider='open-model' AND native_connection_kind='opencode_server')))),
    CHECK(native_target_turn_id IS NULL OR length(trim(native_target_turn_id)) > 0),
    CHECK((admitted_inbox_item_id IS NULL AND admitted_source_message_id IS NULL AND admitted_action_id IS NULL)
      OR (authority_version IS 1 AND from_mode='daemon_inbox'
        AND admitted_inbox_item_id IS NOT NULL AND length(trim(admitted_inbox_item_id)) > 0
        AND admitted_source_message_id IS NOT NULL AND length(trim(admitted_source_message_id)) > 0
        AND admitted_action_id IS NOT NULL AND length(trim(admitted_action_id)) > 0)),
    CHECK(from_mode`)
  .replace("OR target_turn_id IS NOT NULL)", "OR (authority_version IS NULL AND target_turn_id IS NOT NULL) OR (authority_version IS 1 AND native_target_turn_id IS NOT NULL))")
  .replace("    FOREIGN KEY(agent_id,execution_generation_id) REFERENCES execution_generations(agent_id,execution_generation_id),\n", "")
  .replace("    FOREIGN KEY(target_turn_id,agent_id,execution_generation_id) REFERENCES execution_turns(turn_id,agent_id,execution_generation_id),\n", "");
const cutoverNativeTriggers = {
  execution_cutover_identity_immutable: `CREATE TRIGGER execution_cutover_identity_immutable
    BEFORE UPDATE OF operation_id,request_id,agent_id,execution_generation_id,target_turn_id,predecessor_operation_id,from_mode,to_mode,strategy,created_at_ms,
      ${Object.keys(cutoverAuthorityColumns).filter((name) => name !== "native_target_turn_id").join(",")}
    ON execution_cutover_v2
    BEGIN SELECT RAISE(ABORT,'Cutover identity requires a new operation.'); END`,
  execution_cutover_native_target_immutable: `CREATE TRIGGER execution_cutover_native_target_immutable
    BEFORE UPDATE OF native_target_turn_id ON execution_cutover_v2
    WHEN NEW.native_target_turn_id IS NOT OLD.native_target_turn_id
      AND (OLD.native_target_turn_id IS NOT NULL OR OLD.phase NOT IN ('prepared','draining'))
    BEGIN SELECT RAISE(ABORT,'Cutover native target cannot be replaced.'); END`,
};

export type ExecutionStorageSchemaVersion = 18 | 19 | 20 | 21 | 22 | 23 | 24;

function schemaFor(version: ExecutionStorageSchemaVersion): {
  tables: Record<string, string>; indexes: Record<string, string>; triggers: Record<string, string>;
} {
  if (version === 18) return { tables, indexes, triggers };
  const schema: {
    tables: Record<string, string>; indexes: Record<string, string>; triggers: Record<string, string>;
  } = {
    tables: {
      ...Object.fromEntries(Object.entries(tables).map(([name, sql]) => [name, v19Columns[name]
        ? sql.replace("\n    CHECK(", `\n    ${v19Columns[name].join(",\n    ")},\n    CHECK(`) : sql])),
      execution_observers: version === 19 ? observerTable
        : observerTable.replace("  FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)",
          `  ${observerSourceColumn},\n  FOREIGN KEY(agent_id,execution_generation_id,runtime_generation_id)`),
      ...(version >= 20 ? { execution_observer_sources: observerSourcesTable } : {}),
      ...(version >= 21 ? { execution_cutover_v2: cutoverNativeTable } : {}),
      ...(version >= 22 ? { execution_lifecycle_effects: version >= 23 ? lifecycleEffectsTableV23 : lifecycleEffectsTable } : {}),
    },
    indexes: { ...indexes, ...(version >= 22 ? lifecycleEffectIndexes : {}) },
    triggers: {
      ...triggers,
      execution_approval_decision_immutable: triggers.execution_approval_decision_immutable
        .replace("request_sha256,decision", "request_sha256,projection_sha256,decision"),
      ...(version >= 21 ? cutoverNativeTriggers : {}),
      ...(version >= 22 ? lifecycleEffectTriggers : {}),
    },
  };
  if (version >= 24) {
    schema.tables.execution_local_delegations = executionLocalDelegationsV24;
    schema.tables.execution_approval_decisions = executionApprovalDecisionsV24;
    Object.assign(schema.triggers, delegationTriggersV24);
  }
  return schema;
}

/** Caller owns the migration transaction. Existing evidence is never rewritten. */
export function applyExecutionStorageSchema(database: DatabaseSync, version: ExecutionStorageSchemaVersion = 24): void {
  const schema = schemaFor(version);
  for (const statement of Object.values(schema.tables)) database.exec(statement.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
  for (const statement of Object.values(schema.indexes)) database.exec(statement.replace(/CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS "));
  for (const statement of Object.values(schema.triggers)) database.exec(statement.replace("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS "));
}

/** Add evidence slots without rewriting facts, decisions, or their ownership. */
export function migrateExecutionStorageV18ToV19(database: DatabaseSync): void {
  validateExecutionStorageSchema(database, 18);
  for (const [table, columns] of Object.entries(v19Columns)) {
    for (const column of columns) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
  database.exec(observerTable);
  database.exec("DROP TRIGGER execution_approval_decision_immutable");
  database.exec(schemaFor(19).triggers.execution_approval_decision_immutable);
  validateExecutionStorageSchema(database, 19);
}

/** Source identity is unknown for historical rows; their cursors remain intact. */
export function migrateExecutionStorageV19ToV20(database: DatabaseSync): void {
  validateExecutionStorageSchema(database, 19);
  database.exec(`ALTER TABLE execution_observers ADD COLUMN ${observerSourceColumn}`);
  database.exec(observerSourcesTable);
  validateExecutionStorageSchema(database, 20);
}

/** Caller owns the transaction and encrypted recovery snapshot. No authority is backfilled. */
export function migrateExecutionStorageV20ToV21(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Cutover storage migration requires a transaction.");
  validateExecutionStorageSchema(database, 20);
  // Refuse extensions we cannot preserve, rather than silently dropping their
  // constraints while replacing only this table. The self-reference is retained.
  const extra = database.prepare("SELECT name FROM sqlite_master WHERE tbl_name='execution_cutover_v2' AND type IN ('index','trigger') AND sql IS NOT NULL AND name <> 'execution_cutover_one_unresolved'").get();
  if (extra) throw new Error("Unexpected cutover storage dependency.");
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'execution_cutover_v2'").all()) {
    const name = String(row.name).replaceAll('"', '""');
    if (database.prepare(`PRAGMA foreign_key_list("${name}")`).all().some((key) => key.table === "execution_cutover_v2")) {
      throw new Error("Unexpected cutover storage dependency.");
    }
  }
  const columns = (database.prepare("PRAGMA table_info(execution_cutover_v2)").all()).map((column) => String(column.name)).join(",");
  database.exec("PRAGMA defer_foreign_keys=ON");
  database.exec("CREATE TEMP TABLE execution_cutover_migration AS SELECT rowid AS original_rowid,* FROM execution_cutover_v2");
  database.exec("DROP TABLE execution_cutover_v2");
  database.exec(cutoverNativeTable);
  database.exec(`INSERT INTO execution_cutover_v2(rowid,${columns}) SELECT original_rowid,${columns} FROM execution_cutover_migration`);
  database.exec("DROP TABLE execution_cutover_migration");
  database.exec(schemaFor(21).indexes.execution_cutover_one_unresolved);
  for (const statement of Object.values(cutoverNativeTriggers)) database.exec(statement);
  validateExecutionStorageSchema(database, 21);
}

/** Historical facts remain observation-only; never replay old rows as effects. */
export function migrateExecutionStorageV21ToV22(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Lifecycle effect storage migration requires a transaction.");
  validateExecutionStorageSchema(database, 21);
  const existing = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_lifecycle_effects'").get();
  let physicalVersion: 22 | 23 = 22;
  if (existing) {
    // A predecessor repair may encounter a physically complete additive table
    // with older version markers. Trust it only after exact known-shape validation,
    // then still settle every historical fact below.
    try { validateExecutionStorageSchema(database, 22); }
    catch {
      validateExecutionStorageSchema(database, 23);
      physicalVersion = 23;
    }
  } else {
    database.exec(lifecycleEffectsTable);
    for (const statement of Object.values(lifecycleEffectIndexes)) database.exec(statement);
    for (const statement of Object.values(lifecycleEffectTriggers)) database.exec(statement);
  }
  database.exec(`INSERT OR IGNORE INTO execution_lifecycle_effects(
      fact_id,fact_sequence,agent_id,observer_execution_generation_id,observer_runtime_generation_id,observer_epoch,
      subject_authority_mode,observer_authority_mode,effect_kind,state,created_at_ms,disposed_at_ms)
    SELECT f.fact_id,f.sequence,f.agent_id,NULL,NULL,f.observer_epoch,r.authority_mode,NULL,
      CASE WHEN f.domain='turn' AND f.state='active' THEN 'manifest_working'
        WHEN f.domain='turn' AND f.state='terminal' THEN 'manifest_idle' ELSE 'none' END,
      'superseded',f.observed_at_ms,f.observed_at_ms
    FROM execution_facts f
    JOIN execution_runtime_generations r ON r.agent_id=f.agent_id
      AND r.execution_generation_id=f.execution_generation_id
      AND r.runtime_generation_id=f.runtime_generation_id
    WHERE f.domain <> 'execution'`);
  if (hasMissingLifecycleDisposition(database)) {
    throw new Error("Lifecycle effect storage migration left a fact without a disposition.");
  }
  validateExecutionStorageSchema(database, physicalVersion);
}

function hasMissingLifecycleDisposition(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM execution_facts f
    WHERE f.domain <> 'execution'
      AND NOT EXISTS(SELECT 1 FROM execution_lifecycle_effects e WHERE e.fact_id=f.fact_id)
    LIMIT 1`).get());
}

function validateLifecycleEffectDependencies(database: DatabaseSync): void {
  const allowedObjects = new Set([
    "execution_lifecycle_effect_pending",
    "execution_lifecycle_effect_identity_immutable",
    "execution_lifecycle_effect_disposition_final",
  ]);
  const extra = (database.prepare(`SELECT name FROM sqlite_master
    WHERE tbl_name='execution_lifecycle_effects' AND type IN ('index','trigger') AND sql IS NOT NULL`).all())
    .find((row) => !allowedObjects.has(String(row.name)));
  if (extra) throw new Error("Unexpected lifecycle effect storage dependency.");
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'execution_lifecycle_effects'").all()) {
    const name = String(row.name).replaceAll('"', '""');
    if (database.prepare(`PRAGMA foreign_key_list("${name}")`).all().some((key) => key.table === "execution_lifecycle_effects")) {
      throw new Error("Unexpected lifecycle effect storage dependency.");
    }
  }
}

/** Read-only compatibility gate used before WAL conversion and again inside migration. */
export function validateRuntimeFailureEffectMigrationSource(database: DatabaseSync): 22 | 23 {
  let version: 22 | 23 = 22;
  try { validateExecutionStorageSchema(database, 22); }
  catch {
    validateExecutionStorageSchema(database, 23);
    version = 23;
  }
  validateLifecycleEffectDependencies(database);
  if (hasMissingLifecycleDisposition(database)) {
    throw new Error("Current lifecycle effect storage is missing a fact disposition.");
  }
  return version;
}

/** Add a durable hard-runtime-failure disposition without replaying old facts. */
export function migrateExecutionStorageV22ToV23(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Runtime failure effect storage migration requires a transaction.");
  if (validateRuntimeFailureEffectMigrationSource(database) === 23) return;
  database.exec(`
    PRAGMA defer_foreign_keys=ON;
    CREATE TEMP TABLE execution_lifecycle_effect_migration AS
      SELECT rowid AS original_rowid,* FROM execution_lifecycle_effects;
    DROP TABLE execution_lifecycle_effects;
    ${lifecycleEffectsTableV23};
    INSERT INTO execution_lifecycle_effects(
      rowid,fact_id,fact_sequence,agent_id,observer_execution_generation_id,observer_runtime_generation_id,
      observer_epoch,subject_authority_mode,observer_authority_mode,effect_kind,state,created_at_ms,disposed_at_ms)
    SELECT original_rowid,fact_id,fact_sequence,agent_id,observer_execution_generation_id,observer_runtime_generation_id,
      observer_epoch,subject_authority_mode,observer_authority_mode,effect_kind,state,created_at_ms,disposed_at_ms
    FROM execution_lifecycle_effect_migration;
    DROP TABLE execution_lifecycle_effect_migration;
  `);
  for (const statement of Object.values(lifecycleEffectIndexes)) database.exec(statement);
  for (const statement of Object.values(lifecycleEffectTriggers)) database.exec(statement);
  validateExecutionStorageSchema(database, 23);
}

function validateDelegationV24MigrationDependencies(database: DatabaseSync): void {
  const allowedObjects = new Map<string, Set<string>>([
    ["execution_local_delegations", new Set([
      "execution_delegation_scope_immutable",
      "execution_delegation_revocation_final",
    ])],
    ["execution_approval_decisions", new Set(["execution_approval_decision_immutable"])],
  ]);
  for (const [table, allowed] of allowedObjects) {
    const extra = (database.prepare(`SELECT name FROM sqlite_master
      WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL`).all(table))
      .find((row) => !allowed.has(String(row.name)));
    if (extra) throw new Error("Unexpected execution delegation storage dependency.");
  }
  for (const row of database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT IN ('execution_local_delegations','execution_approval_decisions')`).all()) {
    const name = String(row.name).replaceAll('"', '""');
    const referencesRebuiltTable = database.prepare(`PRAGMA foreign_key_list("${name}")`).all()
      .some((key) => key.table === "execution_local_delegations" || key.table === "execution_approval_decisions");
    if (referencesRebuiltTable) throw new Error("Unexpected execution delegation storage dependency.");
  }
}

/**
 * Remove mutable aliases from the local authority key. V23 delegation rows
 * cannot be upgraded honestly: they lack the agent alias and no shipped
 * reconciliation lane proved their digest came from the server. The lane was
 * dormant before V24, so any such row is refused instead of blessed.
 */
export function migrateExecutionStorageV23ToV24(database: DatabaseSync): void {
  if (!database.isTransaction) throw new Error("Execution delegation storage migration requires a transaction.");
  validateExecutionStorageSchema(database, 23);
  validateDelegationV24MigrationDependencies(database);
  if (database.prepare("SELECT 1 FROM execution_local_delegations LIMIT 1").get()
    || database.prepare("SELECT 1 FROM execution_approval_decisions WHERE source='delegate' LIMIT 1").get()) {
    throw new Error("Unverifiable dormant execution delegation authority cannot be migrated.");
  }
  database.exec(`
    PRAGMA defer_foreign_keys=ON;
    CREATE TEMP TABLE execution_approval_decision_v24_migration AS
      SELECT rowid AS original_rowid,* FROM execution_approval_decisions;
    DROP TABLE execution_approval_decisions;
    DROP TABLE execution_local_delegations;
    ${executionLocalDelegationsV24};
    ${executionApprovalDecisionsV24};
    INSERT INTO execution_approval_decisions(
      rowid,decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,
      request_delegatable,request_sha256,decision,source,actor_id,delegation_instance_id,
      delegation_revision,delegation_scope_sha256,dispatch_state,dispatch_id,application_certainty,
      decided_at_ms,dispatch_started_at_ms,resolved_at_ms,projection_sha256)
    SELECT original_rowid,decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,
      request_delegatable,request_sha256,decision,source,actor_id,delegation_instance_id,
      delegation_revision,NULL,dispatch_state,dispatch_id,application_certainty,
      decided_at_ms,dispatch_started_at_ms,resolved_at_ms,projection_sha256
    FROM execution_approval_decision_v24_migration;
    DROP TABLE execution_approval_decision_v24_migration;
    ${delegationTriggersV24.execution_delegation_scope_immutable};
    ${triggers.execution_delegation_revocation_final};
    ${delegationTriggersV24.execution_approval_decision_immutable};
  `);
  validateExecutionStorageSchema(database, 24);
  if (database.prepare("PRAGMA foreign_key_check").get()) {
    throw new Error("Execution delegation storage migration broke ownership.");
  }
}

function normalizedSchema(sql: string): string {
  // SQL keywords/spacing are insensitive, but quoted CHECK values are not.
  return (sql.match(/'(?:''|[^'])*'|[^']+/g) ?? []).map((part) => part.startsWith("'") ? part
    : part.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "").replace(/\s+/g, "").toLowerCase()).join("").replace(/;$/, "");
}

/** Fail closed on weakened CHECKs, ownership FKs, indexes, or incompatible DDL. */
export function validateExecutionStorageSchema(database: DatabaseSync, version: ExecutionStorageSchemaVersion = 24): void {
  const schema = schemaFor(version);
  for (const [name, statement] of Object.entries({ ...schema.tables, ...schema.indexes, ...schema.triggers })) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type IN ('table','index','trigger')").get(name) as { sql: string } | undefined;
    if (!row || normalizedSchema(row.sql) !== normalizedSchema(statement)) throw new Error(`Execution storage schema mismatch: ${name}.`);
  }
  for (const name of Object.keys(schema.tables)) {
    if (database.prepare(`PRAGMA foreign_key_check(${name})`).get()) throw new Error(`Execution storage ownership mismatch: ${name}.`);
  }
}
