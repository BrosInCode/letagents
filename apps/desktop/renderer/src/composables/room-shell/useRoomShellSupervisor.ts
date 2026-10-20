import { provide, readonly, shallowReadonly } from "vue";
import type {
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorRetirementEvent,
  DesktopSupervisorStateSnapshot,
} from "../../../../electron/ipc-types";
import { shouldSkipPollTick } from "../../domain/visibility-polling";
import { isCurrentAgentInspectorSupervisorUpdate, type AgentInspectorSupervisorEntryUpdate } from "../../domain/agent-inspector-identity";
import { settleAgentInspectorRetirementCompletion, settleAgentInspectorRetirementEvent } from "../../domain/agent-inspector";
import { supervisorGenerationIsCurrent } from "../../domain/agent-inspector-settings";
import { invalidateAgentInspectorRuntimeControl } from "../../domain/agent-inspector-work";
import {
  mergeSupervisorEntriesPoll,
  mergeSupervisorStateSnapshotEntries,
  supervisorStateRepairDelayMs,
  supervisorStateSubscriptionNeedsRepair,
  supervisorStatusTrailingRefreshGeneration,
} from "../../domain/supervisor-entries-resource";
import { supervisorEntriesKey } from "../../components/desktop/content/add-agent/supervisor-entries-context";
import { useSupervisorStateSubscription } from "../../components/desktop/content/room-shell/useSupervisorStateSubscription";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** Supervisor state: snapshots, retirement events, status negotiation, and the entries refresh. */
export function useRoomShellSupervisorActions(context: unknown) {
  const {
    agentInspectorActionState, agentInspectorConfigurationResource, agentInspectorRequestState,
    agentInspectorRoomMoveResource, agentInspectorSettingsConflict, agentInspectorWorkResource,
    deliveryRetryNegotiated, emit, props, selectedAgentDetailRequest,
    selectedAgentDetailRequestVersion, selectedAgentDetailTarget, supervisorEntries,
    supervisorEntriesError, supervisorEntriesHaveLoaded, supervisorEntriesState,
    supervisorEntriesUpdatedAt, supervisorSettingsGenerationChangedMessage, supervisorStatus,
    supervisorSyncState,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<"useRoomShellSupervisorSync" | "pending">;
  let supervisorStatusRefreshInFlight: Promise<DesktopSupervisorDaemonStatus | null> | null = null;
  let supervisorStatusRequiredGeneration = 0;
  let supervisorStatusTrailingRefreshAttemptGeneration = 0;
  let supervisorEntriesRefreshTimer: number | null = null;
  let supervisorEntriesRefreshInFlight: Promise<void> | null = null;

  function acceptSupervisorStateSnapshot(snapshot: DesktopSupervisorStateSnapshot): void {
    if (
      snapshot.daemonGeneration < supervisorSyncState.supervisorStateDaemonGeneration
      || (
        snapshot.daemonGeneration === supervisorSyncState.supervisorStateDaemonGeneration
        && snapshot.sequence < supervisorSyncState.supervisorStateSequence
      )
    ) return;
    const statusGeneration = supervisorStatus.value?.generation ?? 0;
    supervisorSyncState.supervisorStateDaemonGeneration = snapshot.daemonGeneration;
    supervisorSyncState.supervisorStateSequence = snapshot.sequence;
    supervisorSyncState.supervisorEntriesMutationVersion += 1;
    const roomEntries = snapshot.entries.filter((entry) => entry.roomId === props.room.identifier);
    // The merge is identity-stable: it returns the retained array when nothing a
    // view renders changed, so a periodic worker-binding republication no longer
    // costs a whole-list reactivity pass (or a whole-snapshot JSON comparison).
    const mergedEntries = mergeSupervisorStateSnapshotEntries(
      supervisorEntries.value,
      roomEntries,
      props.room.identifier,
    );
    if (mergedEntries !== supervisorEntries.value) supervisorEntries.value = mergedEntries;
    supervisorEntriesHaveLoaded.value = true;
    supervisorEntriesUpdatedAt.value = new Date().toISOString();
    supervisorEntriesState.value = "ready";
    supervisorEntriesError.value = null;
    const target = selectedAgentDetailTarget.value;
    if (target?.kind === "supervised") agentInspectorWorkResource.value = invalidateAgentInspectorRuntimeControl(
      agentInspectorWorkResource.value, snapshot, target.supervisorEntryId, props.room.identifier,
    );
    // Status/capability negotiation is generation-scoped. Push snapshots keep
    // the manifest current, but a daemon handoff requires exactly one new
    // negotiation before generation-specific controls may be used.
    if (statusGeneration !== snapshot.daemonGeneration) {
      void refreshSupervisorStatus(snapshot.daemonGeneration)
        .then(() => app.refreshOpenAgentInspectorRuntimeControl(snapshot));
    } else app.refreshOpenAgentInspectorRuntimeControl(snapshot);
    void reconcilePendingRetirementFromDurableState(snapshot);
  }

  function acceptSupervisorRetirementEvent(event: DesktopSupervisorRetirementEvent): void {
    const action = agentInspectorActionState.value;
    const settled = settleAgentInspectorRetirementEvent(action, event);
    if (settled === action) return;
    supervisorSyncState.retirementStatusCheckOperationId = null;
    agentInspectorActionState.value = settled;
    void refreshSupervisorEntries();
  }

  /** State pushes are the missed-event/reconnect fallback. Completion is checked
   * against both the durable daemon lifecycle and Electron's grant registry, so
   * a merely stopped provider is never mistaken for fully revoked authority. */
  async function reconcilePendingRetirementFromDurableState(snapshot: DesktopSupervisorStateSnapshot): Promise<void> {
    const action = agentInspectorActionState.value;
    if (!action || action.kind !== "retire_agent" || action.status !== "running"
      || action.daemonGeneration !== snapshot.daemonGeneration
      || supervisorSyncState.retirementStatusCheckOperationId === action.operationId
      || typeof desktopIpc.supervisor?.getRetirementStatus !== "function") return;
    const entry = snapshot.entries.find((candidate) => candidate.id === action.entryId);
    if (!entry || entry.desiredState !== "stopped" || entry.observedState !== "stopped"
      || entry.agentSessionId !== null || entry.agentSessionBindingState === "active") return;
    supervisorSyncState.retirementStatusCheckOperationId = action.operationId;
    try {
      const result = await desktopIpc.supervisor.getRetirementStatus({
        entryId: action.entryId,
        daemonGeneration: snapshot.daemonGeneration,
      });
      const current = agentInspectorActionState.value;
      if (result.status === "completed" && current?.operationId === action.operationId
        && current.kind === "retire_agent" && current.status === "running") {
        agentInspectorActionState.value = settleAgentInspectorRetirementCompletion(current, {
          operationId: action.operationId,
          entryId: action.entryId,
          daemonGeneration: snapshot.daemonGeneration,
        });
        void refreshSupervisorEntries();
      }
    } catch {
      // The explicit completion/failure event remains primary. A status read can
      // race daemon handoff or temporarily unavailable secure storage, neither
      // of which should turn an accepted retirement into a false UI failure.
    } finally {
      if (supervisorSyncState.retirementStatusCheckOperationId === action.operationId) supervisorSyncState.retirementStatusCheckOperationId = null;
    }
  }

  function applySupervisorStatus(status: DesktopSupervisorDaemonStatus): DesktopSupervisorDaemonStatus {
    const previousGeneration = supervisorStatus.value?.generation ?? null;
    if (!supervisorGenerationIsCurrent(previousGeneration, status.generation)) return supervisorStatus.value!;
    supervisorStatus.value = status;
    deliveryRetryNegotiated.value = status.capabilities.roomDeliveryRetry;
    if (
      previousGeneration !== null
      && previousGeneration !== status.generation
    ) {
      if (agentInspectorConfigurationResource.value.configuration?.daemonGeneration !== status.generation) {
        agentInspectorRequestState.agentInspectorSettingsRequestToken += 1;
        agentInspectorConfigurationResource.value = {
          ...agentInspectorConfigurationResource.value,
          status: "error",
          error: supervisorSettingsGenerationChangedMessage,
        };
        agentInspectorSettingsConflict.value = true;
      }
      agentInspectorRequestState.agentInspectorRoomMoveRequestToken += 1;
      if (agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer);
      agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = null;
      if (agentInspectorRoomMoveResource.value.move) {
        agentInspectorRoomMoveResource.value = {
          ...agentInspectorRoomMoveResource.value,
          status: "recovering",
          error: null,
        };
        if (agentInspectorActionState.value?.status !== "running") void app.loadAgentInspectorRoomMove();
      }
    }
    return status;
  }

  function markSupervisorStatusUnavailable(): void {
    supervisorStatus.value = null;
    deliveryRetryNegotiated.value = false;
    if (agentInspectorConfigurationResource.value.configuration) {
      agentInspectorRequestState.agentInspectorSettingsRequestToken += 1;
      agentInspectorConfigurationResource.value = {
        ...agentInspectorConfigurationResource.value,
        status: "error",
        error: "Background agent management is unavailable. Your draft is preserved.",
      };
    }
    agentInspectorRequestState.agentInspectorRoomMoveRequestToken += 1;
    if (agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer);
    agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = null;
    if (agentInspectorRoomMoveResource.value.move) {
      agentInspectorRoomMoveResource.value = {
        ...agentInspectorRoomMoveResource.value,
        status: "error",
        error: "Background agent management is unavailable. The durable move will be rediscovered after reconnecting.",
      };
    }
  }

  function refreshSupervisorStatus(requiredGeneration = 0): Promise<DesktopSupervisorDaemonStatus | null> {
    supervisorStatusRequiredGeneration = Math.max(supervisorStatusRequiredGeneration, requiredGeneration);
    if (supervisorStatusRefreshInFlight) return supervisorStatusRefreshInFlight;
    const requestToken = ++supervisorSyncState.supervisorStatusRequestToken;
    const refresh = (async () => {
      if (!desktopIpc.supervisor?.getStatus) {
        if (requestToken === supervisorSyncState.supervisorStatusRequestToken) markSupervisorStatusUnavailable();
        return null;
      }
      try {
        const status = await desktopIpc.supervisor.getStatus();
        if (requestToken !== supervisorSyncState.supervisorStatusRequestToken) return supervisorStatus.value;
        return applySupervisorStatus(status);
      } catch {
        if (requestToken === supervisorSyncState.supervisorStatusRequestToken) markSupervisorStatusUnavailable();
        return null;
      }
    })();
    const tracked = refresh.finally(() => {
      if (supervisorStatusRefreshInFlight === tracked) supervisorStatusRefreshInFlight = null;
      const trailingGeneration = supervisorStatusTrailingRefreshGeneration({
        ownerActive: supervisorSyncState.supervisorEntriesRefreshOwnerActive,
        settledGeneration: supervisorStatus.value?.generation ?? 0,
        requiredGeneration: supervisorStatusRequiredGeneration,
        lastAttemptedGeneration: supervisorStatusTrailingRefreshAttemptGeneration,
      });
      if (trailingGeneration !== null) {
        // Electron also single-flights daemon startup/status reads. A request
        // that was fresh in the renderer can therefore settle with the daemon
        // generation from an older main-process operation. Compare the actual
        // settled generation to the required push generation and negotiate one
        // bounded trailing read for each newly observed generation.
        supervisorStatusTrailingRefreshAttemptGeneration = trailingGeneration;
        void refreshSupervisorStatus(trailingGeneration);
      }
    });
    supervisorStatusRefreshInFlight = tracked;
    return tracked;
  }

  function refreshSupervisorEntries(): Promise<void> {
    if (!supervisorSyncState.supervisorEntriesRefreshOwnerActive) return Promise.resolve();
    if (supervisorEntriesRefreshInFlight) {
      supervisorSyncState.supervisorEntriesRefreshQueued = true;
      return supervisorEntriesRefreshInFlight;
    }
    const refresh = performSupervisorEntriesRefresh();
    supervisorEntriesRefreshInFlight = refresh.finally(() => {
      supervisorSyncState.supervisorStateLastRepairAtMs = Date.now();
      supervisorEntriesRefreshInFlight = null;
      if (supervisorSyncState.supervisorEntriesRefreshOwnerActive && supervisorSyncState.supervisorEntriesRefreshQueued) {
        supervisorSyncState.supervisorEntriesRefreshQueued = false;
        void refreshSupervisorEntries();
      } else {
        scheduleSupervisorEntriesRepair();
      }
    });
    return supervisorEntriesRefreshInFlight;
  }

  function retryAgentInspectorState(): void {
    if (!selectedAgentDetailRequest.value) return;
    supervisorEntriesState.value = supervisorEntriesHaveLoaded.value ? "refreshing" : "loading";
    supervisorEntriesError.value = null;
    void refreshSupervisorEntries();
  }

  function refreshRoomAgents(): void {
    supervisorEntriesState.value = supervisorEntriesHaveLoaded.value ? "refreshing" : "loading";
    supervisorEntriesError.value = null;
    // Renew the existing subscription so Retry also repairs a failed daemon
    // read, even when its previous subscription still appeared fresh.
    app.supervisorStateSubscription.sync();
    void refreshSupervisorEntries();
    emit("refresh-room");
  }

  async function performSupervisorEntriesRefresh(): Promise<void> {
    if (!supervisorSyncState.supervisorEntriesRefreshOwnerActive || !props.room.identifier) return;
    const roomIdentifier = props.room.identifier;
    const requestId = ++supervisorSyncState.supervisorEntriesRefreshRequestId;
    const supervisorMutationVersion = supervisorSyncState.supervisorEntriesMutationVersion;
    if (!supervisorEntriesHaveLoaded.value) {
      supervisorEntriesState.value = "loading";
      supervisorEntriesError.value = null;
    }
    const pollSupervisor = !supervisorEntriesHaveLoaded.value || supervisorStateSubscriptionNeedsRepair({
      active: app.supervisorStateSubscription.state().active,
      lastSnapshotAtMs: app.supervisorStateSubscription.state().lastSnapshotAtMs,
      nowMs: Date.now(),
    });
    const [entriesResult] = await Promise.all([
      pollSupervisor && desktopIpc.supervisor?.listAgents
        ? desktopIpc.supervisor.listAgents(roomIdentifier)
          .then((entries) => ({ ok: true as const, entries }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : "Supervisor daemon unavailable.",
          }))
        : Promise.resolve({ ok: true as const, entries: supervisorEntries.value }),
      pollSupervisor || !supervisorStatus.value
        ? refreshSupervisorStatus()
        : Promise.resolve(supervisorStatus.value),
    ]);
    if (
      !supervisorSyncState.supervisorEntriesRefreshOwnerActive
      || props.room.identifier !== roomIdentifier
      || requestId !== supervisorSyncState.supervisorEntriesRefreshRequestId
    ) return;
    if (entriesResult.ok) {
      if (supervisorMutationVersion === supervisorSyncState.supervisorEntriesMutationVersion) {
        if (JSON.stringify(entriesResult.entries) !== JSON.stringify(supervisorEntries.value)) {
          supervisorEntries.value = mergeSupervisorEntriesPoll(
            supervisorEntries.value,
            entriesResult.entries,
            roomIdentifier,
          );
        }
      }
      // Even when a newer non-activity mutation wins over this snapshot, the
      // latest room-scoped poll completed successfully and must release the
      // resource from its transient refreshing state.
      supervisorEntriesHaveLoaded.value = true;
      supervisorEntriesUpdatedAt.value = new Date().toISOString();
      supervisorEntriesState.value = "ready";
      supervisorEntriesError.value = null;
    } else if (!supervisorEntriesHaveLoaded.value || supervisorStateSubscriptionNeedsRepair({
      active: app.supervisorStateSubscription.state().active,
      lastSnapshotAtMs: app.supervisorStateSubscription.state().lastSnapshotAtMs,
      nowMs: Date.now(),
    })) {
      // Keep the last successfully loaded entries. Consumers receive an error
      // resource instead of an empty list, so supervised identity cannot be
      // reclassified as external during a transient daemon failure.
      supervisorEntriesState.value = "error";
      supervisorEntriesError.value = entriesResult.error;
    }
  }

  function upsertSupervisorEntry(update: AgentInspectorSupervisorEntryUpdate): void {
    if (!isCurrentAgentInspectorSupervisorUpdate(
      update,
      props.room.identifier,
      selectedAgentDetailRequestVersion.value,
    )) return;
    supervisorSyncState.supervisorEntriesMutationVersion += 1;
    supervisorEntries.value = [
      update.entry,
      ...supervisorEntries.value.filter((candidate) => candidate.id !== update.entry.id),
    ];
    supervisorEntriesHaveLoaded.value = true;
    supervisorEntriesUpdatedAt.value = new Date().toISOString();
    supervisorEntriesState.value = "ready";
    supervisorEntriesError.value = null;
  }

  function scheduleSupervisorEntriesRepair(): void {
    stopSupervisorEntriesRefreshTimer();
    if (!props.room.identifier || !desktopIpc.supervisor?.listAgents) return;
    const delayMs = supervisorStateRepairDelayMs({
      lastRepairAtMs: supervisorSyncState.supervisorStateLastRepairAtMs,
      nowMs: Date.now(),
    });
    supervisorEntriesRefreshTimer = window.setTimeout(() => {
      supervisorEntriesRefreshTimer = null;
      // A hidden window has no observer that needs repaired projections. Foreground
      // transition performs the repair and establishes the next deadline.
      if (shouldSkipPollTick({ hidden: document.hidden })) return;
      // performSupervisorEntriesRefresh polls daemon entries and status only
      // when their own subscription heartbeat is stale.
      void refreshSupervisorEntries();
    }, delayMs);
  }

  function handleSupervisorEntriesVisibilityChange(): void {
    if (document.hidden) return;
    void refreshSupervisorEntries();
  }

  function stopSupervisorEntriesRefreshTimer(): void {
    if (supervisorEntriesRefreshTimer !== null) {
      window.clearTimeout(supervisorEntriesRefreshTimer);
      supervisorEntriesRefreshTimer = null;
    }
  }
  return {
    acceptSupervisorStateSnapshot, acceptSupervisorRetirementEvent,
    reconcilePendingRetirementFromDurableState, applySupervisorStatus,
    markSupervisorStatusUnavailable, refreshSupervisorStatus, refreshSupervisorEntries,
    retryAgentInspectorState, refreshRoomAgents, performSupervisorEntriesRefresh,
    upsertSupervisorEntry, scheduleSupervisorEntriesRepair,
    handleSupervisorEntriesVisibilityChange, stopSupervisorEntriesRefreshTimer,
  };
}

/** Provide the supervisor entries, and subscribe to supervisor state. */
export function useRoomShellSupervisorSync(context: unknown) {
  const {
    acceptSupervisorStateSnapshot, props, refreshSupervisorEntries, supervisorEntries,
    supervisorEntriesError, supervisorEntriesState,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState" | "useRoomShellSupervisorActions">;
  const app = context as object;
  provide(supervisorEntriesKey, {
    entries: shallowReadonly(supervisorEntries),
    state: readonly(supervisorEntriesState),
    error: readonly(supervisorEntriesError),
    refresh: refreshSupervisorEntries,
  });
  const supervisorStateSubscription = useSupervisorStateSubscription({ roomIdentifier: () => props.room.identifier, accept: acceptSupervisorStateSnapshot });
  Object.assign(app, { supervisorStateSubscription });
  return {
    supervisorStateSubscription,
  };
}
