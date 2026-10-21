/** Row helpers, stored-row types, prepared reads and public activity types shared by the ManifestStore modules. */
import { namesHomeHarness, withoutHomeHarness } from "../provider-configuration.js";
import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import { PENDING_RUNTIME_RECOVERY_SQL } from "../runtime-recovery-journal.js";
import { composeDaemonManifestEntry, projectDaemonManifestEntry } from "../manifest-entry-projection.js";
import type { DaemonActivityEvent, DaemonAgentConfiguration, DaemonManifest, DaemonManifestEntry, DaemonProviderConnection, DaemonPurgePhase, DaemonPurgeRecord, DaemonPurgeWorkerSessionAttestation, DaemonRoomMovePhase, DaemonRoomMoveRecord } from "../types.js";
import type { ManifestStore } from "./store.js";

export type StoredManifest = { manifest: DaemonManifest; checksum: string };
export type Row = Record<string, unknown>;

/** The runtime fields a native activity event may set on its entry. */
export type ActivityRuntimeUpdate = {
  observedState: DaemonManifestEntry["observed_state"];
  nativeLiveness: NonNullable<DaemonManifestEntry["native_liveness"]>;
};

/** One admitted activity event waiting to be written. */
export type ActivityWrite = {
  agentId: string;
  event: DaemonActivityEvent;
  runtimeUpdate: ActivityRuntimeUpdate | null;
  limit: number;
};
/** One event a batch wrote, exactly as a later full read returns it. */
export type CommittedActivityWrite = { agentId: string; event: DaemonActivityEvent; limit: number; bytes: number };
/**
 * The shape of one entry's whole stored activity, read from the activity
 * index without payloads: enough to tell whether a copy of it is current.
 */
export type ActivityShape = { count: number; sequenceTotal: number; firstSequence: number | null };
export type StoredAgentConfiguration = { provider: string; model: string | null; reasoning_effort: DaemonAgentConfiguration["reasoning_effort"]; charter: string; permission_profile_id: string | null; provider_launch_policy: unknown; config_revision: number; runtime_configuration_revision: number; polling_contract: DaemonAgentConfiguration["polling_contract"]; delivery_mode: string; image_input: boolean; live_sharing: LiveSharingState };
export type LiveSharingState = "off" | "on" | "withdrawing";
/** Anything but a known state reads as off. */
export function liveSharingState(value: unknown): LiveSharingState {
  return value === "on" || value === "withdrawing" ? value : "off";
}
export type PreMembershipRoomMoveCancellation = { agentId: string; detail: string };
export type PendingTypedLifecycleEffect = {
  factId: string; agentId: string; factSequence: number;
  observerExecutionGenerationId: string; observerRuntimeGenerationId: string;
  effectKind: "manifest_working" | "manifest_idle" | "manifest_failed"; observedAtMs: number;
};
export type TypedLifecycleEffectInstallation = {
  agentId: string; executionGenerationId: string; workAttemptId: string;
  providerContinuationId: string; providerConnection: DaemonProviderConnection;
  configurationRevision: number; authorityMode: "typed"; disposedAtMs: number;
};

