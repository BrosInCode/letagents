import { inspectorUsageSchema } from "./agents/provider-usage.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { withDaemonMaintenanceOperation, readDaemonMaintenance, daemonMaintenancePath, DAEMON_MAINTENANCE_MESSAGE } from "../../../../shared/daemon-maintenance.mjs";
import { forceStopDaemon, waitForConfirmedDaemonExit } from "./force-daemon-restart.js";

import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorAttemptDetail,
  DesktopSupervisorCreateInput,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorDesiredState,
  DesktopLifecycleCaptureAdmissionStatus,
  DesktopLifecycleProjectionDiagnostics,
  DesktopLifecycleProjectionProvider,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorRoomDeliveryRetryInput,
  DesktopSupervisorStateSnapshot,
  DesktopSupervisorServiceSnapshot,
  DesktopSupervisorTurnControlInput,
  DesktopSupervisorTurnControlResolutionInput,
  DesktopSupervisorTurnControlResult,
} from "../ipc-types.js";
import { apiUrl, desktopRoot, workspaceRoot } from "./paths.js";
import {
  desktopRuntimeEnvironment,
  desktopShellEnvironmentReady,
} from "./desktop-shell-environment.js";
import { defaultGetProcessIdentity, redactCredentialText, safeStreamPayload } from "./agents/provider-evidence.js";
import { supervisedDeliveryModeForProvider } from "./agents/provider-registry.js";
import { LETAGENTS_MCP_RUNTIME_TREE_SHA256 } from "./agents/letagents-mcp-runtime.js";
import { prepareSupervisorState } from "./supervisor-state-recovery.js";
import { loadHostApprovalSigner, type HostApprovalSigner } from "./host-approval-auth.js";
import type { HostApprovalChallenge } from "../../shared/host-approval-auth.js";
import type { DesktopHostApproval, DesktopHostApprovalSnapshot, HostApprovalCandidate, HostApprovalSelection, HostApprovalStatus } from "../../shared/host-approvals.js";
import type { RetainedExecutionDetail } from "../../shared/execution-protocol.js";
import { SUPERVISOR_DAEMON_PROTOCOL_VERSION, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT, REQUEST_TIMEOUT_MS, MANIFEST_LIST_REQUEST_TIMEOUT_MS, CONFIGURATION_APPLY_REQUEST_TIMEOUT_MS, RETIRE_REQUEST_TIMEOUT_MS, BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS, INSTALL_HOST_GRANT_REQUEST_TIMEOUT_MS, RECOVERY_REQUEST_TIMEOUT_MS, HANDOFF_DRAIN_REQUEST_TIMEOUT_MS, TURN_CONTROL_REQUEST_TIMEOUT_MS, START_TIMEOUT_MS, NATURAL_EXIT_TIMEOUT_MS, TERMINATE_EXIT_TIMEOUT_MS, KILL_EXIT_TIMEOUT_MS, PROCESS_POLL_INTERVAL_MS } from "./supervisor-daemon/constants.js";
export { SUPERVISOR_DAEMON_PROTOCOL_VERSION, SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT, BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS } from "./supervisor-daemon/constants.js";
import type { WireResponse, WireEntry, WireActivityEvent, DaemonProcessState, DaemonProcessIdentity, DaemonIdentityInspection, RetiredDaemonObservation, DaemonHandoffDiagnostic, SupervisorDaemonLifecycleOptions } from "./supervisor-daemon/types.js";
export type { DaemonProcessState, DaemonProcessIdentity, DaemonHandoffDiagnostic, SupervisorDaemonLifecycleOptions } from "./supervisor-daemon/types.js";
import { SupervisorDaemonProtocolMismatchError, SupervisorDaemonRequestTimeoutError, isConnectionUnavailable } from "./supervisor-daemon/errors.js";
export { SupervisorDaemonProtocolMismatchError } from "./supervisor-daemon/errors.js";
import { defaultInspectDaemonProcess } from "./supervisor-daemon/process-identity.js";
export { defaultInspectDaemonProcess } from "./supervisor-daemon/process-identity.js";
import { appendDaemonLifecycleEvent } from "./supervisor-daemon/lifecycle-log.js";
import type { DesktopDaemonLifecycleEvent } from "./supervisor-daemon/lifecycle-log.js";
import { supervisorDaemonSpawnEnvironment, supervisorCompatibilityFingerprint, supervisorRuntimeEnvironmentFingerprint } from "./supervisor-daemon/spawn-environment.js";
export { supervisorDaemonSpawnEnvironment, supervisorCompatibilityFingerprint, supervisorRuntimeEnvironmentFingerprint } from "./supervisor-daemon/spawn-environment.js";
import { booleanField, record, nonEmptyString, validTurnControlActionId, nullableString, nullableNonEmptyString, enumValue } from "./supervisor-daemon/wire-values.js";
import type { UnknownRecord } from "./supervisor-daemon/wire-values.js";
import { mapStatus } from "./supervisor-daemon/status-mapping.js";
import { mapAgentConfiguration, mapRoomMove, mapAgentInspectorDetail } from "./supervisor-daemon/agent-mapping.js";
export { mapAgentInspectorDetail } from "./supervisor-daemon/agent-mapping.js";
import { mapEntry, mapActivity } from "./supervisor-daemon/entry-mapping.js";
export { mapEntry } from "./supervisor-daemon/entry-mapping.js";
import { STATE_WATCH_RETRY_BASE_MS, supervisorStateWatchRetryDelay, supervisorStateWatchAcceptsStatus } from "./supervisor-daemon/state-watch-policy.js";
export { supervisorStateWatchRetryDelay, supervisorStateWatchAcceptsStatus } from "./supervisor-daemon/state-watch-policy.js";
import { SupervisorDaemonClientBase } from "./supervisor-daemon/client-base.js";
import { SupervisorDaemonLifecycleClient } from "./supervisor-daemon/client-lifecycle.js";
import { SupervisorDaemonHostApprovalClient } from "./supervisor-daemon/client-host-approvals.js";

