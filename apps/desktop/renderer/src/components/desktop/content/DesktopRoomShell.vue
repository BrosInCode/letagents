<template>
  <section
    class="desktop-room-shell"
    :data-agent-inspector-open="Boolean(selectedAgentDetailTarget && !agentInspectorCompact)"
    data-testid="desktop-room-shell"
  >
    <DesktopRoomHeader
      :sidebar-mode="sidebarMode"
      :room="room"
      :storage="storage"
      :tabs="tabs"
      :active-tab="activeTab"
      :attention="attention"
      @open-inbox="emit('open-inbox')"
      :search-open="searchOpen"
      :action-panel-open="actionPanelOpen"
      :project-connection-needed="Boolean(projectRoom && !durableProjectRootPath)"
      @cycle-sidebar="emit('cycle-sidebar')"
      @toggle-search="toggleSearchTool"
      @toggle-action-panel="toggleActionPanel"
      @select-tab="selectTab"
      @connect-project="emit('connect-project')"
    />

    <DesktopRoomControlRail
      v-model:search-query="searchQuery"
      :action-panel-open="actionPanelOpen"
      :search-open="searchOpen"
      :room="room"
      :storage="storage"
      :room-url="roomUrl"
      :copied="roomLinkCopied"
      :sound-enabled="soundEnabled"
      :notifications-enabled="notificationsEnabled"
      :notification-permission="notificationPermission"
      :rename-busy="renameBusy"
      :rename-error="renameError"
      :github-status="githubStatus"
      :github-loading="githubLoading"
      :github-busy="githubBusy"
      :github-error="githubError"
      :github-events-available="githubEventsAvailable"
      :github-events-visible="githubEventsVisible"
      :storage-busy="storageBusy"
      :storage-feedback="storageFeedback"
      :search-summary="searchSummary"
      :search-results-count="searchResults.length" @show-search-result="revealRoomMessage"
      @copy-room-link="copyRoomLink"
      @open-rules="openRules"
      @toggle-sound="toggleSound"
      @toggle-notifications="toggleNotifications"
      @toggle-github-events-visible="toggleGitHubEventsVisible"
      @set-room-storage-mode="setRoomStorageMode"
      @fork-room-to-local="forkRoomToLocal"
      @publish-local-room="publishLocalRoom"
      @rename-room="renameRoom"
      @refresh-github="refreshGitHubIntegration"
      @install-github="installGitHubIntegration"
      @export-chat="exportChat"
      @move-search="moveSearch"
      @close-search="closeSearch"
      @close-action-panel="closeActionPanel"
    />

    <div
      v-if="showEnvironmentPanelWidget"
      class="desktop-room-environment-popover"
      data-testid="desktop-room-environment-popover"
    >
      <DesktopFloatingWidget
        :open="environmentPanelOpen"
        label="Work"
        test-id="desktop-room-environment-widget"
        @update:open="setEnvironmentPanelOpen"
      >
        <template #icon>
          <GitBranch :size="18" aria-hidden="true" />
        </template>
        <GitRoomEnvironmentPanel
          :room="room"
          :repo-status="effectiveEnvironmentRepoStatus"
          :git-room-matches-active-repo="gitRoomMatchesActiveRepo"
          :room-artifacts="roomArtifacts"
          :github-events="eventsPage"
          @open-repo-root="emit('open-repo-root', $event)"
          @open-pull-request="openGitHubUrlExternally"
        />
      </DesktopFloatingWidget>
    </div>

    <RoomChatView
      ref="roomChatView"
      v-show="activeTab === 'chat'"
      :active="activeTab === 'chat'"
      :messages="timelineMessages"
      :thread-messages="visibleMessages"
      :message-namespace="messageNamespace"
      :composer-event-previews="composerGitHubEventPreviews"
      :has-filtered-room-activity="hasFilteredRoomActivity"
      :room-identifier="room.identifier"
      :github-events-visible="githubEventsVisible"
      :github-events-available="githubEventsAvailable"
      :room-loading="roomLoading"
      :sending="sendingMessage"
      :send-error="sendError"
      :participants="roomParticipants"
      :presence="presence"
      v-bind="{ roomAgentWork, roomAgentWorkStatus, roomAgentWorkTruncated, hasOlderMessages, loadingOlderMessages, olderMessagesError }"
      :local-agent-work="localAgentWork"
      :delivery-receipts-by-message="deliveryReceiptsByMessage"
      :delivery-recovery-available="deliveryRetryAvailable"
      :continuation-repair-available="continuationRepairAvailable"
      :room-delivery-skip-available="roomDeliverySkipAvailable"
      :delivery-retry-keys="deliveryRetryingKeys"
      :continuation-repair-keys="continuationRepairingKeys"
      :room-delivery-skip-keys="roomDeliverySkippingKeys"
      :revealed-message-id="revealedMessageId"
      :reasoning-sessions="reasoningSessions"
      :tasks="tasks"
      :supervisor-entries="supervisorEntries"
      :correctable-agents="correctableAgents"
      :search-query="searchQuery"
      :active-search-message-id="activeSearchMessageId"
      :initial-scroll-position="initialChatScrollPosition ?? null"
      @send-message="sendRoomMessage"
      @discard-attachment="discardAttachment"
      @load-older="loadOlderMessages"
      @open-reasoning="openReasoningInspector"
      @open-agent-reasoning-fallback="openAgentReasoningFallback"
      @open-agent-detail="openAgentDetailFromParticipant"
      @open-agent-correction="openAgentCorrectionFromComposer"
      @open-add-agent="openAddAgentModal"
      @restore-conversation="restoreAgentConversation"
      @skip-delivery="skipRoomDelivery"
      @retry-delivery="retryRoomAgentDelivery"
      @reveal-message="revealRoomMessage"
      @message-reveal-unavailable="emit('message-reveal-unavailable', $event)"
      @stop-agent-turn="stopAgentTurnForApproval"
      @post-agent-answer-now="postAgentAnswerNow"
      @open-events="openEventsTab"
      @open-github-event="openGitHubEventFromChat" @open-person="(target, position) => personActions?.open(target, position)"
      @open-task="openBoardTask"
      @dismiss-event-preview="dismissComposerGitHubEventPreview"
      @scroll-position="rememberChatScrollPosition"
    />

    <Transition name="room-panel" mode="out-in">
      <RoomMemoryView v-if="activeTab === 'memory'" :key="`memory:${messageNamespace}`" :room-identifier="room.identifier" @open-message="(id) => { activeTab = 'chat'; revealRoomMessage(id); }" />
      <RoomBoardView
        v-else-if="activeTab === 'board'"
        key="board"
        :room-identifier="room.identifier"
        :tasks="tasks"
        :board-settings="boardSettings"
        :can-edit-tasks="canManageRoomBoard(room.role)"
        :presence="presence"
        :workers="workers"
        :supervisor-entries="supervisorEntries"
        :selected-task-id="boardSelectedTaskId"
        :governance-section="boardGovernanceSection" @update:governance-section="boardGovernanceSection = $event"
        @task-updated="emit('task-updated', $event)"
        @refresh-room="emit('refresh-room')"
        @update:selected-task-id="boardSelectedTaskId = $event"
        @view-events="openEventsForTask"
        @view-artifacts="openArtifactsForTask"
      />

      <RoomEventsView
        v-else-if="activeTab === 'events'"
        key="events"
        :room-identifier="room.identifier"
        :events-page="eventsPage"
        :repository="githubRepository"
        :current-branch="repoStatus.branch"
        :github-connected="Boolean(githubStatus?.connected)"
        :github-loading="githubLoading"
        :github-busy="githubBusy"
        :github-error="githubError"
        :loading="eventsLoading"
        :loading-older="eventsLoadingOlder"
        :error="eventsError"
        :linked-task-id="eventsTaskFilterId"
        :selected-event-id="eventsSelectedEventId"
        :loaded-older-without-matches="eventsLoadedOlderWithoutMatches"
        @refresh="refreshGitHubEvents"
        @load-older="loadOlderGitHubEvents"
        @install-github="installGitHubIntegration"
        @clear-task-filter="clearEventsTaskFilter"
        @open-task="openBoardTask"
        @close-selected-event="closeSelectedGitHubEvent"
      />

      <RoomActivityTabView
        v-else-if="activeTab === 'activity'"
        key="activity"
        :recent-activity="recentActivity"
        :participants="roomParticipants"
        :live-cleared-count="participantHiddenCount"
        :presence="presence"
        :reasoning-sessions="reasoningSessions"
        :room-git-room="room.gitRoom"
        :room-identifier="room.identifier"
        :room-artifacts="roomArtifacts"
        :room-agent-work="roomAgentWork"
        :room-agent-work-status="roomAgentWorkStatus"
        :room-agent-work-truncated="roomAgentWorkTruncated"
        :activity-history-request="activityHistoryRequest"
        :artifact-task-filter-id="artifactTimelineTaskFilterId"
        :tasks="tasks"
        :messages="visibleMessages"
        :workers="workers"
        :supervisor-entries="supervisorEntries"
        :agent-projections="agentInspectorProjections"
        :agent-roster-state="agentRosterState"
        @open-reasoning="openReasoningInspector"
        @open-add-agent="openAddAgentModal"
        @open-agent-detail="openAgentDetailRequest"
        @open-agent-correction="openAgentCorrectionOrInspector" @open-person="(target, position, action) => personActions?.open(target, position, action)" :viewer-login="viewerLogin"
        @refresh-room="refreshRoomAgents"
        @reveal-message="revealRecordedWorkMessage"
        @clear-artifact-task-filter="artifactTimelineTaskFilterId = null"
      />

      <RoomDetailsView
        v-else-if="activeTab === 'rooms'"
        key="rooms"
        :room="room"
        :focus-rooms="focusRooms"
        :tasks="tasks"
        :on-focus-room-concluded="onFocusRoomConcluded"
        @open-focus-room="emit('open-focus-room', $event)"
        @refresh-room="emit('refresh-room')"
        @request-focus-room-conclusion="emit('request-focus-room-conclusion', $event)"
      />

    </Transition>

    <DesktopRoomRulesModal
      :open="rulesOpen"
      @close="rulesOpen = false"
    />

    <DesktopReasoningInspector
      :open="Boolean(selectedReasoningSessionId && selectedReasoningSessionForInspector)"
      :room-identifier="room.identifier"
      :session="selectedReasoningSessionForInspector"
      @close="closeReasoningInspector"
    />

    <AgentInspectorHost
      v-if="selectedAgentDetailTarget"
      :open="true"
      :projection="selectedAgentDetailProjection"
      :daemon-status="supervisorStatus"
      :refresh-diagnostics="refreshAgentInspectorDiagnostics"
      :selection="selectedAgentDetailTarget"
      :presence="presence"
      :presence-fresh="sourceStates?.presence.status !== 'error'"
      :viewer-login="viewerLogin"
      :action-state="selectedAgentInspectorActionState"
      :work-resource="agentInspectorWorkResource"
      :selected-work-source-message-id="agentInspectorWorkSourceMessageId"
      :work-artifacts="selectedAgentInspectorWorkArtifacts"
      :settings-resource="agentInspectorConfigurationResource"
      :room-move-resource="agentInspectorRoomMoveResource"
      :room-move-available="agentInspectorRoomMoveAvailable"
      :providers="agentInspectorProviders"
      :destinations="focusRooms.filter((candidate) => candidate.identifier !== room.identifier)"
      :settings-conflict="agentInspectorSettingsConflict"
      :live-feed="agentInspectorLiveFeed"
      :room-identifier="room.identifier"
      :room-display-name="room.displayName || room.name"
      :request-version="selectedAgentDetailRequestVersion"
      :initial-tab="agentInspectorInitialTab" v-bind="{ roomAgentWork, roomAgentWorkStatus, workspaceSourceMessageId: selectedAgentDetailTarget?.workspaceSourceMessageId }"
      :reasoning-sessions="reasoningSessions"
      :live-activity-sessions="liveActivitySessions ?? []"
      :correction-request="agentInspectorCorrectionRequest"
      @close="closeAgentDetail"
      @retry="retryAgentInspectorState"
      @live-selected="openAgentInspectorLive"
      @live-dismissed="stopAgentInspectorLive"
      @action="runAgentInspectorAction"
      @open-reasoning="openReasoningFromAgentDetail"
      @presentation-change="agentInspectorCompact = $event"
      @work-selected="openAgentInspectorWork"
      @work-retry="loadAgentInspectorWorkDetail(agentInspectorWorkSourceMessageId, true)"
      @work-source-select="selectAgentInspectorWorkSource"
      @reveal-message="revealAgentInspectorWorkMessage"
      @reveal-live-request="revealSharedLiveRequest"
      @settings-selected="openAgentInspectorSettings"
      @settings-patch="patchAgentInspectorSettings"
      @settings-save="saveAgentInspectorSettings"
      @settings-apply="applyAgentInspectorSettings"
      @settings-reload="reloadAgentInspectorSettings"
      @room-move-prepare="prepareAgentInspectorRoomMove"
      @room-move-commit="commitAgentInspectorRoomMove"
      @retire="retireAgentInspectorAgent"
      @purge="purgeAgentInspectorAgent"
    />

    <PersonActionsHost ref="personActions" :viewer-login="viewerLogin" :room-identifier="room.identifier" @open-messages-with="emit('open-messages-with', $event)" @work-open="selectedAgentDetailRequest && closeAgentDetail(); selectedReasoningSessionId && closeReasoningInspector()" />
    <AddAgentModal
      :room-storage-mode="storage.effectiveMode"
      :open="addAgentModalOpen"
      :room-identifier="room.identifier"
      :room-git-room="room.gitRoom"
      :room-display-name="room.displayName"
      :git-room-matches-active-repo="gitRoomMatchesActiveRepo"
      :repo-root-path="managedAgentRepoRootPath"
      :repo-status="managedAgentRepoStatus"
      @close="addAgentModalOpen = false"
      @choose-worktree="openAgentWorktree"
    />
  </section>
