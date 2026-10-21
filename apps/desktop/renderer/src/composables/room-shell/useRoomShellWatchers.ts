import { nextTick, watch } from "vue";
import { supervisedAgentInspectorRequest } from "../../domain/agent-inspector-identity";
import { emptyAgentInspectorWorkResource } from "../../domain/agent-inspector-work";
import { ownerAttribution as ownerAttributionLabel } from "../../components/desktop/content/room-activity/agentTarget";
import { readEnvironmentPanelOpen, readGitHubEventsVisible } from "../../components/desktop/content/room-shell/preferences";
import { useRoomAttentionNavigation } from "../../components/desktop/content/room-shell/useRoomAttentionNavigation";
import { desktopIpc } from "../../ipc/index.js";
import type { RoomShellContextOf } from "./context";

/** React to room, repo, panel, tab, and storage changes. */
export function useRoomShellRoomWatchers(context: unknown) {
  const {
    actionPanelOpen, activeTab, addAgentModalOpen, agentInspectorActionState,
    agentInspectorBackgroundRefresh, agentInspectorDetailRequest, agentInspectorRequestState,
    agentInspectorWorkResource, agentInspectorWorkSourceMessageId, boardGovernanceSection,
    boardSelectedTaskId, emit, environmentPanelOpen, githubEventsVisible, isLocalRoom,
    openAddAgentModal, props, readRoomActiveTab, refreshEnvironmentRepoStatus,
    refreshSupervisorEntries, refreshedEnvironmentRepoStatus, rememberRoomActiveTab,
    scheduleSupervisorEntriesRepair, searchOpen, selectedAgentDetailRequest,
    selectedAgentDetailRequestVersion, showEventsTab, supervisorEntries, supervisorEntriesError,
    supervisorEntriesHaveLoaded, supervisorEntriesState, supervisorEntriesUpdatedAt,
    supervisorStateSubscription, supervisorSyncState,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellConversation"
    | "useRoomShellIntegrations"
    | "useRoomShellState"
    | "useRoomShellSupervisorActions"
    | "useRoomShellSupervisorSync"
    | "useRoomShellToolActions"
  >;
  watch(() => props.room.identifier, () => {
    selectedAgentDetailRequestVersion.value += 1;
    selectedAgentDetailRequest.value = null;
    agentInspectorActionState.value = null;
    agentInspectorRequestState.agentInspectorWorkRequestToken += 1;
    agentInspectorBackgroundRefresh.reset();
    agentInspectorDetailRequest.reset();
    agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
    agentInspectorWorkSourceMessageId.value = null;
    activeTab.value = readRoomActiveTab(props.room.identifier);
    refreshedEnvironmentRepoStatus.value = null;
    supervisorEntries.value = [];
    supervisorEntriesState.value = "loading";
    supervisorEntriesError.value = null;
    supervisorEntriesHaveLoaded.value = false;
    supervisorEntriesUpdatedAt.value = null;
    boardSelectedTaskId.value = null; boardGovernanceSection.value = null;
    githubEventsVisible.value = readGitHubEventsVisible(props.room.identifier);
    environmentPanelOpen.value = readEnvironmentPanelOpen(props.room.identifier);
    supervisorSyncState.supervisorStateLastRepairAtMs = null;
    void refreshSupervisorEntries();
    scheduleSupervisorEntriesRepair();
  }, { immediate: true });

  watch(() => props.room.identifier, supervisorStateSubscription.sync, { flush: "sync" });

  watch(() => props.repoStatus, () => {
    refreshedEnvironmentRepoStatus.value = null;
  });

  watch(addAgentModalOpen, (open) => {
    if (open) {
      void refreshSupervisorEntries();
    }
  });

  watch(() => actionPanelOpen.value || searchOpen.value, (toolSurfaceOpen) => {
    if (toolSurfaceOpen && environmentPanelOpen.value) {
      environmentPanelOpen.value = false;
    }
  });

  watch(
    () => [environmentPanelOpen.value, props.repoStatus.rootPath, props.room.identifier] as const,
    ([open]) => {
      if (!open) return;
      void refreshEnvironmentRepoStatus();
    },
    { immediate: true },
  );

  watch(() => props.openAddAgentRequested, (requested) => {
    if (!requested) return;
    openAddAgentModal();
    emit("add-agent-open-request-consumed");
  }, { immediate: true });

  watch(() => [showEventsTab.value, props.roomLoading] as const, ([visible, loading]) => {
    if (!visible && !loading && activeTab.value === "events") {
      activeTab.value = "chat";
    }
  }, { immediate: true });

  watch(isLocalRoom, (local) => {
    if (!local) return;
    if (activeTab.value === "rooms") {
      activeTab.value = "chat";
    }
  }, { immediate: true });

  watch(activeTab, (tab) => {
    rememberRoomActiveTab(props.room.identifier, tab);
  }, { flush: "sync" });
}

/** Attention navigation, notification reveal, and inspector work polling. */
export function useRoomShellAttention(context: unknown) {
  const {
    activeTab, agentInspectorInitialTab, agentInspectorWorkSourceMessageId, boardGovernanceSection,
    emit, eventsPage, loadAgentInspectorWorkDetail, openAgentDetailRequest, openBoardTask,
    openEventById, openReasoningInspector, props, revealRoomMessage, roomChatView,
    selectedAgentDetailTarget, supervisorEntries, supervisorEntriesHaveLoaded,
    supervisorEntriesState,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellInspectorActions"
    | "useRoomShellIntegrations"
    | "useRoomShellState"
    | "useRoomShellToolActions"
  >;
  useRoomAttentionNavigation({
    intent: () => props.attentionIntent, roomIdentifier: () => props.room.identifier, roomLoading: () => props.roomLoading,
    agentsSettled: () => supervisorEntriesHaveLoaded.value || supervisorEntriesState.value === "error", agents: () => supervisorEntries.value,
    activeTab, boardGovernanceSection, openBoardTask, openReasoning: openReasoningInspector,
    openThread: (threadRootId) => { activeTab.value = "chat"; void nextTick(() => roomChatView.value?.openThread(threadRootId)); },
    openEvent: (eventId, eventUrl) => {
      if (eventUrl && !eventsPage.value?.events.some(event => event.id === eventId)) void desktopIpc.app.openExternalUrl(eventUrl);
      else openEventById(eventId);
    },
    revealMessage: (messageId) => { activeTab.value = "chat"; void revealRoomMessage(messageId); },
    openAgentDiagnostics: (entry) => {
      openAgentDetailRequest(supervisedAgentInspectorRequest(entry, { ownerAttribution: ownerAttributionLabel(entry.createdBy) }));
      agentInspectorInitialTab.value = "diagnostics";
    },
    opened: () => emit("attention-opened"),
  });

  watch(
    () => [props.notificationRevealMessageId, props.notificationRevealNonce, props.roomLoading] as const,
    ([messageId, _nonce, roomLoading]) => {
      if (!messageId || roomLoading) return;
      activeTab.value = "chat";
      void revealRoomMessage(messageId);
    },
    { immediate: true },
  );

  // Read only while an inspector is open; quota changes need not produce room activity.
  watch(() => selectedAgentDetailTarget.value?.kind === "supervised" ? selectedAgentDetailTarget.value.supervisorEntryId : null,
    (entryId, _previous, onCleanup) => {
      if (!entryId) return;
      const timer = setInterval(() => {
        if (document.visibilityState === "hidden") return;
        void loadAgentInspectorWorkDetail(agentInspectorWorkSourceMessageId.value, true, false);
      }, 5_000);
      onCleanup(() => clearInterval(timer));
    });
}
