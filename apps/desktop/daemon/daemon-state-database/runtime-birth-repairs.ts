/** Local room membership shape, legacy runtime-birth freezes and the current configuration shape. */
import { applyManagedLaunchContractSchema } from "../managed-launch-contract.js";
import { applyHostToolRuleSchema } from "../host-tool-rules.js";
import { applyPreparedRoomContextSchema } from "../prepared-room-context.js";
import type { DatabaseSync } from "node:sqlite";
import { applyPollingActivationSchema, applyPollingOfferSchema, migratePollingOffersV25ToV26 } from "../custodial-polling-activation.js";
import { applyRoomWorkPublicationSchema } from "../room-work-publication-store.js";
import { applyExecutionApprovalPublicationSchema } from "../execution-approval-publication-store.js";
import { applyLifecycleProjectionLedgerSchema } from "../lifecycle-projection-ledger.js";
import { executionRuntimeStorageIdentity, materializeRuntimeIdentity } from "../execution-shadow-store.js";
import { lifecycleAuthorityModeForProvider } from "../lifecycle-authority-mode.js";
import { applyRuntimeRecoverySchema } from "../runtime-recovery-journal.js";
import { applyApprovalRequestClosureSchema } from "../execution-approval-journal.js";
import { applyWorkerExecutionBindings, type Row, POLLING_CONTRACT_COLUMN, CUSTODIAL_LAUNCH_SESSION_COLUMN, TERMINAL_RESULTS_INDEX, terminalResultsSql, validatePollingContract, validateCustodialLaunchSession, validateTerminalResults, schemaMethods } from "./shared.js";

export const runtimeBirthRepairs = schemaMethods({
/** Existing memberships stay cloud-backed. Never reconstruct a missing current authority column. */
applyLocalRoomMembershipShape(database: DatabaseSync): void {
  applyManagedLaunchContractSchema(database);
  applyWorkerExecutionBindings(database);
  applyHostToolRuleSchema(database);
  applyRuntimeRecoverySchema(database);
  applyApprovalRequestClosureSchema(database);
  applyPreparedRoomContextSchema(database);
  if (!this.tableColumns(database, "agent_room_memberships").has("local_room_id")) {
    database.exec("ALTER TABLE agent_room_memberships ADD COLUMN local_room_id TEXT CHECK (local_room_id IS NULL OR (length(trim(local_room_id)) > 0 AND local_room_id = room_id))");
  }
  this.validateLocalRoomMembershipShape(database);
},

validateLocalRoomMembershipShape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "agent_room_memberships").has("local_room_id")
    || database.prepare("SELECT 1 FROM agent_room_memberships WHERE local_room_id IS NOT NULL AND (local_room_id != room_id OR length(trim(local_room_id)) = 0) LIMIT 1").get()) {
    throw new Error("Daemon room transport identity is missing or invalid.");
  }
},

/** Caller owns the migration transaction and has already installed current execution/configuration shape. */
freezeLegacyActiveRuntimeBirths(database: DatabaseSync): void {
  const candidates = database.prepare(`SELECT
      d.agent_id,
      d.provider_execution_generation_id AS execution_generation_id,
      d.provider_connection_kind AS connection_kind,
      d.provider_connection_pid AS connection_pid,
      d.provider_process_identity AS process_identity,
      c.provider,
      c.runtime_configuration_revision AS config_revision
      FROM runtime_deployments d
      JOIN agent_configurations c USING(agent_id)
      JOIN work_attempt_executions w
        ON w.work_attempt_id=d.provider_work_attempt_id
       AND w.execution_generation_id=d.provider_execution_generation_id
      WHERE d.provider_ref_present=1
        AND d.work_attempt_id_present=1
        AND d.work_attempt_id=d.provider_work_attempt_id
        AND d.provider_work_attempt_id IS NOT NULL
        AND d.provider_continuation_id IS NOT NULL
        AND length(trim(d.provider_continuation_id))>0
        AND d.provider_execution_generation_id IS NOT NULL
        AND w.terminal_json IS NULL
        AND d.provider_connection_pid>0
        AND d.provider_process_identity_present=1
        AND d.provider_process_identity IS NOT NULL
        AND length(trim(d.provider_process_identity))>0
        AND c.runtime_configuration_revision>=1
        AND ((c.provider='codex' AND d.provider_connection_kind='codex_app_server')
          OR (c.provider='claude-code' AND d.provider_connection_kind='claude_cli')
          OR (c.provider='cursor' AND d.provider_connection_kind='cursor_cli')
          OR (c.provider='open-model' AND d.provider_connection_kind='opencode_server'))
      ORDER BY d.agent_id`).all() as Row[];
  for (const candidate of candidates) {
    const agentId = String(candidate.agent_id);
    const executionGenerationId = String(candidate.execution_generation_id);
    const connectionKind = String(candidate.connection_kind);
    const connectionPid = Number(candidate.connection_pid);
    const processIdentity = String(candidate.process_identity);
    materializeRuntimeIdentity(database, {
      agentId,
      executionGenerationId,
      runtimeGenerationId: executionRuntimeStorageIdentity(
        agentId,
        executionGenerationId,
        connectionKind,
        connectionPid,
        processIdentity,
      ),
      provider: String(candidate.provider) as "codex" | "claude-code" | "cursor" | "open-model",
      authorityMode: "legacy",
      configRevision: Number(candidate.config_revision),
      createdAtMs: 0,
    });
  }
  for (const candidate of candidates) {
    const runtimeGenerationId = executionRuntimeStorageIdentity(
      String(candidate.agent_id),
      String(candidate.execution_generation_id),
      String(candidate.connection_kind),
      Number(candidate.connection_pid),
      String(candidate.process_identity),
    );
    const frozen = database.prepare(`SELECT provider,config_revision,authority_mode
      FROM execution_runtime_generations
      WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?`).get(
      String(candidate.agent_id),
      String(candidate.execution_generation_id),
      runtimeGenerationId,
    ) as Row | undefined;
    if (!frozen
      || frozen.provider !== candidate.provider
      || Number(frozen.config_revision) !== Number(candidate.config_revision)
      || !["legacy", "typed_shadow", "typed"].includes(String(frozen.authority_mode))) {
      throw new Error("Daemon runtime-birth migration could not verify exact frozen authority.");
    }
  }
},

