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
        :ticket-keys="storage.effectiveMode !== 'local'"
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
        @open-thread="openThreadFromBoard"
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
import { GitBranch } from "@lucide/vue";
import { nextTick, ref } from "vue";
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
import DesktopRoomControlRail from "./room-shell/DesktopRoomControlRail.vue";
import DesktopRoomHeader from "./room-shell/DesktopRoomHeader.vue";
import GitRoomEnvironmentPanel from "./room-shell/GitRoomEnvironmentPanel.vue";
import type { DesktopRoomShellEmits, DesktopRoomShellProps } from "../../../composables/room-shell/props";
import type { RoomShellContext } from "../../../composables/room-shell/context";
import { useRoomShellState } from "../../../composables/room-shell/useRoomShellState";
import { useRoomShellSupervisorActions, useRoomShellSupervisorSync } from "../../../composables/room-shell/useRoomShellSupervisor";
import { useRoomShellDeliveryActions } from "../../../composables/room-shell/useRoomShellDelivery";
import { useRoomShellToolActions, useRoomShellStorageWatcher } from "../../../composables/room-shell/useRoomShellTools";
import { useRoomShellInspectorActions, useRoomShellAgentProjections, useRoomShellInspectorWatchers, useRoomShellInspectorObservations } from "../../../composables/room-shell/useRoomShellAgentInspector";
import { useRoomShellInspectorSettings } from "../../../composables/room-shell/useRoomShellInspectorSettings";
import { useRoomShellInspectorRunActions } from "../../../composables/room-shell/useRoomShellInspectorActions";
import { useRoomShellConversation, useRoomShellIntegrations, useRoomShellNotifications } from "../../../composables/room-shell/useRoomShellConversation";
import { useRoomShellParticipants } from "../../../composables/room-shell/useRoomShellParticipants";
import { useRoomShellRoomWatchers, useRoomShellAttention } from "../../../composables/room-shell/useRoomShellWatchers";
import { useRoomShellLifecycle } from "../../../composables/room-shell/useRoomShellLifecycle";
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
  agentInspectorCompact, agentInspectorLiveFeed, agentInspectorWorkResource,
  agentInspectorWorkSourceMessageId, agentInspectorConfigurationResource,
  agentInspectorRoomMoveResource, agentInspectorProviders, agentInspectorSettingsConflict,
  rulesOpen, roomLinkCopied, deliveryRetryingKeys, continuationRepairingKeys,
  roomDeliverySkippingKeys, deliveryRetryAvailable, boardSelectedTaskId, boardGovernanceSection,
  activityHistoryRequest, artifactTimelineTaskFilterId, storageBusy, storageFeedback,
  githubEventsVisible, environmentPanelOpen, supervisorEntries, agentRosterState, supervisorStatus,
  agentInspectorRoomMoveAvailable, continuationRepairAvailable, roomDeliverySkipAvailable,
  selectedAgentDetailTarget,
} = Object.assign(app, useRoomShellState(app));
const {
  retryAgentInspectorState, refreshRoomAgents,
} = Object.assign(app, useRoomShellSupervisorActions(app));
const {
  retryRoomAgentDelivery, restoreAgentConversation, skipRoomDelivery, stopAgentTurnForApproval,
  postAgentAnswerNow,
} = Object.assign(app, useRoomShellDeliveryActions(app));
const {
  openBoardTask, rememberChatScrollPosition, selectTab, openArtifactsForTask,
  toggleGitHubEventsVisible, setEnvironmentPanelOpen, setRoomStorageMode, forkRoomToLocal,
  publishLocalRoom, toggleSearchTool, toggleActionPanel, closeActionPanel, openRules,
  openAddAgentModal, revealRoomMessage, revealRecordedWorkMessage, revealSharedLiveRequest,
  openAgentWorktree, copyRoomLink, exportChat,
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
const {
  runAgentInspectorAction,
} = Object.assign(app, useRoomShellInspectorRunActions(app));

Object.assign(app, useRoomShellStorageWatcher(app));

const {
  agentInspectorProjections, agentInspectorCorrectionRequest, correctableAgents,
  openAgentCorrectionOrInspector, openAgentCorrectionFromComposer, selectedAgentDetailProjection,
  applyAgentInspectorSettings, selectedAgentInspectorActionState,
  selectedAgentInspectorWorkArtifacts, deliveryReceiptsByMessage,
} = Object.assign(app, useRoomShellAgentProjections(app));

Object.assign(app, useRoomShellSupervisorSync(app));

const {
  roomUrl, messageNamespace, soundEnabled, notificationsEnabled, notificationPermission,
  toggleSound, toggleNotifications, sendingMessage, sendError, hasOlderMessages,
  loadingOlderMessages, olderMessagesError, hasFilteredRoomActivity, visibleMessages,
  timelineMessages, sendRoomMessage, discardAttachment, loadOlderMessages, searchOpen, searchQuery,
  searchResults, activeSearchMessageId, searchSummary, closeSearch, moveSearch,
} = Object.assign(app, useRoomShellConversation(app));

const {
  selectedReasoningSessionId, selectedReasoningSessionForInspector, openReasoningInspector,
  openAgentReasoningFallback, closeReasoningInspector, renameBusy, renameError, githubStatus,
  githubLoading, githubBusy, githubError, renameRoom, refreshGitHubIntegration,
  installGitHubIntegration, eventsPage, eventsLoading, eventsLoadingOlder, eventsError,
  eventsTaskFilterId, eventsSelectedEventId, eventsLoadedOlderWithoutMatches,
  composerGitHubEventPreviews, githubRepository, openEventsTab, refreshGitHubEvents,
  loadOlderGitHubEvents, openEventsForTask, clearEventsTaskFilter, closeSelectedGitHubEvent,
  openGitHubEventFromChat, openGitHubUrlExternally, dismissComposerGitHubEventPreview,
} = Object.assign(app, useRoomShellIntegrations(app));

const {
  githubEventsAvailable, showEnvironmentPanelWidget, effectiveEnvironmentRepoStatus,
  managedAgentRepoStatus, managedAgentRepoRootPath, roomParticipants, localAgentWork,
} = Object.assign(app, useRoomShellParticipants(app));

Object.assign(app, useRoomShellRoomWatchers(app));

Object.assign(app, useRoomShellAttention(app));

Object.assign(app, useRoomShellLifecycle(app));

// A card's "Linked threads" entry opens that thread in chat.
function openThreadFromBoard(threadRootId: string): void {
  activeTab.value = "chat";
  void nextTick(() => roomChatView.value?.openThread(threadRootId));
}

const {
  tabs,
} = Object.assign(app, useRoomShellNotifications(app));

Object.assign(app, useRoomShellInspectorWatchers(app));

const {
  refreshAgentInspectorDiagnostics, openAgentInspectorWork,
} = Object.assign(app, useRoomShellInspectorObservations(app));
</script>
