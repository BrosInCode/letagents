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
      :offer-tour="offerTour && !roomLoading"
      @open-tour="openRoomTour"
      :pages-menu="pagesMenu"
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
      :action-panel-section="actionPanelSection"
      :search-open="searchOpen"
      :room="room"
      :storage="storage"
      :room-url="roomUrl"
      :api-url="apiUrl"
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
      :ticket-match="searchTicketMatch"
      @open-ticket-card="openSearchTicketCard"
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

    <div v-if="activeTab === 'chat' && !actionPanelOpen && !searchOpen" class="desktop-room-release-widget">
      <ReleaseQueueWidget :key="room.identifier" :room-id="room.identifier" :load="loadReleasePlanning" :open-external="desktopIpc.app.openExternalUrl" @select="openBoardTask" />
    </div>

    <TaskLinkPreview :room-id="room.identifier" :tasks="previewTasks" :active="activeTab === 'chat'" :accept="acceptPreviewTask" :open-external="desktopIpc.app.openExternalUrl" @open-board="openBoardTask">
    <template #description="{ text }"><MarkdownBlock :text="text" :mentions="false" preserve-paths /></template>
    <RoomChatView
      ref="roomChatView"
      @content-deleted="emit('content-deleted', $event)"
      v-show="activeTab === 'chat'"
      :active="activeTab === 'chat'"
      :messages="timelineMessages"
      :thread-messages="visibleMessages"
      :message-namespace="messageNamespace"
      :composer-event-previews="composerGitHubEventPreviews"
      :has-filtered-room-activity="hasFilteredRoomActivity"
      :room-identifier="room.identifier"
      :room-label="room.displayName || room.name"
      :viewer-name="viewerName"
      @open-tour="openRoomTour"
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
      :invite-bot="inviteBotContext"
      @send-message="sendRoomMessage"
      @discard-attachment="discardAttachment"
      @load-older="loadOlderMessages"
      @open-reasoning="openReasoningInspector"
      @open-agent-reasoning-fallback="openAgentReasoningFallback"
      @open-agent-detail="openAgentDetailFromParticipant"
      @steer-turn="steerComposerTurn"
      @open-add-agent="openAddAgentModal"
      @open-ask-agent="emit('open-ask-agent')"
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
    >
      <!-- Requests to join, for room admins: a pill above the composer, where the room asks things of you. -->
      <template #above-composer>
        <RoomAgentLaunchNotice v-if="launchNoticeView && latestRoomLaunch" ref="roomLaunchNotice" :key="latestRoomLaunch.id"
          :entry="latestRoomLaunch" :view="launchNoticeView" :avatar-in-flight="arrivingAgentId === latestRoomLaunch.id"
          @open="openSavedAgent(latestRoomLaunch.id, true)" @dismiss="savedRoomLaunch = null" />
        <div class="desktop-join-request-banner" data-testid="desktop-join-request-banner">
          <JoinRequestBanner
            v-if="joinRequestBannerAvailable"
            :key="props.room.identifier"
            :requests="joinRequestBanner"
            :busy="joinRequestBusy"
            :error="joinRequestError"
            :decision="joinRequestDecision"
            @approve="decideJoinRequest($event, 'approve')"
            @decline="decideJoinRequest($event, 'decline')"
            @dismiss="dismissJoinRequests"
            @open-requests="openJoinRequests"
          />
        </div>
        <!-- Invites this account made for a bot: waiting, or (from a Git Room) joined elsewhere. -->
        <div v-if="inviteBotContext" class="desktop-room-invite-pills">
          <RoomInvitePills :room-identifier="room.identifier" :connector-url="inviteBotContext.connectorUrl" @open-room="emit('open-room', $event)" />
        </div>
      </template>
    </RoomChatView>
    </TaskLinkPreview>

    <Transition name="room-panel" mode="out-in">
      <RoomMemoryView v-if="activeTab === 'memory'" :key="`memory:${messageNamespace}`" :room-identifier="room.identifier" @open-message="(id) => { activeTab = 'chat'; revealRoomMessage(id); }" />
      <RoomBoardView
        v-else-if="activeTab === 'board'"
        :key="`board:${room.identifier}`"
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
        @open-room-settings="openActionPanelAt"
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
        :readable="activeTab === 'events' && !roomLoading && sourceStates?.githubEvents?.status !== 'error' && !actionPanelOpen && !rulesOpen && !addAgentModalOpen && !selectedAgentDetailTarget && !selectedReasoningSessionId && !personActions?.isOpen"
        @presented="acknowledgeEvents"
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
        @history-visible="emit('activity-history-visible', $event)"
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

    <!-- Pinned pages stay alive once opened, so switching tabs keeps their state. They are
         hidden with visibility, not display: none, inside RoomPageView: Electron does not
         repaint a <webview> that attached or sat in a display: none parent. -->
    <RoomPageView
      v-for="page in keptPages"
      :key="`page:${room.identifier}:${page.id}`"
      :room-identifier="room.identifier"
      :page="page"
      :active="activeTab === roomPageTabId(page.id)"
      :can-manage="canManagePages"
      @review="pagePinFlow.review"
    />
    <PageConfirmSheet />
    <PageGrantSheet :sheet="pageGrantSheet" :busy="pageGrantBusy" :error="pageGrantError" @approve="pagePinFlow.approve" @cancel="pagePinFlow.cancel" />

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
      :initial-tab="agentInspectorInitialTab"
      v-bind="{ roomAgentWork, roomAgentWorkStatus, workspaceSourceMessageId: selectedAgentDetailTarget?.workspaceSourceMessageId, workspaceFilePath: selectedAgentDetailTarget?.workspaceFilePath }"
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

    <PersonActionsHost ref="personActions" :viewer-login="viewerLogin" :room-identifier="room.identifier" :tasks="tasks" :tasks-unavailable="roomLoading || sourceStates?.tasks.status === 'error'" @open-task="openBoardTask" @open-messages-with="emit('open-messages-with', $event)" @work-open="selectedAgentDetailRequest && closeAgentDetail(); selectedReasoningSessionId && closeReasoningInspector()" />
    <AddAgentModal
      v-if="supervisedAgentsSupported"
      :room-storage-mode="storage.effectiveMode"
      :open="addAgentModalOpen"
      :room-identifier="room.identifier"
      :room-git-room="room.gitRoom"
      :room-display-name="room.displayName"
      :git-room-matches-active-repo="gitRoomMatchesActiveRepo"
      :repo-root-path="managedAgentRepoRootPath"
      :repo-status="managedAgentRepoStatus"
      :initial-provider-id="addAgentInitialProviderId"
      :initial-section="addAgentInitialSection" :held-names="addAgentHeldNames"
      @close="closeAddAgentModal"
      @launch-saved="handleFullAgentSaved"
      @choose-worktree="openAgentWorktree"
    />
    <AddAgentUnavailableModal v-else :open="addAgentModalOpen" @close="closeAddAgentModal" />
    <RoomGuidedTour ref="roomGuide" :room-identifier="room.identifier" :room-loading="roomLoading" :viewer-name="viewerName" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, provide, ref, watch } from "vue";