/**
 * A pre-typed Codex birth cannot be relabelled safely: its stream contract was
 * fixed when the native process started. Fence it before daemon startup can
 * attach, deliver, or restart work. Retirement keeps the manifest identity,
 * inspector history, work attempt, and workspace; Electron's existing stopped
 * entry reconciliation completes worker/grant revocation after the socket is up.
 */
retireIncompatibleCodexRuntimeBirths(database: DatabaseSync): void {
  const candidates = database.prepare(`SELECT
      d.agent_id,
      d.provider_execution_generation_id AS execution_generation_id,
      d.provider_connection_kind AS connection_kind,
      d.provider_connection_pid AS connection_pid,
      d.provider_process_identity_present AS process_identity_present,
      d.provider_process_identity AS process_identity,
      c.delivery_mode,
      c.runtime_configuration_revision AS config_revision
    FROM runtime_deployments d
    JOIN agent_configurations c USING(agent_id)
    WHERE c.provider='codex' AND d.provider_ref_present=1
      AND d.provider_work_attempt_id IS NOT NULL
    ORDER BY d.agent_id`).all() as Row[];
  const retiredAtMs = Date.now();
  const retiredAt = new Date(retiredAtMs).toISOString();
  for (const candidate of candidates) {
    const agentId = String(candidate.agent_id);
    const executionGenerationId = typeof candidate.execution_generation_id === "string"
      && candidate.execution_generation_id.trim() ? candidate.execution_generation_id : null;
    const connectionKind = candidate.connection_kind === "codex_app_server"
      ? candidate.connection_kind : null;
    const connectionPid = Number(candidate.connection_pid);
    const processIdentity = Number(candidate.process_identity_present) === 1
      && typeof candidate.process_identity === "string" && candidate.process_identity.trim()
      ? candidate.process_identity : null;
    const deliveryMode = candidate.delivery_mode;
    if (deliveryMode !== "mcp_polling" && deliveryMode !== "desktop_events" && deliveryMode !== "daemon_inbox") {
      throw new Error("Incompatible Codex birth has no valid durable delivery mode.");
    }
    // Defensive: every caller runs after the v49 rewrite, so a birth cannot
    // say "desktop_events" here any more; an old value still means polling.
    const expectedAuthorityMode = lifecycleAuthorityModeForProvider("codex", deliveryMode === "daemon_inbox" ? "daemon_inbox" : "mcp_polling");
    const configRevision = Number(candidate.config_revision);
    let compatible = false;
    if (executionGenerationId && connectionKind && Number.isSafeInteger(connectionPid)
      && connectionPid > 0 && processIdentity && Number.isSafeInteger(configRevision) && configRevision >= 1) {
      const runtimeGenerationId = executionRuntimeStorageIdentity(
        agentId,
        executionGenerationId,
        connectionKind,
        connectionPid,
        processIdentity,
      );
      const runtime = database.prepare(`SELECT provider,authority_mode,config_revision
        FROM execution_runtime_generations
        WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?`).get(
        agentId,
        executionGenerationId,
        runtimeGenerationId,
      ) as Row | undefined;
      compatible = runtime?.provider === "codex"
        && runtime.authority_mode === expectedAuthorityMode
        && Number(runtime.config_revision) === configRevision;
    }
    if (compatible) continue;

    const stopped = database.prepare("UPDATE agent_launch_intents SET desired_state='stopped' WHERE agent_id=?")
      .run(agentId);
    if (Number(stopped.changes) !== 1) {
      throw new Error("Incompatible Codex birth has no durable launch intent to retire.");
    }

    database.prepare(`UPDATE execution_approval_decisions
      SET dispatch_state='lost',
        application_certainty=CASE WHEN dispatch_id IS NULL THEN 'impossible' ELSE 'unknown' END,
        resolved_at_ms=MAX(decided_at_ms,?)
      WHERE agent_id=? AND dispatch_state NOT IN ('acknowledged','lost')`).run(retiredAtMs, agentId);
    database.prepare(`UPDATE execution_approval_requests
      SET state='lost',application_certainty=COALESCE((
        SELECT d.application_certainty FROM execution_approval_decisions d
        WHERE d.request_id=execution_approval_requests.request_id
          AND d.request_version=execution_approval_requests.request_version
      ),'impossible')
      WHERE agent_id=? AND state NOT IN ('resolved','superseded','lost')`).run(agentId);
    database.prepare(`UPDATE execution_turns
      SET state='lost',ended_at_ms=MAX(created_at_ms,?)
      WHERE agent_id=? AND state='active'`).run(retiredAtMs, agentId);
    database.prepare(`UPDATE execution_message_attempts
      SET state='lost',conclusion='lost',settled_at_ms=MAX(created_at_ms,?)
      WHERE agent_id=? AND state='active'`).run(retiredAtMs, agentId);
    database.prepare(`INSERT INTO supervised_agent_inbox_events
        (inbox_item_id,event_sequence,idempotency_key,phase,observed_at,detail)
      SELECT i.inbox_item_id,
        COALESCE((SELECT MAX(e.event_sequence) FROM supervised_agent_inbox_events e
          WHERE e.inbox_item_id=i.inbox_item_id),0)+1,
        'v33_incompatible_codex_birth_retired','no_reply',?,
        'Upgrade retired an incompatible Codex runtime birth; provider work was not replayed.'
      FROM supervised_agent_inbox i
      WHERE i.agent_id=?
        AND i.state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')
        AND NOT EXISTS (SELECT 1 FROM supervised_agent_inbox_events e
          WHERE e.inbox_item_id=i.inbox_item_id
            AND e.idempotency_key='v33_incompatible_codex_birth_retired')`).run(retiredAt, agentId);
    database.prepare(`UPDATE supervised_agent_inbox
      SET state='acknowledged_no_reply',outcome=NULL,failure_code=NULL,
        terminal_reason='upgrade_authority_unavailable',
        last_error='Upgrade retired this Codex runtime because its frozen lifecycle authority is incompatible; provider work was not replayed.',
        blocked_by_inbox_item_id=NULL,next_attempt_at_ms=NULL,
        updated_at=?,acknowledged_at=COALESCE(acknowledged_at,?)
      WHERE agent_id=?
        AND state NOT IN ('acknowledged','acknowledged_no_reply','acknowledged_failed','cancelled_by_room_move','cancelled_by_user')`)
      .run(retiredAt, retiredAt, agentId);
  }
},

