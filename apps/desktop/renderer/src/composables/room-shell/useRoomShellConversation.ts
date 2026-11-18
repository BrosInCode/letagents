import { computed, ref, toRef, watch } from "vue";
import { isLocalGitRoom } from "../../domain/git-rooms";
import { buildLetAgentsFocusRoomUrl, buildLetAgentsRoomCopyValue } from "../../domain/room-urls";
import { roomPageIdOfTab, type RoomTab } from "../../components/desktop/content/room-shell/types";
import { availableRoomTab, keptRoomPages, withRoomPageTabs } from "../../components/desktop/content/room-pages/room-pages";
import { useRoomPages } from "../../components/desktop/content/room-pages/useRoomPages";
import { useDesktopReasoningInspector } from "../../components/desktop/content/room-shell/useDesktopReasoningInspector";
import { useDesktopRoomGitHub } from "../../components/desktop/content/room-shell/useDesktopRoomGitHub";
import { useDesktopRoomGitHubEvents } from "../../components/desktop/content/room-shell/useDesktopRoomGitHubEvents";
import { useDesktopRoomMessages } from "../../components/desktop/content/room-shell/useDesktopRoomMessages";
import {
  useDesktopRoomPreferences,
} from "../../components/desktop/content/room-shell/useDesktopRoomPreferences";
import { useDesktopRoomSearch } from "../../components/desktop/content/room-shell/useDesktopRoomSearch";
import type { RoomShellContextOf } from "./context";

/** Room identity, preferences, messages, and search. */
export function useRoomShellConversation(context: unknown) {
  const {
    emit, githubEventsVisible, messagesRef, props, roomRef,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<"useRoomShellParticipants">;
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
  Object.assign(app, { roomUrl });
  const localGitRoom = computed(() => isLocalGitRoom(props.room));
  const isLocalRoom = computed(() => props.storage.effectiveMode === "local");
  Object.assign(app, { isLocalRoom });
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
    notificationPermission,
    toggleSound,
    toggleNotifications,
    playRoomSound,
    showRoomNotification,
    watchRoomNotifications,
  } = useDesktopRoomPreferences(() => props.room.identifier);
  const {
    sendingMessage,
    sendError,
    hasOlderMessages,
    loadingOlderMessages,
    olderMessagesError,
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
    messageNamespace,
    messages: messagesRef,
    githubEventsVisible,
    playRoomSound,
    onMessageSent: (message) => emit("message-sent", message),
  });
  Object.assign(app, { visibleMessages, revealMessage });

  const {
    searchOpen,
    searchQuery,
    searchResults,
    activeSearchMessageId,
    searchSummary,
    toggleSearch: toggleSearchOpen,
    closeSearch,
    moveSearch,
  } = useDesktopRoomSearch(visibleMessages, () => app.roomAttentionResponseNames.value);
  Object.assign(app, { searchOpen, toggleSearchOpen, closeSearch });
  return {
    roomUrl, localGitRoom, isLocalRoom, messageNamespace, soundEnabled, notificationsEnabled,
    notificationPermission, toggleSound, toggleNotifications, playRoomSound, showRoomNotification,
    watchRoomNotifications, sendingMessage, sendError, hasOlderMessages, loadingOlderMessages,
    olderMessagesError, ownMessageIds, hasFilteredRoomActivity, visibleMessages, timelineMessages,
    roomMessagesForAgentInsight, sendRoomMessage, discardAttachment, loadOlderMessages,
    revealMessage, searchOpen, searchQuery, searchResults, activeSearchMessageId, searchSummary,
    toggleSearchOpen, closeSearch, moveSearch,
  };
}

