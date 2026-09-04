<template>
  <section
    class="desktop-room-shell"
    :data-liquid-glass="liquidGlassEnabled"
    :data-agent-inspector-open="Boolean(selectedAgentDetailTarget && !agentInspectorCompact)"
    data-testid="desktop-room-shell"
  >
    <DesktopRoomHeader
      :sidebar-mode="sidebarMode"
      :room="room"
      :storage="storage"
      :tabs="tabs"
      :active-tab="activeTab"
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
      :liquid-glass-enabled="liquidGlassEnabled"
      :rename-busy="renameBusy"
      :rename-error="renameError"
      :github-status="githubStatus"
      :github-loading="githubLoading"
      :github-busy="githubBusy"
      :github-error="githubError"
      :github-events-available="githubEventsAvailable"
      :github-events-visible="githubEventsVisible"
      :storage-busy="storageBusy"
      :search-summary="searchSummary"
      :search-results-count="searchResults.length"
      @copy-room-link="copyRoomLink"
      @open-rules="openRules"
      @toggle-sound="toggleSound"
      @toggle-notifications="toggleNotifications"
      @toggle-liquid-glass="toggleLiquidGlass"
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
      :has-older-messages="hasOlderMessages"
      :loading-older-messages="loadingOlderMessages"
      :participants="roomParticipants"
      :presence="roomPresence"
      :local-agent-work="localAgentWork"
      :delivery-receipts-by-message="deliveryReceiptsByMessage"
      :delivery-recovery-available="deliveryRetryAvailable"
      :continuation-repair-available="continuationRepairAvailable"
      :room-delivery-skip-available="roomDeliverySkipAvailable"
      :delivery-retry-keys="deliveryRetryingKeys"
      :continuation-repair-keys="continuationRepairingKeys"
      :room-delivery-skip-keys="roomDeliverySkippingKeys"
      :revealed-message-id="revealedMessageId"
      :permission-approvals="pendingPermissionApprovals"
      :permission-error="composerPermissionError"
      :resolving-permission-ids="resolvingComposerPermissionIds"
      :reasoning-sessions="reasoningSessions"
      :tasks="tasks"
      :supervisor-entries="supervisorEntries"
      :search-query="searchQuery"
      :active-search-message-id="activeSearchMessageId"
      :initial-draft="chatDraftText"
      :initial-scroll-top="initialChatScrollTop ?? null"
      @send-message="sendRoomMessage"
      @discard-attachment="discardAttachment"
      @load-older="loadOlderMessages"
      @open-reasoning="openReasoningInspector"
      @open-agent-reasoning-fallback="openAgentReasoningFallback"
      @open-agent-detail="openAgentDetailFromParticipant"
      @open-add-agent="openAddAgentModal"
      @open-permission-detail="openComposerPermissionDetail"
      @restore-conversation="restoreAgentConversation"
      @skip-delivery="skipRoomDelivery"
      @retry-delivery="retryRoomAgentDelivery"
      @reveal-message="revealRoomMessage"
      @message-reveal-unavailable="emit('message-reveal-unavailable', $event)"
      @resolve-permission="resolveComposerPermission"
      @draft-change="chatDraftText = $event"
      @open-events="openEventsTab"
      @open-github-event="openGitHubEventFromChat"
      @open-task="openBoardTask"
      @dismiss-event-preview="dismissComposerGitHubEventPreview"
      @scroll-position="rememberChatScrollPosition"
      @thread-read="handleThreadRead"
    />

    <Transition name="room-panel" mode="out-in">
      <RoomInboxView
        v-if="activeTab === 'inbox'"
        key="inbox"
        v-model:filter="inboxFilter"
        :items="inboxItems"
        :loading="inboxLoading"
        :loading-older="inboxLoadingOlder"
        :error="inboxError"
        :has-more="inboxHasMore"
        :last-cleared-item="lastClearedInboxItem"
        :degraded-sources="inboxDegradation.sources"
        @refresh="handleInboxRefresh"
        @load-older="loadOlderInboxThreads"
        @open-thread="openInboxThread"
        @clear-item="clearInboxItem"
        @restore-item="restoreInboxItem"
        @open-task="openBoardTask"
        @open-github-event="openInboxGitHubEvent"
        @open-reasoning="openReasoningInspector"
        @open-rental-request="emit('open-rental-request')"
      />

      <RoomBoardView
        v-else-if="activeTab === 'board'"
        key="board"
        :room-identifier="room.identifier"
        :tasks="tasks"
        :board-settings="boardSettings"
        :presence="roomPresence"
        :workers="workers"
        :supervisor-entries="supervisorEntries"
        :selected-task-id="boardSelectedTaskId"
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
        :presence="roomPresence"
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
        @open-reasoning="openReasoningInspector"
        @open-add-agent="openAddAgentModal"
        @open-agent-detail="openAgentDetailRequest"
        @refresh-room="emit('refresh-room')"
        @reveal-message="revealRecordedWorkMessage"
        @clear-artifact-task-filter="artifactTimelineTaskFilterId = null"
      />

      <RoomDetailsView
        v-else-if="activeTab === 'rooms'"
        key="rooms"
        :room="room"
        :focus-rooms="focusRooms"
        :repo-status="repoStatus"
        :git-room-matches-active-repo="gitRoomMatchesActiveRepo"
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
      :selection="selectedAgentDetailTarget"
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
      :request-version="selectedAgentDetailRequestVersion"
      :managed-sessions="roomManagedAgentSessions"
      :reasoning-sessions="reasoningSessions"
      @close="closeAgentDetail"
      @retry="retryAgentInspectorState"
      @live-selected="openAgentInspectorLive"
      @live-dismissed="stopAgentInspectorLive"
      @action="runAgentInspectorAction"
      @session-updated="applyAgentInspectorParticipantSessionUpdate"
      @open-reasoning="openReasoningFromAgentDetail"
      @presentation-change="agentInspectorCompact = $event"
      @work-selected="openAgentInspectorWork"
      @work-retry="loadAgentInspectorWorkDetail(agentInspectorWorkSourceMessageId, true)"
      @work-source-select="selectAgentInspectorWorkSource"
      @reveal-message="revealAgentInspectorWorkMessage"
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

    <AddAgentModal
      :open="addAgentModalOpen"
      :room-identifier="room.identifier"
      :room-git-room="room.gitRoom"
      :room-display-name="room.displayName"
      :git-room-matches-active-repo="gitRoomMatchesActiveRepo"
      :repo-root-path="managedAgentRepoRootPath"
      :repo-status="managedAgentRepoStatus"
      @close="addAgentModalOpen = false"
      @choose-worktree="openAgentWorktree"
      @managed-session-started="upsertManagedAgentSession"
    />
  </section>
</template>