/**
 * While a focused agent's feed sits ended, re-poll at this cadence. The daemon
 * ends the feed when a provider generation exits but keeps the entry so the next
 * generation reopens it; this idle picks that reopen up without spinning against
 * a daemon that answers an ended feed immediately.
 */
const AGENT_STREAM_REOPEN_POLL_MS = 1_000;
const activityEmitter = new EventEmitter();
const stateEmitter = new EventEmitter();
const agentStreamEmitter = new EventEmitter();
let stateWatchOperation: Promise<void> | null = null;
let stateWatchUnsupportedGeneration: number | null = null;
/** Newest pushed manifest state; absent until the watch delivers one. */
let latestSupervisorState: DesktopSupervisorStateSnapshot | null = null;
/** The single agent whose live feed is currently subscribed (inspector focus). */
let focusedAgentStreamEntryId: string | null = null;
let focusedAgentStreamEpoch = 0;
let agentStreamWatchOperation: Promise<void> | null = null;
let agentStreamWatchAbortController: AbortController | null = null;

/** Main-process lifecycle signal. Renderer IPC never receives this hook. */
export function onSupervisorDaemonGeneration(
  listener: (status: DesktopSupervisorDaemonStatus) => void,
): () => void {
  return supervisorDaemonClient.onGeneration(listener);
}

export class SupervisorDaemonClient extends SupervisorDaemonHostApprovalClient {

  /** Troubleshooting observes the service without taking lifecycle ownership. */
  async getServiceSnapshot(): Promise<DesktopSupervisorServiceSnapshot> {
    const status = await this.connectIfRunning();
    let state: DesktopSupervisorStateSnapshot | null = null;
    if (status && !status.maintenanceHoldId && status.capabilities.agentStateSubscription
      && supervisorStateWatchAcceptsStatus(status)) {
      state = await this.watchState({ afterDaemonGeneration: 0, afterSequence: 0, waitMs: 0 });
      if (state.daemonGeneration !== status.generation) {
        throw new Error("The background service restarted during this read. Refresh to see its current state.");
      }
    }
    return { status, state, observedAt: this.now().toISOString() };
  }

  async list(roomIdentifier?: string | null): Promise<DesktopSupervisorManifestEntry[]> {
    await this.ensureRunning();
    // Rich manifest projections open several durable stores and can be slower
    // on their first read. This must not share the tight timeout used by small
    // control requests or a healthy cold daemon is misreported as unavailable.
    // manifest.list stays the full-history read: it backs first load, the
    // stale-subscription repair, and the Inspector's payload detail. It is also
    // the expensive one, so ask the daemon to project and serialize only the
    // room this caller will keep. The client-side filter stays as well: a
    // daemon that ignored the scope still yields a correct answer.
    const entries = await this.request<WireEntry[]>(
      "manifest.list",
      roomIdentifier ? { room_id: roomIdentifier } : undefined,
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      MANIFEST_LIST_REQUEST_TIMEOUT_MS,
    );
    return entries.map((entry) => mapEntry(entry)).filter((entry) => !roomIdentifier || entry.roomId === roomIdentifier);
  }

  async watchState(input: {
    afterDaemonGeneration: number;
    afterSequence: number;
    waitMs?: number;
  }): Promise<DesktopSupervisorStateSnapshot> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.request<{
      daemon_generation: number;
      sequence: number;
      entries: WireEntry[];
    }>("manifest.watch_state", {
      after_daemon_generation: input.afterDaemonGeneration,
      after_sequence: input.afterSequence,
      wait_ms: waitMs,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, waitMs + this.requestTimeoutMs, true);
    if (
      !Number.isSafeInteger(value.daemon_generation)
      || value.daemon_generation < 1
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 1
      || !Array.isArray(value.entries)
    ) {
      throw new Error("Supervisor daemon returned an invalid state snapshot.");
    }
    return {
      daemonGeneration: value.daemon_generation,
      sequence: value.sequence,
      entries: value.entries.map((entry) => mapEntry(entry, SUPERVISOR_STATE_ACTIVITY_SUMMARY_LIMIT)),
    };
  }