</template>

<script setup lang="ts">
import { roomAgentRecoveryAction } from "../../../domain/room-agent-delivery";
import { GitBranch } from "@lucide/vue";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopSupervisorManifestEntry } from "../../../../../electron/ipc-types";
import { appendAgentInspectorLiveBatch } from "../../../domain/agent-inspector-live";
import { roomMentionCandidates } from "../../../domain/participants";
import { supervisedAgentInspectorRequest } from "../../../domain/agent-inspector-identity";
import { agentInspectorActionErrorMessage, actionProgressMessage, actionSuccessMessage } from "../../../domain/agent-inspector-presentation";
import {
  clearAgentInspectorActionStateIfMatching,
  agentInspectorTurnControlActionId,
  agentInspectorTurnControlActionIdIfCurrent,
  agentInspectorRetryableTurnControlInput,
  agentInspectorTurnControlFenceMatches,
  type AgentInspectorTurnControlFence,
  type AgentInspectorActionIntent,
} from "../../../domain/agent-inspector";
import { isStaleDaemonGenerationError } from "../../../domain/agent-inspector-settings";
import { emptyAgentInspectorWorkResource } from "../../../domain/agent-inspector-work";
import { foldSupervisorActivityPush } from "../../../domain/supervisor-entries-resource";
import AddAgentModal from "./AddAgentModal.vue";
import AgentInspectorHost from "./agent-inspector/AgentInspectorHost.vue";
import DesktopReasoningInspector from "./DesktopReasoningInspector.vue";
import DesktopFloatingWidget from "../controls/DesktopFloatingWidget.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import PersonActionsHost from "./PersonActionsHost.vue";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import { canManageRoomBoard } from "./room-board/board-presentation";
import RoomChatView from "./RoomChatView.vue";
import RoomEventsView from "./RoomEventsView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";
import RoomMemoryView from "./RoomMemoryView.vue";
import { ownerAttribution as ownerAttributionLabel } from "./room-activity/agentTarget";
import DesktopRoomControlRail from "./room-shell/DesktopRoomControlRail.vue";
import DesktopRoomHeader from "./room-shell/DesktopRoomHeader.vue";
import GitRoomEnvironmentPanel from "./room-shell/GitRoomEnvironmentPanel.vue";
import { readEnvironmentPanelOpen, readGitHubEventsVisible } from "./room-shell/preferences";
import { useRoomAttentionNavigation } from "./room-shell/useRoomAttentionNavigation";
import { desktopIpc } from "../../../ipc/index.js";
import type { DesktopRoomShellEmits, DesktopRoomShellProps } from "../../../composables/room-shell/props";
import type { RoomShellContext } from "../../../composables/room-shell/context";
import { useRoomShellState } from "../../../composables/room-shell/useRoomShellState";
import { useRoomShellSupervisorActions, useRoomShellSupervisorSync } from "../../../composables/room-shell/useRoomShellSupervisor";
import { useRoomShellDeliveryActions } from "../../../composables/room-shell/useRoomShellDelivery";
import { useRoomShellToolActions, useRoomShellStorageWatcher } from "../../../composables/room-shell/useRoomShellTools";
import { useRoomShellInspectorActions, useRoomShellAgentProjections, useRoomShellInspectorWatchers, useRoomShellInspectorObservations } from "../../../composables/room-shell/useRoomShellAgentInspector";
import { useRoomShellInspectorSettings } from "../../../composables/room-shell/useRoomShellInspectorSettings";
import { useRoomShellConversation, useRoomShellIntegrations, useRoomShellNotifications } from "../../../composables/room-shell/useRoomShellConversation";
import { useRoomShellParticipants } from "../../../composables/room-shell/useRoomShellParticipants";
const props = defineProps<DesktopRoomShellProps>();
const emit = defineEmits<DesktopRoomShellEmits>();