export function roomMoveFromRow(row: Row): DaemonRoomMoveRecord {
  return {
    operation_id: String(row.operation_id), request_id: String(row.request_id), agent_id: String(row.agent_id),
    source_room_id: String(row.source_room_id), destination_room_id: String(row.destination_room_id), daemon_generation: Number(row.daemon_generation),
    work_attempt_id: nullableString(row.work_attempt_id), execution_generation_id: nullableString(row.execution_generation_id), agent_session_id: nullableString(row.agent_session_id),
    activating_inbox_item_id: nullableString(row.activating_inbox_item_id), provider_turn_id: nullableString(row.provider_turn_id), effect_id: nullableString(row.effect_id),
    phase: String(row.phase) as DaemonRoomMovePhase, remote_room_id: nullableString(row.remote_room_id), destination_cursor: nullableString(row.destination_cursor),
    source_credentials_revoked: bool(row.source_credentials_revoked),
    source_cursor_present: bool(row.source_cursor_present), source_cursor: nullableString(row.source_cursor),
    error: nullableString(row.error), created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

export function purgeFromRow(row: Row): DaemonPurgeRecord {
  return {
    operation_id: String(row.operation_id), request_id: String(row.request_id), agent_id: String(row.agent_id),
    daemon_generation: Number(row.daemon_generation), phase: String(row.phase) as DaemonPurgePhase,
    external_revoke_required: bool(row.external_revoke_required), attached_work_attempt_id: nullableString(row.attached_work_attempt_id),
    preserved_workspace_path: nullableString(row.preserved_workspace_path),
    worker_session_attestation: String(row.worker_session_attestation) as DaemonPurgeWorkerSessionAttestation,
    agent_session_id: nullableString(row.agent_session_id),
    error: nullableString(row.error),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

/**
 * This is the version for the *entire* daemon-state database, not only the
 * manifest projection.  Other durable stores deliberately go through this
 * initializer so two connections cannot race independent user_version owners.
 */
export class ManifestConflictError extends Error {}

export function checksum(manifest: DaemonManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function bool(value: unknown): boolean {
  return Number(value) === 1;
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("SQLite manifest JSON payloads must be JSON-serializable.");
  return encoded;
}

export function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function activityEventFromRow(event: Row, payload: unknown): DaemonActivityEvent {
  return {
    observed_at: String(event.observed_at), sequence: Number(event.sequence), provider: String(event.provider),
    kind: String(event.kind), method: String(event.method), summary: String(event.summary),
    status: String(event.status) as DaemonActivityEvent["status"], payload,
    payload_truncated: bool(event.payload_truncated), payload_redacted: bool(event.payload_redacted),
    durable_payload_ref: nullableString(event.durable_payload_ref),
  };
}

/**
 * A JSON-normalized event as appendActivityEvent stores it and a full read
 * returns it. Its payload is already a JSON value, so it is kept as is.
 */
export function committedActivityEvent(event: DaemonActivityEvent): DaemonActivityEvent {
  return activityEventFromRow({
    observed_at: event.observed_at, sequence: event.sequence, provider: event.provider, kind: event.kind,
    method: event.method, summary: event.summary, status: event.status,
    payload_truncated: Number(event.payload_truncated), payload_redacted: Number(event.payload_redacted),
    durable_payload_ref: event.durable_payload_ref,
  } as Row, event.payload);
}

export function normalizeManifestEntry(entry: DaemonManifestEntry): DaemonManifestEntry {
  return JSON.parse(JSON.stringify(entry)) as DaemonManifestEntry;
}

export function importedWithoutHomeHarness(entry: DaemonManifestEntry): DaemonManifestEntry {
  return namesHomeHarness(entry.provider_launch_policy)
    ? { ...entry, provider_launch_policy: withoutHomeHarness(entry.provider_launch_policy) }
    : entry;
}

export function canonicalManifestEntry(entry: DaemonManifestEntry): DaemonManifestEntry {
  return composeDaemonManifestEntry(projectDaemonManifestEntry(normalizeManifestEntry(entry)));
}

export function run(statement: StatementSync, ...values: unknown[]): void {
  statement.run(...values as never[]);
}

export const MANIFEST_ENTRY_SELECT = `
      SELECT
        i.agent_id, i.created_by, i.created_at,
        p.display_name, m.room_id, m.local_room_id,
        c.provider, c.model, c.reasoning_effort, c.charter, c.permission_profile_id, c.config_revision, c.runtime_configuration_revision, c.delivery_mode, c.delivery_cutover_json,
        c.provider_launch_policy_present, c.provider_launch_policy_undefined, c.provider_launch_policy_json,
        l.desired_state, l.source_repo_path_present, l.source_repo_path,
        d.deployment_id, d.run_id, d.observed_state,
        d.workspace_path_present, d.workspace_path,
        d.work_attempt_id_present, d.work_attempt_id,
        d.provider_ref_present, d.provider_work_attempt_id, d.provider_continuation_id,
        d.provider_connection_kind, d.provider_connection_url, d.provider_server_auth_path,
        d.provider_connection_pid,
        d.provider_process_identity_present,
        d.provider_process_identity, d.provider_execution_generation_id, d.custodial_launch_agent_session_id,
        d.workplace_liveness_present, d.workplace_liveness_state,
        d.workplace_liveness_observed_at, d.workplace_liveness_detail,
        d.native_liveness_present, d.native_liveness_state,
        d.native_liveness_observed_at, d.native_liveness_detail,
        d.activity_present,
        s.condition, s.last_error_present, s.last_error,
        r.ready_reached_at_present, r.ready_reached_at,
        COALESCE(w.last_sequence,0) AS last_turn_control_sequence,
        t.turn_control_present, t.action_id, t.action_sequence, t.turn_work_attempt_id,
        t.turn_execution_generation_id, t.target_room_id, t.target_source_message_id,
        t.target_provider_continuation_id, t.has_correction, t.status AS turn_status,
        t.inbox_item_id, t.provider_turn_id, t.correction_text, t.correction_strategy, t.operator_resolution,
        t.capability, t.interrupted, t.resumed, t.turn_state, t.error AS turn_error,
        t.recorded_at, t.updated_at,
        b.last_worker_binding_present, b.binding_agent_session_id,
        b.binding_work_attempt_id, b.binding_execution_generation_id, b.binding_updated_at,
        q.reconciliation_present, q.consecutive_action_failures,
        q.last_observed_state, q.next_restart_at_ms, q.last_action_sequence,
        q.pending_action_id, q.pending_action_sequence, q.pending_action_kind,
        q.pending_action_recorded_at_ms, q.last_terminal_present,
        q.terminal_ended_at, q.terminal_exit_code, q.terminal_signal,
        q.terminal_stdio_archive_ref, q.terminal_stdio_tail, q.terminal_cause,
        q.terminal_actor, q.terminal_generation, q.terminal_provider_continuation_id,
        q.reconciliation_notices_present
      FROM agent_identities i
      JOIN agent_profiles p USING (agent_id)
      JOIN agent_room_memberships m USING (agent_id)
      JOIN agent_configurations c USING (agent_id)
      JOIN agent_launch_intents l USING (agent_id)
      JOIN runtime_deployments d USING (agent_id)
      JOIN agent_lifecycle_states s USING (agent_id)
      JOIN agent_readiness r USING (agent_id)
      JOIN turn_control_journals t USING (agent_id)
      LEFT JOIN turn_control_sequence_watermarks w USING (agent_id)
      JOIN retained_worker_bindings b USING (agent_id)
      JOIN reconciliation_records q USING (agent_id)
`;

export const MANIFEST_READS = {
  generation: "SELECT generation FROM manifest_metadata WHERE singleton = 1",
  allEntries: `${MANIFEST_ENTRY_SELECT} ORDER BY i.sort_order`,
  roomEntries: `${MANIFEST_ENTRY_SELECT} WHERE m.room_id = ? ORDER BY i.sort_order`,
  entry: `${MANIFEST_ENTRY_SELECT} WHERE i.agent_id = ?`,
  activityState: `SELECT observed_state,
    (SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT 1) AS last_sequence
    FROM runtime_deployments WHERE agent_id = ?`,
  activity: "SELECT * FROM activity_events WHERE agent_id = ? ORDER BY sort_order",
  activitySummary: `SELECT observed_at, sequence, provider, kind, method, summary, status,
    NULL AS payload_json, payload_truncated, payload_redacted, durable_payload_ref
    FROM activity_events WHERE agent_id = ? ORDER BY sequence DESC, sort_order DESC LIMIT ?`,
  lastSequence: "SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT 1",
  // TOTAL, not SUM: a sum of large sequences must never fail the read.
  activityShape: `SELECT COUNT(*) AS count, TOTAL(sequence) AS sequence_total,
    (SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order LIMIT 1) AS first_sequence
    FROM activity_events WHERE agent_id = ?`,
  stages: "SELECT stage FROM turn_control_stages WHERE agent_id = ? ORDER BY sort_order",
  completedActions: `SELECT action_id FROM reconciliation_completed_actions
    WHERE agent_id = ? ORDER BY sort_order DESC LIMIT ?`,
  exitTimestamps: "SELECT timestamp_ms FROM reconciliation_exit_timestamps WHERE agent_id = ? ORDER BY sort_order",
  notices: "SELECT * FROM reconciliation_notices WHERE agent_id = ? ORDER BY sort_order",
  agentConfiguration: `SELECT provider,model,reasoning_effort,charter,permission_profile_id,provider_launch_policy_present,provider_launch_policy_undefined,provider_launch_policy_json,config_revision,runtime_configuration_revision,polling_contract,delivery_mode,image_input,live_sharing FROM agent_configurations WHERE agent_id=?`,
  pendingRuntimeRecovery: PENDING_RUNTIME_RECOVERY_SQL,
} as const;

/** Types an object of ManifestStore methods; `this` is the composed store instance. */
export function storeMethods<T>(methods: T & ThisType<ManifestStore>): T { return methods; }