  async watchAgentStream(input: {
    entryId: string;
    afterSequence: number;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<{ sequence: number; streamGeneration: number; droppedEvents: number; events: import("../ipc-types/agents.js").DesktopAgentStreamEvent[]; ended: boolean }> {
    const waitMs = Math.max(0, Math.min(30_000, input.waitMs ?? 25_000));
    const value = await this.request<{
      sequence: number;
      stream_generation: number;
      dropped_events: number;
      events: Array<{ sequence: number; observed_at: string; kind: string; method: string; summary: string | null; payload: unknown }>;
      ended: boolean;
    }>("supervisor.watch_agent_stream", {
      entry_id: input.entryId,
      after_sequence: input.afterSequence,
      wait_ms: waitMs,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, waitMs + this.requestTimeoutMs, true, input.signal);
    return {
      sequence: Number(value.sequence ?? input.afterSequence),
      streamGeneration: Number(value.stream_generation ?? 0),
      droppedEvents: Number(value.dropped_events ?? 0),
      ended: value.ended === true,
      events: (Array.isArray(value.events) ? value.events : []).map((event) => ({
        sequence: Number(event.sequence),
        observedAt: String(event.observed_at ?? ""),
        kind: String(event.kind ?? ""),
        method: String(event.method ?? ""),
        summary: typeof event.summary === "string" ? event.summary : null,
        payload: event.payload,
      })),
    };
  }

  /**
   * Save a new supervised entry. A normal launch is saved as `running`: the
   * daemon starts the provider only once owner authority and room delivery
   * are installed, so the entry waits durably without a separate claim step.
   * A rental launch is saved `paused` and activated after the rental server
   * acknowledges provisioning.
   */
  async create(
    input: DesktopSupervisorCreateInput,
    options: { desiredState?: "running" | "paused" } = {},
  ): Promise<DesktopSupervisorManifestEntry> {
    if (!input.charter.trim()) throw new Error("A supervised agent initial message is required.");
    const creationRequestId = input.creationRequestId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(creationRequestId)) {
      throw new Error("A valid supervised agent creation request id is required.");
    }
    const now = this.now().toISOString();
    const entry: WireEntry = {
      id: `supervised_${creationRequestId}`,
      room_id: input.roomIdentifier,
      ...(input.localRoomId ? { local_room_id: input.localRoomId } : {}),
      display_name: input.displayName.trim() || "Supervised agent",
      provider: input.providerId,
      model: input.model?.trim() || null,
      charter: input.charter.trim(),
      desired_state: options.desiredState ?? "running",
      observed_state: "absent",
      condition: "none",
      permission_profile_id: input.permissionProfileId ?? null,
      // Admission declares the durable ingress owner independently from the
      // provider's opaque native launch policy. Provider descriptors opt into
      // daemon delivery only after their bounded-turn adapter is ready.
      delivery_mode: supervisedDeliveryModeForProvider(input.providerId),
      // A caller-supplied policy belongs to the selected native provider. Do
      // not reinterpret it as a LetAgents permission profile on its way to
      // the daemon. The Codex default remains only for the existing UI that
      // has not supplied an explicit provider policy yet.
      provider_launch_policy: input.launchPolicy ?? (input.providerId === "codex" && (!input.permissionProfileId || input.permissionProfileId === "full_access")
        ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
        : {}),
      created_by: "desktop",
      created_at: now,
      source_repo_path: input.repoRootPath?.trim() || null,
      workspace_path: null,
      work_attempt_id: null,
      workplace_liveness: { state: "unknown", observed_at: null, detail: "Awaiting room registration." },
      native_liveness: { state: "unknown", observed_at: null, detail: "Awaiting native provider launch." },
      activity: [],
      // Creation is the one authoritative point where the desktop can prove
      // no worker session has ever been minted for this immutable entry id.
      // Legacy entries that omitted this field remain revocation-unknown.
      last_worker_binding: null,
    };
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.put", { entry }));
  }

  async setDesiredState(id: string, desiredState: DesktopSupervisorDesiredState): Promise<DesktopSupervisorManifestEntry> {
    if (!nonEmptyString(id) || !["running", "paused", "stopped"].includes(desiredState)) throw new Error("Agent lifecycle requires an exact identity and desired state.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    return mapEntry(await this.request<WireEntry>("manifest.set_desired_state", { id, desired_state: desiredState }));
  }

  async recoverAgentRuntime(id: string, recovery?: import("../ipc-types.js").DesktopSupervisorRuntimeRecoveryInput["recovery"]): Promise<DesktopSupervisorManifestEntry> {
    if (!nonEmptyString(id) || id !== id.trim()) {
      throw new Error("Agent runtime recovery requires an exact identity.");
    }
    const status = await this.ensureRunning();
    if (recovery && !status.capabilities.agentRuntimeRecoveryV2) {
      this.invalidateReadyStatus();
      throw new Error("Update the background service to use reconnect and runtime restart controls.");
    }
    if (!status.capabilities.agentRuntimeRecovery) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor is too old for safe provider runtime recovery; rebuild the desktop daemon.");
    }
    const result = await this.request<{ outcome: "recovering"; entry: WireEntry }>(
      "supervisor.recover_agent_runtime",
      { entry_id: id, daemon_generation: status.generation, ...(recovery ? { mode: recovery.mode,
        operation_id: recovery.operationId, room_id: recovery.roomId,
        execution_generation_id: recovery.executionGenerationId, runtime_generation_id: recovery.runtimeGenerationId } : {}) },
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      RECOVERY_REQUEST_TIMEOUT_MS,
    );
    return mapEntry(result.entry);
  }

  async setDisplayName(id: string, displayName: string): Promise<DesktopSupervisorManifestEntry> {
    const normalized = displayName.trim();
    if (!nonEmptyString(id) || !normalized || normalized.length > 120) {
      throw new Error("Agent naming requires an exact identity and display name.");
    }
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor is too old for durable agent naming; rebuild the desktop daemon.");
    }
    return mapEntry(await this.request<WireEntry>("manifest.set_display_name", {
      id,
      display_name: normalized,
    }));
  }

  /** This call deliberately accepts only a renderer-safe exact identity tuple. */
  async retryRoomDelivery(input: DesktopSupervisorRoomDeliveryRetryInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliveryRetry) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support room delivery retry.");
    }
    await this.request<{ accepted: boolean }>("supervisor.retry_room_delivery", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async restoreAgentConversation(input: import("../ipc-types/agents.js").DesktopSupervisorConversationRestoreInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.providerContinuationRepair) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support provider conversation restoration.");
    }
    await this.request<{ accepted: boolean }>("supervisor.restore_agent_conversation", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async skipRoomDelivery(input: import("../ipc-types/agents.js").DesktopSupervisorRoomDeliverySkipInput): Promise<void> {
    const status = await this.ensureRunning();
    if (!status.capabilities.roomDeliverySkip) {
      this.invalidateReadyStatus();
      throw new Error("This supervisor does not support safely skipping a blocked room message.");
    }
    await this.request<{ accepted: boolean }>("supervisor.skip_room_delivery", {
      entry_id: input.entryId,
      room_id: input.roomId,
      source_message_id: input.sourceMessageId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      agent_session_id: input.agentSessionId,
      daemon_generation: status.generation,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async compareAndSetDesiredState(
    id: string,
    expectedDesiredState: DesktopSupervisorDesiredState,
    desiredState: DesktopSupervisorDesiredState,
  ): Promise<DesktopSupervisorManifestEntry | null> {
    if (!nonEmptyString(id) || !["running", "paused", "stopped"].includes(expectedDesiredState) || !["running", "paused", "stopped"].includes(desiredState)) throw new Error("Agent lifecycle compare-and-set requires exact typed fields.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.request<{ applied: boolean; entry: WireEntry }>("manifest.compare_and_set_desired_state", {
      id,
      expected_desired_state: expectedDesiredState,
      desired_state: desiredState,
    });
    return result.applied ? mapEntry(result.entry) : null;
  }

  async controlTurn(input: DesktopSupervisorTurnControlInput): Promise<DesktopSupervisorTurnControlResult> {
    if (!input || !nonEmptyString(input.entryId) || !nonEmptyString(input.roomId)
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !nonEmptyString(input.workAttemptId) || !nonEmptyString(input.executionGenerationId)
      || !nonEmptyString(input.providerContinuationId) || !nonEmptyString(input.providerTurnId)
      || !nonEmptyString(input.inboxItemId) || !nonEmptyString(input.sourceMessageId)
      || !validTurnControlActionId(input.actionId)
      || !Number.isSafeInteger(input.actionSequence) || input.actionSequence < 1
      || (input.correction !== null && input.correction !== undefined && typeof input.correction !== "string")) {
      throw new Error("Turn control requires exact typed identity and a bounded action id.");
    }
    const status = await this.ensureRunning();
    if (status.generation !== input.daemonGeneration) {
      this.invalidateReadyStatus();
      throw new Error("The supervisor generation changed before turn control was sent.");
    }
    return this.request<DesktopSupervisorTurnControlResult>("manifest.control_turn", {
      id: input.entryId,
      daemon_generation: input.daemonGeneration,
      room_id: input.roomId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      provider_continuation_id: input.providerContinuationId,
      provider_turn_id: input.providerTurnId,
      inbox_item_id: input.inboxItemId,
      source_message_id: input.sourceMessageId,
      action_id: input.actionId,
      action_sequence: input.actionSequence,
      correction: input.correction ?? null,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.turnControlRequestTimeoutMs);
  }

  async resolveTurnControl(input: DesktopSupervisorTurnControlResolutionInput): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.resolve_turn_control", {
      id: input.entryId,
      work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId,
      action_id: input.actionId,
      resolution: input.resolution,
    }));
  }