/** The reasoning inspector, GitHub integration, and GitHub events. */
export function useRoomShellIntegrations(context: unknown) {
  const {
    activeTab, emit, localGitRoom, messagesRef, props, reasoningSessionsRef,
    roomMessagesForAgentInsight, roomRef,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellConversation" | "useRoomShellState">;
  const app = context as object;
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
  Object.assign(app, { openReasoningInspector });

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
    acknowledgeEvents,
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
  Object.assign(app, { showEventsTab });
  return {
    selectedReasoningSessionId, selectedReasoningSessionForInspector, openReasoningInspector,
    openAgentReasoningFallback, closeReasoningInspector, renameBusy, renameError, githubStatus,
    githubLoading, githubBusy, githubError, renameRoom, refreshGitHubIntegration,
    installGitHubIntegration, eventsPage, eventsLoading, eventsLoadingOlder, eventsError,
    eventsTaskFilterId, eventsSelectedEventId, eventsLoadedOlderWithoutMatches,
    composerGitHubEventPreviews, acknowledgeEvents, eventsUnseenCount, eventsUnseenTone, githubRepository,
    showEventsTab, openEventsTab, refreshGitHubEvents, loadOlderGitHubEvents, openEventsForTask,
    openEventById, clearEventsTaskFilter, closeSelectedGitHubEvent, openGitHubEventFromChat,
    openGitHubUrlExternally, dismissComposerGitHubEventPreview,
  };
}

/** Room notifications, the tab list, and the room's pinned pages. */
export function useRoomShellNotifications(context: unknown) {
  const {
    activeTab, eventsUnseenCount, eventsUnseenTone, isLocalRoom, ownMessageIds, playRoomSound,
    props, roomAttentionResponseNames, showEventsTab, showRoomNotification, visibleMessages,
    watchRoomNotifications,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellConversation"
    | "useRoomShellIntegrations"
    | "useRoomShellParticipants"
    | "useRoomShellState"
  >;
  watchRoomNotifications({
    visibleMessages,
    ownMessageIds,
    playRoomSound,
    showRoomNotification: (message) => showRoomNotification(message, props.room.displayName, roomAttentionResponseNames.value),
  });

  const baseTabs = computed<RoomTab[]>(() => {
    const nextTabs: RoomTab[] = [
      { id: "chat", label: "Chat", count: null },
    ];
    if (showEventsTab.value) {
      nextTabs.push({
        id: "events",
        label: "Activity",
        count: null,
        indicator: eventsUnseenCount.value > 0
          ? {
              label: eventsUnseenCount.value === 1 ? "New event" : "New events",
              count: eventsUnseenCount.value,
              tone: eventsUnseenTone.value,
              pulse: false,
              mode: "count",
            }
          : null,
      });
    }
    nextTabs.push(
      { id: "memory", label: "Memory", count: null },
      { id: "board", label: "Board", count: null },
      { id: "activity", label: "Agents", count: null },
    );
    if (!isLocalRoom.value) {
      nextTabs.push({ id: "rooms", label: "Rooms", count: props.roomLoading ? null : props.focusRooms.length });
    }
    return nextTabs;
  });

  // Pinned pages come after the room's own tabs; a room without pages keeps its tab list as it was.
  const { roomPages, roomPagesLoaded } = useRoomPages(() => props.room.identifier, () => !isLocalRoom.value);
  const pageTabs = computed(() => withRoomPageTabs(baseTabs.value, roomPages.value));
  const tabs = computed(() => pageTabs.value.tabs);
  const pagesMenu = computed(() => pageTabs.value.pagesMenu);
  watch([activeTab, roomPages, roomPagesLoaded], () => {
    const available = availableRoomTab(activeTab.value, roomPages.value, roomPagesLoaded.value);
    if (available !== activeTab.value) activeTab.value = available;
  });
  // A page opened once stays alive, hidden, until the room closes or unpins it.
  const openedPageIds = ref(new Set<string>());
  watch(() => props.room.identifier, () => { openedPageIds.value = new Set(); });
  function rememberOpenedPage(tab: string): void {
    const pageId = roomPageIdOfTab(tab);
    if (pageId !== null && !openedPageIds.value.has(pageId)) openedPageIds.value = new Set([...openedPageIds.value, pageId]);
  }
  watch(activeTab, rememberOpenedPage, { immediate: true });
  const keptPages = computed(() => keptRoomPages(roomPages.value, openedPageIds.value));
  return {
    tabs,
    pagesMenu,
    roomPages,
    keptPages,
  };
}