// The shell holds the layout template and this wiring. The context fills in the
// original order: props and emit, state, then the function composables (only
// function definitions, like the hoisted declarations they came from), then each
// watcher and composable slice exactly where its code used to run.
const app = {} as RoomShellContext;
Object.assign(app, { props, emit });
const {
  personActions, activeTab, roomChatView, revealedMessageId, actionPanelOpen, addAgentModalOpen,
  selectedAgentDetailRequest, selectedAgentDetailRequestVersion, agentInspectorInitialTab,
  agentInspectorActionState, agentInspectorCompact, agentInspectorRequestState,
  agentInspectorLiveFeed, agentInspectorWorkResource, agentInspectorWorkSourceMessageId,
  agentInspectorConfigurationResource, agentInspectorRoomMoveResource, agentInspectorProviders,
  agentInspectorSettingsConflict, agentInspectorBackgroundRefresh, agentInspectorDetailRequest,
  rulesOpen, roomLinkCopied, deliveryRetryCoordinator, deliveryRetryingKeys,
  continuationRepairingKeys, roomDeliverySkippingKeys, deliveryRetryAvailable, boardSelectedTaskId,
  boardGovernanceSection, activityHistoryRequest, artifactTimelineTaskFilterId, storageBusy,
  storageFeedback, githubEventsVisible, environmentPanelOpen, refreshedEnvironmentRepoStatus,
  supervisorEntries, supervisorEntriesState, supervisorEntriesError, supervisorEntriesHaveLoaded,
  agentRosterState, supervisorEntriesUpdatedAt, supervisorStatus, supervisorSyncState,
  agentInspectorRoomMoveAvailable, continuationRepairAvailable, roomDeliverySkipAvailable,
  selectedAgentDetailTarget, readRoomActiveTab, supervisorGenerationChangedMessage,
} = Object.assign(app, useRoomShellState(app));
const {
  acceptSupervisorRetirementEvent, refreshSupervisorStatus, refreshSupervisorEntries,
  retryAgentInspectorState, refreshRoomAgents, upsertSupervisorEntry,
  scheduleSupervisorEntriesRepair, handleSupervisorEntriesVisibilityChange,
  stopSupervisorEntriesRefreshTimer,
} = Object.assign(app, useRoomShellSupervisorActions(app));
const {
  retryRoomAgentDelivery, restoreAgentConversation, skipRoomDelivery, stopAgentTurnForApproval,
  postAgentAnswerNow,
} = Object.assign(app, useRoomShellDeliveryActions(app));
const {
  openBoardTask, rememberChatScrollPosition, selectTab, rememberRoomActiveTab,
  openArtifactsForTask, toggleGitHubEventsVisible, setEnvironmentPanelOpen,
  refreshEnvironmentRepoStatus, setRoomStorageMode, forkRoomToLocal, publishLocalRoom,
  toggleSearchTool, toggleActionPanel, closeActionPanel, openRules, openAddAgentModal,
  revealRoomMessage, revealRecordedWorkMessage, revealSharedLiveRequest, openAgentWorktree,
  copyRoomLink, exportChat,
} = Object.assign(app, useRoomShellToolActions(app));
const {
  openAgentDetailFromParticipant, openAgentDetailRequest, closeAgentDetail, openAgentInspectorLive,
  stopAgentInspectorLive, selectAgentInspectorWorkSource, loadAgentInspectorWorkDetail,
  revealAgentInspectorWorkMessage, openReasoningFromAgentDetail,
} = Object.assign(app, useRoomShellInspectorActions(app));
const {
  reloadAgentInspectorSettings, openAgentInspectorSettings, patchAgentInspectorSettings,
  saveAgentInspectorSettings, prepareAgentInspectorRoomMove, commitAgentInspectorRoomMove,
  retireAgentInspectorAgent, purgeAgentInspectorAgent,
} = Object.assign(app, useRoomShellInspectorSettings(app));
// Functions still in DesktopRoomShell.vue are hoisted, so they join the context first.
Object.assign(app, {
  runAgentInspectorAction,
});

