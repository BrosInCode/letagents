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
      @cycle-sidebar="emit('cycle-sidebar')"
      @toggle-search="toggleSearchTool"
      @toggle-action-panel="toggleActionPanel"
      @select-tab="selectTab"
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
        @clear-task-filter="eventsTaskFilterId = null"
        @open-task="openBoardTask"
        @close-selected-event="eventsSelectedEventId = null"
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
        @open-focus-room="emit('open-focus-room', $event)"
        @refresh-room="emit('refresh-room')"
      />

      <RentAnAgentView
        v-else-if="activeTab === 'rent'"
        key="rent"
        :room-identifier="room.identifier"
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
      :room-identifier="room.identifier"
      :request-version="selectedAgentDetailRequestVersion"
      :managed-sessions="roomManagedAgentSessions"
      :reasoning-sessions="reasoningSessions"
      @close="closeAgentDetail"
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
      @settings-reload="() => loadAgentInspectorSettings(true)"
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
      @choose-repo="openAgentRepoPicker"
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
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopRoomMessage,
  DesktopRoomThreadInboxPage,
  DesktopReasoningSession,
  DesktopSnapshotSourceStates,
  DesktopSupervisorManifestEntry,
  DesktopSupervisorDaemonStatus,
  DesktopSupervisorRoomMove,
  DesktopSupervisorStateSnapshot,
  DesktopTaskSummary,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";
import { useDesktopActionToasts } from "../../../composables/useDesktopActionToasts";
import { mergeDesktopGitHubEventsPage } from "../../../domain/desktop-room-snapshots";
import {
  isLocalGitRoom,
  roomSupportsGitHubIntegration,
} from "../../../domain/git-rooms";
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
import { buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
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
  agentInspectorTurnControlFenceMatches,
  projectAgentInspectors,
  type AgentInspectorTurnControlFence,
  type AgentInspectorActionIntent,
  type AgentInspectorActionState,
} from "../../../domain/agent-inspector";
import {
  agentInspectorSettingsFenceCurrent,
  configurationDraft,
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
  supervisorStateSubscriptionNeedsRepair,
} from "../../../domain/supervisor-entries-resource";
import type { SidebarMode } from "../types";
import AddAgentModal from "./AddAgentModal.vue";
import { managedAgentSessionsKey } from "./add-agent/managed-agent-sessions-context";
import AgentInspectorHost from "./agent-inspector/AgentInspectorHost.vue";
import DesktopReasoningInspector from "./DesktopReasoningInspector.vue";
import DesktopFloatingWidget from "../controls/DesktopFloatingWidget.vue";
import DesktopRoomRulesModal from "./DesktopRoomRulesModal.vue";
import RentAnAgentView from "./RentAnAgentView.vue";
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
import { useDesktopReasoningInspector } from "./room-shell/useDesktopReasoningInspector";
import type { ComposerEventPreview } from "./room-chat/RoomComposerEventChips.vue";
import { buildComposerEventPreview } from "./room-chat/composer-event-preview";
import type {
  AgentInspectorSelection,
  AgentInspectorRequest,
  AgentModalTarget,
  GitHubEventPresentation,
} from "./desktop-chat-message/types";
import {
  isLowSignalGitHubCheckMessage,
  parseGitHubEvent,
} from "./desktop-chat-message/github-event";
import {
  buildDesktopInboxItems,
  deriveInboxDegradation,
  desktopInboxItemFingerprint,
  type DesktopInboxFilter,
  type DesktopInboxItem,
} from "./room-inbox/items";
import { useDesktopRoomGitHub } from "./room-shell/useDesktopRoomGitHub";
import { useDesktopRoomMessages } from "./room-shell/useDesktopRoomMessages";
import {
  useDesktopRoomPreferences,
  watchRoomNotifications,
} from "./room-shell/useDesktopRoomPreferences";
import { useDesktopRoomSearch } from "./room-shell/useDesktopRoomSearch";
import { isThreadReplyMessage } from "./room-shell/threading";
import { desktopIpc } from "../../../ipc/index.js";

