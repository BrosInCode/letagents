/** Row helpers, stored-row types, prepared reads and public activity types shared by the ManifestStore modules. */
import type { StatementSync } from "node:sqlite";
import { PENDING_RUNTIME_RECOVERY_SQL } from "../runtime-recovery-journal.js";
import { composeDaemonManifestEntry, projectDaemonManifestEntry } from "../manifest-entry-projection.js";
import type { DaemonActivityEvent, DaemonAgentConfiguration, DaemonManifestEntry, DaemonPurgePhase, DaemonPurgeRecord, DaemonPurgeWorkerSessionAttestation, DaemonRoomMovePhase, DaemonRoomMoveRecord, ObservedState, PolicyCondition, ReconciliationNotice, ReconciliationState } from "../types.js";
import type { ManifestStore } from "./store.js";

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
export type StoredAgentConfiguration = { provider: string; model: string | null; reasoning_effort: DaemonAgentConfiguration["reasoning_effort"]; charter: string; permission_profile_id: string | null; provider_launch_policy: unknown; config_revision: number; runtime_configuration_revision: number; delivery_mode: "daemon_inbox"; image_input: boolean; live_sharing: LiveSharingState };
export type LiveSharingState = "off" | "on" | "withdrawing";
/** Anything but a known state reads as off. */
export function liveSharingState(value: unknown): LiveSharingState {
  return value === "on" || value === "withdrawing" ? value : "off";
}
export type PreMembershipRoomMoveCancellation = { agentId: string; detail: string };
/** Targeted observed-state / reconciliation transition persisted without touching activity_events. */
export type ManifestTransitionCommit = {
  agentId: string;
  observedState: ObservedState;
  condition: PolicyCondition;
  lastError: string | null;
  readyReachedAt?: string | null;
  reconciliation: ReconciliationState;
  reconciliationNotices: ReconciliationNotice[];
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

export class ManifestConflictError extends Error {}

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

export function canonicalManifestEntry(entry: DaemonManifestEntry): DaemonManifestEntry {
  return composeDaemonManifestEntry(projectDaemonManifestEntry(normalizeManifestEntry(entry)));
}

export function run(statement: StatementSync, ...values: unknown[]): void {
  statement.run(...values as never[]);
}

export const MANIFEST_READS = {
  allEntries: "SELECT * FROM agents ORDER BY sort_order",
  entryIds: "SELECT agent_id FROM agents ORDER BY sort_order",
  unresolvedTurnControlAgentIds: `SELECT agent_id FROM agents
    WHERE turn_control_json IS NOT NULL
      AND (turn_control_status IS NULL OR turn_control_status <> 'completed')
    ORDER BY sort_order`,
  entryVersion: "SELECT version FROM agents WHERE agent_id = ?",
  agentManifestVersions: "SELECT agent_id, manifest_version FROM agent_state_versions",
  roomEntries: "SELECT * FROM agents WHERE room_id = ? ORDER BY sort_order",
  entry: "SELECT * FROM agents WHERE agent_id = ?",
  activityState: `SELECT version, observed_state,
    (SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT 1) AS last_sequence
    FROM agents WHERE agent_id = ?`,
  activity: "SELECT * FROM activity_events WHERE agent_id = ? ORDER BY sort_order",
  activitySummary: `SELECT observed_at, sequence, provider, kind, method, summary, status,
    NULL AS payload_json, payload_truncated, payload_redacted, durable_payload_ref
    FROM activity_events WHERE agent_id = ? ORDER BY sequence DESC, sort_order DESC LIMIT ?`,
  lastSequence: "SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order DESC LIMIT 1",
  // TOTAL, not SUM: a sum of large sequences must never fail the read.
  activityShape: `SELECT COUNT(*) AS count, TOTAL(sequence) AS sequence_total,
    (SELECT sequence FROM activity_events WHERE agent_id = ? ORDER BY sort_order LIMIT 1) AS first_sequence
    FROM activity_events WHERE agent_id = ?`,
  agentConfiguration: `SELECT provider,model,reasoning_effort,charter,permission_profile_id,provider_launch_policy_json,config_revision,runtime_configuration_revision,image_input,live_sharing FROM agents WHERE agent_id=?`,
  pendingRuntimeRecovery: PENDING_RUNTIME_RECOVERY_SQL,
} as const;

/** Types an object of ManifestStore methods; `this` is the composed store instance. */
export function storeMethods<T>(methods: T & ThisType<ManifestStore>): T { return methods; }