Object.assign(app, useRoomShellStorageWatcher(app));

const {
  agentPauseRequests, agentInspectorProjections, agentInspectorCorrectionRequest,
  correctableAgents, openAgentCorrectionOrInspector, openAgentCorrectionFromComposer,
  releaseAgentCorrectionRequest, selectedAgentDetailProjection, applyAgentInspectorSettings,
  selectedAgentInspectorActionState, selectedAgentInspectorWorkArtifacts,
  deliveryReceiptsByMessage,
} = Object.assign(app, useRoomShellAgentProjections(app));

const {
  supervisorStateSubscription,
} = Object.assign(app, useRoomShellSupervisorSync(app));

let unsubscribeSupervisorActivity: (() => void) | null = null;

let unsubscribeSupervisorAgentStream: (() => void) | null = null;

let unsubscribeSupervisorRetirement: (() => void) | null = null;

const {
  roomUrl, isLocalRoom, messageNamespace, soundEnabled, notificationsEnabled,
  notificationPermission, toggleSound, toggleNotifications, sendingMessage, sendError,
  hasOlderMessages, loadingOlderMessages, olderMessagesError, hasFilteredRoomActivity,
  visibleMessages, timelineMessages, sendRoomMessage, discardAttachment, loadOlderMessages,
  searchOpen, searchQuery, searchResults, activeSearchMessageId, searchSummary, closeSearch,
  moveSearch,
} = Object.assign(app, useRoomShellConversation(app));

