import { computed, toRef } from "vue";
import { isLocalGitRoom } from "../../domain/git-rooms";
import { buildLetAgentsFocusRoomUrl, buildLetAgentsRoomCopyValue } from "../../domain/room-urls";
import type { RoomTab } from "../../components/desktop/content/room-shell/types";
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
  const app = context as RoomShellContextOf<"pending">;
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
  Object.assign(app, { showEventsTab });
  return {
    selectedReasoningSessionId, selectedReasoningSessionForInspector, openReasoningInspector,
    openAgentReasoningFallback, closeReasoningInspector, renameBusy, renameError, githubStatus,
    githubLoading, githubBusy, githubError, renameRoom, refreshGitHubIntegration,
    installGitHubIntegration, eventsPage, eventsLoading, eventsLoadingOlder, eventsError,
    eventsTaskFilterId, eventsSelectedEventId, eventsLoadedOlderWithoutMatches,
    composerGitHubEventPreviews, eventsUnseenCount, eventsUnseenTone, githubRepository,
    showEventsTab, openEventsTab, refreshGitHubEvents, loadOlderGitHubEvents, openEventsForTask,
    openEventById, clearEventsTaskFilter, closeSelectedGitHubEvent, openGitHubEventFromChat,
    openGitHubUrlExternally, dismissComposerGitHubEventPreview,
  };
}

/** Room notifications and the tab list. */
export function useRoomShellNotifications(context: unknown) {
  const {
    activeTab, eventsUnseenCount, eventsUnseenTone, isLocalRoom, ownMessageIds, playRoomSound,
    props, showEventsTab, showRoomNotification, visibleMessages, watchRoomNotifications,
  } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellConversation"
    | "useRoomShellIntegrations"
    | "useRoomShellState"
  >;
  const app = context as RoomShellContextOf<"pending">;
  watchRoomNotifications({
    visibleMessages,
    ownMessageIds,
    playRoomSound,
    showRoomNotification: (message) => showRoomNotification(message, props.room.displayName, app.roomAttentionResponseNames.value),
  });

  const tabs = computed<RoomTab[]>(() => {
    const nextTabs: RoomTab[] = [
      { id: "chat", label: "Chat", count: null },
    ];
    if (showEventsTab.value) {
      nextTabs.push({
        id: "events",
        label: "Activity",
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
      { id: "memory", label: "Memory", count: null },
      { id: "board", label: "Board", count: null },
      { id: "activity", label: "Agents", count: null },
    );
    if (!isLocalRoom.value) {
      nextTabs.push({ id: "rooms", label: "Rooms", count: props.roomLoading ? null : props.focusRooms.length });
    }
    return nextTabs;
  });
  return {
    tabs,
  };
}