  async readAttempt(id: string): Promise<DesktopSupervisorAttemptDetail> {
    await this.ensureRunning();
    const detail = await this.request<Record<string, unknown>>("attempt.read", { id }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
    return {
      entryId: String(detail.entry_id ?? id),
      workAttemptId: typeof detail.work_attempt_id === "string" ? detail.work_attempt_id : null,
      workspacePath: typeof detail.workspace_path === "string" ? detail.workspace_path : null,
      lastTerminal: detail.last_terminal && typeof detail.last_terminal === "object" ? detail.last_terminal as Record<string, unknown> : null,
      restartCount: Number(detail.restart_count ?? 0),
      activity: Array.isArray(detail.activity) ? detail.activity.map((event) => mapActivity(event as WireActivityEvent)) : [],
    };
  }
  async getAgentInspectorDetail(input: import("../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetailInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetail> {
    if (!nonEmptyString(input.entryId) || !nonEmptyString(input.roomId) || (input.sourceMessageId !== undefined && input.sourceMessageId !== null && !nonEmptyString(input.sourceMessageId))) throw new Error("Agent inspector detail requires exact non-empty entry, room, and optional source identities.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorDetail) { this.invalidateReadyStatus(); throw new Error("This supervisor does not support agent inspector detail history."); }
    const detail = await this.request<Record<string, unknown>>("supervisor.get_agent_inspector_detail", { entry_id: input.entryId, room_id: input.roomId, source_message_id: input.sourceMessageId ?? null }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
    return mapAgentInspectorDetail(detail, input);
  }

  async getAgentConfiguration(entryId: string, daemonGeneration: number): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfiguration> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1) throw new Error("Agent configuration requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const value = await this.request<Record<string, unknown>>("supervisor.get_agent_configuration", { entry_id: entryId, daemon_generation: daemonGeneration }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
    return mapAgentConfiguration(value, entryId, daemonGeneration);
  }

  async updateAgentConfiguration(input: import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateResult> {
    if (!input || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || !input.configuration || typeof input.configuration !== "object"
      || !Object.hasOwn(input.configuration, "model") || !Object.hasOwn(input.configuration, "reasoningEffort") || !Object.hasOwn(input.configuration, "charter") || !Object.hasOwn(input.configuration, "permissionProfileId")) throw new Error("Agent configuration update requires exact typed coordinates and fields.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>("supervisor.update_agent_configuration", { entry_id: input.entryId, daemon_generation: input.daemonGeneration, expected_revision: input.expectedRevision, configuration: {
      model: input.configuration.model, reasoning_effort: input.configuration.reasoningEffort, charter: input.configuration.charter,
      permission_profile_id: input.configuration.permissionProfileId,
      ...(typeof input.configuration.imageInput === "boolean" ? { image_input: input.configuration.imageInput } : {}),
    } });
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated" && result.outcome !== "conflict") throw new Error("Supervisor returned an invalid configuration update result.");
    return { outcome: result.outcome, configuration: mapAgentConfiguration(record(result.configuration) ?? {}, input.entryId, input.daemonGeneration) };
  }

  async applyAgentConfiguration(input: import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationApplyInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorAgentConfigurationApplyResult> {
    if (!input || !nonEmptyString(input.entryId)
      || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1
      || !Number.isSafeInteger(input.expectedConfigurationRevision) || input.expectedConfigurationRevision < 1) {
      throw new Error("Agent configuration apply requires exact typed coordinates.");
    }
    const status = await this.ensureRunning();
    if (!status.capabilities.agentInspectorSettings) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for Inspector settings; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>(
      "supervisor.apply_agent_configuration",
      {
        entry_id: input.entryId,
        daemon_generation: input.daemonGeneration,
        expected_configuration_revision: input.expectedConfigurationRevision,
      },
      SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      CONFIGURATION_APPLY_REQUEST_TIMEOUT_MS,
    );
    if (result.outcome !== "already_applied"
      && result.outcome !== "restarting"
      && result.outcome !== "busy_active_turn"
      && result.outcome !== "conflict"
      && result.outcome !== "unsupported") {
      throw new Error("Supervisor returned an invalid configuration apply result.");
    }
    return { outcome: result.outcome };
  }

  async prepareRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMovePrepareInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.entryId) || !nonEmptyString(input.destinationRoomId) || !nonEmptyString(input.requestId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move preparation requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.prepare_room_move", { entry_id: input.entryId, destination_room_id: input.destinationRoomId, request_id: input.requestId, daemon_generation: input.daemonGeneration }), input.entryId);
  }

  async commitRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move commit requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.commit_room_move", { operation_id: input.operationId, entry_id: input.entryId, daemon_generation: input.daemonGeneration }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, 15_000), input.entryId, input.operationId);
  }

  async acknowledgeRoomMoveSourceRevocation(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput & { sourceAgentSessionId: string }): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !nonEmptyString(input.sourceAgentSessionId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move credential acknowledgement requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.acknowledge_room_move_source_revocation", {
      operation_id: input.operationId, entry_id: input.entryId, source_agent_session_id: input.sourceAgentSessionId, daemon_generation: input.daemonGeneration,
    }), input.entryId, input.operationId);
  }

  async rollbackRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput & { error: string }): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !nonEmptyString(input.error) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move rollback requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.rollback_room_move", {
      operation_id: input.operationId, entry_id: input.entryId, error: input.error, daemon_generation: input.daemonGeneration,
    }), input.entryId, input.operationId);
  }

  async getRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorRoomMoveOperationInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove> {
    if (!nonEmptyString(input.operationId) || !nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Room-move status requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    return mapRoomMove(await this.request<Record<string, unknown>>("supervisor.get_room_move", { operation_id: input.operationId, entry_id: input.entryId, daemon_generation: input.daemonGeneration }), input.entryId, input.operationId);
  }

  async getCurrentRoomMove(input: import("../ipc-types/agents.js").DesktopSupervisorCurrentRoomMoveInput): Promise<import("../ipc-types/agents.js").DesktopSupervisorRoomMove | null> {
    if (!nonEmptyString(input.entryId) || !Number.isSafeInteger(input.daemonGeneration) || input.daemonGeneration < 1) throw new Error("Current room-move discovery requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentRoomMove) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable room moves; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown> | null>("supervisor.get_current_room_move", {
      entry_id: input.entryId,
      daemon_generation: input.daemonGeneration,
    });
    return result === null ? null : mapRoomMove(result, input.entryId);
  }

  async retireAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
  ): Promise<{
    outcome: "retired" | "invalid" | "revocation_required";
    revocationKind?: "worker_session" | "grant_only";
    agentSessionId?: string;
    error?: string;
  }> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1
      || !(revokedAgentSessionId === null || nonEmptyString(revokedAgentSessionId))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)
      || typeof grantRevokedWithoutWorkerSession !== "boolean") throw new Error("Retire requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>("supervisor.retire_agent", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      revoked_agent_session_id: revokedAgentSessionId,
      grant_revoked_without_worker_session: grantRevokedWithoutWorkerSession,
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, RETIRE_REQUEST_TIMEOUT_MS);
    if (result.outcome === "retired") return { outcome: "retired" };
    if (result.outcome === "revocation_required") {
      if (result.revocation_kind === "worker_session"
        && typeof result.agent_session_id === "string" && result.agent_session_id.trim()) {
        return { outcome: "revocation_required", revocationKind: "worker_session", agentSessionId: result.agent_session_id };
      }
      if (result.revocation_kind === "grant_only" && result.agent_session_id === undefined) {
        return { outcome: "revocation_required", revocationKind: "grant_only" };
      }
    }
    if (result.outcome === "invalid" && typeof result.error === "string" && result.error.trim()) {
      return { outcome: "invalid", error: result.error };
    }
    throw new Error("Supervisor returned an invalid retirement result.");
  }

  async purgeAgent(
    entryId: string,
    daemonGeneration: number,
    revokedAgentSessionId: string | null = null,
    grantRevokedWithoutWorkerSession = false,
    includeCleanupIdentity = false,
  ): Promise<{
    outcome: "purged" | "invalid" | "revocation_required";
    operationId?: string;
    revocationKind?: "worker_session" | "grant_only";
    agentSessionId?: string;
    purgedWorkAttemptId?: string;
    error?: string;
  }> {
    if (!nonEmptyString(entryId) || !Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1
      || !(revokedAgentSessionId === null || nonEmptyString(revokedAgentSessionId))
      || (revokedAgentSessionId !== null && grantRevokedWithoutWorkerSession)
      || typeof grantRevokedWithoutWorkerSession !== "boolean"
      || typeof includeCleanupIdentity !== "boolean") throw new Error("Purge requires exact typed coordinates.");
    const status = await this.ensureRunning();
    if (!status.capabilities.agentLifecycle) { this.invalidateReadyStatus(); throw new Error("This supervisor is too old for durable agent lifecycle operations; rebuild the desktop daemon."); }
    const result = await this.request<Record<string, unknown>>("supervisor.purge_agent", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      revoked_agent_session_id: revokedAgentSessionId,
      grant_revoked_without_worker_session: grantRevokedWithoutWorkerSession,
    });
    if (result.outcome === "purged") {
      return {
        outcome: "purged",
        ...(includeCleanupIdentity && typeof result.purged_work_attempt_id === "string" && result.purged_work_attempt_id.trim()
          ? { purgedWorkAttemptId: result.purged_work_attempt_id }
          : {}),
      };
    }
    if (result.outcome === "revocation_required" && typeof result.operation_id === "string" && result.operation_id.trim()) {
      if (result.revocation_kind === "worker_session"
        && typeof result.agent_session_id === "string" && result.agent_session_id.trim()) {
        return {
          outcome: "revocation_required",
          operationId: result.operation_id,
          revocationKind: "worker_session",
          agentSessionId: result.agent_session_id,
        };
      }
      if (result.revocation_kind === "grant_only" && result.agent_session_id === undefined) {
        return { outcome: "revocation_required", operationId: result.operation_id, revocationKind: "grant_only" };
      }
    }
    if (result.outcome === "invalid" && typeof result.error === "string" && result.error.trim()) return { outcome: "invalid", error: result.error };
    throw new Error("Supervisor returned an invalid purge result.");
  }

  async updateWorkplaceLiveness(id: string, state: "reachable" | "stale" | "unknown", detail: string | null): Promise<DesktopSupervisorManifestEntry> {
    await this.ensureRunning();
    return mapEntry(await this.request<WireEntry>("manifest.update_workplace_liveness", {
      id,
      state,
      detail,
      observed_at: this.now().toISOString(),
    }));
  }

  /** Main-process only: a secret crosses only the owner-only local socket. */
  async installWorkerCredential(input: {
    entryId: string; roomId: string; workAttemptId: string;
    executionGenerationId: string; agentSessionId: string; credential: string;
  }): Promise<"installed" | "stale"> {
    if (!input.credential.trim()) throw new Error("A supervised worker credential is required.");
    const status = await this.ensureRunning();
    const result = await this.request<{ status?: unknown }>("supervisor.install_worker_credential", {
      entry_id: input.entryId, room_id: input.roomId, work_attempt_id: input.workAttemptId,
      execution_generation_id: input.executionGenerationId, agent_session_id: input.agentSessionId,
      agent_session_token: input.credential, daemon_generation: status.generation,
    });
    if (result.status !== "installed") this.invalidateReadyStatus();
    return result.status === "installed" ? "installed" : "stale";
  }

  /**
   * Main-process-only Open Model credential ingress. The provider key is
   * decrypted by Electron and crosses only the owner-only daemon socket.
   */
  async installOpenModelCredential(input: {
    entryId: string;
    apiKey: string | null;
    baseUrl: string;
    model: string;
    contextWindow?: number | null;
    daemonGeneration: number;
  }): Promise<"installed" | "stale"> {
    if (!input.baseUrl.trim() || !input.model.trim()) {
      throw new Error("An Open Model endpoint and model are required.");
    }
    const status = await this.ensureRunning();
    if (status.generation !== input.daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.request<{ status?: unknown }>(
      "supervisor.install_open_model_credential",
      {
        entry_id: input.entryId,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        model: input.model,
        ...(input.contextWindow != null ? { context_window: input.contextWindow } : {}),
        daemon_generation: input.daemonGeneration,
      },
    );
    if (result.status !== "installed") this.invalidateReadyStatus();
    return result.status === "installed" ? "installed" : "stale";
  }

  /**
   * Main-process-only grant ingress.  This is deliberately not represented in
   * IPC types: a supervisor bearer may cross only the owner-only Unix socket
   * to the exact daemon generation that will hold it in process memory.
   */
  async installHostGrant(input: {
    entryId: string;
    roomId: string;
    agentKey: string;
    grantId: string;
    supervisorGrant: string;
    grantGeneration: number;
    daemonGeneration: number;
    hostId: string;
    installationId: string;
    ownerAccountId: string | null;
    scopeKey: string | null;
    expiresAt: string;
    apiUrl?: string;
    /** Rebind only an already-live exact provider generation; never converge. */
    credentialOnly?: boolean;
    /** Install owner authority for explicit runtime replacement; never attach or converge. */
    recoveryOnly?: boolean;
  }): Promise<"installed" | "stale" | "provider_unavailable"> {
    if (input.credentialOnly && input.recoveryOnly) {
      throw new Error("Host grant installation cannot be both reconnect-only and recovery-only.");
    }
    if (!input.supervisorGrant.trim()) throw new Error("A supervised host grant is required.");
    const status = await this.ensureRunning();
    // Never let a request started against an old process install into its
    // successor. The daemon independently checks this fence too.
    if (status.generation !== input.daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.request<{ status?: unknown }>("supervisor.install_host_grant", {
      entry_id: input.entryId,
      room_id: input.roomId,
      agent_key: input.agentKey,
      grant_id: input.grantId,
      supervisor_grant: input.supervisorGrant,
      grant_generation: input.grantGeneration,
      host_id: input.hostId,
      installation_id: input.installationId,
      owner_account_id: input.ownerAccountId,
      scope_key: input.scopeKey,
      grant_expires_at: input.expiresAt,
      api_url: input.apiUrl ?? apiUrl,
      daemon_generation: input.daemonGeneration,
      credential_only: Boolean(input.credentialOnly),
      ...(input.recoveryOnly ? { recovery_only: true } : {}),
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, INSTALL_HOST_GRANT_REQUEST_TIMEOUT_MS);
    if (result.status === "installed" || result.status === "provider_unavailable") return result.status;
    this.invalidateReadyStatus();
    return "stale";
  }

  /** Queue exact host-side delegation discovery; no authority crosses IPC. */
  async syncExecutionDelegations(roomId: string): Promise<"queued" | "stale"> {
    const status = await this.ensureRunning();
    const result = await this.request<{ status?: unknown }>("supervisor.sync_execution_delegations", {
      room_id: roomId,
      daemon_generation: status.generation,
    });
    if (result.status !== "queued") this.invalidateReadyStatus();
    return result.status === "queued" ? "queued" : "stale";
  }

  /** Establish a daemon-inbox entry's one-time durable room boundary. */
  async bootstrapRoomIngress(entryId: string, daemonGeneration: number, initialMessage?: string): Promise<"bootstrapped" | "existing" | "stale"> {
    const status = await this.ensureRunning();
    if (status.generation !== daemonGeneration) { this.invalidateReadyStatus(); return "stale"; }
    const result = await this.request<{ status?: unknown }>("supervisor.bootstrap_room_ingress", {
      entry_id: entryId,
      daemon_generation: daemonGeneration,
      ...(initialMessage?.trim() ? { initial_message: initialMessage.trim() } : {}),
    }, SUPERVISOR_DAEMON_PROTOCOL_VERSION, BOOTSTRAP_INGRESS_REQUEST_TIMEOUT_MS);
    if (result.status !== "bootstrapped" && result.status !== "existing") this.invalidateReadyStatus();
    return result.status === "bootstrapped" || result.status === "existing" ? result.status : "stale";
  }

}

export const supervisorDaemonClient = new SupervisorDaemonClient();
supervisorDaemonClient.onGeneration((status) => {
  if (stateWatchUnsupportedGeneration !== status.generation) {
    stateWatchUnsupportedGeneration = null;
  }
  if (stateEmitter.listenerCount("state") > 0) ensureSupervisorStateWatch();
});

export function onSupervisorActivity(
  listener: (payload: { entryId: string; event: DesktopSupervisorActivityEvent }) => void,
): () => void {
  activityEmitter.on("activity", listener);
  return () => activityEmitter.off("activity", listener);
}

export function onSupervisorState(
  listener: (snapshot: DesktopSupervisorStateSnapshot) => void,
): () => void {
  stateEmitter.on("state", listener);
  ensureSupervisorStateWatch();
  return () => stateEmitter.off("state", listener);
}

/**
 * Agents that are not retired, from the last pushed state and without activity
 * history. App-wide attention reads this instead of a full-history
 * `manifest.list` of every room; null until the watch has delivered state.
 */
export function liveSupervisorStateEntries(): DesktopSupervisorManifestEntry[] | null {
  return latestSupervisorState ? projectLiveSupervisorEntries(latestSupervisorState.entries) : null;
}

export function projectLiveSupervisorEntries(entries: readonly DesktopSupervisorManifestEntry[]): DesktopSupervisorManifestEntry[] {
  return entries.filter((entry) => entry.desiredState !== "stopped").map((entry) => ({ ...entry, activity: [] }));
}

function ensureSupervisorStateWatch(): void {
  if (stateWatchOperation || stateEmitter.listenerCount("state") === 0) return;
  stateWatchOperation = runSupervisorStateWatch().finally(() => {
    stateWatchOperation = null;
  });
}

async function runSupervisorStateWatch(): Promise<void> {
  try { await watchSupervisorState(); }
  // Attention reads only what the current watch has confirmed: never state
  // from a stopped, replaced, unsupported or unreachable daemon.
  finally { latestSupervisorState = null; }
}

async function watchSupervisorState(): Promise<void> {
  let afterDaemonGeneration = 0;
  let afterSequence = 0;
  let consecutiveFailures = 0;
  while (stateEmitter.listenerCount("state") > 0) {
    try {
      const status = await supervisorDaemonClient.connectIfRunning();
      if (!status) return;
      if (!supervisorStateWatchAcceptsStatus(status)) {
        latestSupervisorState = null;
        // Startup may briefly attach to the previous desktop build's daemon
        // while the lifecycle owner performs a negotiated handoff. Do not
        // project its additive wire shape as current durable state.
        await unrefDelay(STATE_WATCH_RETRY_BASE_MS);
        continue;
      }
      if (stateWatchUnsupportedGeneration === status.generation) return;
      if (!status.capabilities.agentStateSubscription) {
        stateWatchUnsupportedGeneration = status.generation;
        return;
      }
      if (afterDaemonGeneration !== status.generation) {
        afterDaemonGeneration = 0;
        afterSequence = 0;
      }
      const snapshot = await supervisorDaemonClient.watchState({
        afterDaemonGeneration,
        afterSequence,
      });
      afterDaemonGeneration = snapshot.daemonGeneration;
      afterSequence = snapshot.sequence;
      consecutiveFailures = 0;
      latestSupervisorState = snapshot;
      stateEmitter.emit("state", snapshot);
    } catch {
      // The renderer keeps its last authoritative snapshot. Reconnection is a
      // transport concern and must not transiently dismantle its live controls.
      // A capped exponential delay avoids turning a persistent failure into a
      // tight background loop.
      latestSupervisorState = null;
      consecutiveFailures += 1;
      await unrefDelay(supervisorStateWatchRetryDelay(consecutiveFailures));
    }
  }
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function onSupervisorAgentStream(
  listener: (batch: import("../ipc-types/agents.js").DesktopAgentStreamBatch) => void,
): () => void {
  agentStreamEmitter.on("agent-stream", listener);
  return () => agentStreamEmitter.off("agent-stream", listener);
}

/**
 * Focus the live feed on exactly one agent (or clear it). Only the inspected
 * agent's token firehose is streamed; switching focus abandons the previous
 * long-poll and starts a fresh one. Passing null stops streaming entirely.
 */
export function setFocusedAgentStream(entryId: string | null): void {
  if (focusedAgentStreamEntryId === entryId) return;
  focusedAgentStreamEntryId = entryId;
  // The epoch distinguishes close→reopen of the same agent while an old
  // long-poll is still in flight. Entry identity alone cannot observe that
  // lifecycle edge, and would otherwise resume the stale cursor/feed.
  focusedAgentStreamEpoch += 1;
  // Destroy the old long-poll socket now. Waiting for its 25-second server
  // timeout would make close→reopen of the same agent appear frozen even
  // though the renderer requested a new viewer lifecycle.
  agentStreamWatchAbortController?.abort();
  if (entryId && !agentStreamWatchOperation) {
    agentStreamWatchOperation = runAgentStreamWatch().finally(() => { agentStreamWatchOperation = null; });
  }
}

async function runAgentStreamWatch(): Promise<void> {
  let afterSequence = 0;
  let watchedEntryId: string | null = null;
  let watchedGeneration = 0;
  let watchedFocusEpoch = -1;
  let consecutiveFailures = 0;
  let endedNotified = false;
  let watchedStreamGeneration = 0;
  while (focusedAgentStreamEntryId !== null) {
    const entryId = focusedAgentStreamEntryId;
    const focusEpoch = focusedAgentStreamEpoch;
    try {
      const status = await supervisorDaemonClient.connectIfRunning();
      if (!status) return;
      if (focusedAgentStreamEntryId !== entryId || focusedAgentStreamEpoch !== focusEpoch) continue;
      if (!status.capabilities.agentActivityStream) {
        // Old daemon: tell the renderer the feed is unavailable, then stop.
        agentStreamEmitter.emit("agent-stream", {
          entryId,
          events: [],
          ended: true,
          reset: true,
          droppedEvents: 0,
        });
        return;
      }
      // A focus change or daemon restart resets the cursor and the ended latch.
      if (watchedEntryId !== entryId || watchedGeneration !== status.generation || watchedFocusEpoch !== focusEpoch) {
        watchedEntryId = entryId;
        watchedGeneration = status.generation;
        watchedFocusEpoch = focusEpoch;
        afterSequence = 0;
        endedNotified = false;
        watchedStreamGeneration = 0;
      }
      const watchController = new AbortController();
      agentStreamWatchAbortController = watchController;
      const batch = await supervisorDaemonClient.watchAgentStream({
        entryId,
        afterSequence,
        signal: watchController.signal,
      }).finally(() => {
        if (agentStreamWatchAbortController === watchController) agentStreamWatchAbortController = null;
      });
      consecutiveFailures = 0;
      if (focusedAgentStreamEntryId !== entryId || focusedAgentStreamEpoch !== focusEpoch) continue; // focus moved or closed/reopened mid-poll
      afterSequence = batch.sequence;
      const reset = watchedStreamGeneration !== batch.streamGeneration;
      watchedStreamGeneration = batch.streamGeneration;
      // A reopened provider generation reuses the daemon buffer and keeps its
      // monotonic cursor, so post-reopen events climb past ours and clear the
      // latch; the renderer un-ends the feed on the next non-ended batch.
      if (batch.events.length > 0) endedNotified = false;
      if (reset || batch.events.length > 0 || batch.droppedEvents > 0 || (batch.ended && !endedNotified)) {
        agentStreamEmitter.emit("agent-stream", {
          entryId,
          events: batch.events,
          ended: batch.ended,
          reset,
          droppedEvents: batch.droppedEvents,
        });
      }
      if (batch.ended) {
        // `ended` is a generation boundary, not a terminal state: the daemon
        // keeps the entry so the next generation reopens the feed. Notify the
        // renderer once and stay subscribed while this entry is focused, idling
        // so a permanently ended feed re-polls slowly instead of spinning.
        endedNotified = true;
        if (focusedAgentStreamEntryId === entryId) await unrefDelay(AGENT_STREAM_REOPEN_POLL_MS);
      }
    } catch {
      if (focusedAgentStreamEntryId !== entryId || focusedAgentStreamEpoch !== focusEpoch) continue;
      consecutiveFailures += 1;
      await unrefDelay(supervisorStateWatchRetryDelay(consecutiveFailures));
    }
  }
}