const {
  selectedReasoningSessionId, selectedReasoningSessionForInspector, openReasoningInspector,
  openAgentReasoningFallback, closeReasoningInspector, renameBusy, renameError, githubStatus,
  githubLoading, githubBusy, githubError, renameRoom, refreshGitHubIntegration,
  installGitHubIntegration, eventsPage, eventsLoading, eventsLoadingOlder, eventsError,
  eventsTaskFilterId, eventsSelectedEventId, eventsLoadedOlderWithoutMatches,
  composerGitHubEventPreviews, githubRepository, showEventsTab, openEventsTab, refreshGitHubEvents,
  loadOlderGitHubEvents, openEventsForTask, openEventById, clearEventsTaskFilter,
  closeSelectedGitHubEvent, openGitHubEventFromChat, openGitHubUrlExternally,
  dismissComposerGitHubEventPreview,
} = Object.assign(app, useRoomShellIntegrations(app));

const {
  githubEventsAvailable, showEnvironmentPanelWidget, effectiveEnvironmentRepoStatus,
  managedAgentRepoStatus, managedAgentRepoRootPath, roomParticipants, localAgentWork,
} = Object.assign(app, useRoomShellParticipants(app));

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

const {
  tabs,
} = Object.assign(app, useRoomShellNotifications(app));

Object.assign(app, useRoomShellInspectorWatchers(app));

const {
  refreshAgentInspectorDiagnostics, openAgentInspectorWork,
} = Object.assign(app, useRoomShellInspectorObservations(app));

function currentAgentInspectorActionIdentity(
  operationId: string,
  intent: AgentInspectorActionIntent,
  requestVersion: number,
): boolean {
  return props.room.identifier === intent.roomId
    && selectedAgentDetailRequestVersion.value === requestVersion
    && selectedAgentDetailTarget.value?.kind === "supervised"
    && selectedAgentDetailTarget.value.supervisorEntryId === intent.entryId
    && agentInspectorActionState.value?.operationId === operationId;
}

function currentAgentInspectorAction(
  operationId: string,
  intent: AgentInspectorActionIntent,
  requestVersion: number,
  daemonGeneration: number | null,
): boolean {
  return currentAgentInspectorActionIdentity(operationId, intent, requestVersion)
    && (daemonGeneration === null || supervisorStatus.value?.generation === daemonGeneration);
}