<script setup lang="ts">
import { GitBranch } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowReadonly, toRef, watch } from "vue";
import type {
  DesktopActivityEntry,
  DesktopAgentProvider,
  DesktopAgentPresence,
  DesktopBoardSettingsSummary,
  DesktopFocusRoomInfo,
  DesktopGitHubEventsPage,
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopManagedAgentSession,
  DesktopParticipantSummary,
  DesktopRoomInfo,
  DesktopRoomAgentWork,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopRoomMessage,
  DesktopReasoningSession,
  DesktopSnapshotSourceStates,
  DesktopSupervisorManifestEntry,
  DesktopAgentStreamEvent,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorRoomMove,
  DesktopSupervisorRetirementEvent,
  DesktopSupervisorStateSnapshot,
  DesktopTaskSummary,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { useDesktopActionToasts } from "../../../composables/useDesktopActionToasts";
import type { FocusRoomConcludedEvent } from "../../../domain/focus-room-conclusion";
import { isLocalGitRoom } from "../../../domain/git-rooms";
import {
  activeManagedAgentWorkIndicators,
  managedAgentSessionDisplayName,
  managedAgentSessionMatchesRoom,
  managedAgentRepoStatusForRoom,
  mergeDesktopManagedAgentParticipants,
  mergeDesktopSupervisorAgentParticipants,
  mergeDesktopManagedAgentPresence,
  mergeReachableAgentPresenceParticipants,
  pendingManagedAgentPermissionApprovals,
  supervisedAgentWorkIndicators,
  managedAgentRootPathForRoom,
  type ManagedAgentPermissionApproval,
  managedAgentSessionListsEqual,
  withUpsertedManagedAgentSession,
} from "../../../domain/managed-agents";
import { buildLetAgentsFocusRoomUrl, buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
import { shouldSkipPollTick } from "../../../domain/visibility-polling";
import { createRoomDeliveryRetryCoordinator } from "../../../domain/room-delivery-retry";
import { supervisedAgentDisplayLabel } from "../../../domain/codenames";
import { roomMentionCandidates } from "../../../domain/participants";
import {
  isCurrentAgentInspectorSupervisorUpdate,
  participantAgentInspectorRequest,
  resolvingAgentInspectorRequest,
  resolveAgentInspectorSelection,
  type AgentInspectorSupervisorEntryUpdate,
  type SupervisorEntriesResource,
} from "../../../domain/agent-inspector-identity";
import {
  isCurrentAgentInspectorParticipantSessionUpdate,
  type AgentInspectorParticipantSessionUpdate,
} from "../../../domain/agent-inspector-participant";
import {
  agentInspectorActionStateForEntry,
  clearAgentInspectorActionStateIfMatching,
  agentInspectorTurnControlActionId,
  agentInspectorTurnControlActionIdIfCurrent,
  agentInspectorRetryableTurnControlInput,
  settleAgentInspectorRetirementCompletion,
  settleAgentInspectorRetirementEvent,
  agentInspectorTurnControlFenceMatches,
  projectAgentInspectors,
  type AgentInspectorTurnControlFence,
  type AgentInspectorActionIntent,
  type AgentInspectorActionState,
} from "../../../domain/agent-inspector";
import {
  agentInspectorSettingsFenceCurrent,
  configurationDraft,
  configurationHasRuntimeLag,
  isStaleDaemonGenerationError,
  recoveredRoomMoveState,
  settleConfigurationConflict,
  settleConfigurationUpdate,
  snapshotConfigurationSave,
  supervisorGenerationIsCurrent,
  type AgentInspectorConfigurationDraft,
  type AgentInspectorConfigurationResource,
  type AgentInspectorRoomMoveResource,
  type AgentInspectorSettingsFence,
} from "../../../domain/agent-inspector-settings";
import {
  agentInspectorRuntimeControlMatchesFence,
  agentInspectorWorkArtifacts,
  defaultAgentInspectorWorkSource,
  emptyAgentInspectorWorkResource,
  isCurrentAgentInspectorWorkResponse,
  type AgentInspectorWorkResource,
} from "../../../domain/agent-inspector-work";
import {
  foldSupervisorActivityPush,
  mergeSupervisorEntriesPoll,
  supervisorEntriesResourceFreshness,
  supervisorStateRepairDelayMs,
  supervisorStateSubscriptionNeedsRepair,
  supervisorStatusTrailingRefreshGeneration,
} from "../../../domain/supervisor-entries-resource";
import type { SidebarMode } from "../types";
import AddAgentModal from "./AddAgentModal.vue";
import { managedAgentSessionsKey } from "./add-agent/managed-agent-sessions-context";
import AgentInspectorHost from "./agent-inspector/AgentInspectorHost.vue";
import DesktopReasoningInspector from "./DesktopReasoningInspector.vue";
import DesktopFloatingWidget from "../controls/DesktopFloatingWidget.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import RoomActivityTabView from "./RoomActivityTabView.vue";
import RoomBoardView from "./RoomBoardView.vue";
import RoomChatView from "./RoomChatView.vue";
import RoomEventsView from "./RoomEventsView.vue";
import RoomDetailsView from "./RoomDetailsView.vue";
import RoomInboxView from "./RoomInboxView.vue";
import { ownerAttribution as ownerAttributionLabel } from "./room-activity/agentTarget";
import DesktopRoomControlRail from "./room-shell/DesktopRoomControlRail.vue";
import DesktopRoomHeader from "./room-shell/DesktopRoomHeader.vue";
import GitRoomEnvironmentPanel from "./room-shell/GitRoomEnvironmentPanel.vue";
import {
  readEnvironmentPanelOpen,
  readGitHubEventsVisible,
  rememberEnvironmentPanelOpen,
  rememberGitHubEventsVisible,
} from "./room-shell/preferences";
import { exportRoomChat } from "./room-shell/roomExport";
import type { RoomTab, RoomTabId } from "./room-shell/types";
import { useAgentInspectorConfigurationApply } from "./room-shell/useAgentInspectorConfigurationApply";
import { useDesktopReasoningInspector } from "./room-shell/useDesktopReasoningInspector";
import type {
  AgentInspectorSelection,
  AgentInspectorRequest,
  AgentModalTarget,
} from "./desktop-chat-message/types";
import { useDesktopRoomGitHub } from "./room-shell/useDesktopRoomGitHub";
import { useDesktopRoomGitHubEvents } from "./room-shell/useDesktopRoomGitHubEvents";
import { useDesktopRoomInbox } from "./room-shell/useDesktopRoomInbox";
import { useDesktopRoomMessages } from "./room-shell/useDesktopRoomMessages";
import {
  useDesktopRoomPreferences,
  watchRoomNotifications,
} from "./room-shell/useDesktopRoomPreferences";
import { useDesktopRoomSearch } from "./room-shell/useDesktopRoomSearch";
import { isThreadReplyMessage } from "./room-shell/threading";
import { desktopIpc } from "../../../ipc/index.js";

const props = defineProps<{
  sidebarMode: SidebarMode;
  roomLoading: boolean;
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  roomArtifacts: DesktopRoomSharedArtifact[];
  roomAgentWork: DesktopRoomAgentWork[];
  roomAgentWorkStatus: "idle" | "loading" | "ready" | "stale" | "error" | "unavailable";
  roomAgentWorkTruncated: boolean;
  boardSettings: DesktopBoardSettingsSummary | null;
  messages: DesktopRoomMessage[];
  githubEvents: DesktopGitHubEventsPage | null;
  sourceStates?: DesktopSnapshotSourceStates | null;
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
  durableProjectRootPath?: string | null;
  projectRoom?: boolean;
  workers: WorkerSnapshot[];
  openAddAgentRequested?: boolean;
  notificationRevealMessageId?: string | null;
  notificationRevealNonce?: number;
  initialChatScrollTop?: number | null;
  onFocusRoomConcluded?: (event: FocusRoomConcludedEvent) => Promise<void>;
}>();
const { pushActionToast } = useDesktopActionToasts();
const notifiedManagedAgentFailures = new Set<string>();

const emit = defineEmits<{
  "cycle-sidebar": [];
  "message-sent": [message: DesktopRoomMessage];
  "room-renamed": [room: DesktopRoomInfo];
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [snapshot?: DesktopRoomSnapshot];
  "open-focus-room": [roomIdentifier: string];
  "request-focus-room-conclusion": [focusRoom: DesktopFocusRoomInfo];
  "chat-scroll-position": [roomIdentifier: string, scrollTop: number];
  "connect-project": [];
  "choose-worktree": [rootPath: string];
  "open-repo-root": [rootPath: string];
  "add-agent-open-request-consumed": [];
  /** Placeholder until the daemon exposes a receipt retry control endpoint. */
  "retry-room-agent-delivery": [input: { agentId: string; sourceMessageId: string }];
  "message-reveal-unavailable": [messageId: string];
  "open-rental-request": [];
}>();

const roomRef = toRef(props, "room");
const messagesRef = toRef(props, "messages");
const reasoningSessionsRef = toRef(props, "reasoningSessions");
const activeTab = ref<RoomTabId>(readRoomActiveTab(props.room.identifier));
const roomChatView = ref<InstanceType<typeof RoomChatView> | null>(null);
const revealedMessageId = ref<string | null>(null);
const actionPanelOpen = ref(false);
const addAgentModalOpen = ref(false);
const selectedAgentDetailRequest = ref<AgentInspectorRequest | null>(null);
const selectedAgentDetailRequestVersion = ref(0);
const agentInspectorActionState = ref<AgentInspectorActionState | null>(null);
const agentInspectorCompact = ref(false);
// Cap the retained live-feed tail so a long turn can't grow the renderer
// buffer without bound; matches the daemon's ephemeral ring buffer intent.
const AGENT_LIVE_FEED_LIMIT = 400;
// Ephemeral live feed for the inspected agent's "Live" tab. Not persisted;
// accumulates raw stream events for the focused entry only, reset on focus
// change and inspector close.
const agentInspectorLiveFeed = ref<{ events: DesktopAgentStreamEvent[]; ended: boolean; droppedEvents: number }>({ events: [], ended: false, droppedEvents: 0 });
const agentInspectorWorkResource = ref<AgentInspectorWorkResource>(emptyAgentInspectorWorkResource());
const agentInspectorWorkSourceMessageId = ref<string | null>(null);
const agentInspectorConfigurationResource = ref<AgentInspectorConfigurationResource>({ status: "idle", configuration: null, draft: null, error: null });
const agentInspectorRoomMoveResource = ref<AgentInspectorRoomMoveResource>({ status: "idle", move: null, error: null });
const agentInspectorProviders = ref<DesktopAgentProvider[]>([]);
let agentInspectorProvidersRequest: Promise<void> | null = null;
const agentInspectorSettingsConflict = ref(false);
let agentInspectorSettingsRequestToken = 0;
let agentInspectorSettingsDraftVersion = 0;
let agentInspectorMessageIdentityRequestToken = 0;
let agentInspectorRoomMoveRequestToken = 0;
let agentInspectorRoomMoveRecoveryTimer: number | null = null;
let agentInspectorWorkRequestToken = 0;
const rulesOpen = ref(false);
const { copied: roomLinkCopied, copy: copyRoomLinkToClipboard } = useCopyIndicator(1400);
const deliveryRetryCoordinator = createRoomDeliveryRetryCoordinator();
const deliveryRetryingKeys = deliveryRetryCoordinator.retryingKeys;
const continuationRepairCoordinator = createRoomDeliveryRetryCoordinator();
const continuationRepairingKeys = continuationRepairCoordinator.retryingKeys;
const roomDeliverySkipCoordinator = createRoomDeliveryRetryCoordinator();
const roomDeliverySkippingKeys = roomDeliverySkipCoordinator.retryingKeys;
const deliveryRetryNegotiated = ref(false);
const deliveryRetryAvailable = computed(() => deliveryRetryNegotiated.value && typeof desktopIpc.supervisor?.retryRoomDelivery === "function");
const boardSelectedTaskId = ref<string | null>(null);
const activityHistoryRequest = ref(0);
const artifactTimelineTaskFilterId = ref<string | null>(null);
const storageBusy = ref(false);
const githubEventsVisible = ref(readGitHubEventsVisible(props.room.identifier));
const environmentPanelOpen = ref(readEnvironmentPanelOpen(props.room.identifier));
const refreshedEnvironmentRepoStatus = ref<RepoStatus | null>(null);
const managedAgentSessions = ref<DesktopManagedAgentSession[]>([]);
const supervisorEntries = ref<DesktopSupervisorManifestEntry[]>([]);
const supervisorEntriesState = ref<SupervisorEntriesResource["state"]>("loading");
const supervisorEntriesError = ref<string | null>(null);
const supervisorEntriesHaveLoaded = ref(false);
const supervisorEntriesUpdatedAt = ref<string | null>(null);
const supervisorStatus = ref<DesktopSupervisorDaemonStatus | null>(null);
let supervisorStatusRequestToken = 0;
let supervisorStatusRefreshInFlight: Promise<DesktopSupervisorDaemonStatus | null> | null = null;
let supervisorStatusRequiredGeneration = 0;
let supervisorStatusTrailingRefreshAttemptGeneration = 0;
const agentInspectorRoomMoveAvailable = computed(() =>
  Boolean(supervisorStatus.value?.capabilities.agentRoomMove));
const continuationRepairAvailable = computed(() =>
  Boolean(supervisorStatus.value?.capabilities.providerContinuationRepair
    && typeof desktopIpc.supervisor?.restoreAgentConversation === "function"));
const roomDeliverySkipAvailable = computed(() =>
  Boolean(supervisorStatus.value?.capabilities.roomDeliverySkip
    && typeof desktopIpc.supervisor?.skipRoomDelivery === "function"));
const supervisorEntriesResource = computed<SupervisorEntriesResource>(() => {
  if (supervisorEntriesState.value === "error") {
    return {
      state: "error",
      roomIdentifier: props.room.identifier,
      updatedAt: supervisorEntriesUpdatedAt.value,
      data: supervisorEntries.value,
      error: supervisorEntriesError.value || "Supervisor daemon unavailable.",
    };
  }
  return {
    state: supervisorEntriesState.value,
    roomIdentifier: props.room.identifier,
    updatedAt: supervisorEntriesUpdatedAt.value,
    data: supervisorEntries.value,
    error: null,
  } as SupervisorEntriesResource;
});
const selectedAgentDetailTarget = computed<AgentInspectorSelection | null>(() => {
  const request = selectedAgentDetailRequest.value;
  if (!request) return null;
  return resolveAgentInspectorSelection(
    supervisorEntriesResource.value,
    request,
    props.room.identifier,
  );
});
const agentInspectorProjections = computed(() => {
  return projectAgentInspectors(supervisorEntries.value, {
    roomId: props.room.identifier,
    tasks: props.tasks,
    deliveryRetryAvailable: deliveryRetryAvailable.value,
    continuationRepairAvailable: continuationRepairAvailable.value,
    roomDeliverySkipAvailable: roomDeliverySkipAvailable.value,
    resourceFreshness: supervisorEntriesResourceFreshness(supervisorEntriesResource.value.state),
    mentionInsertTextByEntryId: agentMentionInsertTextByEntryId.value,
    deliveryRetryingKeys: deliveryRetryingKeys.value,
  });
});
const selectedAgentDetailProjection = computed(() => {
  const target = selectedAgentDetailTarget.value;
  if (target?.kind !== "supervised") return null;
  return agentInspectorProjections.value.find((projection) => projection.entryId === target.supervisorEntryId) ?? null;
});
const { applyAgentInspectorSettings } = useAgentInspectorConfigurationApply({
  selectedProjection: selectedAgentDetailProjection,
  configurationResource: agentInspectorConfigurationResource,
  actionState: agentInspectorActionState,
  refreshSupervisorStatus,
  selectionCurrent: agentInspectorSettingsSelectionCurrent,
  beginOperation: (message, daemonGeneration) =>
    beginAgentInspectorOperation("apply_settings", message, daemonGeneration),
  operationIdentityCurrent: agentInspectorOperationIdentityCurrent,
  operationCurrent: agentInspectorOperationCurrent,
  recoverGeneration: recoverAgentInspectorSettingsGeneration,
});
const selectedAgentInspectorActionState = computed(() => {
  const target = selectedAgentDetailTarget.value;
  return agentInspectorActionStateForEntry(
    agentInspectorActionState.value,
    target?.kind === "supervised" ? target.supervisorEntryId : null,
  );
});
const selectedAgentInspectorWorkArtifacts = computed(() => {
  const projection = selectedAgentDetailProjection.value;
  return projection ? agentInspectorWorkArtifacts(projection.assignedWork, props.roomArtifacts) : [];
});
const deliveryReceiptsByMessage = computed(() => {
  const grouped: Record<string, Array<{
    agentId: string;
    agentName: string;
    state: string;
    blockedByMessageId: string | null;
    error: string | null;
    failureCode: string | null;
    terminalReason: string | null;
    attemptCount: number;
    providerTurnId: string | null;
  }>> = {};
  for (const entry of supervisorEntries.value) for (const receipt of entry.deliveryReceipts ?? []) {
    (grouped[receipt.sourceMessageId] ??= []).push({
      agentId: entry.id,
      agentName: supervisedAgentDisplayLabel(entry.displayName, entry.id),
      state: receipt.state,
      blockedByMessageId: receipt.blockedByMessageId,
      error: receipt.error,
      failureCode: receipt.failureCode,
      terminalReason: receipt.terminalReason,
      attemptCount: receipt.attemptCount,
      providerTurnId: receipt.providerTurnId,
    });
  }
  return grouped;
});
provide(managedAgentSessionsKey, {
  sessions: shallowReadonly(managedAgentSessions),
  refresh: refreshManagedAgentSessions,
  upsert: upsertManagedAgentSession,
});
const composerPermissionError = ref<string | null>(null);
const resolvingComposerPermissionIds = ref<Record<string, DesktopManagedAgentPermissionDecisionBehavior>>({});
let managedAgentSessionsRefreshTimer: number | null = null;
let managedAgentSessionsRefreshRequestId = 0;
let managedAgentSessionsMutationVersion = 0;
let supervisorEntriesMutationVersion = 0;
let managedAgentSessionsRefreshInFlight: Promise<void> | null = null;
let managedAgentSessionsRefreshQueued = false;
let managedAgentSessionsRefreshOwnerActive = true;
let unsubscribeManagedAgentSessionUpdate: (() => void) | null = null;
let unsubscribeSupervisorActivity: (() => void) | null = null;
let unsubscribeSupervisorAgentStream: (() => void) | null = null;
let unsubscribeSupervisorState: (() => void) | null = null;
let unsubscribeSupervisorRetirement: (() => void) | null = null;
let retirementStatusCheckOperationId: string | null = null;
let supervisorStateSubscriptionActive = false;
let supervisorStateLastSnapshotAtMs: number | null = null;
let supervisorStateLastRepairAtMs: number | null = null;
let supervisorStateDaemonGeneration = 0;
let supervisorStateSequence = 0;
let pendingSupervisorStateSnapshot: DesktopSupervisorStateSnapshot | null = null;
let supervisorStateFrame: number | null = null;
let environmentRepoStatusRefreshRequestId = 0;
const roomUrl = computed(() => props.room.kind === "focus"
  ? buildLetAgentsFocusRoomUrl({
      roomIdentifier: props.room.identifier,
      parentRoomId: props.room.parentRoomId,
      focusKey: props.room.focusKey,
      sourceTaskId: props.room.sourceTaskId,
    })
  : buildLetAgentsRoomCopyValue(props.room.identifier, {
      localOnly: props.storage.localRoom?.publishStatus === "local_only",
    })
);
const localGitRoom = computed(() => isLocalGitRoom(props.room));
const isLocalRoom = computed(() => props.storage.effectiveMode === "local");
const messageNamespace = computed(() =>
  [
    props.room.identifier,
    props.storage.effectiveMode,
    props.storage.localRoom?.roomIdentifier || "cloud",
  ].join(":")
);
const {
  soundEnabled,
  notificationsEnabled,
  liquidGlassEnabled,
  notificationPermission,
  toggleSound,
  toggleNotifications,
  toggleLiquidGlass,
  playRoomSound,
  showRoomNotification,
} = useDesktopRoomPreferences();

const {
  sendingMessage,
  sendError,
  hasOlderMessages,
  loadingOlderMessages,
  chatDraftText,
  ownMessageIds,
  hasFilteredRoomActivity,
  visibleMessages,
  timelineMessages,
  roomMessagesForAgentInsight,
  sendRoomMessage,
  discardAttachment,
  loadOlderMessages,
  revealMessage,
} = useDesktopRoomMessages({
  room: roomRef,
  messages: messagesRef,
  githubEventsVisible,
  playRoomSound,
  onMessageSent: (message) => emit("message-sent", message),
});

const {
  searchOpen,
  searchQuery,
  searchResults,
  activeSearchMessageId,
  searchSummary,
  toggleSearch: toggleSearchOpen,
  closeSearch,
  moveSearch,
} = useDesktopRoomSearch(visibleMessages);

const {
  selectedReasoningSessionId,
  selectedReasoningSessionForInspector,
  openReasoningInspector,
  openAgentReasoningFallback,
  closeReasoningInspector,
} = useDesktopReasoningInspector({
  roomIdentifier: computed(() => props.room.identifier),
  reasoningSessions: reasoningSessionsRef,
  roomMessagesForAgentInsight,
});

const {
  renameBusy,
  renameError,
  githubStatus,
  githubLoading,
  githubBusy,
  githubError,
  renameRoom,
  refreshGitHubIntegration,
  installGitHubIntegration,
} = useDesktopRoomGitHub({
  room: roomRef,
  onRoomRenamed: (room) => emit("room-renamed", room),
  refreshRoom: () => emit("refresh-room"),
});

const {
  eventsPage,
  eventsLoading,
  eventsLoadingOlder,
  eventsError,
  eventsTaskFilterId,
  eventsSelectedEventId,
  eventsLoadedOlderWithoutMatches,
  composerGitHubEventPreviews,
  eventsUnseenCount,
  eventsUnseenTone,
  githubRepository,
  showEventsTab,
  openEventsTab,
  refreshGitHubEvents,
  loadOlderGitHubEvents,
  openEventsForTask,
  openEventById,
  clearTaskFilter: clearEventsTaskFilter,
  closeSelectedEvent: closeSelectedGitHubEvent,
  openGitHubEventFromChat,
  openGitHubUrlExternally,
  dismissComposerGitHubEventPreview,
} = useDesktopRoomGitHubEvents({
  room: roomRef,
  messages: messagesRef,
  initialPage: toRef(props, "githubEvents"),
  activeTab,
  localGitRoom,
  githubConnected: computed(() => Boolean(githubStatus.value?.connected)),
  connectedRepository: computed(() => githubStatus.value?.repository?.fullName || null),
});
const githubEventsAvailable = showEventsTab;
const showEnvironmentPanelWidget = computed(() =>
  activeTab.value === "chat" && Boolean(props.room.gitRoom) && !actionPanelOpen.value && !searchOpen.value
);
const effectiveEnvironmentRepoStatus = computed(() => {
  const refreshed = refreshedEnvironmentRepoStatus.value;
  if (!refreshed || refreshed.rootPath !== props.repoStatus.rootPath) return props.repoStatus;
  return refreshed;
});
const roomManagedAgentSessions = computed(() =>
  managedAgentSessions.value.filter((session) =>
    managedAgentSessionMatchesRoom(session, props.room.identifier)
  )
);
const managedAgentRepoStatus = computed(() =>
  managedAgentRepoStatusForRoom(props.repoStatus, props.room, props.gitRoomMatchesActiveRepo)
);
const managedAgentRepoRootPath = computed(() =>
  managedAgentRootPathForRoom({
    room: props.room,
    repoStatus: managedAgentRepoStatus.value,
    gitRoomMatchesActiveRepo: props.gitRoomMatchesActiveRepo,
    durableProjectRootPath: props.durableProjectRootPath,
  })
);
const roomPresence = computed(() =>
  mergeDesktopManagedAgentPresence(props.presence, roomManagedAgentSessions.value, props.room.identifier)
);
const roomParticipants = computed(() =>
  mergeReachableAgentPresenceParticipants(
    mergeDesktopSupervisorAgentParticipants(
      mergeDesktopManagedAgentParticipants(props.participants, roomManagedAgentSessions.value, props.room.identifier),
      supervisorEntries.value,
      props.room.identifier,
    ),
    roomPresence.value,
    props.room.identifier,
  )
);
const agentMentionInsertTextByEntryId = computed(() => {
  const result = new Map<string, string>();
  for (const entry of supervisorEntries.value) {
    const expectedAgentKey = entry.agentKey?.trim();
    if (!expectedAgentKey) continue;
    const participant = roomParticipants.value.find((candidate) =>
      candidate.kind === "agent"
      && candidate.participantKey === `desktop-supervisor-agent:${entry.id}`
      && candidate.agentKey === expectedAgentKey);
    const candidate = participant
      ? roomMentionCandidates(
          roomParticipants.value,
          participant.displayName,
          roomParticipants.value.length + 1,
        ).find((mention) => mention.participantKey === participant.participantKey)
      : null;
    if (candidate?.kind === "agent") {
      result.set(entry.id, candidate.insertText);
    }
  }
  return result;
});
const localAgentWork = computed(() =>
  [
    ...activeManagedAgentWorkIndicators(
      roomManagedAgentSessions.value.filter((session) => !session.supervisorEntryId),
      props.room.identifier,
    ),
    ...supervisedAgentWorkIndicators(supervisorEntries.value, roomPresence.value, props.room.identifier),
  ]
);
const pendingPermissionApprovals = computed(() =>
  pendingManagedAgentPermissionApprovals(roomManagedAgentSessions.value, props.room.identifier)
);
const {
  inboxFilter,
  inboxLoading,
  inboxLoadingOlder,
  inboxError,
  lastClearedInboxItem,
  inboxUnseenCount,
  inboxItems,
  inboxActionableCount,
  inboxHasMore,
  inboxDegradation,
  loadOlderInboxThreads,
  handleInboxRefresh,
  openInboxThread,
  clearInboxItem,
  restoreInboxItem,
  handleThreadRead,
  openBoardTask,
  openInboxGitHubEvent,
  scheduleInboxRefresh,
} = useDesktopRoomInbox({
  room: roomRef,
  namespace: messageNamespace,
  activeTab,
  tasks: toRef(props, "tasks"),
  githubEvents: eventsPage,
  reasoningSessions: reasoningSessionsRef,
  presence: roomPresence,
  sourceStates: computed(() => props.sourceStates ?? null),
  fallbackRepository: githubRepository,
  openThread: async (rootMessageId) => {
    activeTab.value = "chat";
    await nextTick();
    roomChatView.value?.openThread(rootMessageId);
  },
  openBoardTask: (taskId) => {
    boardSelectedTaskId.value = taskId;
    activeTab.value = "board";
  },
  openGitHubEvent: (eventId) => {
    openEventById(eventId);
  },
  refreshRoom: () => emit("refresh-room"),
});

watch(() => props.room.identifier, () => {
  selectedAgentDetailRequestVersion.value += 1;
  selectedAgentDetailRequest.value = null;
  agentInspectorActionState.value = null;
  agentInspectorWorkRequestToken += 1;
  agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
  agentInspectorWorkSourceMessageId.value = null;
  activeTab.value = readRoomActiveTab(props.room.identifier);
  refreshedEnvironmentRepoStatus.value = null;
  managedAgentSessions.value = [];
  supervisorEntries.value = [];
  supervisorEntriesState.value = "loading";
  supervisorEntriesError.value = null;
  supervisorEntriesHaveLoaded.value = false;
  supervisorEntriesUpdatedAt.value = null;
  composerPermissionError.value = null;
  resolvingComposerPermissionIds.value = {};
  boardSelectedTaskId.value = null;
  githubEventsVisible.value = readGitHubEventsVisible(props.room.identifier);
  environmentPanelOpen.value = readEnvironmentPanelOpen(props.room.identifier);
  supervisorStateLastRepairAtMs = null;
  void refreshManagedAgentSessions();
  scheduleManagedAgentSessionsRepair();
}, { immediate: true });

watch(() => props.repoStatus, () => {
  refreshedEnvironmentRepoStatus.value = null;
});

watch(addAgentModalOpen, (open) => {
  if (open) {
    void refreshManagedAgentSessions();
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

watch(() => props.messages.at(-1)?.id || null, () => {
  const latestMessage = props.messages.at(-1);
  if (!latestMessage) return;
  if (isThreadReplyMessage(latestMessage)) {
    scheduleInboxRefresh(activeTab.value === "inbox" ? 200 : 700);
  }
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

onBeforeUnmount(() => {
  managedAgentSessionsRefreshOwnerActive = false;
  managedAgentSessionsRefreshQueued = false;
  managedAgentSessionsRefreshRequestId += 1;
  stopManagedAgentSessionsRefreshTimer();
  supervisorStatusRequestToken += 1;
  agentInspectorSettingsRequestToken += 1;
  agentInspectorRoomMoveRequestToken += 1;
  if (agentInspectorRoomMoveRecoveryTimer !== null) {
    window.clearTimeout(agentInspectorRoomMoveRecoveryTimer);
    agentInspectorRoomMoveRecoveryTimer = null;
  }
  document.removeEventListener("visibilitychange", handleManagedAgentSessionsVisibilityChange);
  unsubscribeManagedAgentSessionUpdate?.();
  unsubscribeManagedAgentSessionUpdate = null;
  unsubscribeSupervisorActivity?.();
  unsubscribeSupervisorActivity = null;
  unsubscribeSupervisorAgentStream?.();
  unsubscribeSupervisorAgentStream = null;
  void desktopIpc.supervisor?.watchAgentStream?.(null);
  unsubscribeSupervisorState?.();
  unsubscribeSupervisorState = null;
  unsubscribeSupervisorRetirement?.();
  unsubscribeSupervisorRetirement = null;
  retirementStatusCheckOperationId = null;
  supervisorStateSubscriptionActive = false;
  supervisorStateLastSnapshotAtMs = null;
  pendingSupervisorStateSnapshot = null;
  if (supervisorStateFrame !== null) {
    window.cancelAnimationFrame(supervisorStateFrame);
    supervisorStateFrame = null;
  }
});

onMounted(() => {
  document.addEventListener("visibilitychange", handleManagedAgentSessionsVisibilityChange);
  unsubscribeManagedAgentSessionUpdate = desktopIpc.workers?.onManagedAgentSessionUpdate?.((session) => {
    if (!managedAgentSessionMatchesRoom(session, props.room.identifier)) {
      return;
    }
    upsertManagedAgentSession(session);
    if (session.failure) {
      const failureKey = `${session.id}:${session.failure.occurredAt}:${session.failure.code}`;
      if (!notifiedManagedAgentFailures.has(failureKey)) {
        notifiedManagedAgentFailures.add(failureKey);
        pushActionToast(
          `${managedAgentSessionDisplayName(session)} could not reply: ${session.failure.message}`,
          "error",
          8_000,
        );
      }
    }
  }) || null;
  unsubscribeSupervisorActivity = desktopIpc.supervisor?.onActivity?.((push) => {
    const next = foldSupervisorActivityPush(supervisorEntries.value, props.room.identifier, push);
    if (next === supervisorEntries.value) return;
    supervisorEntries.value = next;
    supervisorEntriesUpdatedAt.value = new Date().toISOString();
  }) || null;
  unsubscribeSupervisorState = desktopIpc.supervisor?.onState?.((snapshot) => {
    supervisorStateLastSnapshotAtMs = Date.now();
    queueSupervisorStateSnapshot(snapshot);
  }) || null;
  unsubscribeSupervisorRetirement = desktopIpc.supervisor?.onRetirement?.((event) => {
    acceptSupervisorRetirementEvent(event);
  }) || null;
  supervisorStateSubscriptionActive = Boolean(unsubscribeSupervisorState);
  unsubscribeSupervisorAgentStream = desktopIpc.supervisor?.onAgentStream?.((batch) => {
    // Only accumulate for the agent whose inspector is focused; a batch for a
    // stale focus (raced focus change) is ignored.
    if (batch.entryId !== selectedAgentDetailProjection.value?.entryId) return;
    const priorEvents = batch.reset ? [] : agentInspectorLiveFeed.value.events;
    const localOverflow = Math.max(0, priorEvents.length + batch.events.length - AGENT_LIVE_FEED_LIMIT);
    const events = batch.events.length
      ? [...priorEvents, ...batch.events].slice(-AGENT_LIVE_FEED_LIMIT)
      : priorEvents;
    agentInspectorLiveFeed.value = {
      events,
      ended: batch.ended,
      droppedEvents: (batch.reset ? 0 : agentInspectorLiveFeed.value.droppedEvents)
        + Math.max(0, batch.droppedEvents)
        + localOverflow,
    };
  }) || null;
});

function queueSupervisorStateSnapshot(snapshot: DesktopSupervisorStateSnapshot): void {
  const pending = pendingSupervisorStateSnapshot;
  if (
    pending
    && (
      snapshot.daemonGeneration < pending.daemonGeneration
      || (
        snapshot.daemonGeneration === pending.daemonGeneration
        && snapshot.sequence < pending.sequence
      )
    )
  ) return;
  pendingSupervisorStateSnapshot = snapshot;
  if (supervisorStateFrame !== null) return;
  supervisorStateFrame = window.requestAnimationFrame(() => {
    supervisorStateFrame = null;
    const next = pendingSupervisorStateSnapshot;
    pendingSupervisorStateSnapshot = null;
    if (next) acceptSupervisorStateSnapshot(next);
  });
}

function acceptSupervisorStateSnapshot(snapshot: DesktopSupervisorStateSnapshot): void {
  if (
    snapshot.daemonGeneration < supervisorStateDaemonGeneration
    || (
      snapshot.daemonGeneration === supervisorStateDaemonGeneration
      && snapshot.sequence < supervisorStateSequence
    )
  ) return;
  const statusGeneration = supervisorStatus.value?.generation ?? 0;
  supervisorStateDaemonGeneration = snapshot.daemonGeneration;
  supervisorStateSequence = snapshot.sequence;
  supervisorEntriesMutationVersion += 1;
  const roomEntries = snapshot.entries.filter((entry) => entry.roomId === props.room.identifier);
  if (JSON.stringify(roomEntries) !== JSON.stringify(supervisorEntries.value)) {
    supervisorEntries.value = mergeSupervisorEntriesPoll(
      supervisorEntries.value,
      roomEntries,
      props.room.identifier,
    );
  }
  supervisorEntriesHaveLoaded.value = true;
  supervisorEntriesUpdatedAt.value = new Date().toISOString();
  supervisorEntriesState.value = "ready";
  supervisorEntriesError.value = null;
  // Status/capability negotiation is generation-scoped. Push snapshots keep
  // the manifest current, but a daemon handoff requires exactly one new
  // negotiation before generation-specific controls may be used.
  if (statusGeneration !== snapshot.daemonGeneration) {
    void refreshSupervisorStatus(snapshot.daemonGeneration)
      .then(() => refreshOpenAgentInspectorRuntimeControl(snapshot));
  } else refreshOpenAgentInspectorRuntimeControl(snapshot);
  void reconcilePendingRetirementFromDurableState(snapshot);
}

function acceptSupervisorRetirementEvent(event: DesktopSupervisorRetirementEvent): void {
  const action = agentInspectorActionState.value;
  const settled = settleAgentInspectorRetirementEvent(action, event);
  if (settled === action) return;
  retirementStatusCheckOperationId = null;
  agentInspectorActionState.value = settled;
  void refreshManagedAgentSessions();
}

/** State pushes are the missed-event/reconnect fallback. Completion is checked
 * against both the durable daemon lifecycle and Electron's grant registry, so
 * a merely stopped provider is never mistaken for fully revoked authority. */
async function reconcilePendingRetirementFromDurableState(snapshot: DesktopSupervisorStateSnapshot): Promise<void> {
  const action = agentInspectorActionState.value;
  if (!action || action.kind !== "retire_agent" || action.status !== "running"
    || action.daemonGeneration !== snapshot.daemonGeneration
    || retirementStatusCheckOperationId === action.operationId
    || typeof desktopIpc.supervisor?.getRetirementStatus !== "function") return;
  const entry = snapshot.entries.find((candidate) => candidate.id === action.entryId);
  if (!entry || entry.desiredState !== "stopped" || entry.observedState !== "stopped"
    || entry.agentSessionId !== null || entry.agentSessionBindingState === "active") return;
  retirementStatusCheckOperationId = action.operationId;
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
      void refreshManagedAgentSessions();
    }
  } catch {
    // The explicit completion/failure event remains primary. A status read can
    // race daemon handoff or temporarily unavailable secure storage, neither
    // of which should turn an accepted retirement into a false UI failure.
  } finally {
    if (retirementStatusCheckOperationId === action.operationId) retirementStatusCheckOperationId = null;
  }
}

function rememberChatScrollPosition(scrollTop: number): void {
  emit("chat-scroll-position", props.room.identifier, scrollTop);
}

watchRoomNotifications({
  visibleMessages,
  ownMessageIds,
  playRoomSound,
  showRoomNotification: (message) => showRoomNotification(message, props.room.displayName),
});

const tabs = computed<RoomTab[]>(() => {
  const nextTabs: RoomTab[] = [
    { id: "chat", label: "Chat", count: null },
    {
      id: "inbox",
      label: "Inbox",
      count: inboxActionableCount.value || null,
      indicator: inboxUnseenCount.value > 0 && activeTab.value !== "inbox"
        ? {
            label: inboxUnseenCount.value === 1 ? "New inbox item" : "New inbox items",
            count: inboxUnseenCount.value,
            tone: "info",
            pulse: true,
            mode: "dot",
          }
        : null,
    },
  ];
  if (showEventsTab.value) {
    nextTabs.push({
      id: "events",
      label: "Events",
      count: null,
      indicator: eventsUnseenCount.value > 0 && activeTab.value !== "events"
        ? {
            label: eventsUnseenCount.value === 1 ? "New event" : "New events",
            count: eventsUnseenCount.value,
            tone: eventsUnseenTone.value,
            pulse: true,
            mode: "count",
          }
        : null,
    });
  }
  nextTabs.push(
    { id: "board", label: "Board", count: null },
    { id: "activity", label: "Activity", count: null },
  );
  if (!isLocalRoom.value) {
    nextTabs.push({ id: "rooms", label: "Rooms", count: props.roomLoading ? null : props.focusRooms.length });
  }
  return nextTabs;
});

function selectTab(tabId: RoomTabId): void {
  if (activeTab.value === tabId) return;
  if (tabId === "events" && !showEventsTab.value) return;
  if (isLocalRoom.value && tabId === "rooms") return;
  activeTab.value = tabId;
}

function roomActiveTabStorageKey(roomIdentifier: string): string {
  return `letagents-desktop:room-active-tab:${roomIdentifier}`;
}

function isRoomTabId(value: string | null): value is RoomTabId {
  return (
    value === "chat"
    || value === "inbox"
    || value === "events"
    || value === "board"
    || value === "activity"
    || value === "rooms"
  );
}

function readRoomActiveTab(roomIdentifier: string): RoomTabId {
  try {
    const stored = window.localStorage.getItem(roomActiveTabStorageKey(roomIdentifier));
    return isRoomTabId(stored) ? stored : "chat";
  } catch {
    return "chat";
  }
}

function rememberRoomActiveTab(roomIdentifier: string, tab: RoomTabId): void {
  try {
    window.localStorage.setItem(roomActiveTabStorageKey(roomIdentifier), tab);
  } catch {
    // Tab memory is only a convenience; navigation should still work when storage is blocked.
  }
}

function openArtifactsForTask(taskId: string): void {
  boardSelectedTaskId.value = taskId;
  artifactTimelineTaskFilterId.value = taskId;
  activityHistoryRequest.value += 1;
  activeTab.value = "activity";
}


function toggleGitHubEventsVisible(): void {
  githubEventsVisible.value = !githubEventsVisible.value;
  rememberGitHubEventsVisible(props.room.identifier, githubEventsVisible.value);
}

function setEnvironmentPanelOpen(open: boolean): void {
  environmentPanelOpen.value = open;
  rememberEnvironmentPanelOpen(props.room.identifier, open);
  if (open) void refreshEnvironmentRepoStatus();
}

async function refreshEnvironmentRepoStatus(): Promise<void> {
  const rootPath = props.repoStatus.rootPath?.trim();
  if (!rootPath || !desktopIpc.repos?.getStatus) return;
  const requestId = ++environmentRepoStatusRefreshRequestId;
  const nextStatus = await desktopIpc.repos.getStatus(rootPath).catch(() => null);
  if (requestId !== environmentRepoStatusRefreshRequestId || !nextStatus) return;
  if (nextStatus.rootPath !== props.repoStatus.rootPath) return;
  refreshedEnvironmentRepoStatus.value = nextStatus;
}

async function setRoomStorageMode(mode: DesktopRoomStorageState["overrideMode"]): Promise<void> {
  const bridge = desktopIpc.chatStorage;
  if (!bridge?.setRoomMode || storageBusy.value) return;
  if (mode === "local" && !props.storage.localRoom) {
    await forkRoomToLocal();
    return;
  }
  storageBusy.value = true;
  try {
    await bridge.setRoomMode(props.room.identifier, mode);
    const snapshot = await desktopIpc.room?.getSnapshot?.(props.room.identifier);
    emit("refresh-room", snapshot);
  } finally {
    storageBusy.value = false;
  }
}

async function forkRoomToLocal(): Promise<void> {
  const bridge = desktopIpc.chatStorage;
  if (!bridge?.forkRoomToLocal || storageBusy.value) return;
  const confirmed = window.confirm(
    "Switch this room to Local on this device? Desktop will import the current chat and board into local storage, keep this same room visible, and keep new updates on this device until you publish.",
  );
  if (!confirmed) return;
  storageBusy.value = true;
  try {
    const result = await bridge.forkRoomToLocal(props.room.identifier);
    await desktopIpc.room?.stopStream?.(props.room.identifier);
    actionPanelOpen.value = false;
    emit("refresh-room", result.snapshot);
  } finally {
    storageBusy.value = false;
  }
}

async function publishLocalRoom(): Promise<void> {
  const bridge = desktopIpc.chatStorage;
  if (!bridge?.publishLocalRoom || storageBusy.value) return;
  storageBusy.value = true;
  try {
    await bridge.publishLocalRoom(props.room.identifier);
    const snapshot = await desktopIpc.room?.getSnapshot?.(props.room.identifier);
    emit("refresh-room", snapshot);
  } finally {
    storageBusy.value = false;
  }
}

function toggleSearchTool(): void {
  if (!searchOpen.value) {
    actionPanelOpen.value = false;
  }
  toggleSearchOpen();
}

function toggleActionPanel(): void {
  const nextOpen = !actionPanelOpen.value;
  actionPanelOpen.value = nextOpen;
  if (nextOpen) {
    closeSearch();
  }
}

function closeActionPanel(): void {
  actionPanelOpen.value = false;
}

function openRules(): void {
  rulesOpen.value = true;
  actionPanelOpen.value = false;
}

function openAddAgentModal(): void {
  if (props.projectRoom && !props.durableProjectRootPath) {
    pushActionToast("Connect this room to its local project before adding an agent.", "info", 6_000);
    return;
  }
  addAgentModalOpen.value = true;
}

async function retryRoomAgentDelivery(agentId: string, sourceMessageId: string): Promise<void> {
  if (!deliveryRetryAvailable.value) return;
  const entry = supervisorEntries.value.find((candidate) => candidate.id === agentId);
  if (!entry?.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) {
    pushActionToast("This delivery binding changed. Refresh the room before retrying.", "error", 6_000);
    return;
  }
  const { workAttemptId, executionGenerationId, agentSessionId } = entry;
  const result = await deliveryRetryCoordinator.run({ agentId, sourceMessageId }, async () => {
    await desktopIpc.supervisor!.retryRoomDelivery({
      entryId: entry.id,
      roomId: props.room.identifier,
      sourceMessageId,
      workAttemptId,
      executionGenerationId,
      agentSessionId,
    });
    await refreshManagedAgentSessions();
    const refreshed = supervisorEntries.value.find((candidate) => candidate.id === agentId);
    return refreshed?.deliveryReceipts?.find((candidate) => candidate.sourceMessageId === sourceMessageId);
  });
  if (!result.started) return;
  if (!result.ok) {
    pushActionToast(result.error instanceof Error ? result.error.message : "Could not retry room delivery.", "error", 7_000);
    return;
  }
  pushActionToast(
    result.value?.state === "blocked"
      ? "Delivery still needs attention."
      : "Delivery retry accepted. The agent is resuming delivery.",
    result.value?.state === "blocked" ? "error" : "success",
    5_000,
  );
}

function exactRoomDeliveryControlInput(agentId: string, sourceMessageId: string): {
  entryId: string;
  roomId: string;
  sourceMessageId: string;
  workAttemptId: string;
  executionGenerationId: string;
  agentSessionId: string;
} | null {
  const entry = supervisorEntries.value.find((candidate) => candidate.id === agentId);
  if (!entry?.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) return null;
  return {
    entryId: entry.id,
    roomId: props.room.identifier,
    sourceMessageId,
    workAttemptId: entry.workAttemptId,
    executionGenerationId: entry.executionGenerationId,
    agentSessionId: entry.agentSessionId,
  };
}

async function restoreAgentConversation(agentId: string, sourceMessageId: string): Promise<void> {
  if (!continuationRepairAvailable.value) return;
  const input = exactRoomDeliveryControlInput(agentId, sourceMessageId);
  if (!input) {
    pushActionToast("This agent binding changed. Refresh the room before restoring its conversation.", "error", 7_000);
    return;
  }
  const result = await continuationRepairCoordinator.run({ agentId, sourceMessageId }, async () => {
    await desktopIpc.supervisor.restoreAgentConversation(input);
  });
  if (!result.started) return;
  if (!result.ok) {
    pushActionToast(result.error instanceof Error ? result.error.message : "Could not restore this agent’s conversation.", "error", 7_000);
    return;
  }
  pushActionToast("Conversation restoration started. The provider will stay running.", "success", 5_000);
}

async function skipRoomDelivery(agentId: string, sourceMessageId: string): Promise<void> {
  if (!roomDeliverySkipAvailable.value) return;
  const input = exactRoomDeliveryControlInput(agentId, sourceMessageId);
  if (!input) {
    pushActionToast("This agent binding changed. Refresh the room before skipping the message.", "error", 7_000);
    return;
  }
  const result = await roomDeliverySkipCoordinator.run({ agentId, sourceMessageId }, async () => {
    await desktopIpc.supervisor.skipRoomDelivery(input);
  });
  if (!result.started) return;
  if (!result.ok) {
    pushActionToast(result.error instanceof Error ? result.error.message : "Could not safely skip this message.", "error", 7_000);
    return;
  }
  pushActionToast("Message skipped. Later room work can continue.", "success", 5_000);
}

async function revealRoomMessage(messageId: string): Promise<void> {
  const revealed = await revealMessage(messageId);
  if (!revealed) {
    emit("message-reveal-unavailable", messageId);
    return;
  }
  // Repeated links to the same message need a new reactive edge.
  revealedMessageId.value = null;
  await nextTick();
  revealedMessageId.value = messageId;
}

async function revealRecordedWorkMessage(messageId: string): Promise<void> {
  if (!messageId.trim()) return;
  activeTab.value = "chat";
  await revealRoomMessage(messageId);
}

const supervisorGenerationChangedMessage =
  "Background agent management restarted. Current state was refreshed; review and retry.";
const supervisorSettingsGenerationChangedMessage =
  "Background agent management restarted. Your draft is preserved; reload the current configuration before saving.";

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
      agentInspectorSettingsRequestToken += 1;
      agentInspectorConfigurationResource.value = {
        ...agentInspectorConfigurationResource.value,
        status: "error",
        error: supervisorSettingsGenerationChangedMessage,
      };
      agentInspectorSettingsConflict.value = true;
    }
    agentInspectorRoomMoveRequestToken += 1;
    if (agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRoomMoveRecoveryTimer);
    agentInspectorRoomMoveRecoveryTimer = null;
    if (agentInspectorRoomMoveResource.value.move) {
      agentInspectorRoomMoveResource.value = {
        ...agentInspectorRoomMoveResource.value,
        status: "recovering",
        error: null,
      };
      if (agentInspectorActionState.value?.status !== "running") void loadAgentInspectorRoomMove();
    }
  }
  return status;
}

function markSupervisorStatusUnavailable(): void {
  supervisorStatus.value = null;
  deliveryRetryNegotiated.value = false;
  if (agentInspectorConfigurationResource.value.configuration) {
    agentInspectorSettingsRequestToken += 1;
    agentInspectorConfigurationResource.value = {
      ...agentInspectorConfigurationResource.value,
      status: "error",
      error: "Background agent management is unavailable. Your draft is preserved.",
    };
  }
  agentInspectorRoomMoveRequestToken += 1;
  if (agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRoomMoveRecoveryTimer);
  agentInspectorRoomMoveRecoveryTimer = null;
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
  const requestToken = ++supervisorStatusRequestToken;
  const refresh = (async () => {
    if (!desktopIpc.supervisor?.getStatus) {
      if (requestToken === supervisorStatusRequestToken) markSupervisorStatusUnavailable();
      return null;
    }
    try {
      const status = await desktopIpc.supervisor.getStatus();
      if (requestToken !== supervisorStatusRequestToken) return supervisorStatus.value;
      return applySupervisorStatus(status);
    } catch {
      if (requestToken === supervisorStatusRequestToken) markSupervisorStatusUnavailable();
      return null;
    }
  })();
  const tracked = refresh.finally(() => {
    if (supervisorStatusRefreshInFlight === tracked) supervisorStatusRefreshInFlight = null;
    const trailingGeneration = supervisorStatusTrailingRefreshGeneration({
      ownerActive: managedAgentSessionsRefreshOwnerActive,
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

function refreshManagedAgentSessions(): Promise<void> {
  if (!managedAgentSessionsRefreshOwnerActive) return Promise.resolve();
  if (managedAgentSessionsRefreshInFlight) {
    managedAgentSessionsRefreshQueued = true;
    return managedAgentSessionsRefreshInFlight;
  }
  const refresh = performManagedAgentSessionsRefresh();
  managedAgentSessionsRefreshInFlight = refresh.finally(() => {
    supervisorStateLastRepairAtMs = Date.now();
    managedAgentSessionsRefreshInFlight = null;
    if (managedAgentSessionsRefreshOwnerActive && managedAgentSessionsRefreshQueued) {
      managedAgentSessionsRefreshQueued = false;
      void refreshManagedAgentSessions();
    } else {
      scheduleManagedAgentSessionsRepair();
    }
  });
  return managedAgentSessionsRefreshInFlight;
}

function retryAgentInspectorState(): void {
  if (!selectedAgentDetailRequest.value) return;
  supervisorEntriesState.value = supervisorEntriesHaveLoaded.value ? "refreshing" : "loading";
  supervisorEntriesError.value = null;
  void refreshManagedAgentSessions();
}

async function performManagedAgentSessionsRefresh(): Promise<void> {
  if (!managedAgentSessionsRefreshOwnerActive || !props.room.identifier) return;
  const roomIdentifier = props.room.identifier;
  const requestId = ++managedAgentSessionsRefreshRequestId;
  const mutationVersion = managedAgentSessionsMutationVersion;
  const supervisorMutationVersion = supervisorEntriesMutationVersion;
  if (!supervisorEntriesHaveLoaded.value) {
    supervisorEntriesState.value = "loading";
    supervisorEntriesError.value = null;
  }
  const pollSupervisor = !supervisorEntriesHaveLoaded.value || supervisorStateSubscriptionNeedsRepair({
    active: supervisorStateSubscriptionActive,
    lastSnapshotAtMs: supervisorStateLastSnapshotAtMs,
    nowMs: Date.now(),
  });
  const [sessions, entriesResult] = await Promise.all([
    desktopIpc.workers?.listManagedAgentSessions
      ? desktopIpc.workers.listManagedAgentSessions(roomIdentifier).catch(() => null)
      : Promise.resolve(null),
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
    !managedAgentSessionsRefreshOwnerActive
    || props.room.identifier !== roomIdentifier
    || requestId !== managedAgentSessionsRefreshRequestId
  ) return;
  if (sessions && mutationVersion === managedAgentSessionsMutationVersion) {
    if (!managedAgentSessionListsEqual(managedAgentSessions.value, sessions)) {
      managedAgentSessions.value = sessions;
    }
  } else if (!sessions && mutationVersion === managedAgentSessionsMutationVersion) {
    const scoped = managedAgentSessions.value.filter((session) =>
      managedAgentSessionMatchesRoom(session, roomIdentifier)
    );
    // Identity-stable like the success path: repeated poll errors must not
    // re-render the shell every tick.
    if (scoped.length !== managedAgentSessions.value.length) {
      managedAgentSessions.value = scoped;
    }
  }
  if (entriesResult.ok) {
    if (supervisorMutationVersion === supervisorEntriesMutationVersion) {
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
  } else if (!supervisorStateSubscriptionActive || !supervisorEntriesHaveLoaded.value) {
    // Keep the last successfully loaded entries. Consumers receive an error
    // resource instead of an empty list, so supervised identity cannot be
    // reclassified as external during a transient daemon failure.
    supervisorEntriesState.value = "error";
    supervisorEntriesError.value = entriesResult.error;
  }
}

function upsertManagedAgentSession(session: DesktopManagedAgentSession): void {
  managedAgentSessionsMutationVersion += 1;
  managedAgentSessions.value = withUpsertedManagedAgentSession(
    managedAgentSessions.value,
    session,
  );
}

function applyAgentInspectorParticipantSessionUpdate(
  update: AgentInspectorParticipantSessionUpdate,
): void {
  if (!isCurrentAgentInspectorParticipantSessionUpdate(update, {
    roomIdentifier: props.room.identifier,
    inspectorRequestVersion: selectedAgentDetailRequestVersion.value,
    selection: selectedAgentDetailTarget.value,
    sessions: roomManagedAgentSessions.value,
  })) return;
  upsertManagedAgentSession(update.session);
}

function upsertSupervisorEntry(update: AgentInspectorSupervisorEntryUpdate): void {
  if (!isCurrentAgentInspectorSupervisorUpdate(
    update,
    props.room.identifier,
    selectedAgentDetailRequestVersion.value,
  )) return;
  supervisorEntriesMutationVersion += 1;
  supervisorEntries.value = [
    update.entry,
    ...supervisorEntries.value.filter((candidate) => candidate.id !== update.entry.id),
  ];
  supervisorEntriesHaveLoaded.value = true;
  supervisorEntriesUpdatedAt.value = new Date().toISOString();
  supervisorEntriesState.value = "ready";
  supervisorEntriesError.value = null;
}

async function resolveComposerPermission(
  approval: ManagedAgentPermissionApproval,
  behavior: DesktopManagedAgentPermissionDecisionBehavior,
): Promise<void> {
  if (resolvingComposerPermissionIds.value[approval.id]) return;
  resolvingComposerPermissionIds.value = {
    ...resolvingComposerPermissionIds.value,
    [approval.id]: behavior,
  };
  composerPermissionError.value = null;
  try {
    const result = await desktopIpc.workers.resolveManagedAgentPermission({
      requestId: approval.request.id,
      sessionId: approval.request.sessionId,
      behavior,
      message: behavior === "deny" ? "Denied from LetAgents Desktop." : null,
    });
    if (result.session) {
      upsertManagedAgentSession(result.session);
    } else {
      await refreshManagedAgentSessions();
    }
  } catch (error) {
    composerPermissionError.value = error instanceof Error
      ? error.message
      : "Could not resolve this permission request.";
  } finally {
    const { [approval.id]: _ignored, ...remaining } = resolvingComposerPermissionIds.value;
    resolvingComposerPermissionIds.value = remaining;
  }
}

function openComposerPermissionDetail(approval: ManagedAgentPermissionApproval): void {
  const target = agentTargetForManagedSession(approval.session);
  if (approval.session.supervisorEntryId) {
    openAgentDetailRequest({
      kind: "supervised",
      supervisorEntryId: approval.session.supervisorEntryId,
      target,
    });
    return;
  }
  openAgentDetailFromParticipant(target);
}

function agentTargetForManagedSession(session: DesktopManagedAgentSession): AgentModalTarget {
  const displayName = managedAgentSessionDisplayName(session);
  return {
    messageId: null,
    clientMessageId: null,
    messageSource: null,
    actorLabel: session.actorLabel,
    displayName,
    ownerAttribution: ownerAttributionLabel(session.ownerLabel),
    ideLabel: session.ideLabel,
    sender: session.actorLabel || displayName,
    agentKey: session.agentKey,
    agentSessionId: session.agentSessionId,
  };
}

function scheduleManagedAgentSessionsRepair(): void {
  stopManagedAgentSessionsRefreshTimer();
  if (!props.room.identifier || (!desktopIpc.workers?.listManagedAgentSessions && !desktopIpc.supervisor?.listAgents)) return;
  const delayMs = supervisorStateRepairDelayMs({
    lastRepairAtMs: supervisorStateLastRepairAtMs,
    nowMs: Date.now(),
  });
  managedAgentSessionsRefreshTimer = window.setTimeout(() => {
    managedAgentSessionsRefreshTimer = null;
    // A hidden window has no observer that needs repaired projections. Foreground
    // transition performs the repair and establishes the next deadline.
    if (shouldSkipPollTick({ hidden: document.hidden })) return;
    // Managed-session pushes are a different channel from daemon state
    // snapshots. Always repair that population on the bounded cadence;
    // performManagedAgentSessionsRefresh polls daemon entries/status only if
    // their own subscription heartbeat is stale.
    void refreshManagedAgentSessions();
  }, delayMs);
}

function handleManagedAgentSessionsVisibilityChange(): void {
  if (document.hidden) return;
  void refreshManagedAgentSessions();
}

function stopManagedAgentSessionsRefreshTimer(): void {
  if (managedAgentSessionsRefreshTimer !== null) {
    window.clearTimeout(managedAgentSessionsRefreshTimer);
    managedAgentSessionsRefreshTimer = null;
  }
}

async function openAgentDetailFromParticipant(target: AgentModalTarget): Promise<void> {
  const hasExactPublishedIdentity = Boolean(target.clientMessageId?.trim());
  const hasExactRuntimeIdentity = Boolean(
    target.agentSessionId?.trim()
    || (target.agentKey?.trim() && /[/:]/.test(target.agentKey)),
  );
  if (hasExactPublishedIdentity || hasExactRuntimeIdentity || !target.messageId?.trim()) {
    openAgentDetailRequest(participantAgentInspectorRequest(target));
    return;
  }

  const roomIdentifier = props.room.identifier;
  const requestToken = ++agentInspectorMessageIdentityRequestToken;
  openAgentDetailRequest(resolvingAgentInspectorRequest(target));
  const requestVersion = selectedAgentDetailRequestVersion.value;
  try {
    const message = await desktopIpc.room.getMessage(roomIdentifier, target.messageId);
    if (
      requestToken !== agentInspectorMessageIdentityRequestToken
      || requestVersion !== selectedAgentDetailRequestVersion.value
      || roomIdentifier !== props.room.identifier
    ) return;
    openAgentDetailRequest(participantAgentInspectorRequest(message
      ? {
          ...target,
          messageId: message.id,
          clientMessageId: message.clientMessageId ?? null,
          messageSource: message.source ?? target.messageSource,
          actorLabel: message.actorLabel || message.agentIdentity?.actorLabel || target.actorLabel,
          agentKey: message.agentIdentity?.agentKey || target.agentKey,
          agentSessionId: message.agentIdentity?.agentSessionId || target.agentSessionId,
        }
      : target));
  } catch {
    if (
      requestToken !== agentInspectorMessageIdentityRequestToken
      || requestVersion !== selectedAgentDetailRequestVersion.value
      || roomIdentifier !== props.room.identifier
    ) return;
    openAgentDetailRequest(participantAgentInspectorRequest(target));
  }
}

function openAgentDetailRequest(request: AgentInspectorRequest): void {
  selectedAgentDetailRequestVersion.value += 1;
  selectedAgentDetailRequest.value = request;
  agentInspectorActionState.value = null;
  agentInspectorWorkRequestToken += 1;
  agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
  agentInspectorWorkSourceMessageId.value = null;
  // A fresh agent opens on the Overview tab; drop any prior live subscription
  // so a stale agent's feed never leaks into the new inspector.
  stopAgentInspectorLive();
  resetAgentInspectorSettings();
  // Live capability copy is provider-driven and must be ready independently
  // of the Settings tab, which happens to consume the same catalog.
  void loadAgentInspectorProviders();
  // Overview reads the exact current control-health projection without
  // selecting or loading a retained message from the Work tab.
  void loadAgentInspectorWorkDetail(null, false, false);
}

async function loadAgentInspectorProviders(): Promise<void> {
  if (agentInspectorProviders.value.length > 0) return;
  if (agentInspectorProvidersRequest) return agentInspectorProvidersRequest;
  agentInspectorProvidersRequest = desktopIpc.workers.listAgentProviders()
    .then((providers) => { agentInspectorProviders.value = providers; })
    .catch(() => undefined)
    .finally(() => { agentInspectorProvidersRequest = null; });
  return agentInspectorProvidersRequest;
}

function closeAgentDetail(): void {
  agentInspectorMessageIdentityRequestToken += 1;
  selectedAgentDetailRequestVersion.value += 1;
  selectedAgentDetailRequest.value = null;
  agentInspectorActionState.value = null;
  agentInspectorWorkRequestToken += 1;
  agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
  agentInspectorWorkSourceMessageId.value = null;
  stopAgentInspectorLive();
  resetAgentInspectorSettings();
}

function openAgentInspectorLive(): void {
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  agentInspectorLiveFeed.value = { events: [], ended: false, droppedEvents: 0 };
  void loadAgentInspectorProviders();
  void desktopIpc.supervisor?.watchAgentStream?.(projection.entryId);
}

function stopAgentInspectorLive(): void {
  agentInspectorLiveFeed.value = { events: [], ended: false, droppedEvents: 0 };
  void desktopIpc.supervisor?.watchAgentStream?.(null);
}

function resetAgentInspectorSettings(): void {
  agentInspectorSettingsRequestToken += 1;
  agentInspectorSettingsDraftVersion = 0;
  agentInspectorRoomMoveRequestToken += 1;
  if (agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRoomMoveRecoveryTimer);
  agentInspectorRoomMoveRecoveryTimer = null;
  agentInspectorConfigurationResource.value = { status: "idle", configuration: null, draft: null, error: null };
  agentInspectorRoomMoveResource.value = { status: "idle", move: null, error: null };
  agentInspectorProviders.value = [];
  agentInspectorSettingsConflict.value = false;
}

function agentInspectorSettingsSelectionCurrent(entryId: string, roomId: string): boolean {
  return props.room.identifier === roomId
    && selectedAgentDetailTarget.value?.kind === "supervised"
    && selectedAgentDetailTarget.value.supervisorEntryId === entryId;
}

function agentInspectorSettingsCurrent(fence: AgentInspectorSettingsFence): boolean {
  return agentInspectorSettingsFenceCurrent(fence, {
    entryId: selectedAgentDetailTarget.value?.kind === "supervised"
      ? selectedAgentDetailTarget.value.supervisorEntryId
      : null,
    roomId: props.room.identifier,
    daemonGeneration: supervisorStatus.value?.generation ?? null,
    requestToken: agentInspectorSettingsRequestToken,
  });
}

function agentInspectorActionRunning(): boolean {
  return agentInspectorActionState.value?.status === "running";
}

async function loadAgentInspectorSettings(force = false, retryOnStaleGeneration = true): Promise<void> {
  if (agentInspectorActionRunning()) return;
  const projection = selectedAgentDetailProjection.value;
  if (!projection || !desktopIpc.supervisor?.getAgentConfiguration) {
    agentInspectorConfigurationResource.value = { status: "unavailable", configuration: null, draft: null, error: "Inspector settings require a current desktop supervisor." };
    return;
  }
  if (!force && agentInspectorConfigurationResource.value.status === "ready") return;
  const status = await refreshSupervisorStatus();
  if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
  if (agentInspectorActionRunning()) return;
  if (!status) {
    agentInspectorConfigurationResource.value = {
      status: "error",
      configuration: null,
      draft: null,
      error: "Background agent management is unavailable. Retry when it reconnects.",
    };
    return;
  }
  if (!status.capabilities.agentInspectorSettings) {
    agentInspectorConfigurationResource.value = { status: "unavailable", configuration: null, draft: null, error: "Inspector settings require a current desktop supervisor." };
    return;
  }
  const token = ++agentInspectorSettingsRequestToken;
  const fence: AgentInspectorSettingsFence = {
    entryId: projection.entryId,
    roomId: projection.roomId,
    daemonGeneration: status.generation,
    requestToken: token,
  };
  const previous = agentInspectorConfigurationResource.value;
  agentInspectorConfigurationResource.value = { ...previous, status: previous.configuration ? "refreshing" : "loading", error: null };
  try {
    const [configuration, providers] = await Promise.all([
      desktopIpc.supervisor.getAgentConfiguration({ entryId: projection.entryId, daemonGeneration: status.generation }),
      desktopIpc.workers.listAgentProviders(),
    ]);
    if (!agentInspectorSettingsCurrent(fence)) return;
    agentInspectorProviders.value = providers;
    agentInspectorConfigurationResource.value = { status: "ready", configuration, draft: configurationDraft(configuration), error: null };
    agentInspectorSettingsDraftVersion += 1;
    agentInspectorSettingsConflict.value = false;
  } catch (error) {
    if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId) || token !== agentInspectorSettingsRequestToken) return;
    if (retryOnStaleGeneration && isStaleDaemonGenerationError(error)) {
      const refreshed = await refreshSupervisorStatus();
      if (refreshed && refreshed.generation !== fence.daemonGeneration && agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) {
        await loadAgentInspectorSettings(true, false);
        return;
      }
    }
    agentInspectorConfigurationResource.value = {
      ...previous,
      status: "error",
      error: error instanceof Error ? error.message : "Could not load saved configuration.",
    };
  }
}

async function reloadAgentInspectorSettings(): Promise<void> {
  const action = agentInspectorActionState.value;
  if (action?.kind === "apply_settings" && action.status === "success"
    && selectedAgentDetailProjection.value?.entryId === action.entryId) {
    agentInspectorActionState.value = null;
  }
  await loadAgentInspectorSettings(true);
}

function openAgentInspectorSettings(): void {
  void loadAgentInspectorSettings();
  void loadAgentInspectorRoomMove();
}

function agentInspectorRoomMoveCurrent(fence: AgentInspectorSettingsFence): boolean {
  return agentInspectorSettingsFenceCurrent(fence, {
    entryId: selectedAgentDetailTarget.value?.kind === "supervised"
      ? selectedAgentDetailTarget.value.supervisorEntryId
      : null,
    roomId: props.room.identifier,
    daemonGeneration: supervisorStatus.value?.generation ?? null,
    requestToken: agentInspectorRoomMoveRequestToken,
  });
}

async function applyDiscoveredAgentInspectorRoomMove(move: DesktopSupervisorRoomMove | null): Promise<void> {
  const recovered = recoveredRoomMoveState(move);
  agentInspectorRoomMoveResource.value = recovered.resource;
  if (recovered.refreshAgents) await refreshManagedAgentSessions();
  if (recovered.shouldPoll) scheduleAgentInspectorMoveRecovery();
}

async function loadAgentInspectorRoomMove(retryOnStaleGeneration = true): Promise<void> {
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  const status = await refreshSupervisorStatus();
  if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
  if (!status?.capabilities.agentRoomMove) {
    agentInspectorRoomMoveResource.value = {
      status: "unavailable",
      move: null,
      error: "Durable room-move discovery requires supervisor implementation 2.0.48 or newer.",
    };
    return;
  }
  const requestToken = ++agentInspectorRoomMoveRequestToken;
  const fence: AgentInspectorSettingsFence = {
    entryId: projection.entryId,
    roomId: projection.roomId,
    daemonGeneration: status.generation,
    requestToken,
  };
  agentInspectorRoomMoveResource.value = {
    ...agentInspectorRoomMoveResource.value,
    status: agentInspectorRoomMoveResource.value.move ? "recovering" : "loading",
    error: null,
  };
  try {
    const move = await desktopIpc.supervisor.getCurrentRoomMove({
      entryId: projection.entryId,
      daemonGeneration: status.generation,
    });
    if (!agentInspectorRoomMoveCurrent(fence)) return;
    await applyDiscoveredAgentInspectorRoomMove(move);
  } catch (error) {
    if (!agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId) || requestToken !== agentInspectorRoomMoveRequestToken) return;
    if (retryOnStaleGeneration && isStaleDaemonGenerationError(error)) {
      const refreshed = await refreshSupervisorStatus();
      if (refreshed && refreshed.generation !== fence.daemonGeneration) {
        await loadAgentInspectorRoomMove(false);
        return;
      }
    }
    agentInspectorRoomMoveResource.value = {
      ...agentInspectorRoomMoveResource.value,
      status: "error",
      error: error instanceof Error ? error.message : "Could not discover the current room move.",
    };
  }
}

function scheduleAgentInspectorMoveRecovery(): void {
  if (agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRoomMoveRecoveryTimer);
  agentInspectorRoomMoveRecoveryTimer = window.setTimeout(() => {
    agentInspectorRoomMoveRecoveryTimer = null;
    void loadAgentInspectorRoomMove();
  }, 1_200);
}

function patchAgentInspectorSettings(patch: Partial<AgentInspectorConfigurationDraft>): void {
  const current = agentInspectorConfigurationResource.value;
  if (current.status !== "ready" || !current.draft || agentInspectorActionState.value?.status === "running") return;
  agentInspectorSettingsDraftVersion += 1;
  agentInspectorConfigurationResource.value = { ...current, draft: { ...current.draft, ...patch } };
}

interface AgentInspectorOperationFence {
  operationId: string;
  entryId: string;
  roomId: string;
  requestVersion: number;
  daemonGeneration: number;
  kind: AgentInspectorActionState["kind"];
}

function beginAgentInspectorOperation(kind: AgentInspectorActionState["kind"], message: string, daemonGeneration: number): AgentInspectorOperationFence | null {
  const projection = selectedAgentDetailProjection.value;
  if (!projection || agentInspectorActionState.value?.status === "running") return null;
  const operationId = globalThis.crypto.randomUUID();
  const requestVersion = selectedAgentDetailRequestVersion.value;
  agentInspectorActionState.value = { operationId, entryId: projection.entryId, kind, status: "running", message };
  return { operationId, entryId: projection.entryId, roomId: projection.roomId, requestVersion, daemonGeneration, kind };
}

function agentInspectorOperationIdentityCurrent(operation: AgentInspectorOperationFence): boolean {
  return props.room.identifier === operation.roomId && selectedAgentDetailRequestVersion.value === operation.requestVersion
    && selectedAgentDetailTarget.value?.kind === "supervised" && selectedAgentDetailTarget.value.supervisorEntryId === operation.entryId
    && agentInspectorActionState.value?.operationId === operation.operationId;
}

function agentInspectorOperationCurrent(operation: AgentInspectorOperationFence): boolean {
  return agentInspectorOperationIdentityCurrent(operation)
    && supervisorStatus.value?.generation === operation.daemonGeneration;
}

async function recoverAgentInspectorSettingsGeneration(
  operation: AgentInspectorOperationFence,
  preservedDraft: AgentInspectorConfigurationDraft,
): Promise<void> {
  if (!agentInspectorOperationIdentityCurrent(operation)) return;
  agentInspectorActionState.value = {
    operationId: operation.operationId,
    entryId: operation.entryId,
    kind: operation.kind,
    status: "error",
    message: supervisorSettingsGenerationChangedMessage,
  };
  const status = await refreshSupervisorStatus();
  if (!status || !agentInspectorOperationIdentityCurrent(operation) || !desktopIpc.supervisor?.getAgentConfiguration) return;
  const token = ++agentInspectorSettingsRequestToken;
  const fence: AgentInspectorSettingsFence = {
    entryId: operation.entryId,
    roomId: operation.roomId,
    daemonGeneration: status.generation,
    requestToken: token,
  };
  try {
    const [configuration, providers] = await Promise.all([
      desktopIpc.supervisor.getAgentConfiguration({ entryId: operation.entryId, daemonGeneration: status.generation }),
      desktopIpc.workers.listAgentProviders(),
    ]);
    if (!agentInspectorSettingsCurrent(fence) || !agentInspectorOperationIdentityCurrent(operation)) return;
    agentInspectorProviders.value = providers;
    agentInspectorConfigurationResource.value = { status: "ready", configuration, draft: preservedDraft, error: null };
    agentInspectorSettingsDraftVersion += 1;
    agentInspectorSettingsConflict.value = true;
  } catch (error) {
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    agentInspectorConfigurationResource.value = {
      ...agentInspectorConfigurationResource.value,
      status: "error",
      draft: preservedDraft,
      error: error instanceof Error ? error.message : "Could not refresh configuration after the supervisor restarted.",
    };
  }
}

async function saveAgentInspectorSettings(overwrite: boolean): Promise<void> {
  if (!desktopIpc.supervisor?.updateAgentConfiguration) return;
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  const status = await refreshSupervisorStatus();
  if (!status || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
  if (agentInspectorConfigurationResource.value.status !== "ready") return;
  const snapshot = snapshotConfigurationSave(
    agentInspectorConfigurationResource.value,
    agentInspectorSettingsDraftVersion,
    status.generation,
  );
  if (!snapshot) {
    const draft = agentInspectorConfigurationResource.value.draft;
    if (draft) {
      const operation = beginAgentInspectorOperation("save_settings", "Refreshing configuration after supervisor restart…", status.generation);
      if (operation) await recoverAgentInspectorSettingsGeneration(operation, draft);
    }
    return;
  }
  const operation = beginAgentInspectorOperation("save_settings", overwrite ? "Overwriting saved configuration…" : "Saving configuration…", status.generation);
  if (!operation) return;
  agentInspectorSettingsRequestToken += 1;
  try {
    const result = await desktopIpc.supervisor.updateAgentConfiguration({
      entryId: operation.entryId,
      daemonGeneration: snapshot.daemonGeneration,
      expectedRevision: snapshot.expectedRevision,
      configuration: snapshot.draft,
    });
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    if (!agentInspectorOperationCurrent(operation)) {
      await recoverAgentInspectorSettingsGeneration(operation, snapshot.draft);
      return;
    }
    if (result.outcome === "conflict") {
      agentInspectorConfigurationResource.value = settleConfigurationConflict(
        agentInspectorConfigurationResource.value,
        snapshot,
        result.configuration,
      );
      agentInspectorSettingsConflict.value = true;
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "save_settings", status: "error", message: "Saved configuration changed elsewhere. Your draft is preserved." };
      return;
    }
    if (result.outcome === "invalid") throw new Error(result.error);
    const settled = settleConfigurationUpdate(
      agentInspectorConfigurationResource.value,
      agentInspectorSettingsDraftVersion,
      snapshot,
      result.configuration,
    );
    agentInspectorConfigurationResource.value = settled.resource;
    agentInspectorSettingsDraftVersion = settled.draftVersion;
    agentInspectorSettingsConflict.value = false;
    agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "save_settings", status: "success", message: "Configuration saved." };
  } catch (error) {
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    const refreshed = await refreshSupervisorStatus();
    if (isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration) {
      await recoverAgentInspectorSettingsGeneration(operation, snapshot.draft);
      return;
    }
    agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "save_settings", status: "error", message: error instanceof Error ? error.message : "Configuration could not be saved." };
  }
}

async function prepareAgentInspectorRoomMove(destinationRoomId: string): Promise<void> {
  if (!destinationRoomId.trim()) return;
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  const status = await refreshSupervisorStatus();
  if (!status?.capabilities.agentRoomMove || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
  const operation = beginAgentInspectorOperation("move_room", "Preparing durable room move…", status.generation);
  if (!operation) return;
  agentInspectorRoomMoveRequestToken += 1;
  if (agentInspectorRoomMoveRecoveryTimer !== null) window.clearTimeout(agentInspectorRoomMoveRecoveryTimer);
  agentInspectorRoomMoveRecoveryTimer = null;
  agentInspectorRoomMoveResource.value = { status: "preparing", move: null, error: null };
  try {
    const move = await desktopIpc.supervisor.prepareRoomMove({
      entryId: operation.entryId,
      destinationRoomId,
      requestId: globalThis.crypto.randomUUID(),
      daemonGeneration: operation.daemonGeneration,
    });
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    if (!agentInspectorOperationCurrent(operation)) {
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "move_room", status: "error", message: supervisorGenerationChangedMessage };
      await loadAgentInspectorRoomMove();
      return;
    }
    agentInspectorRoomMoveResource.value = { status: "idle", move, error: null };
    agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "move_room", status: "success", message: "Move prepared. Continue when ready." };
  } catch (error) {
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    const refreshed = await refreshSupervisorStatus();
    const stale = isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration;
    agentInspectorActionState.value = {
      operationId: operation.operationId,
      entryId: operation.entryId,
      kind: "move_room",
      status: "error",
      message: stale ? supervisorGenerationChangedMessage : error instanceof Error ? error.message : "Room move could not be prepared.",
    };
    if (stale) await loadAgentInspectorRoomMove();
    else agentInspectorRoomMoveResource.value = { status: "error", move: null, error: agentInspectorActionState.value.message };
  }
}

async function commitAgentInspectorRoomMove(): Promise<void> {
  const currentMove = agentInspectorRoomMoveResource.value.move;
  if (!currentMove) return;
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  const status = await refreshSupervisorStatus();
  if (!status?.capabilities.agentRoomMove || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
  const operation = beginAgentInspectorOperation("move_room", "Continuing durable room move…", status.generation);
  if (!operation) return;
  agentInspectorRoomMoveRequestToken += 1;
  agentInspectorRoomMoveResource.value = { status: "committing", move: currentMove, error: null };
  try {
    const move = await desktopIpc.supervisor.commitRoomMove({
      operationId: currentMove.operationId,
      entryId: operation.entryId,
      daemonGeneration: operation.daemonGeneration,
    });
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    if (!agentInspectorOperationCurrent(operation)) {
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "move_room", status: "error", message: supervisorGenerationChangedMessage };
      await loadAgentInspectorRoomMove();
      return;
    }
    agentInspectorActionState.value = {
      operationId: operation.operationId,
      entryId: operation.entryId,
      kind: "move_room",
      status: "success",
      message: move.phase === "active" ? "Room move completed." : "Room move is continuing in the daemon.",
    };
    await applyDiscoveredAgentInspectorRoomMove(move);
  } catch (error) {
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    const refreshed = await refreshSupervisorStatus();
    const stale = isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration;
    agentInspectorActionState.value = {
      operationId: operation.operationId,
      entryId: operation.entryId,
      kind: "move_room",
      status: "error",
      message: stale ? supervisorGenerationChangedMessage : error instanceof Error ? error.message : "Room move could not continue.",
    };
    if (stale) await loadAgentInspectorRoomMove();
    else agentInspectorRoomMoveResource.value = { status: "error", move: currentMove, error: agentInspectorActionState.value.message };
  }
}

async function retireAgentInspectorAgent(): Promise<void> {
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  await runAgentInspectorAction({
    entryId: projection.entryId,
    roomId: projection.roomId,
    kind: "retire_agent",
  });
}

async function purgeAgentInspectorAgent(): Promise<void> {
  if (!desktopIpc.supervisor?.purgeAgent) return;
  const projection = selectedAgentDetailProjection.value;
  if (!projection) return;
  const status = await refreshSupervisorStatus();
  if (!status || !agentInspectorSettingsSelectionCurrent(projection.entryId, projection.roomId)) return;
  const operation = beginAgentInspectorOperation("purge_agent", "Revoking credentials and purging durable records…", status.generation);
  if (!operation) return;
  try {
    const result = await desktopIpc.supervisor.purgeAgent({ entryId: operation.entryId, daemonGeneration: operation.daemonGeneration });
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    if (!agentInspectorOperationCurrent(operation)) {
      agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "purge_agent", status: "error", message: supervisorGenerationChangedMessage };
      return;
    }
    if (result.outcome !== "purged") throw new Error(result.error || "Purge could not be completed.");
    agentInspectorActionState.value = { operationId: operation.operationId, entryId: operation.entryId, kind: "purge_agent", status: "success", message: "Durable agent records purged. The worktree was preserved." };
    await refreshManagedAgentSessions();
    if (agentInspectorOperationIdentityCurrent(operation)) closeAgentDetail();
  } catch (error) {
    if (!agentInspectorOperationIdentityCurrent(operation)) return;
    const refreshed = await refreshSupervisorStatus();
    agentInspectorActionState.value = {
      operationId: operation.operationId,
      entryId: operation.entryId,
      kind: "purge_agent",
      status: "error",
      message: isStaleDaemonGenerationError(error) || refreshed?.generation !== operation.daemonGeneration
        ? supervisorGenerationChangedMessage
        : error instanceof Error ? error.message : "Purge could not be completed.",
    };
  }
}

function refreshOpenAgentInspectorRuntimeControl(snapshot: DesktopSupervisorStateSnapshot): void {
  const target = selectedAgentDetailTarget.value;
  if (target?.kind !== "supervised") return;
  const entry = snapshot.entries.find((candidate) => candidate.id === target.supervisorEntryId);
  const detail = agentInspectorWorkResource.value.detail;
  if (!entry || entry.roomId !== props.room.identifier) return;
  // The renderer cannot identify a provider process birth from a state snapshot.
  // Drop cached health before reconciling so a failed refresh cannot resurrect
  // evidence from a replaced or now-absent process in the same execution.
  if (detail?.runtime_control) {
    agentInspectorWorkResource.value = {
      ...agentInspectorWorkResource.value,
      detail: { ...detail, runtime_control: null },
    };
  }
  void loadAgentInspectorWorkDetail(agentInspectorWorkSourceMessageId.value, true, false);
}

function agentInspectorWorkRequestStillCurrent(
  entryId: string,
  roomId: string,
  sourceMessageId: string | null,
  executionGenerationId: string | null,
  daemonGeneration: number,
  token: number,
): boolean {
  const target = selectedAgentDetailTarget.value;
  const projection = selectedAgentDetailProjection.value;
  return token === agentInspectorWorkRequestToken
    && props.room.identifier === roomId
    && target?.kind === "supervised"
    && target.supervisorEntryId === entryId
    && projection?.entry.executionGenerationId === executionGenerationId
    && supervisorStatus.value?.generation === daemonGeneration
    && agentInspectorWorkSourceMessageId.value === sourceMessageId;
}

function selectAgentInspectorWorkSource(sourceMessageId: string): void {
  if (!sourceMessageId.trim()) return;
  agentInspectorWorkSourceMessageId.value = sourceMessageId;
  // A work item is a fenced causal record, not a generic detail cache. Never
  // leave the previous message visible while the exact new source is loading.
  agentInspectorWorkResource.value = { status: "loading", detail: null, error: null, sourceMessageId };
  void loadAgentInspectorWorkDetail(sourceMessageId);
}

function openAgentInspectorWork(): void {
  const projection = selectedAgentDetailProjection.value;
  const sourceMessageId = projection
    ? defaultAgentInspectorWorkSource(projection.entry, agentInspectorWorkResource.value.detail)
    : null;
  agentInspectorWorkSourceMessageId.value = sourceMessageId;
  // Re-entering Work reconciles the exact active source and receipt; manifest
  // activity may have advanced while another tab was selected.
  void loadAgentInspectorWorkDetail(sourceMessageId, true);
}

async function loadAgentInspectorWorkDetail(
  sourceMessageId: string | null = agentInspectorWorkSourceMessageId.value,
  force = false,
  followDefaultSource = true,
): Promise<void> {
  const target = selectedAgentDetailTarget.value;
  const projection = selectedAgentDetailProjection.value;
  if (target?.kind !== "supervised" || !projection || projection.roomId !== props.room.identifier) return;
  if (!desktopIpc.supervisor?.getAgentInspectorDetail || !supervisorStatus.value?.capabilities.agentInspectorDetail) {
    agentInspectorWorkResource.value = { status: "unavailable", detail: null, error: null, sourceMessageId };
    return;
  }
  if (!force && agentInspectorWorkResource.value.status === "ready" && agentInspectorWorkSourceMessageId.value === sourceMessageId) return;
  const executionGenerationId = projection.entry.executionGenerationId;
  const daemonGeneration = supervisorStatus.value.generation;
  agentInspectorWorkSourceMessageId.value = sourceMessageId;
  const token = ++agentInspectorWorkRequestToken;
  const cached = agentInspectorWorkResource.value.detail;
  const previous = agentInspectorWorkResource.value.sourceMessageId === sourceMessageId
    && cached
    && isCurrentAgentInspectorWorkResponse(cached, target.supervisorEntryId, projection.roomId, sourceMessageId)
    ? cached
    : null;
  agentInspectorWorkResource.value = { status: previous ? "refreshing" : "loading", detail: previous, error: null, sourceMessageId };
  try {
    const detail = await desktopIpc.supervisor.getAgentInspectorDetail({ entryId: target.supervisorEntryId, roomId: projection.roomId, sourceMessageId });
    if (!agentInspectorWorkRequestStillCurrent(target.supervisorEntryId, projection.roomId, sourceMessageId,
      executionGenerationId, daemonGeneration, token)
      || !isCurrentAgentInspectorWorkResponse(detail, target.supervisorEntryId, projection.roomId, sourceMessageId)) return;
    const currentDetail = detail.runtime_control && !agentInspectorRuntimeControlMatchesFence(
      detail.runtime_control, executionGenerationId, daemonGeneration,
    ) ? { ...detail, runtime_control: null } : detail;
    const defaultSource = defaultAgentInspectorWorkSource(projection.entry, currentDetail);
    agentInspectorWorkResource.value = { status: "ready", detail: currentDetail, error: null, sourceMessageId };
    if (followDefaultSource && sourceMessageId === null && defaultSource && defaultSource !== agentInspectorWorkSourceMessageId.value) {
      agentInspectorWorkSourceMessageId.value = defaultSource;
      void loadAgentInspectorWorkDetail(defaultSource);
    }
  } catch (error) {
    if (!agentInspectorWorkRequestStillCurrent(target.supervisorEntryId, projection.roomId, sourceMessageId,
      executionGenerationId, daemonGeneration, token)) return;
    agentInspectorWorkResource.value = { status: "error", detail: previous, error: error instanceof Error ? error.message : "Could not load retained work.", sourceMessageId };
  }
}

async function revealAgentInspectorWorkMessage(canonicalMessageId: string): Promise<void> {
  const detail = agentInspectorWorkResource.value.detail;
  const target = selectedAgentDetailTarget.value;
  if (!canonicalMessageId.trim() || !detail || target?.kind !== "supervised" || detail.entry_id !== target.supervisorEntryId || detail.room_id !== props.room.identifier || detail.publication?.canonical_message_id !== canonicalMessageId) return;
  activeTab.value = "chat";
  await revealRoomMessage(canonicalMessageId);
  if (agentInspectorCompact.value) closeAgentDetail();
}

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
  if (agentInspectorActionState.value?.status === "running" && agentInspectorActionState.value.entryId === intent.entryId) return;
  if (intent.roomId !== props.room.identifier) return;
  const projection = agentInspectorProjections.value.find((candidate) => candidate.entryId === intent.entryId);
  if (!projection) return;
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
      updated = await desktopIpc.supervisor.setDesiredState(intent.entryId, "paused");
    } else if (intent.kind === "resume") {
      updated = await desktopIpc.supervisor.setDesiredState(intent.entryId, "running");
    } else if (intent.kind === "recover") {
      updated = await desktopIpc.supervisor.recoverAgentRuntime({ entryId: intent.entryId });
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
        await refreshManagedAgentSessions();
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
      await refreshManagedAgentSessions();
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

function agentInspectorActionErrorMessage(
  kind: AgentInspectorActionIntent["kind"],
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : "";
  if (kind === "reconnect" && /previous provider runtime is unavailable|no longer has a live runtime/i.test(detail)) {
    return "This provider process has stopped. Recover the agent to continue with the same identity and workspace.";
  }
  if (kind === "recover" && /cannot prove that the previous provider process stopped/i.test(detail)) {
    return "LetAgents could not safely prove the old provider stopped. No replacement was started.";
  }
  if (kind === "recover" && /desktop credentials are required/i.test(detail)) {
    return "LetAgents could not restore this agent’s room credentials. Try recovery again.";
  }
  return detail || "The agent action could not be completed.";
}

function actionProgressMessage(kind: AgentInspectorActionIntent["kind"]): string {
  return ({
    mention: "Opening the room composer…",
    pause: "Pausing this agent…",
    resume: "Resuming this agent…",
    reconnect: "Restoring the existing agent connection…",
    recover: "Starting a replacement provider for this agent…",
    stop_turn: "Stopping the current turn…",
    steer_turn: "Applying correction to this session…",
    retry_turn_control: "Retrying the exact previous turn control…",
    resolve_turn_control: "Recording the verified turn outcome…",
    retry_delivery: "Retrying this delivery…",
    restore_conversation: "Restoring this agent’s conversation…",
    skip_message: "Skipping this blocked message…",
    retire_agent: "Retiring this saved agent…",
    save_settings: "Saving configuration…",
    apply_settings: "Restarting with saved configuration…",
    move_room: "Moving room…",
    purge_agent: "Purging durable records…",
  } as const)[kind];
}

function actionSuccessMessage(kind: AgentInspectorActionIntent["kind"]): string {
  return ({
    mention: "Composer ready.",
    pause: "Agent paused.",
    resume: "Agent resumed.",
    reconnect: "Connection handoff requested.",
    recover: "Provider recovery started. The agent identity and workspace were preserved.",
    stop_turn: "Current turn stopped.",
    steer_turn: "Correction applied to the same agent session.",
    retry_turn_control: "Previous turn control completed.",
    resolve_turn_control: "Turn-control outcome recorded.",
    retry_delivery: "Delivery retry started.",
    restore_conversation: "Conversation restoration started.",
    skip_message: "Message skipped. Later room work can continue.",
    retire_agent: "Agent retired. Its worktree is retained.",
    save_settings: "Configuration saved.",
    apply_settings: "Saved configuration restart requested.",
    move_room: "Room move started.",
    purge_agent: "Durable records purged.",
  } as const)[kind];
}

function openReasoningFromAgentDetail(sessionId: string): void {
  closeAgentDetail();
  openReasoningInspector(sessionId);
}

function openAgentWorktree(rootPath: string): void {
  addAgentModalOpen.value = false;
  emit("choose-worktree", rootPath);
}

async function copyRoomLink(): Promise<void> {
  await copyRoomLinkToClipboard(roomUrl.value);
}

function exportChat(): void {
  exportRoomChat(props.room, visibleMessages.value);
}
</script>