import type { DesktopAgentProviderId, DesktopSupervisorManifestEntry } from "../../../../../electron/ipc-types";
import { composerAgentLaunchKey } from "./room-chat/composer-agent-launch";
import RoomAgentLaunchNotice from "./room-chat/RoomAgentLaunchNotice.vue";
import { captureAgentAvatarSource, flyAgentAvatar, type AgentAvatarFlightSource } from "./room-chat/agent-avatar-flight";
import { agentStartupView } from "../../../domain/agent-startup";
import { useNow } from "../../../composables/useNow";
import AddAgentModal from "./AddAgentModal.vue";
import AddAgentUnavailableModal from "./AddAgentUnavailableModal.vue";
import { supervisedAgentsSupported } from "../../../domain/supervised-agents-support";
import AgentInspectorHost from "./agent-inspector/AgentInspectorHost.vue";
import DesktopReasoningInspector from "./DesktopReasoningInspector.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import PersonActionsHost from "./PersonActionsHost.vue";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import TaskLinkPreview from "../../../../../../../shared/ui/board/TaskLinkPreview.vue";
import MarkdownBlock from "./formatting/MarkdownBlock.vue";
import { useRoomBoardController } from "./room-board/useRoomBoardController";
import { desktopBoardTask } from "./room-board/board-workspace-tasks";
import { canManageRoomBoard } from "./room-board/board-presentation";
import { taskForTicketQuery, ticketRefParts } from "./room-board/ticket-ref";
import RoomChatView from "./RoomChatView.vue";
import RoomGuidedTour from "./room-chat/RoomGuidedTour.vue";
import RoomEventsView from "./RoomEventsView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";
import RoomMemoryView from "./RoomMemoryView.vue";
import RoomPageView from "./room-pages/RoomPageView.vue";
import PageConfirmSheet from "./room-pages/PageConfirmSheet.vue";
import PageGrantSheet from "./room-pages/PageGrantSheet.vue";
import { roomPageActionsKey, useRoomPagePinFlow } from "./room-pages/room-page-admin";
import { roomPageTabId } from "./room-shell/types";
import DesktopRoomControlRail from "./room-shell/DesktopRoomControlRail.vue";
import DesktopRoomHeader from "./room-shell/DesktopRoomHeader.vue";
import ReleaseQueueWidget from "../../../../../../../shared/ui/board/ReleaseQueueWidget.vue";
import { desktopIpc } from "../../../ipc";
import JoinRequestBanner from "../../../../../../../shared/ui/JoinRequestBanner.vue";
import RoomInvitePills from "./asks/RoomInvitePills.vue";
import type { RoomInviteBotContext } from "./room-chat/RoomInviteBotPanel.vue";
import { remoteConnectorUrl } from "../settings/connectors";
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
import { useRoomShellJoinRequests } from "../../../composables/room-shell/useRoomShellJoinRequests";
import { provideBackgroundCommands } from "../../../composables/useBackgroundCommands";
import { supervisedAgentInspectorRequest } from "../../../domain/agent-inspector-identity";
import { ownerAttribution as backgroundCommandOwner } from "./room-activity/agentTarget";
const props = defineProps<DesktopRoomShellProps>();
const emit = defineEmits<DesktopRoomShellEmits>();
const roomGuide = ref<InstanceType<typeof RoomGuidedTour> | null>(null);
function openRoomTour() {
  void roomGuide.value?.open();
}
// "Invite a bot" in the composer's "+" menu: for a room on the server. A Git
// Room's panel lists invite rooms first; the server decides what an invite does.
const inviteBotContext = computed<RoomInviteBotContext | null>(() => {
  if (props.storage.effectiveMode === "local" || !props.room.identifier) return null;
  return {
    roomId: props.room.identifier,
    roomName: props.room.displayName || props.room.name || props.room.identifier,
    gitRoom: props.room.gitRoom !== null,
    admin: props.room.role === "admin",
    connectorUrl: remoteConnectorUrl(props.apiUrl),
  };
});
const previewBoard = useRoomBoardController({
  get roomIdentifier() { return props.room.identifier; },
  get tasks() { return props.tasks; },
  get presence() { return props.presence; },
  get workers() { return props.workers; },
  get canEditTasks() { return canManageRoomBoard(props.room.role); },
}, emit);
const previewTasks = computed(() => props.tasks.map(task => desktopBoardTask(task, props.presence, previewBoard.actionsFor(task))));
async function acceptPreviewTask(id: string) {
  const task = props.tasks.find(item => item.id === id);
  const action = task?.status === 'proposed' && previewBoard.actionsFor(task).find(item => item.targetStatus === 'accepted');
  return task && action ? previewBoard.runTaskAction(task, action) : false;
}

