import type {
  DesktopSupervisorDaemonStatus,
  DesktopLifecycleCaptureAdmissionStatus,
  DesktopLifecycleProjectionDiagnostics,
  DesktopLifecycleProjectionProvider,
} from "../../ipc-types.js";
import { booleanField, enumValue, record } from "./wire-values.js";

export function mapStatus(value: Record<string, unknown>): DesktopSupervisorDaemonStatus {
  const rawRecoveryDiagnostics = record(value.recovery_diagnostics);
  const daemonInboxWaitEvidenceDependency = rawRecoveryDiagnostics?.daemon_inbox_wait_evidence_dependency;
  const lifecycleProjection = mapLifecycleProjectionDiagnostics(rawRecoveryDiagnostics?.lifecycle_projection);
  const lifecycleCaptureAdmission = mapLifecycleCaptureAdmission(
    rawRecoveryDiagnostics?.lifecycle_capture_admission,
  );
  const lifecycleLocalConformanceEligible = mapLifecycleLocalConformanceEligibility(
    rawRecoveryDiagnostics?.lifecycle_local_conformance_eligible,
  );
  const eligibilityClaimsAreSupported = lifecycleProjection && lifecycleCaptureAdmission && lifecycleLocalConformanceEligible
    ? lifecycleProjectionProviders.every((provider) => !lifecycleLocalConformanceEligible[provider]
      || lifecycleProjectionSupportsLocalConformance(
        lifecycleProjection,
        provider,
        daemonInboxWaitEvidenceDependency,
        lifecycleCaptureAdmission,
      ))
    : false;
  const recoveryDiagnostics = Number.isSafeInteger(daemonInboxWaitEvidenceDependency)
    && (daemonInboxWaitEvidenceDependency as number) >= 0
    && lifecycleProjection
    && lifecycleCaptureAdmission
    && lifecycleLocalConformanceEligible
    && eligibilityClaimsAreSupported
    ? {
        daemonInboxWaitEvidenceDependency: daemonInboxWaitEvidenceDependency as number,
        lifecycleProjection,
        lifecycleCaptureAdmission,
        lifecycleLocalConformanceEligible,
      }
    : null;
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
    recoveryDiagnostics,
  };
}

const lifecycleProjectionProviders = ["codex", "claude-code", "cursor", "open-model"] as const;
const lifecycleProjectionCounterKeys = [
  "comparedSegments",
  "matched",
  "missingInTyped",
  "missingInLegacy",
  "pairedButDifferent",
  "conflicts",
  "observationUnavailable",
] as const;

function mapLifecycleProjectionDiagnostics(value: unknown): DesktopLifecycleProjectionDiagnostics | null {
  const projection = record(value);
  const providers = record(projection?.providers);
  if (!projection || typeof projection.available !== "boolean" || !providers) return null;
  const mapped = {} as DesktopLifecycleProjectionDiagnostics["providers"];
  for (const provider of lifecycleProjectionProviders) {
    const source = record(providers[provider]);
    if (!source) return null;
    const counters = {} as DesktopLifecycleProjectionDiagnostics["providers"][DesktopLifecycleProjectionProvider];
    for (const key of lifecycleProjectionCounterKeys) {
      const counter = source[key];
      if (!Number.isSafeInteger(counter) || (counter as number) < 0) return null;
      counters[key] = counter as number;
    }
    mapped[provider] = counters;
  }
  return { available: projection.available, providers: mapped };
}

function mapLifecycleLocalConformanceEligibility(
  value: unknown,
): Record<DesktopLifecycleProjectionProvider, boolean> | null {
  const source = record(value);
  if (!source) return null;
  const mapped = {} as Record<DesktopLifecycleProjectionProvider, boolean>;
  for (const provider of lifecycleProjectionProviders) {
    if (typeof source[provider] !== "boolean") return null;
    mapped[provider] = source[provider];
  }
  return mapped;
}

function mapLifecycleCaptureAdmission(
  value: unknown,
): Record<DesktopLifecycleProjectionProvider, DesktopLifecycleCaptureAdmissionStatus> | null {
  const source = record(value);
  if (!source) return null;
  const mapped = {} as Record<DesktopLifecycleProjectionProvider, DesktopLifecycleCaptureAdmissionStatus>;
  for (const provider of lifecycleProjectionProviders) {
    const status = enumValue(source[provider], ["pending", "ready", "unavailable"] as const);
    if (!status) return null;
    mapped[provider] = status;
  }
  return mapped;
}

function lifecycleProjectionSupportsLocalConformance(
  projection: DesktopLifecycleProjectionDiagnostics,
  provider: DesktopLifecycleProjectionProvider,
  daemonInboxWaitEvidenceDependency: unknown,
  captureAdmission: Record<DesktopLifecycleProjectionProvider, DesktopLifecycleCaptureAdmissionStatus>,
): boolean {
  const evidence = projection.providers[provider];
  return projection.available
    && daemonInboxWaitEvidenceDependency === 0
    && captureAdmission[provider] === "ready"
    && evidence.comparedSegments >= 1
    && evidence.missingInTyped === 0
    && evidence.missingInLegacy === 0
    && evidence.pairedButDifferent === 0
    && evidence.conflicts === 0
    && evidence.observationUnavailable === 0;
}
