import { onBeforeUnmount, onMounted } from "vue";
import { appendAgentInspectorLiveBatch } from "../../domain/agent-inspector-live";
import { foldSupervisorActivityPush } from "../../domain/supervisor-entries-resource";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** Mount and unmount: supervisor subscriptions, visibility listener, and cleanup. */
export function useRoomShellLifecycle(context: unknown) {
  const {
    acceptSupervisorRetirementEvent, agentInspectorBackgroundRefresh, agentInspectorDetailRequest,
    agentInspectorLiveFeed, agentInspectorRequestState, handleSupervisorEntriesVisibilityChange,
    props, selectedAgentDetailProjection, stopSupervisorEntriesRefreshTimer, supervisorEntries,
    supervisorEntriesUpdatedAt, supervisorStateSubscription, supervisorSyncState,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellAgentProjections"
    | "useRoomShellState"
    | "useRoomShellSupervisorActions"
    | "useRoomShellSupervisorSync"
  >;
  let unsubscribeSupervisorActivity: (() => void) | null = null;
  let unsubscribeSupervisorAgentStream: (() => void) | null = null;
  let unsubscribeSupervisorRetirement: (() => void) | null = null;

  onBeforeUnmount(() => {
    agentInspectorRequestState.agentInspectorWorkRequestToken += 1;
    agentInspectorDetailRequest.reset();
    agentInspectorBackgroundRefresh.reset();
    supervisorSyncState.supervisorEntriesRefreshOwnerActive = false;
    supervisorSyncState.supervisorEntriesRefreshQueued = false;
    supervisorSyncState.supervisorEntriesRefreshRequestId += 1;
    stopSupervisorEntriesRefreshTimer();
    supervisorSyncState.supervisorStatusRequestToken += 1;
    agentInspectorRequestState.agentInspectorSettingsRequestToken += 1;
    agentInspectorRequestState.agentInspectorRoomMoveRequestToken += 1;
    if (agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer !== null) {
      window.clearTimeout(agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer);
      agentInspectorRequestState.agentInspectorRoomMoveRecoveryTimer = null;
    }
    document.removeEventListener("visibilitychange", handleSupervisorEntriesVisibilityChange);
    unsubscribeSupervisorActivity?.();
    unsubscribeSupervisorActivity = null;
    unsubscribeSupervisorAgentStream?.();
    unsubscribeSupervisorAgentStream = null;
    void desktopIpc.supervisor?.watchAgentStream?.(null);
    supervisorStateSubscription.unmount();
    unsubscribeSupervisorRetirement?.();
    unsubscribeSupervisorRetirement = null;
    supervisorSyncState.retirementStatusCheckOperationId = null;
  });

  onMounted(() => {
    document.addEventListener("visibilitychange", handleSupervisorEntriesVisibilityChange);
    unsubscribeSupervisorActivity = desktopIpc.supervisor?.onActivity?.((push) => {
      const next = foldSupervisorActivityPush(supervisorEntries.value, props.room.identifier, push);
      if (next === supervisorEntries.value) return;
      supervisorEntries.value = next;
      supervisorEntriesUpdatedAt.value = new Date().toISOString();
    }) || null;
    supervisorStateSubscription.mount();
    unsubscribeSupervisorRetirement = desktopIpc.supervisor?.onRetirement?.((event) => {
      acceptSupervisorRetirementEvent(event);
    }) || null;
    unsubscribeSupervisorAgentStream = desktopIpc.supervisor?.onAgentStream?.((batch) => {
      // Only accumulate for the agent whose inspector is focused; a batch for a
      // stale focus (raced focus change) is ignored.
      if (batch.entryId !== selectedAgentDetailProjection.value?.entryId) return;
      agentInspectorLiveFeed.value = appendAgentInspectorLiveBatch(agentInspectorLiveFeed.value, batch);
    }) || null;
  });
}
