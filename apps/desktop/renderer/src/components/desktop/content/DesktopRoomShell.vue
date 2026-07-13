<template>
  <section
    class="desktop-room-shell"
    :data-liquid-glass="liquidGlassEnabled"
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
      :permission-approvals="pendingPermissionApprovals"
      :permission-error="composerPermissionError"
      :resolving-permission-ids="resolvingComposerPermissionIds"
      :reasoning-sessions="reasoningSessions"
      :tasks="tasks"
      :search-query="searchQuery"
      :active-search-message-id="activeSearchMessageId"
      :initial-draft="chatDraftText"
      :initial-scroll-top="initialChatScrollTop ?? null"
      @send-message="sendRoomMessage"
      @discard-attachment="discardAttachment"
      @load-older="loadOlderMessages"
      @open-reasoning="openReasoningInspector"
      @open-agent-reasoning-fallback="openAgentReasoningFallback"
      @open-agent-detail="openAgentDetail"
      @open-add-agent="openAddAgentModal"
      @open-permission-detail="openComposerPermissionDetail"
      @resolve-permission="resolveComposerPermission"
      @draft-change="chatDraftText = $event"
      @open-events="openEventsTab"
      @open-github-event="openGitHubEventFromChat"
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
        @refresh="loadInboxThreads"
        @load-older="loadOlderInboxThreads"
        @open-thread="openInboxThread"
        @clear-item="clearInboxItem"
        @restore-item="restoreInboxItem"
        @open-task="openInboxTask"
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
        @open-task="openBoardTaskFromEvents"
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
        :room-artifacts="roomArtifacts"
        :activity-history-request="activityHistoryRequest"
        :artifact-task-filter-id="artifactTimelineTaskFilterId"
        :tasks="tasks"
        :messages="visibleMessages"
        :workers="workers"
        @open-reasoning="openReasoningInspector"
        @open-add-agent="openAddAgentModal"
        @open-agent-detail="openAgentDetail"
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

    <DesktopAgentDetailModal
      :open="Boolean(selectedAgentDetailTarget)"
      :room-identifier="room.identifier"
      :target="selectedAgentDetailTarget"
      :reasoning-sessions="reasoningSessions"
      @close="selectedAgentDetailTarget = null"
      @open-add-agent="openAddAgentModalFromDetail"
      @open-reasoning="openReasoningFromAgentDetail"
    />

    <AddAgentModal
      :open="addAgentModalOpen"
      :room-identifier="room.identifier"
      :room-git-room="room.gitRoom"
      :room-display-name="room.displayName"
      :git-room-matches-active-repo="gitRoomMatchesActiveRepo"
      :repo-root-path="managedAgentRepoRootPath"
      :repo-status="managedAgentRepoStatus"
      :managed-sessions="managedAgentSessions"
      @close="addAgentModalOpen = false"
      @choose-repo="openAgentRepoPicker"
      @choose-worktree="openAgentWorktree"
      @managed-sessions-updated="replaceManagedAgentSessions"
      @managed-session-started="upsertManagedAgentSession"
    />
  </section>
</template>