/** Every legacy caller advances directly to the current paired version. */
applyCurrentConfigurationShape(database: DatabaseSync): void {
  if (!this.tableColumns(database, "agent_configurations").has("polling_contract")) {
    database.exec(`ALTER TABLE agent_configurations ADD COLUMN ${POLLING_CONTRACT_COLUMN}`);
  }
  validatePollingContract(database);
  if (!this.tableColumns(database, "runtime_deployments").has("custodial_launch_agent_session_id")) {
    database.exec(`ALTER TABLE runtime_deployments ADD COLUMN ${CUSTODIAL_LAUNCH_SESSION_COLUMN}`);
  }
  validateCustodialLaunchSession(database);
  if (this.tableColumns(database, "custodial_polling_activations").size
    && !this.tableColumns(database, "custodial_polling_activations").has("compacted_through_offer_id")) {
    applyPollingActivationSchema(database, 24);
    applyPollingOfferSchema(database, 25);
    migratePollingOffersV25ToV26(database);
  } else {
    applyPollingActivationSchema(database);
    applyPollingOfferSchema(database);
  }
  applyRoomWorkPublicationSchema(database);
  applyExecutionApprovalPublicationSchema(database);
  applyLifecycleProjectionLedgerSchema(database);
  this.freezeLegacyActiveRuntimeBirths(database);
  this.retireIncompatibleCodexRuntimeBirths(database);
},

applyV20Shape(database: DatabaseSync): void {
  if (validateTerminalResults(database) === 20) return;
  database.exec(`
    ${terminalResultsSql(20, "supervised_agent_terminal_results_v20")};
    INSERT INTO supervised_agent_terminal_results_v20(rowid,inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at)
      SELECT rowid,inbox_item_id,agent_id,execution_generation_id,provider_turn_id,outcome,normalized_text,evidence_source,terminal_evidence_json,observed_at,updated_at FROM supervised_agent_terminal_results;
    DROP TABLE supervised_agent_terminal_results;
    ALTER TABLE supervised_agent_terminal_results_v20 RENAME TO supervised_agent_terminal_results;
    ${TERMINAL_RESULTS_INDEX};
  `);
  validateTerminalResults(database, 20);
},
});