// The shell holds the layout template and this wiring. The context fills in the
// original order: props and emit, state, then the function composables (only
// function definitions, like the hoisted declarations they came from), then each
// watcher and composable slice exactly where its code used to run.
const app = {} as RoomShellContext;
Object.assign(app, { props, emit });
const {
  personActions, activeTab, roomChatView, revealedMessageId, actionPanelOpen, actionPanelSection, addAgentModalOpen,
  selectedAgentDetailRequest, selectedAgentDetailRequestVersion, agentInspectorInitialTab,
  agentInspectorCompact, agentInspectorLiveFeed, agentInspectorWorkResource,
  agentInspectorWorkSourceMessageId, agentInspectorConfigurationResource,
  agentInspectorRoomMoveResource, agentInspectorProviders, agentInspectorSettingsConflict,
  rulesOpen, roomLinkCopied, deliveryRetryingKeys, continuationRepairingKeys,
  roomDeliverySkippingKeys, deliveryRetryAvailable, boardSelectedTaskId, boardGovernanceSection,
  activityHistoryRequest, artifactTimelineTaskFilterId, storageBusy, storageFeedback,
  githubEventsVisible, supervisorEntries, agentRosterState, supervisorStatus,
  agentInspectorRoomMoveAvailable, continuationRepairAvailable, roomDeliverySkipAvailable,
  selectedAgentDetailTarget,
} = Object.assign(app, useRoomShellState(app));
const {
  retryAgentInspectorState, refreshRoomAgents, refreshSupervisorEntries,
} = Object.assign(app, useRoomShellSupervisorActions(app));
const {
  retryRoomAgentDelivery, restoreAgentConversation, skipRoomDelivery, stopAgentTurnForApproval,
  postAgentAnswerNow,
} = Object.assign(app, useRoomShellDeliveryActions(app));
const {
  openBoardTask, rememberChatScrollPosition, selectTab, openArtifactsForTask,
  toggleGitHubEventsVisible, setRoomStorageMode, forkRoomToLocal,
  publishLocalRoom, toggleSearchTool, toggleActionPanel, openActionPanelAt, closeActionPanel, openRules,
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
  runAgentInspectorAction, steerComposerTurn,
} = Object.assign(app, useRoomShellInspectorRunActions(app));