async function runAgentInspectorAction(intent: AgentInspectorActionIntent): Promise<void> {
  // Recovery options is local navigation; only a chosen runtime action may reach IPC.
  if (intent.kind === "recovery_options") return;
  if (agentInspectorActionState.value?.status === "running" && agentInspectorActionState.value.entryId === intent.entryId) return;
  if (intent.roomId !== props.room.identifier) return;
  const projection = agentInspectorProjections.value.find((candidate) => candidate.entryId === intent.entryId);
  if (!projection) return;
  if (intent.kind === "recover" && roomAgentRecoveryAction(projection.entry) !== "recover") return;
  const turnControlIntent = intent.kind === "stop_turn" || intent.kind === "steer_turn" || intent.kind === "retry_turn_control" || intent.kind === "resolve_turn_control";
  const actionAvailable = projection.actions.some((action) => action.kind === intent.kind && action.available);
  const turnControlAvailable = projection.resourceFreshness === "fresh" && (intent.kind === "stop_turn"
    ? projection.turnControl?.canStop === true
    : intent.kind === "steer_turn"
      ? projection.turnControl?.canCorrect === true && Boolean(intent.correction?.trim())
      : intent.kind === "retry_turn_control"
        ? projection.turnControl?.canRetry === true
      : intent.kind === "resolve_turn_control"
        ? projection.turnControl?.canResolve === true && Boolean(intent.turnControlResolution)
        : false);
  if (!actionAvailable && (!turnControlIntent || !turnControlAvailable)) return;
  // The handed-over text is now the person's own correction; never refill it.
  if (intent.kind === "steer_turn") releaseAgentCorrectionRequest({ restoreComposerText: false });

  if (intent.kind === "mention") {
    const participant = roomParticipants.value.find((candidate) =>
      candidate.kind === "agent"
      && candidate.participantKey === `desktop-supervisor-agent:${projection.entryId}`
      && Boolean(projection.agentKey)
      && candidate.agentKey === projection.agentKey);
    const mention = participant
      ? roomMentionCandidates(
          roomParticipants.value,
          participant.displayName,
          roomParticipants.value.length + 1,
        ).find((candidate) => (
          candidate.kind === "agent"
          && candidate.participantKey === participant.participantKey
        ))
      : null;
    if (!mention || mention.insertText !== projection.mentionInsertText) {
      agentInspectorActionState.value = {
        operationId: globalThis.crypto.randomUUID(),
        entryId: intent.entryId,
        kind: intent.kind,
        status: "error",
        message: "This agent is not currently available in the room mention list.",
      };
      return;
    }
    if (intent.presentation === "compact") closeAgentDetail();
    activeTab.value = "chat";
    await nextTick();
    roomChatView.value?.focusComposerWithMention(mention.insertText);
    return;
  }

  const operationId = globalThis.crypto.randomUUID();
  const requestVersion = selectedAgentDetailRequestVersion.value;
  agentInspectorActionState.value = {
    operationId,
    entryId: intent.entryId,
    kind: intent.kind,
    status: "running",
    message: actionProgressMessage(intent.kind),
  };
  let operationDaemonGeneration: number | null = null;
  let turnControlFence: AgentInspectorTurnControlFence | null = null;
  let refreshedDuringOperation = false;
  try {
    let updated: DesktopSupervisorManifestEntry | null = null;
    if (intent.kind === "pause") {
      updated = await agentPauseRequests.run(
        intent.entryId,
        () => desktopIpc.supervisor.setDesiredState(intent.entryId, "paused"),
      );
    } else if (intent.kind === "resume") {
      agentPauseRequests.clear(intent.entryId);
      updated = await desktopIpc.supervisor.setDesiredState(intent.entryId, "running");
    } else if (intent.kind === "recover") {
      updated = await desktopIpc.supervisor.recoverAgentRuntime({ entryId: intent.entryId });
    } else if (["reconnect_runtime", "restart_runtime", "fresh_runtime"].includes(intent.kind)) {
      const status = await refreshSupervisorStatus();
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (!status?.capabilities.agentRuntimeRecoveryV2) throw new Error("Update the background service to use runtime recovery controls.");
      const pending = projection.entry.runtimeRecovery;
      const executionGenerationId = pending?.executionGenerationId ?? projection.entry.executionGenerationId;
      const runtimeGenerationId = pending?.runtimeGenerationId ?? projection.entry.runtimeGenerationId;
      if (!executionGenerationId || !runtimeGenerationId) throw new Error("The runtime changed. Refresh checks before recovering it.");
      updated = await desktopIpc.supervisor.recoverAgentRuntime({ entryId: intent.entryId, recovery: {
        mode: intent.kind === "reconnect_runtime" ? "reconnect" : intent.kind === "restart_runtime" ? "resume" : "fresh",
        operationId: pending?.operationId ?? operationId, roomId: intent.roomId, executionGenerationId, runtimeGenerationId,
      } });
    } else if (intent.kind === "retire_agent") {
      const status = await refreshSupervisorStatus();
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (!status?.capabilities.agentLifecycle || !desktopIpc.supervisor.retireAgent) throw new Error("This supervisor does not support durable retirement.");
      operationDaemonGeneration = status.generation;
      agentInspectorActionState.value = {
        ...agentInspectorActionState.value!,
        daemonGeneration: operationDaemonGeneration,
      };
      const receipt = await desktopIpc.supervisor.retireAgent({
        operationId,
        entryId: intent.entryId,
        daemonGeneration: operationDaemonGeneration,
      });
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (receipt.status !== "accepted" || receipt.operationId !== operationId
        || receipt.entryId !== intent.entryId || receipt.daemonGeneration !== operationDaemonGeneration) {
        throw new Error("The supervisor returned an invalid retirement receipt.");
      }
      if (agentInspectorActionState.value?.status !== "running") return;
      agentInspectorActionState.value = {
        ...agentInspectorActionState.value!,
        message: "Retirement accepted. Finishing credential cleanup…",
      };
      return;
    } else if (intent.kind === "reconnect") {
      updated = await desktopIpc.supervisor.reconnectAgent({ entryId: intent.entryId });
    } else if (intent.kind === "stop_turn" || intent.kind === "steer_turn" || intent.kind === "retry_turn_control" || intent.kind === "resolve_turn_control") {
      const entry = projection.entry;
      const control = projection.turnControl;
      const status = await refreshSupervisorStatus();
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (!status || !control
        || (intent.kind !== "resolve_turn_control" && (!entry.workAttemptId || !entry.executionGenerationId))) {
        throw new Error("The active turn changed. Refresh and try again.");
      }
      operationDaemonGeneration = status.generation;
      if (intent.kind === "resolve_turn_control") {
        if (!control.actionId || !control.workAttemptId || !control.executionGenerationId
          || !intent.turnControlResolution) {
          throw new Error("The uncertain turn-control record changed. Refresh and try again.");
        }
        const latestControl = agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.turnControl ?? null;
        if (latestControl?.status !== "uncertain"
          || latestControl.actionId !== control.actionId
          || latestControl.workAttemptId !== control.workAttemptId
          || latestControl.executionGenerationId !== control.executionGenerationId) {
          throw new Error("The uncertain turn-control record changed. Refresh and try again.");
        }
        updated = await desktopIpc.supervisor.resolveTurnControl({
          entryId: entry.id,
          workAttemptId: control.workAttemptId,
          executionGenerationId: control.executionGenerationId,
          actionId: control.actionId,
          resolution: intent.turnControlResolution,
        });
      } else if (intent.kind === "retry_turn_control") {
        const retryInput = agentInspectorRetryableTurnControlInput(entry, control, status.generation);
        if (!retryInput) {
          throw new Error("The retryable turn-control record changed. Refresh and try again.");
        }
        const latestControl = agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.turnControl ?? null;
        if (latestControl?.status !== "retryable"
          || latestControl.actionId !== control.actionId
          || latestControl.workAttemptId !== control.workAttemptId
          || latestControl.executionGenerationId !== control.executionGenerationId) {
          throw new Error("The retryable turn-control record changed. Refresh and try again.");
        }
        await desktopIpc.supervisor.controlTurn(retryInput);
      } else {
        const currentWorkAttemptId = entry.workAttemptId;
        const currentExecutionGenerationId = entry.executionGenerationId;
        if (!currentWorkAttemptId || !currentExecutionGenerationId) {
          throw new Error("The active turn changed. Refresh and try again.");
        }
        const exactTurnControlFence: AgentInspectorTurnControlFence = {
          entryId: entry.id,
          roomId: entry.roomId,
          workAttemptId: currentWorkAttemptId,
          executionGenerationId: currentExecutionGenerationId,
          providerTurnId: control.providerTurnId,
          inboxItemId: entry.roomAgentState?.turn.inboxItemId ?? null,
          sourceMessageId: entry.roomAgentState?.turn.sourceMessageId ?? null,
          daemonGeneration: status.generation,
        };
        turnControlFence = exactTurnControlFence;
        if (!entry.providerContinuationId || !exactTurnControlFence.providerTurnId
          || !exactTurnControlFence.inboxItemId || !exactTurnControlFence.sourceMessageId) {
          throw new Error("The exact room turn is no longer available. Refresh and try again.");
        }
        const currentEntry = agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.entry ?? null;
        if (!agentInspectorTurnControlFenceMatches(exactTurnControlFence, currentEntry, supervisorStatus.value?.generation ?? null)) {
          throw new Error("The active turn changed. Refresh and try again.");
        }
        const correction = intent.kind === "steer_turn" ? intent.correction?.trim() || null : null;
        if (intent.kind === "steer_turn" && !correction) throw new Error("Write a correction before applying it.");
        const actionId = await agentInspectorTurnControlActionIdIfCurrent(
            agentInspectorTurnControlActionId({
              entryId: entry.id,
              roomId: entry.roomId,
              workAttemptId: currentWorkAttemptId,
              executionGenerationId: currentExecutionGenerationId,
              actionSequence: entry.lastTurnControlSequence + 1,
              providerTurnId: control.providerTurnId,
              inboxItemId: entry.roomAgentState?.turn.inboxItemId ?? null,
              sourceMessageId: entry.roomAgentState?.turn.sourceMessageId ?? null,
              correction,
            }),
            () => {
              // A supervisor push can arrive while the digest yields. Re-read
              // the projected entry rather than trusting the pre-digest object.
              const currentEntryAfterDigest = agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.entry ?? null;
              return currentAgentInspectorAction(operationId, intent, requestVersion, operationDaemonGeneration)
                && agentInspectorTurnControlFenceMatches(exactTurnControlFence, currentEntryAfterDigest, supervisorStatus.value?.generation ?? null);
            },
        );
        if (!actionId) {
          // The post-digest fence rejected this operation. Clear only this
          // matching action so controls recover, never a newer user action.
          if (currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) {
            agentInspectorActionState.value = clearAgentInspectorActionStateIfMatching(agentInspectorActionState.value, operationId);
          }
          return;
        }
        await desktopIpc.supervisor.controlTurn({
          entryId: entry.id,
          daemonGeneration: exactTurnControlFence.daemonGeneration,
          roomId: exactTurnControlFence.roomId,
          workAttemptId: currentWorkAttemptId,
          executionGenerationId: currentExecutionGenerationId,
          providerContinuationId: entry.providerContinuationId,
          providerTurnId: exactTurnControlFence.providerTurnId,
          inboxItemId: exactTurnControlFence.inboxItemId,
          sourceMessageId: exactTurnControlFence.sourceMessageId,
          actionId,
          actionSequence: entry.lastTurnControlSequence + 1,
          correction,
        });
      }
    } else if (intent.kind === "retry_delivery") {
      const entry = projection.entry;
      if (!intent.sourceMessageId || !entry.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) {
        throw new Error("The delivery binding changed. Refresh and try again.");
      }
      const sourceMessageId = intent.sourceMessageId;
      const workAttemptId = entry.workAttemptId;
      const executionGenerationId = entry.executionGenerationId;
      const agentSessionId = entry.agentSessionId;
      const retryResult = await deliveryRetryCoordinator.run({
        agentId: entry.id,
        sourceMessageId,
      }, async () => {
        await desktopIpc.supervisor.retryRoomDelivery({
          entryId: entry.id,
          roomId: intent.roomId,
          sourceMessageId,
          workAttemptId,
          executionGenerationId,
          agentSessionId,
        });
        await refreshSupervisorEntries();
        refreshedDuringOperation = true;
      });
      if (!retryResult.started) {
        if (currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) {
          agentInspectorActionState.value = clearAgentInspectorActionStateIfMatching(
            agentInspectorActionState.value,
            operationId,
          );
        }
        return;
      }
      if (!retryResult.ok) throw retryResult.error;
    } else if (intent.kind === "restore_conversation" || intent.kind === "skip_message") {
      const entry = projection.entry;
      if (!intent.sourceMessageId || !entry.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) {
        throw new Error("The delivery binding changed. Refresh and try again.");
      }
      const input = {
        entryId: entry.id,
        roomId: intent.roomId,
        sourceMessageId: intent.sourceMessageId,
        workAttemptId: entry.workAttemptId,
        executionGenerationId: entry.executionGenerationId,
        agentSessionId: entry.agentSessionId,
      };
      if (intent.kind === "restore_conversation") {
        if (!continuationRepairAvailable.value) throw new Error("Conversation restoration is not available.");
        await desktopIpc.supervisor.restoreAgentConversation(input);
      } else {
        if (!roomDeliverySkipAvailable.value) throw new Error("Safe message skipping is not available.");
        await desktopIpc.supervisor.skipRoomDelivery(input);
      }
    }
    if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
    const currentEntry = agentInspectorProjections.value.find((candidate) => candidate.entryId === intent.entryId)?.entry ?? null;
    if (!currentAgentInspectorAction(operationId, intent, requestVersion, operationDaemonGeneration)
      || (turnControlFence && !agentInspectorTurnControlFenceMatches(turnControlFence, currentEntry, supervisorStatus.value?.generation ?? null))) {
      // The request may have completed, but it no longer describes the exact
      // selected room/entry/generation/turn. Do not attach its outcome to the
      // Inspector; a fresh supervisor push owns the visible truth instead.
      if (currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) {
        agentInspectorActionState.value = null;
      }
      return;
    }
    if (updated) {
      upsertSupervisorEntry({
        entry: updated,
        roomIdentifier: intent.roomId,
        inspectorRequestVersion: requestVersion,
      });
    } else if (!refreshedDuringOperation) {
      await refreshSupervisorEntries();
    }
    if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
    agentInspectorActionState.value = {
      operationId,
      entryId: intent.entryId,
      kind: intent.kind,
      status: "success",
      message: actionSuccessMessage(intent.kind),
    };
  } catch (error) {
    if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
    if (intent.kind === "reconnect" || intent.kind === "reconnect_runtime") {
      // A failed credential reconnect may reveal a stopped runtime. Read the
      // existing fenced diagnostics so Overview offers the correct recovery.
      await refreshAgentInspectorDiagnostics().catch(() => false);
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
    }
    const refreshed = intent.kind === "retire_agent" ? await refreshSupervisorStatus() : supervisorStatus.value;
    agentInspectorActionState.value = {
      operationId,
      entryId: intent.entryId,
      kind: intent.kind,
      status: "error",
      message: intent.kind === "retire_agent"
        && (isStaleDaemonGenerationError(error) || (operationDaemonGeneration !== null && refreshed?.generation !== operationDaemonGeneration))
        ? supervisorGenerationChangedMessage
        : agentInspectorActionErrorMessage(intent.kind, error),
    };
  }
}
</script>
