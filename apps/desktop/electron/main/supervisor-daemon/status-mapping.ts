import type { DesktopSupervisorDaemonStatus, DesktopSupervisorLegacyStateReset } from "../../ipc-types.js";
import { booleanField } from "./wire-values.js";

function mapLegacyStateReset(value: unknown): DesktopSupervisorLegacyStateReset | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.reset_at !== "string"
    || typeof record.backup_name !== "string"
    || typeof record.legacy_schema_version !== "number"
    || !Number.isSafeInteger(record.legacy_schema_version)
    || record.legacy_schema_version < 0) {
    return null;
  }
  return {
    resetAt: record.reset_at,
    backupName: record.backup_name,
    legacySchemaVersion: record.legacy_schema_version,
    preservedRoomOnlyWorkspaces: record.preserved_room_only_workspaces === true,
    preservedReviewArchives: record.preserved_review_archives === true,
  };
}

export function mapStatus(value: Record<string, unknown>): DesktopSupervisorDaemonStatus {
  const legacyStateReset = mapLegacyStateReset(value.legacy_state_reset);
  return {
    healthy: value.healthy === true,
    protocolVersion: Number(value.protocol_version ?? 0),
    implementationVersion: String(value.implementation_version ?? "unknown"),
    capabilities: {
      roomDeliveryRetry: booleanField(value.capabilities, "room_delivery_retry"),
      providerContinuationRepair: booleanField(value.capabilities, "provider_continuation_repair"),
      roomDeliverySkip: booleanField(value.capabilities, "room_delivery_skip"),
      agentInspectorDetail: booleanField(value.capabilities, "agent_inspector_detail_v1"),
      agentInspectorSettings: booleanField(value.capabilities, "agent_inspector_settings_v1"),
      agentRoomMove: booleanField(value.capabilities, "agent_room_move_v1"),
      agentLifecycle: booleanField(value.capabilities, "agent_lifecycle_v1"),
      agentRuntimeRecovery: booleanField(value.capabilities, "agent_runtime_recovery_v1"),
      agentRuntimeRecoveryV2: booleanField(value.capabilities, "agent_runtime_recovery_v2"),
      agentStateSubscription: booleanField(value.capabilities, "agent_state_subscription_v1"),
      agentActivityStream: booleanField(value.capabilities, "agent_activity_stream_v1"),
    },
    generation: Number(value.generation ?? 0),
    pid: Number(value.pid ?? 0),
    startedAt: String(value.started_at ?? ""),
    maintenanceHoldId: typeof value.maintenance_hold_id === "string" ? value.maintenance_hold_id : null,
    ...(legacyStateReset ? { legacyStateReset } : {}),
  };
}
