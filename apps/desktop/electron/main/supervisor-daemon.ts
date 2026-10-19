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
import { SupervisorDaemonClient } from "./supervisor-daemon/client.js";
export { SupervisorDaemonClient } from "./supervisor-daemon/client.js";

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