type RoomTabIndicatorTone = NonNullable<NonNullable<RoomTab["indicator"]>["tone"]>;

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
  boardSettings: DesktopBoardSettingsSummary | null;
  messages: DesktopRoomMessage[];
  githubEvents: DesktopGitHubEventsPage | null;
  sourceStates?: DesktopSnapshotSourceStates | null;
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
  durableProjectRootPath?: string | null;
  homePath?: string | null;
  workers: WorkerSnapshot[];
  openAddAgentRequested?: boolean;
  initialChatScrollTop?: number | null;
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
  "chat-scroll-position": [roomIdentifier: string, scrollTop: number];
  "choose-repo": [];
  "choose-worktree": [rootPath: string];
  "open-repo-root": [rootPath: string];
  "add-agent-open-request-consumed": [];
  /** Placeholder until the daemon exposes a receipt retry control endpoint. */
  "retry-room-agent-delivery": [input: { agentId: string; sourceMessageId: string }];
  "message-reveal-unavailable": [messageId: string];
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
const agentInspectorWorkResource = ref<AgentInspectorWorkResource>(emptyAgentInspectorWorkResource());
const agentInspectorWorkSourceMessageId = ref<string | null>(null);
const agentInspectorConfigurationResource = ref<AgentInspectorConfigurationResource>({ status: "idle", configuration: null, draft: null, error: null });
const agentInspectorRoomMoveResource = ref<AgentInspectorRoomMoveResource>({ status: "idle", move: null, error: null });
const agentInspectorProviders = ref<DesktopAgentProvider[]>([]);
const agentInspectorSettingsConflict = ref(false);
let agentInspectorSettingsRequestToken = 0;
let agentInspectorSettingsDraftVersion = 0;
let agentInspectorMessageIdentityRequestToken = 0;
let agentInspectorRoomMoveRequestToken = 0;
let agentInspectorRoomMoveRecoveryTimer: number | null = null;
let agentInspectorWorkRequestToken = 0;
const rulesOpen = ref(false);
const { copied: roomLinkCopied, copy: copyRoomLinkToClipboard } = useCopyIndicator(1400);
const inboxFilter = ref<DesktopInboxFilter>("actionable");
const deliveryRetryCoordinator = createRoomDeliveryRetryCoordinator();
const deliveryRetryingKeys = deliveryRetryCoordinator.retryingKeys;
const continuationRepairCoordinator = createRoomDeliveryRetryCoordinator();
const continuationRepairingKeys = continuationRepairCoordinator.retryingKeys;
const roomDeliverySkipCoordinator = createRoomDeliveryRetryCoordinator();
const roomDeliverySkippingKeys = roomDeliverySkipCoordinator.retryingKeys;
const deliveryRetryNegotiated = ref(false);
const deliveryRetryAvailable = computed(() => deliveryRetryNegotiated.value && typeof desktopIpc.supervisor?.retryRoomDelivery === "function");
const threadInboxPage = ref<DesktopRoomThreadInboxPage | null>(null);
const inboxLoading = ref(false);
const inboxLoadingOlder = ref(false);
const inboxError = ref<string | null>(null);
const inboxLoadedKey = ref<string | null>(null);
const inboxDismissals = ref<Record<string, string>>({});
const lastClearedInboxItem = ref<DesktopInboxItem | null>(null);
const inboxSeenFingerprints = ref<string[]>([]);
const inboxUnseenCount = ref(0);
const inboxSeenInitialized = ref(false);
const eventsPage = ref<DesktopGitHubEventsPage | null>(props.githubEvents);
const eventsLoading = ref(false);
const eventsLoadingOlder = ref(false);
const eventsError = ref<string | null>(null);
const eventsTaskFilterId = ref<string | null>(null);
const eventsSelectedEventId = ref<string | null>(null);
const eventsLoadedOlderWithoutMatches = ref(false);
const boardSelectedTaskId = ref<string | null>(null);
const activityHistoryRequest = ref(0);
const artifactTimelineTaskFilterId = ref<string | null>(null);
const storageBusy = ref(false);
const githubEventsVisible = ref(readGitHubEventsVisible(props.room.identifier));
const environmentPanelOpen = ref(readEnvironmentPanelOpen(props.room.identifier));
const refreshedEnvironmentRepoStatus = ref<RepoStatus | null>(null);
const composerGitHubEventPreviews = ref<ComposerEventPreview[]>([]);
const eventsUnseenCount = ref(0);
const eventsUnseenTone = ref<RoomTabIndicatorTone>("info");
const managedAgentSessions = ref<DesktopManagedAgentSession[]>([]);
const supervisorEntries = ref<DesktopSupervisorManifestEntry[]>([]);
const supervisorEntriesState = ref<SupervisorEntriesResource["state"]>("loading");
const supervisorEntriesError = ref<string | null>(null);
const supervisorEntriesHaveLoaded = ref(false);
const supervisorEntriesUpdatedAt = ref<string | null>(null);
const supervisorStatus = ref<DesktopSupervisorDaemonStatus | null>(null);
let supervisorStatusRequestToken = 0;
let supervisorStatusRefreshInFlight: Promise<DesktopSupervisorDaemonStatus | null> | null = null;
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
    failureCode: string | null;
    attemptCount: number;
    providerTurnId: string | null;
  }>> = {};
  for (const entry of supervisorEntries.value) for (const receipt of entry.deliveryReceipts ?? []) {
    (grouped[receipt.sourceMessageId] ??= []).push({
      agentId: entry.id,
      agentName: supervisedAgentDisplayLabel(entry.displayName, entry.id),
      state: receipt.state,
      blockedByMessageId: receipt.blockedByMessageId,
      failureCode: receipt.failureCode,
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
let githubEventsRefreshTimer: number | null = null;
const composerGitHubEventTimers = new Map<string, number>();
let inboxRefreshTimer: number | null = null;
let inboxUndoTimer: number | null = null;
let managedAgentSessionsRefreshTimer: number | null = null;
let managedAgentSessionsRefreshRequestId = 0;
let managedAgentSessionsMutationVersion = 0;
let supervisorEntriesMutationVersion = 0;
let managedAgentSessionsRefreshInFlight: Promise<void> | null = null;
let managedAgentSessionsRefreshQueued = false;
let managedAgentSessionsRefreshOwnerActive = true;
let unsubscribeManagedAgentSessionUpdate: (() => void) | null = null;
let unsubscribeSupervisorActivity: (() => void) | null = null;
let unsubscribeSupervisorState: (() => void) | null = null;
let supervisorStateSubscriptionActive = false;
let supervisorStateLastSnapshotAtMs: number | null = null;
let supervisorStateDaemonGeneration = 0;
let supervisorStateSequence = 0;
let pendingSupervisorStateSnapshot: DesktopSupervisorStateSnapshot | null = null;
let supervisorStateFrame: number | null = null;
let environmentRepoStatusRefreshRequestId = 0;
let inboxReloadAfterCurrentLoad = false;
let inboxThreadBaselinePending = false;
const roomUrl = computed(() =>
  buildLetAgentsRoomCopyValue(props.room.identifier, {
    localOnly: props.storage.localRoom?.publishStatus === "local_only",
  })
);
const isGitHubIntegrationRoom = computed(() => roomSupportsGitHubIntegration(props.room));
const localGitRoom = computed(() => isLocalGitRoom(props.room));
const isLocalRoom = computed(() => props.storage.effectiveMode === "local");
const messageNamespace = computed(() =>
  [
    props.room.identifier,
    props.storage.effectiveMode,
    props.storage.localRoom?.roomIdentifier || "cloud",
  ].join(":")
);
inboxDismissals.value = readInboxDismissals(messageNamespace.value);

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

const githubRepository = computed(() =>
  githubStatus.value?.repository?.fullName
  || repoRepositoryFromRoomIdentifier(props.room.identifier)
  || eventsPage.value?.githubRoomIdentifier
  || null
);

const githubEventsAvailable = computed(() =>
  !localGitRoom.value && (
    isGitHubIntegrationRoom.value
    || Boolean(githubStatus.value?.connected)
    || Boolean(eventsPage.value?.events.length)
    || props.messages.some(shouldRefreshEventsForMessage)
  )
);

const showEventsTab = computed(() => githubEventsAvailable.value);
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
    homePath: props.homePath,
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
      ? roomMentionCandidates([participant], participant.displayName, 1)[0]
      : null;
    if (candidate?.kind === "agent" && candidate.insertText === `agent:${expectedAgentKey}`) {
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
const rawInboxItems = computed(() =>
  buildDesktopInboxItems({
    filter: inboxFilter.value,
    threadPage: threadInboxPage.value,
    tasks: props.tasks,
    githubEvents: eventsPage.value?.events || [],
    reasoningSessions: props.reasoningSessions,
    presence: roomPresence.value,
    fallbackRepository: githubRepository.value,
  })
);
const inboxItems = computed(() =>
  rawInboxItems.value.filter((item) => !isInboxItemDismissed(item))
);
const inboxActionableCount = computed(() =>
  inboxItems.value.filter((item) => item.actionable).length
);
const inboxActionableFingerprints = computed(() =>
  inboxItems.value
    .filter((item) => item.actionable)
    .map(desktopInboxItemFingerprint)
);
const inboxHasMore = computed(() => Boolean(threadInboxPage.value?.hasMore));
const inboxDegradation = computed(() =>
  deriveInboxDegradation(props.sourceStates ?? null)
);

watch(() => props.githubEvents, (nextPage) => {
  if (!nextPage) {
    if (!eventsPage.value || eventsPage.value.roomIdentifier !== props.room.identifier) {
      eventsPage.value = null;
    }
    return;
  }
  eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
}, { immediate: true });

watch(() => props.room.identifier, () => {
  selectedAgentDetailRequestVersion.value += 1;
  selectedAgentDetailRequest.value = null;
  agentInspectorActionState.value = null;
  agentInspectorWorkRequestToken += 1;
  agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
  agentInspectorWorkSourceMessageId.value = null;
  activeTab.value = readRoomActiveTab(props.room.identifier);
  eventsPage.value = props.githubEvents;
  refreshedEnvironmentRepoStatus.value = null;
  managedAgentSessions.value = [];
  supervisorEntries.value = [];
  supervisorEntriesState.value = "loading";
  supervisorEntriesError.value = null;
  supervisorEntriesHaveLoaded.value = false;
  supervisorEntriesUpdatedAt.value = null;
  composerPermissionError.value = null;
  resolvingComposerPermissionIds.value = {};
  eventsTaskFilterId.value = null;
  eventsSelectedEventId.value = null;
  boardSelectedTaskId.value = null;
  eventsError.value = null;
  eventsLoadedOlderWithoutMatches.value = false;
  githubEventsVisible.value = readGitHubEventsVisible(props.room.identifier);
  environmentPanelOpen.value = readEnvironmentPanelOpen(props.room.identifier);
  clearComposerGitHubEventPreviews();
  resetEventsIndicator();
  void refreshManagedAgentSessions();
  restartManagedAgentSessionsRefreshTimer();
}, { immediate: true });

watch(() => props.repoStatus, () => {
  refreshedEnvironmentRepoStatus.value = null;
});

watch(messageNamespace, () => {
  inboxDismissals.value = readInboxDismissals(messageNamespace.value);
  clearInboxUndoState();
  const hasSeenState = hydrateInboxIndicatorState(messageNamespace.value);
  resetInboxState();
  inboxThreadBaselinePending = !hasSeenState;
  if (inboxThreadBaselinePending) {
    acknowledgeInboxItems();
  }
  void loadInboxThreads({ baselineIndicator: inboxThreadBaselinePending }).catch(() => undefined);
}, { immediate: true });

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
  addAgentModalOpen.value = true;
  emit("add-agent-open-request-consumed");
}, { immediate: true });

watch(() => [showEventsTab.value, props.roomLoading] as const, ([visible, loading]) => {
  if (!visible && !loading && activeTab.value === "events") {
    activeTab.value = "chat";
  }
}, { immediate: true });

watch(isLocalRoom, (local) => {
  if (!local) return;
  if (["rooms", "rent"].includes(activeTab.value)) {
    activeTab.value = "chat";
  }
}, { immediate: true });

watch(activeTab, (tab) => {
  rememberRoomActiveTab(props.room.identifier, tab);
  if (tab === "events" && showEventsTab.value && !eventsPage.value && !eventsLoading.value) {
    void refreshGitHubEvents().catch(() => undefined);
  }
  if (tab === "events") {
    resetEventsIndicator();
  }
  if (tab === "inbox" && inboxLoadedKey.value !== currentInboxLoadKey() && !inboxLoading.value) {
    void loadInboxThreads().catch(() => undefined);
  }
  if (tab === "inbox") {
    acknowledgeInboxItems();
  }
}, { flush: "sync" });

watch(inboxFilter, () => {
  resetInboxState();
  void loadInboxThreads({ baselineIndicator: !inboxSeenInitialized.value }).catch(() => undefined);
});

watch(inboxActionableFingerprints, (fingerprints) => {
  if (activeTab.value === "inbox") {
    acknowledgeInboxItems(fingerprints);
    return;
  }
  if (!inboxSeenInitialized.value) {
    inboxUnseenCount.value = 0;
    return;
  }

  const seen = new Set(inboxSeenFingerprints.value);
  inboxUnseenCount.value = fingerprints.filter((fingerprint) => !seen.has(fingerprint)).length;
}, { immediate: true });

watch(() => props.messages.at(-1)?.id || null, () => {
  const latestMessage = props.messages.at(-1);
  if (!latestMessage) return;
  if (isThreadReplyMessage(latestMessage)) {
    scheduleInboxRefresh(activeTab.value === "inbox" ? 200 : 700);
  }
  if (!showEventsTab.value || !shouldRefreshEventsForMessage(latestMessage)) return;
  if (!shouldPreviewComposerEvent(latestMessage)) {
    scheduleGitHubEventsRefresh(activeTab.value === "events" ? 250 : 900);
    return;
  }
  ingestComposerGitHubEvent(latestMessage);
  scheduleGitHubEventsRefresh(activeTab.value === "events" ? 250 : 900);
});

onBeforeUnmount(() => {
  managedAgentSessionsRefreshOwnerActive = false;
  managedAgentSessionsRefreshQueued = false;
  managedAgentSessionsRefreshRequestId += 1;
  if (githubEventsRefreshTimer !== null) {
    window.clearTimeout(githubEventsRefreshTimer);
    githubEventsRefreshTimer = null;
  }
  clearComposerGitHubEventPreviews();
  if (inboxRefreshTimer !== null) {
    window.clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = null;
  }
  if (inboxUndoTimer !== null) {
    window.clearTimeout(inboxUndoTimer);
    inboxUndoTimer = null;
  }
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
  unsubscribeSupervisorState?.();
  unsubscribeSupervisorState = null;
  supervisorStateSubscriptionActive = false;
  supervisorStateLastSnapshotAtMs = null;
  pendingSupervisorStateSnapshot = null;
  if (supervisorStateFrame !== null) {
    window.cancelAnimationFrame(supervisorStateFrame);
    supervisorStateFrame = null;
  }
});

onMounted(() => {
  void refreshSupervisorStatus();
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
  supervisorStateSubscriptionActive = Boolean(unsubscribeSupervisorState);
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
    nextTabs.push(
      { id: "rooms", label: "Rooms", count: props.roomLoading ? null : props.focusRooms.length },
      { id: "rent", label: "Rent an Agent", count: null },
    );
  }
  return nextTabs;
});

function selectTab(tabId: RoomTabId): void {
  if (activeTab.value === tabId) return;
  if (tabId === "events" && !showEventsTab.value) return;
  if (isLocalRoom.value && ["rooms", "rent"].includes(tabId)) return;
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
    || value === "rent"
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

function currentInboxLoadKey(): string {
  return `${messageNamespace.value}:${inboxFilter.value}`;
}

function resetInboxIndicatorState(): void {
  inboxSeenFingerprints.value = [];
  inboxUnseenCount.value = 0;
  inboxSeenInitialized.value = false;
}

function acknowledgeInboxItems(fingerprints = inboxActionableFingerprints.value): void {
  inboxSeenFingerprints.value = [...new Set(fingerprints)];
  inboxUnseenCount.value = 0;
  inboxSeenInitialized.value = true;
  writeInboxSeenFingerprints(messageNamespace.value, inboxSeenFingerprints.value);
}

function inboxSeenStorageKey(namespace: string): string {
  return `letagents-desktop:room-inbox-seen:${namespace}`;
}

function hydrateInboxIndicatorState(namespace: string): boolean {
  const fingerprints = readInboxSeenFingerprints(namespace);
  if (fingerprints === null) {
    resetInboxIndicatorState();
    return false;
  }
  inboxSeenFingerprints.value = fingerprints;
  inboxUnseenCount.value = 0;
  inboxSeenInitialized.value = true;
  return true;
}

function readInboxSeenFingerprints(namespace: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(inboxSeenStorageKey(namespace));
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    return [...new Set(parsed)];
  } catch {
    return null;
  }
}

function writeInboxSeenFingerprints(namespace: string, fingerprints: string[]): void {
  try {
    window.localStorage.setItem(inboxSeenStorageKey(namespace), JSON.stringify(fingerprints));
  } catch {
    // The indicator can fall back to the in-memory baseline when storage is unavailable.
  }
}

function inboxDismissalsStorageKey(namespace: string): string {
  return `letagents-desktop:room-inbox-dismissals:${namespace}`;
}

function readInboxDismissals(namespace: string): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(inboxDismissalsStorageKey(namespace)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function writeInboxDismissals(namespace: string, dismissals: Record<string, string>): void {
  try {
    window.localStorage.setItem(inboxDismissalsStorageKey(namespace), JSON.stringify(dismissals));
  } catch {
    // Clearing the current view should still work even when storage is unavailable.
  }
}

function resetInboxState(): void {
  threadInboxPage.value = null;
  inboxLoading.value = false;
  inboxLoadingOlder.value = false;
  inboxError.value = null;
  inboxLoadedKey.value = null;
  inboxReloadAfterCurrentLoad = false;
  if (inboxRefreshTimer !== null) {
    window.clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = null;
  }
}

async function loadInboxThreads(options: { append?: boolean; baselineIndicator?: boolean } = {}): Promise<void> {
  const roomApi = desktopIpc.room;
  const requestKey = currentInboxLoadKey();
  const append = Boolean(options.append);
  const shouldBaselineIndicator = !append && (options.baselineIndicator || inboxThreadBaselinePending);
  if (!roomApi?.getThreads) {
    threadInboxPage.value = { threads: [], hasMore: false, unreadThreadCount: 0 };
    inboxLoadedKey.value = requestKey;
    if (shouldBaselineIndicator) {
      acknowledgeInboxItems();
      inboxThreadBaselinePending = false;
    }
    return;
  }
  if (append) {
    if (inboxLoadingOlder.value || !threadInboxPage.value?.hasMore) return;
  } else if (inboxLoading.value) {
    inboxReloadAfterCurrentLoad = true;
    return;
  }

  const before = append
    ? threadInboxPage.value?.threads.at(-1)?.summary.latestReply?.id || null
    : null;
  if (append && !before) return;
  if (append) {
    inboxLoadingOlder.value = true;
  } else {
    inboxLoading.value = true;
  }
  inboxError.value = null;

  try {
    const page = await roomApi.getThreads(
      props.room.identifier,
      inboxFilter.value === "actionable" ? "unread" : "all",
      before,
      75,
    );
    if (currentInboxLoadKey() !== requestKey) return;
    threadInboxPage.value = append && threadInboxPage.value
      ? mergeThreadInboxPages(threadInboxPage.value, page)
      : page;
    inboxLoadedKey.value = requestKey;
    if (shouldBaselineIndicator) {
      acknowledgeInboxItems();
      inboxThreadBaselinePending = false;
    }
  } catch (error) {
    if (currentInboxLoadKey() === requestKey) {
      inboxError.value = error instanceof Error ? error.message : "Inbox could not be loaded.";
    }
  } finally {
    const shouldReload = !append && inboxReloadAfterCurrentLoad && currentInboxLoadKey() === requestKey;
    if (currentInboxLoadKey() === requestKey) {
      inboxLoading.value = false;
      inboxLoadingOlder.value = false;
    }
    if (shouldReload) {
      inboxReloadAfterCurrentLoad = false;
      void loadInboxThreads().catch(() => undefined);
    }
  }
}

function loadOlderInboxThreads(): void {
  void loadInboxThreads({ append: true });
}

function handleInboxRefresh(): void {
  // Always reload the thread inbox. If snapshot-backed inbox sources (tasks,
  // GitHub events, agent sessions, presence) are degraded, also ask the app to
  // re-fetch the room snapshot so a retry can recover them, not just the threads.
  void loadInboxThreads().catch(() => undefined);
  if (inboxDegradation.value.degraded) {
    emit("refresh-room");
  }
}

function mergeThreadInboxPages(
  current: DesktopRoomThreadInboxPage,
  next: DesktopRoomThreadInboxPage,
): DesktopRoomThreadInboxPage {
  const threadsByRoot = new Map(current.threads.map((item) => [item.root.id, item]));
  for (const item of next.threads) {
    threadsByRoot.set(item.root.id, item);
  }
  return {
    threads: [...threadsByRoot.values()],
    hasMore: next.hasMore,
    unreadThreadCount: next.unreadThreadCount,
  };
}

async function openInboxThread(item: Extract<DesktopInboxItem, { kind: "thread" }>): Promise<void> {
  activeTab.value = "chat";
  await nextTick();
  roomChatView.value?.openThread(item.root.id);
}

function clearInboxItem(item: DesktopInboxItem): void {
  dismissInboxItem(item);
  showInboxUndo(item);
}

function dismissInboxItem(item: DesktopInboxItem): void {
  const nextDismissals = {
    ...inboxDismissals.value,
    [item.id]: desktopInboxItemFingerprint(item),
  };
  inboxDismissals.value = nextDismissals;
  writeInboxDismissals(messageNamespace.value, nextDismissals);
}

function restoreInboxItem(item: DesktopInboxItem): void {
  const nextDismissals = { ...inboxDismissals.value };
  delete nextDismissals[item.id];
  inboxDismissals.value = nextDismissals;
  writeInboxDismissals(messageNamespace.value, nextDismissals);
  clearInboxUndoState();
}

function showInboxUndo(item: DesktopInboxItem): void {
  lastClearedInboxItem.value = item;
  if (inboxUndoTimer !== null) {
    window.clearTimeout(inboxUndoTimer);
  }
  inboxUndoTimer = window.setTimeout(() => {
    clearInboxUndoState();
  }, 8_000);
}

function clearInboxUndoState(): void {
  lastClearedInboxItem.value = null;
  if (inboxUndoTimer !== null) {
    window.clearTimeout(inboxUndoTimer);
    inboxUndoTimer = null;
  }
}

function isInboxItemDismissed(item: DesktopInboxItem): boolean {
  return inboxDismissals.value[item.id] === desktopInboxItemFingerprint(item);
}

function handleThreadRead(threadRootId: string, summary: DesktopRoomThreadInboxPage["threads"][number]["summary"]): void {
  const page = threadInboxPage.value;
  if (!page) return;
  const previous = page.threads.find((item) => item.root.id === threadRootId);
  if (!previous) return;
  const previousUnread = previous.summary.unreadCount > 0 ? 1 : 0;
  const nextUnread = summary.unreadCount > 0 ? 1 : 0;
  threadInboxPage.value = {
    ...page,
    unreadThreadCount: Math.max(0, page.unreadThreadCount - previousUnread + nextUnread),
    threads: page.threads.map((item) =>
      item.root.id === threadRootId
        ? { ...item, root: { ...item.root, thread: summary }, summary }
        : item
    ),
  };
}

function openBoardTask(taskId: string): void {
  boardSelectedTaskId.value = taskId;
  activeTab.value = "board";
}

function openInboxGitHubEvent(eventId: string): void {
  eventsTaskFilterId.value = null;
  eventsSelectedEventId.value = eventId;
  activeTab.value = "events";
}

function openEventsTab(): void {
  if (!showEventsTab.value) return;
  eventsTaskFilterId.value = null;
  eventsSelectedEventId.value = null;
  activeTab.value = "events";
}

function scheduleInboxRefresh(delayMs: number): void {
  if (inboxRefreshTimer !== null) {
    window.clearTimeout(inboxRefreshTimer);
  }
  inboxRefreshTimer = window.setTimeout(() => {
    inboxRefreshTimer = null;
    void loadInboxThreads().catch(() => undefined);
  }, delayMs);
}

async function refreshGitHubEvents(): Promise<void> {
  if (!showEventsTab.value || !desktopIpc.room?.getGitHubEvents) return;
  eventsLoading.value = true;
  eventsError.value = null;
  try {
    const nextPage = await desktopIpc.room.getGitHubEvents(props.room.identifier, { limit: 100 });
    eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
  } catch (error) {
    eventsError.value = error instanceof Error ? error.message : "GitHub events could not be loaded.";
  } finally {
    eventsLoading.value = false;
  }
}

async function loadOlderGitHubEvents(): Promise<void> {
  if (!showEventsTab.value || !desktopIpc.room?.getGitHubEvents || eventsLoadingOlder.value) return;
  const after = eventsPage.value?.events.at(-1)?.id || null;
  if (!after) return;
  eventsLoadingOlder.value = true;
  eventsError.value = null;
  eventsLoadedOlderWithoutMatches.value = false;
  const beforeCount = eventsPage.value?.events.length || 0;
  try {
    const nextPage = await desktopIpc.room.getGitHubEvents(props.room.identifier, {
      limit: 100,
      after,
    });
    eventsPage.value = mergeDesktopGitHubEventsPage(eventsPage.value, nextPage);
    eventsLoadedOlderWithoutMatches.value = Boolean(nextPage.events.length && (eventsPage.value?.events.length || 0) === beforeCount);
  } catch (error) {
    eventsError.value = error instanceof Error ? error.message : "Older GitHub events could not be loaded.";
  } finally {
    eventsLoadingOlder.value = false;
  }
}

function openEventsForTask(taskId: string): void {
  if (!showEventsTab.value) return;
  eventsTaskFilterId.value = taskId;
  eventsSelectedEventId.value = null;
  activeTab.value = "events";
}

function openArtifactsForTask(taskId: string): void {
  boardSelectedTaskId.value = taskId;
  artifactTimelineTaskFilterId.value = taskId;
  activityHistoryRequest.value += 1;
  activeTab.value = "activity";
}

async function openGitHubEventFromChat(url: string): Promise<void> {
  if (!showEventsTab.value) return;
  eventsTaskFilterId.value = null;
  activeTab.value = "events";
  const firstMatch = findEventByUrl(url);
  if (firstMatch) {
    eventsSelectedEventId.value = firstMatch.id;
    return;
  }
  await refreshGitHubEvents();
  eventsSelectedEventId.value = findEventByUrl(url)?.id || null;
}

async function openGitHubUrlExternally(url: string): Promise<void> {
  if (desktopIpc.app?.openGitHubUrl) {
    await desktopIpc.app.openGitHubUrl(url);
    return;
  }
  await desktopIpc.auth?.openVerification?.(url);
}

function scheduleGitHubEventsRefresh(delayMs: number): void {
  if (!showEventsTab.value) return;
  if (githubEventsRefreshTimer !== null) {
    window.clearTimeout(githubEventsRefreshTimer);
  }
  githubEventsRefreshTimer = window.setTimeout(() => {
    githubEventsRefreshTimer = null;
    void refreshGitHubEvents().catch(() => undefined);
  }, delayMs);
}

function ingestComposerGitHubEvent(message: DesktopRoomMessage): void {
  if (activeTab.value === "events" || isLowSignalGitHubCheckMessage(message)) return;
  const event = parseGitHubEvent(message);
  if (!event) return;
  eventsUnseenCount.value = Math.min(99, eventsUnseenCount.value + 1);
  eventsUnseenTone.value = eventTabIndicatorTone(event.tone);
  addComposerGitHubEventPreview(message.id, event);
}

function addComposerGitHubEventPreview(messageId: string, event: GitHubEventPresentation): void {
  const preview = buildComposerEventPreview(messageId, event, props.room, eventsPage.value?.events || []);
  const existingTimer = composerGitHubEventTimers.get(messageId);
  if (existingTimer !== undefined) window.clearTimeout(existingTimer);
  composerGitHubEventPreviews.value = [
    ...composerGitHubEventPreviews.value.filter((item) => item.id !== messageId),
    preview,
  ].slice(-1);
  for (const staleId of [...composerGitHubEventTimers.keys()]) {
    if (composerGitHubEventPreviews.value.some((item) => item.id === staleId)) continue;
    const timer = composerGitHubEventTimers.get(staleId);
    if (timer !== undefined) window.clearTimeout(timer);
    composerGitHubEventTimers.delete(staleId);
  }
  composerGitHubEventTimers.set(messageId, window.setTimeout(() => {
    composerGitHubEventTimers.delete(messageId);
    composerGitHubEventPreviews.value = composerGitHubEventPreviews.value.filter((item) => item.id !== messageId);
  }, 8000));
}

function clearComposerGitHubEventPreviews(): void {
  for (const timer of composerGitHubEventTimers.values()) {
    window.clearTimeout(timer);
  }
  composerGitHubEventTimers.clear();
  composerGitHubEventPreviews.value = [];
}

function dismissComposerGitHubEventPreview(messageId: string): void {
  const timer = composerGitHubEventTimers.get(messageId);
  if (timer !== undefined) window.clearTimeout(timer);
  composerGitHubEventTimers.delete(messageId);
  composerGitHubEventPreviews.value = composerGitHubEventPreviews.value.filter((item) => item.id !== messageId);
}

function resetEventsIndicator(): void {
  eventsUnseenCount.value = 0;
  eventsUnseenTone.value = "info";
}

function eventTabIndicatorTone(tone: GitHubEventPresentation["tone"]): RoomTabIndicatorTone {
  if (tone === "emerald") return "success";
  if (tone === "rose") return "danger";
  if (tone === "amber") return "warning";
  return "info";
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

function shouldRefreshEventsForMessage(message: DesktopRoomMessage): boolean {
  const source = (message.source || "").toLowerCase();
  const sender = (message.sender || "").toLowerCase();
  return source === "github" || sender === "github";
}

function shouldPreviewComposerEvent(message: DesktopRoomMessage): boolean {
  const timestamp = Date.parse(message.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp < 30_000;
}

function repoRepositoryFromRoomIdentifier(identifier: string): string | null {
  const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(identifier.trim());
  return match ? match[1] : null;
}

function findEventByUrl(url: string): NonNullable<DesktopGitHubEventsPage["events"][number]> | null {
  const exactUrl = normalizeExactGitHubUrl(url);
  if (!exactUrl) return null;
  const events = eventsPage.value?.events || [];
  const exactMatch = events.find((event) =>
    normalizeExactGitHubUrl(event.githubObjectUrl) === exactUrl
  );
  if (exactMatch) return exactMatch;

  const normalizedUrl = normalizeGitHubObjectUrl(url);
  if (!normalizedUrl) return null;
  return events.find((event) =>
    normalizeGitHubObjectUrl(event.githubObjectUrl) === normalizedUrl
  ) || null;
}

function normalizeExactGitHubUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "").toLowerCase();
}

function normalizeGitHubObjectUrl(url: string | null | undefined): string | null {
  const trimmed = normalizeExactGitHubUrl(url);
  if (!trimmed) return null;
  return trimmed.replace(/[#?].*$/, "");
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

function refreshSupervisorStatus(): Promise<DesktopSupervisorDaemonStatus | null> {
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
    managedAgentSessionsRefreshInFlight = null;
    if (managedAgentSessionsRefreshOwnerActive && managedAgentSessionsRefreshQueued) {
      managedAgentSessionsRefreshQueued = false;
      void refreshManagedAgentSessions();
    }
  });
  return managedAgentSessionsRefreshInFlight;
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
    refreshSupervisorStatus(),
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

function restartManagedAgentSessionsRefreshTimer(): void {
  stopManagedAgentSessionsRefreshTimer();
  if (!props.room.identifier || (!desktopIpc.workers?.listManagedAgentSessions && !desktopIpc.supervisor?.listAgents)) return;
  managedAgentSessionsRefreshTimer = window.setInterval(() => {
    // Skip the tick while the window is hidden — a background room has no reason
    // to poll supervisor/session state. `handleManagedAgentSessionsVisibilityChange`
    // kicks one immediate refresh on foreground return.
    if (shouldSkipPollTick({ hidden: document.hidden })) return;
    void refreshManagedAgentSessions();
  }, 2_000);
}

function handleManagedAgentSessionsVisibilityChange(): void {
  if (document.hidden) return;
  void refreshManagedAgentSessions();
}

function stopManagedAgentSessionsRefreshTimer(): void {
  if (managedAgentSessionsRefreshTimer !== null) {
    window.clearInterval(managedAgentSessionsRefreshTimer);
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
  resetAgentInspectorSettings();
}

function closeAgentDetail(): void {
  agentInspectorMessageIdentityRequestToken += 1;
  selectedAgentDetailRequestVersion.value += 1;
  selectedAgentDetailRequest.value = null;
  agentInspectorActionState.value = null;
  agentInspectorWorkRequestToken += 1;
  agentInspectorWorkResource.value = emptyAgentInspectorWorkResource();
  agentInspectorWorkSourceMessageId.value = null;
  resetAgentInspectorSettings();
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

function agentInspectorWorkRequestStillCurrent(entryId: string, roomId: string, sourceMessageId: string | null, token: number): boolean {
  const target = selectedAgentDetailTarget.value;
  return token === agentInspectorWorkRequestToken
    && props.room.identifier === roomId
    && target?.kind === "supervised"
    && target.supervisorEntryId === entryId
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

async function loadAgentInspectorWorkDetail(sourceMessageId: string | null = agentInspectorWorkSourceMessageId.value, force = false): Promise<void> {
  const target = selectedAgentDetailTarget.value;
  const projection = selectedAgentDetailProjection.value;
  if (target?.kind !== "supervised" || !projection || projection.roomId !== props.room.identifier) return;
  if (!desktopIpc.supervisor?.getAgentInspectorDetail || !supervisorStatus.value?.capabilities.agentInspectorDetail) {
    agentInspectorWorkResource.value = { status: "unavailable", detail: null, error: null, sourceMessageId };
    return;
  }
  if (!force && agentInspectorWorkResource.value.status === "ready" && agentInspectorWorkSourceMessageId.value === sourceMessageId) return;
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
    if (!agentInspectorWorkRequestStillCurrent(target.supervisorEntryId, projection.roomId, sourceMessageId, token)
      || !isCurrentAgentInspectorWorkResponse(detail, target.supervisorEntryId, projection.roomId, sourceMessageId)) return;
    const defaultSource = defaultAgentInspectorWorkSource(projection.entry, detail);
    agentInspectorWorkResource.value = { status: "ready", detail, error: null, sourceMessageId };
    if (sourceMessageId === null && defaultSource && defaultSource !== agentInspectorWorkSourceMessageId.value) {
      agentInspectorWorkSourceMessageId.value = defaultSource;
      void loadAgentInspectorWorkDetail(defaultSource);
    }
  } catch (error) {
    if (!agentInspectorWorkRequestStillCurrent(target.supervisorEntryId, projection.roomId, sourceMessageId, token)) return;
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
  const turnControlIntent = intent.kind === "stop_turn" || intent.kind === "steer_turn" || intent.kind === "resolve_turn_control";
  const actionAvailable = projection.actions.some((action) => action.kind === intent.kind && action.available);
  const turnControlAvailable = intent.kind === "stop_turn"
    ? projection.turnControl?.canStop === true
    : intent.kind === "steer_turn"
      ? projection.turnControl?.canCorrect === true && Boolean(intent.correction?.trim())
      : intent.kind === "resolve_turn_control"
        ? projection.turnControl?.canResolve === true && Boolean(intent.turnControlResolution)
        : false;
  if (!actionAvailable && (!turnControlIntent || !turnControlAvailable)) return;

  if (intent.kind === "mention") {
    const participant = roomParticipants.value.find((candidate) =>
      candidate.kind === "agent"
      && candidate.participantKey === `desktop-supervisor-agent:${projection.entryId}`
      && Boolean(projection.agentKey)
      && candidate.agentKey === projection.agentKey);
    const mention = participant
      ? roomMentionCandidates([participant], participant.displayName, 1).find((candidate) => candidate.kind === "agent")
      : null;
    if (!mention || mention.insertText !== projection.mentionInsertText || mention.insertText !== `agent:${projection.agentKey}`) {
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
    } else if (intent.kind === "resume" || intent.kind === "recover") {
      updated = await desktopIpc.supervisor.setDesiredState(intent.entryId, "running");
    } else if (intent.kind === "retire_agent") {
      const status = await refreshSupervisorStatus();
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (!status?.capabilities.agentLifecycle || !desktopIpc.supervisor.retireAgent) throw new Error("This supervisor does not support durable retirement.");
      operationDaemonGeneration = status.generation;
      await desktopIpc.supervisor.retireAgent({ entryId: intent.entryId, daemonGeneration: operationDaemonGeneration });
    } else if (intent.kind === "reconnect") {
      updated = await desktopIpc.supervisor.reconnectAgent({ entryId: intent.entryId });
    } else if (intent.kind === "stop_turn" || intent.kind === "steer_turn" || intent.kind === "resolve_turn_control") {
      const entry = projection.entry;
      const control = projection.turnControl;
      const status = await refreshSupervisorStatus();
      if (!currentAgentInspectorActionIdentity(operationId, intent, requestVersion)) return;
      if (!status || !entry.workAttemptId || !entry.executionGenerationId || !control) {
        throw new Error("The active turn changed. Refresh and try again.");
      }
      operationDaemonGeneration = status.generation;
      const exactTurnControlFence: AgentInspectorTurnControlFence = {
        entryId: entry.id,
        roomId: entry.roomId,
        workAttemptId: entry.workAttemptId,
        executionGenerationId: entry.executionGenerationId,
        providerTurnId: control.providerTurnId,
        inboxItemId: entry.roomAgentState?.turn.inboxItemId ?? null,
        sourceMessageId: entry.roomAgentState?.turn.sourceMessageId ?? null,
        daemonGeneration: status.generation,
      };
      turnControlFence = exactTurnControlFence;
      const currentEntry = agentInspectorProjections.value.find((candidate) => candidate.entryId === entry.id)?.entry ?? null;
      if (!agentInspectorTurnControlFenceMatches(exactTurnControlFence, currentEntry, supervisorStatus.value?.generation ?? null)) {
        throw new Error("The active turn changed. Refresh and try again.");
      }
      if (intent.kind === "resolve_turn_control") {
        if (!control.actionId || !intent.turnControlResolution) throw new Error("The uncertain turn-control record changed. Refresh and try again.");
        updated = await desktopIpc.supervisor.resolveTurnControl({
          entryId: entry.id,
          workAttemptId: entry.workAttemptId,
          executionGenerationId: entry.executionGenerationId,
          actionId: control.actionId,
          resolution: intent.turnControlResolution,
        });
      } else {
        const correction = intent.kind === "steer_turn" ? intent.correction?.trim() || null : null;
        if (intent.kind === "steer_turn" && !correction) throw new Error("Write a correction before applying it.");
        const actionId = await agentInspectorTurnControlActionIdIfCurrent(
          agentInspectorTurnControlActionId({
            entryId: entry.id,
            roomId: entry.roomId,
            workAttemptId: entry.workAttemptId,
            executionGenerationId: entry.executionGenerationId,
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
          workAttemptId: entry.workAttemptId,
          executionGenerationId: entry.executionGenerationId,
          actionId,
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
        : error instanceof Error ? error.message : "The agent action could not be completed.",
    };
  }
}

function actionProgressMessage(kind: AgentInspectorActionIntent["kind"]): string {
  return ({
    mention: "Opening the room composer…",
    pause: "Pausing this agent…",
    resume: "Resuming this agent…",
    reconnect: "Restoring the existing agent connection…",
    recover: "Recovering this saved agent…",
    stop_turn: "Stopping the current turn…",
    steer_turn: "Applying correction to this session…",
    resolve_turn_control: "Recording the verified turn outcome…",
    retry_delivery: "Retrying this delivery…",
    restore_conversation: "Restoring this agent’s conversation…",
    skip_message: "Skipping this blocked message…",
    retire_agent: "Retiring this saved agent…",
    save_settings: "Saving configuration…",
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
    recover: "Recovery started.",
    stop_turn: "Current turn stopped.",
    steer_turn: "Correction applied to the same agent session.",
    resolve_turn_control: "Turn-control outcome recorded.",
    retry_delivery: "Delivery retry started.",
    restore_conversation: "Conversation restoration started.",
    skip_message: "Message skipped. Later room work can continue.",
    retire_agent: "Agent retired. Its worktree is retained.",
    save_settings: "Configuration saved.",
    move_room: "Room move started.",
    purge_agent: "Durable records purged.",
  } as const)[kind];
}

function openReasoningFromAgentDetail(sessionId: string): void {
  closeAgentDetail();
  openReasoningInspector(sessionId);
}

function openAgentRepoPicker(): void {
  addAgentModalOpen.value = false;
  emit("choose-repo");
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