<script setup lang="ts">
import { GitBranch } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import type {
  DesktopActivityEntry,
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
  mergeDesktopManagedAgentPresence,
  mergeReachableAgentPresenceParticipants,
  pendingManagedAgentPermissionApprovals,
  preferredManagedAgentRepoRootPath,
  type ManagedAgentPermissionApproval,
  managedAgentSessionListsEqual,
  withRoomManagedAgentSessions,
  withUpsertedManagedAgentSession,
} from "../../../domain/managed-agents";
import { buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
import type { SidebarMode } from "../types";
import AddAgentModal from "./AddAgentModal.vue";
import DesktopAgentDetailModal from "./DesktopAgentDetailModal.vue";
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
import type { AgentModalTarget, GitHubEventPresentation } from "./desktop-chat-message/types";
import {
  isLowSignalGitHubCheckMessage,
  parseGitHubEvent,
} from "./desktop-chat-message/github-event";
import {
  buildDesktopInboxItems,
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
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
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
}>();

const roomRef = toRef(props, "room");
const messagesRef = toRef(props, "messages");
const reasoningSessionsRef = toRef(props, "reasoningSessions");
const activeTab = ref<RoomTabId>(readRoomActiveTab(props.room.identifier));
const roomChatView = ref<InstanceType<typeof RoomChatView> | null>(null);
const actionPanelOpen = ref(false);
const addAgentModalOpen = ref(false);
const selectedAgentDetailTarget = ref<AgentModalTarget | null>(null);
const rulesOpen = ref(false);
const { copied: roomLinkCopied, copy: copyRoomLinkToClipboard } = useCopyIndicator(1400);
const inboxFilter = ref<DesktopInboxFilter>("actionable");
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
const composerPermissionError = ref<string | null>(null);
const resolvingComposerPermissionIds = ref<Record<string, DesktopManagedAgentPermissionDecisionBehavior>>({});
let githubEventsRefreshTimer: number | null = null;
const composerGitHubEventTimers = new Map<string, number>();
let inboxRefreshTimer: number | null = null;
let inboxUndoTimer: number | null = null;
let managedAgentSessionsRefreshTimer: number | null = null;
let unsubscribeManagedAgentSessionUpdate: (() => void) | null = null;
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
  preferredManagedAgentRepoRootPath(managedAgentRepoStatus.value, props.room.gitRoom)
);
const roomPresence = computed(() =>
  mergeDesktopManagedAgentPresence(props.presence, roomManagedAgentSessions.value, props.room.identifier)
);
const roomParticipants = computed(() =>
  mergeReachableAgentPresenceParticipants(
    mergeDesktopManagedAgentParticipants(props.participants, roomManagedAgentSessions.value, props.room.identifier),
    roomPresence.value,
    props.room.identifier,
  )
);
const localAgentWork = computed(() =>
  activeManagedAgentWorkIndicators(roomManagedAgentSessions.value, props.room.identifier)
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
  activeTab.value = readRoomActiveTab(props.room.identifier);
  eventsPage.value = props.githubEvents;
  refreshedEnvironmentRepoStatus.value = null;
  managedAgentSessions.value = [];
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
  unsubscribeManagedAgentSessionUpdate?.();
  unsubscribeManagedAgentSessionUpdate = null;
});

onMounted(() => {
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
});

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

function openInboxTask(taskId: string): void {
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

function openBoardTaskFromEvents(taskId: string): void {
  boardSelectedTaskId.value = taskId;
  activeTab.value = "board";
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

async function refreshManagedAgentSessions(): Promise<void> {
  if (!desktopIpc.workers?.listManagedAgentSessions || !props.room.identifier) return;
  const roomIdentifier = props.room.identifier;
  try {
    const sessions = await desktopIpc.workers.listManagedAgentSessions(roomIdentifier);
    if (props.room.identifier !== roomIdentifier) return;
    if (!managedAgentSessionListsEqual(managedAgentSessions.value, sessions)) {
      managedAgentSessions.value = sessions;
    }
  } catch {
    if (props.room.identifier === roomIdentifier) {
      const scoped = managedAgentSessions.value.filter((session) =>
        managedAgentSessionMatchesRoom(session, roomIdentifier)
      );
      // Identity-stable like the success path: repeated poll errors must not
      // re-render the shell every tick.
      if (scoped.length !== managedAgentSessions.value.length) {
        managedAgentSessions.value = scoped;
      }
    }
  }
}

function replaceManagedAgentSessions(sessions: DesktopManagedAgentSession[]): void {
  managedAgentSessions.value = withRoomManagedAgentSessions(
    managedAgentSessions.value,
    props.room.identifier,
    sessions,
  );
}

function upsertManagedAgentSession(session: DesktopManagedAgentSession): void {
  managedAgentSessions.value = withUpsertedManagedAgentSession(
    managedAgentSessions.value,
    session,
  );
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
  openAgentDetail(agentTargetForManagedSession(approval.session));
}

function agentTargetForManagedSession(session: DesktopManagedAgentSession): AgentModalTarget {
  const displayName = managedAgentSessionDisplayName(session);
  return {
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
  if (!props.room.identifier || !desktopIpc.workers?.listManagedAgentSessions) return;
  managedAgentSessionsRefreshTimer = window.setInterval(() => {
    void refreshManagedAgentSessions();
  }, 4_000);
}

function stopManagedAgentSessionsRefreshTimer(): void {
  if (managedAgentSessionsRefreshTimer !== null) {
    window.clearInterval(managedAgentSessionsRefreshTimer);
    managedAgentSessionsRefreshTimer = null;
  }
}

function openAgentDetail(target: AgentModalTarget): void {
  selectedAgentDetailTarget.value = target;
}

function openAddAgentModalFromDetail(): void {
  selectedAgentDetailTarget.value = null;
  addAgentModalOpen.value = true;
}

function openReasoningFromAgentDetail(sessionId: string): void {
  selectedAgentDetailTarget.value = null;
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