Object.assign(app, useRoomShellStorageWatcher(app));

const {
  agentInspectorProjections, agentInspectorCorrectionRequest, correctableAgents,
  openAgentCorrectionOrInspector, selectedAgentDetailProjection,
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

// Typing a ticket key in room search offers its card; Enter opens it on the board.
const searchTicketMatch = computed(() => {
  const task = taskForTicketQuery(props.tasks, searchQuery.value);
  const key = ticketRefParts(task?.externalRef)?.key;
  return task && key ? { taskId: task.id, key } : null;
});
function openSearchTicketCard(taskId: string): void {
  closeSearch();
  openBoardTask(taskId);
}

const {
  selectedReasoningSessionId, selectedReasoningSessionForInspector, openReasoningInspector,
  openAgentReasoningFallback, closeReasoningInspector, renameBusy, renameError, githubStatus,
  githubLoading, githubBusy, githubError, renameRoom, refreshGitHubIntegration,
  installGitHubIntegration, eventsPage, eventsLoading, eventsLoadingOlder, eventsError,
  eventsTaskFilterId, eventsSelectedEventId, eventsLoadedOlderWithoutMatches,
  composerGitHubEventPreviews, acknowledgeEvents, githubRepository, openEventsTab, refreshGitHubEvents,
  loadOlderGitHubEvents, openEventsForTask, clearEventsTaskFilter, closeSelectedGitHubEvent,
  openGitHubEventFromChat, openGitHubUrlExternally, dismissComposerGitHubEventPreview,
} = Object.assign(app, useRoomShellIntegrations(app));

const {
  githubEventsAvailable,
  managedAgentRepoStatus, managedAgentRepoRootPath, roomParticipants, localAgentWork, addAgentHeldNames,
} = Object.assign(app, useRoomShellParticipants(app));

// The room's own agents' background commands: the activity strip and the Live tab show them and stop them.
provideBackgroundCommands({
  entries: () => supervisorEntries.value,
  roomId: () => props.room.identifier,
  daemonGeneration: () => supervisorStatus.value?.generation ?? null,
  openInspector: (entry) => openAgentDetailRequest(supervisedAgentInspectorRequest(entry, {
    ownerAttribution: backgroundCommandOwner(entry.createdBy), initialTab: "live",
  })),
});

Object.assign(app, useRoomShellRoomWatchers(app));

Object.assign(app, useRoomShellAttention(app));

const {
  joinRequestBannerAvailable, joinRequestBanner, joinRequestBusy, joinRequestError, joinRequestDecision, decideJoinRequest, dismissJoinRequests, openJoinRequests,
} = Object.assign(app, useRoomShellJoinRequests(app));

Object.assign(app, useRoomShellLifecycle(app));

// A card's "Linked threads" entry opens that thread in chat.
function openThreadFromBoard(threadRootId: string): void {
  activeTab.value = "chat";
  void nextTick(() => roomChatView.value?.openThread(threadRootId));
}

const {
  tabs, pagesMenu, keptPages,
} = Object.assign(app, useRoomShellNotifications(app));

// Room pages: a room admin pins an HTML attachment as a tab, grants what it asks for, and rolls updates back.
const canManagePages = computed(() => props.room.role === "admin" && props.storage.effectiveMode !== "local");
const pagePinFlow = useRoomPagePinFlow({
  roomId: () => props.room.identifier,
  canPin: () => canManagePages.value,
  opened: (pageId) => selectTab(roomPageTabId(pageId)),
  toast: (message, state) => app.pushActionToast(message, state),
});
const { sheet: pageGrantSheet, busy: pageGrantBusy, error: pageGrantError } = pagePinFlow;
provide(roomPageActionsKey, pagePinFlow.actions);

Object.assign(app, useRoomShellInspectorWatchers(app));

const {
  refreshAgentInspectorDiagnostics, openAgentInspectorWork,
} = Object.assign(app, useRoomShellInspectorObservations(app));

// The composer starts agents inline and opens the Add agent window, at one
// provider or on the Open Model settings, when one must be set up first.
const addAgentInitialProviderId = ref<DesktopAgentProviderId | null>(null);
const addAgentInitialSection = ref<"open-model" | null>(null);
function closeAddAgentModal(): void {
  addAgentModalOpen.value = false;
  addAgentInitialProviderId.value = null;
  addAgentInitialSection.value = null;
}
// The daemon remains authoritative after the create surface closes. This small
// pointer leads back to the existing Agents inspector for progress and recovery.
const savedRoomLaunch = ref<DesktopSupervisorManifestEntry | null>(null);
const roomLaunchNotice = ref<InstanceType<typeof RoomAgentLaunchNotice> | null>(null);
const arrivingAgentId = ref<string | null>(null);
let activeAvatarFlight: Animation | undefined;
let savedLaunchSeenInRoster = false;
const latestRoomLaunch = computed(() => {
  const saved = savedRoomLaunch.value;
  return saved && saved.roomId === props.room.identifier
    ? supervisorEntries.value.find(entry => entry.id === saved.id) ?? saved : null;
});
const launchClock = useNow(1_000, () => launchNoticeView.value?.status === "running");
const launchNoticeView = computed(() => {
  const entry = latestRoomLaunch.value;
  if (!entry) return null;
  const view = agentStartupView(entry, { roomLabel: props.room.displayName || props.room.name }, launchClock.value);
  return view.status === "cancelled" || (view.status === "joined" && arrivingAgentId.value !== entry.id) ? null : view;
});
function cancelAvatarFlight(): void {
  arrivingAgentId.value = null;
  activeAvatarFlight?.cancel();
  activeAvatarFlight = undefined;
}
watch([() => props.room.identifier, activeTab], cancelAvatarFlight);
watch(roomLaunchNotice, (notice, previous) => { if (previous && notice !== previous) activeAvatarFlight?.cancel(); });
onDeactivated(cancelAvatarFlight);
onBeforeUnmount(cancelAvatarFlight);
watch(() => props.room.identifier, () => { savedRoomLaunch.value = null; savedLaunchSeenInRoster = false; });
watch(supervisorEntries, entries => {
  if (!savedRoomLaunch.value) return;
  const entry = entries.find(candidate => candidate.id === savedRoomLaunch.value!.id);
  if (entry) { savedLaunchSeenInRoster = true; savedRoomLaunch.value = entry; }
  else if (savedLaunchSeenInRoster) savedRoomLaunch.value = null;
});

function openSavedAgent(entryId: string, inAgents = false, initialTab?: "settings" | "diagnostics"): void {
  const entry = supervisorEntries.value.find(candidate => candidate.id === entryId)
    ?? (savedRoomLaunch.value?.id === entryId ? savedRoomLaunch.value : null);
  if (!entry || entry.roomId !== props.room.identifier) return;
  if (inAgents) {
    selectTab("activity");
    // The chat notice becomes hidden; give the inspector a visible return target.
    document.querySelector<HTMLElement>('[data-testid="desktop-room-tab-activity"]')?.focus({ preventScroll: true });
  }
  openAgentDetailRequest(supervisedAgentInspectorRequest(entry, { ownerAttribution: backgroundCommandOwner(entry.createdBy), initialTab }));
}
async function presentSavedAgent(entry: DesktopSupervisorManifestEntry, source?: AgentAvatarFlightSource | null): Promise<void> {
  if (entry.roomId !== props.room.identifier) return;
  cancelAvatarFlight();
  const shouldAnimate = Boolean(source && activeTab.value === "chat" && !document.hidden);
  if (shouldAnimate) arrivingAgentId.value = entry.id;
  savedLaunchSeenInRoster = supervisorEntries.value.some(candidate => candidate.id === entry.id);
  savedRoomLaunch.value = entry;
  void refreshSupervisorEntries();
  if (!source || !shouldAnimate) return;
  // Let the aligned banner settle after the composer or the Add agent sheet changes.
  await nextTick();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (arrivingAgentId.value !== entry.id) return;
  const flight = flyAgentAvatar(source, roomLaunchNotice.value?.avatarElement() ?? null, true);
  activeAvatarFlight = flight;
  try {
    await flight?.finished.catch(() => undefined);
  } finally {
    if (activeAvatarFlight === flight) activeAvatarFlight = undefined;
    if (arrivingAgentId.value === entry.id) arrivingAgentId.value = null;
  }
}
function handleFullAgentSaved(entry: DesktopSupervisorManifestEntry, presentation: { fromActiveForm: boolean }): void {
  if (entry.roomId !== props.room.identifier) return;
  const fromChat = presentation.fromActiveForm && activeTab.value === "chat" && addAgentModalOpen.value;
  const source = fromChat && typeof document.querySelector === "function"
    ? captureAgentAvatarSource(document.querySelector<HTMLElement>(".agent-refresh-footer [data-agent-avatar-source] .agent-identity-avatar")) : null;
  if (fromChat) closeAddAgentModal();
  void presentSavedAgent(entry, source);
}

provide(composerAgentLaunchKey, {
  context: () => ({
    roomStorageMode: props.storage.effectiveMode,
    roomGitRoom: props.room.gitRoom,
    repoRootPath: managedAgentRepoRootPath.value,
    repoStatus: managedAgentRepoStatus.value,
    gitRoomMatchesActiveRepo: props.gitRoomMatchesActiveRepo,
    viewerLogin: props.viewerLogin ?? null,
  }),
  openAddAgent: (options = {}) => {
    addAgentInitialProviderId.value = options.providerId ?? null;
    addAgentInitialSection.value = options.section ?? null;
    openAddAgentModal();
  },
  chooseWorktree: openAgentWorktree,
  agentSaved: (entry, source) => { void presentSavedAgent(entry, source); },
  openAgent: (entryId, initialTab) => openSavedAgent(entryId, false, initialTab),
  openFirstMessageWork: (entryId) => { void revealRoomMessage(`desktop-initial-message:${entryId}`); },
});
async function loadReleasePlanning() {
  if (!desktopIpc.room?.getBoardPlanning) throw new Error('Board unavailable');
  return desktopIpc.room.getBoardPlanning(props.room.identifier);
}
</script>
