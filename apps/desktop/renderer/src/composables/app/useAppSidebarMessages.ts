import { roomUnread } from "../roomUnread";
import { computed, onScopeDispose, ref, toRaw, watch } from "vue";
import { createRestoreGuard, createThrottledCheck, provenRoomRead, roomListReadState } from "../../domain/visible-room-read";
import type { DesktopRoomLatestMessage } from "../../../../electron/ipc-types";
import { reuseUnchanged } from "../../domain/reuse-unchanged";
import type { ProjectGroup, RoomEntry } from "../../components/desktop/types";
import {
  deriveSidebarLatestMessages,
  isRoomBeingRead,
  localAccountRoomKeys,
  markRoomRead,
  readStoredRoomMessageIds,
  roomReadKey,
  roomReadMarkerKey,
  seedRoomReadMarker,
} from "../../domain/desktop-room-read-state";
import { normalizeRoomIdentifier } from "../../domain/sidebar-rooms";
import { orderedSidebarChildRooms } from "../../domain/sidebar-room-order";
import { useAccountActivity } from "../useAccountActivity";
import { newerLatestMessage, sidebarActivityFor, streamedLatestMessage } from "../../domain/account-activity";
import { desktopIpc } from "../../ipc/index.js";
import type { AppContextOf } from "./context";

/** Sidebar latest messages, history modes, unread state, and read markers. */
export function useAppSidebarMessages(context: unknown) {
  const app = context as AppContextOf<
      "useAppAccountActivityFeed"
    | "useAppNavigation"
    | "useAppReadMarkers"
    | "useAppRoomData"
    | "useAppSetupOnboarding"
    | "useAppSidebarEntries"
    | "useAppState"
  >;
  const {
    accountRooms, authStatus, chatStorageSettings, readRoomMessageIds, selectedSnapshot,
    sessionGeneration, sidebarLatestMessages, sidebarMetadataRefresh, windowFocused, windowHidden,
  } = app;
  /**
   * Reads this device can prove, by room key (cloud rooms only): the newest
   * message seen on screen in a focused window, or "Mark as read". Only these
   * are reported to the server. The local read marker also moves on its own
   * (a first-seen room's baseline, the end of the open room); those moves stay
   * on this device.
   */
  const confirmedReads = ref<Record<string, string>>({});
  watch(() => authStatus.value?.authenticated ? authStatus.value.account?.id : null, () => { confirmedReads.value = {}; });
  function confirmRead(roomIdentifier: string | null | undefined, messageId: string | null | undefined): void {
    const key = roomReadKey(roomIdentifier);
    if (!key || !messageId || !/^msg_[1-9]\d*$/.test(messageId) || roomHistoryMode(roomIdentifier) !== "cloud") return;
    const previous = confirmedReads.value[key];
    if (previous && Number(previous.slice(4)) >= Number(messageId.slice(4))) return;
    confirmedReads.value = { ...confirmedReads.value, [key]: messageId };
  }
  /** The on-screen check runs at most this often while messages arrive, and once more after the last. */
  const VISIBLE_READ_EVERY_MS = 250;
  const scrollPositionFor = (room: string): unknown =>
    (app as { chatScrollPositionForRoom?: (room: string) => unknown }).chatScrollPositionForRoom?.(room) ?? null;
  const restoreGuard = createRestoreGuard(scrollPositionFor);
  const activeRoom = () => app.activeEntry.value.type === "room" ? app.activeEntry.value.roomIdentifier : null;
  function recordVisibleRead(): void {
    restoreGuard.note(activeRoom());
    const room = activeRoom();
    if (!room || !activeRoomIsBeingRead() || restoreGuard.blocks(room)) return;
    confirmRead(room, provenRoomRead(roomListReadState(), selectedSnapshot.value?.messages ?? []));
  }
  const visibleReadCheck = createThrottledCheck(recordVisibleRead, VISIBLE_READ_EVERY_MS);
  const scheduleVisibleRead = () => visibleReadCheck.schedule();
  if (typeof document !== "undefined") {
    // Scrolling the room's message list down shows newer messages.
    const onScroll = (event: Event) => {
      if ((event.target as HTMLElement | null)?.dataset?.testid === "room-chat-list") scheduleVisibleRead();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    onScopeDispose(() => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      visibleReadCheck.dispose();
    });
  }

  async function refreshSidebarRoomMetadata(): Promise<void> {
    if (app.showFirstRunGate.value || !authStatus.value?.authenticated || sidebarMetadataRefresh.inFlight) return;
    sidebarMetadataRefresh.inFlight = true;
    sidebarMetadataRefresh.lastAt = Date.now();
    try {
      await app.refreshAccountRooms().catch(() => undefined);
      await refreshSidebarLatestMessages();
    } finally {
      sidebarMetadataRefresh.inFlight = false;
    }
  }

  async function refreshSidebarLatestMessages(): Promise<void> {
    const generation = sessionGeneration.value;
    const storageSettings = JSON.stringify(chatStorageSettings.value);
    const roomIdentifiers = sidebarRoomIdentifiers();
    if (!roomIdentifiers.length) {
      sidebarLatestMessages.value = {};
      return;
    }

    // The `/account/rooms` payload (already refreshed before this call) carries
    // `latestMessageId` / `latestMessageAt` for every cloud room and focus room,
    // so we derive sidebar latest-message state from it instead of fanning out one
    // `/rooms/:id/messages` request per sidebar room. Local-storage entries are
    // delegated to the fallback lookup: they appear in the payload with null
    // latest fields because their latest message lives in the local DB (that
    // fallback is a local read, not HTTP). Rooms absent from the payload fall
    // back the same way.
    const { latestMessages, uncoveredRoomIdentifiers } = deriveSidebarLatestMessages({
      accountRooms: accountRooms.value,
      sidebarRoomIdentifiers: roomIdentifiers,
      localRoomIdentifiers: roomIdentifiers.filter(roomUsesLocalHistory),
    });
    const nextLatestMessages: Record<string, DesktopRoomLatestMessage> = { ...latestMessages };

    if (uncoveredRoomIdentifiers.length && desktopIpc.room.getLatestMessages) {
      const fallbackMessages = await desktopIpc.room
        .getLatestMessages(uncoveredRoomIdentifiers)
        .catch(() => []);
      for (const latestMessage of fallbackMessages) {
        const key = roomReadKey(latestMessage.roomIdentifier);
        if (!key) continue;
        nextLatestMessages[key] = latestMessage;
      }
    }

    if (generation !== sessionGeneration.value || !authStatus.value?.authenticated) return;
    if (storageSettings !== JSON.stringify(chatStorageSettings.value)) return;
    sidebarLatestMessages.value = reuseUnchanged(toRaw(sidebarLatestMessages.value), nextLatestMessages);
    seedReadMarkersForKnownRooms();
    markActiveRoomRead();
    void app.refreshUnreadCounts();
  }

  // One set per room-list change; each sidebar row then checks its room in constant time.
  const localRoomKeys = computed(() => localAccountRoomKeys(accountRooms.value));
  function roomUsesLocalHistory(identifier: string): boolean {
    const override = chatStorageSettings.value?.roomOverrides[identifier];
    return /^local[_-]|^git-room:local:/i.test(identifier)
      || localRoomKeys.value.has(roomReadKey(identifier) ?? "")
      || (override && override !== "inherit" ? override : chatStorageSettings.value?.mode) === "local";
  }

  function roomHistoryMode(identifier: string | null | undefined): "cloud" | "local" {
    if (!identifier) return "cloud";
    return sidebarLatestMessages.value[roomReadKey(identifier)!]?.storageMode
      || (roomUsesLocalHistory(identifier) ? "local" : "cloud");
  }

  function sidebarRoomIdentifiers(): string[] {
    const identifiers = new Set<string>();
    for (const project of app.projectEntries.value) {
      for (const entry of [project.parent, ...projectChildRooms(project)]) {
        const identifier = entry.roomIdentifier?.trim();
        if (identifier) identifiers.add(identifier);
      }
    }
    return [...identifiers];
  }

  function withRoomUnreadState(entry: RoomEntry): RoomEntry {
    const latestMessageId = latestMessageIdForEntry(entry);
    return {
      ...entry,
      activity: sidebarActivityFor(app.accountActivity.index.value, entry.roomIdentifier),
      latestMessageId,
      latestMessageAt: latestMessageAtForEntry(entry),
      unreadCount: app.unreadRoomCounts.value[roomReadKey(entry.roomIdentifier) || ""] || 0,
      hasUnread: Boolean(roomUnread.get(entry.roomIdentifier)) || (app.unreadRoomCounts.value[roomReadKey(entry.roomIdentifier) || ""] || 0) > 0,
    };
  }

  function latestMessageIdForEntry(entry: RoomEntry): string | null {
    return latestKnownMessageForEntry(entry)?.latestMessageId || (roomHistoryMode(entry.roomIdentifier) === "cloud" ? entry.latestMessageId : null);
  }

  function latestMessageAtForEntry(entry: RoomEntry): string | null {
    return latestKnownMessageForEntry(entry)?.latestMessageAt || (roomHistoryMode(entry.roomIdentifier) === "cloud" ? entry.latestMessageAt : null);
  }

  function latestKnownMessageForEntry(entry: RoomEntry): DesktopRoomLatestMessage | null {
    const message = selectedSnapshotMatchesEntry(entry)
      && (selectedSnapshot.value?.storage?.effectiveMode || "cloud") === roomHistoryMode(entry.roomIdentifier)
      ? selectedSnapshot.value?.messages.at(-1) : null;
    return newerLatestMessage(latestMessageForEntry(entry), message ? {
      roomIdentifier: entry.roomIdentifier || "",
      latestMessageId: message.id,
      latestMessageAt: message.timestamp,
    } : null);
  }

  function latestMessageForEntry(entry: RoomEntry): DesktopRoomLatestMessage | null {
    const key = roomReadKey(entry.roomIdentifier);
    const stored = key ? sidebarLatestMessages.value[key] : null;
    if (roomHistoryMode(entry.roomIdentifier) === "local") return stored?.storageMode === "local" ? stored : null;
    return newerLatestMessage(stored, streamedLatestMessage(app.accountActivity.index.value, entry.roomIdentifier));
  }

  function selectedSnapshotMatchesEntry(entry: RoomEntry): boolean {
    const entryIdentifier = normalizeRoomIdentifier(entry.roomIdentifier);
    const snapshotIdentifier = normalizeRoomIdentifier(
      selectedSnapshot.value?.room?.identifier || selectedSnapshot.value?.roomIdentifier
    );
    return Boolean(entryIdentifier && snapshotIdentifier && entryIdentifier === snapshotIdentifier);
  }

  function seedReadMarkersForKnownRooms(): void {
    let nextMarkers = readRoomMessageIds.value;
    let changed = false;
    for (const project of app.projectEntries.value) {
      for (const entry of [project.parent, ...projectChildRooms(project)]) {
        // Wait for the local lookup before baselining its independent msg_N namespace.
        if (roomHistoryMode(entry.roomIdentifier) === "local" && !latestKnownMessageForEntry(entry)) continue;
        const result = seedRoomReadMarker(nextMarkers, roomReadMarkerKey(entry.roomIdentifier, roomHistoryMode(entry.roomIdentifier)), latestMessageIdForEntry(entry));
        nextMarkers = result.readMarkers;
        changed = changed || result.changed;
      }
    }
    if (changed) {
      readRoomMessageIds.value = nextMarkers;
      app.rememberRoomMessageIds();
    }
  }

  function projectChildRooms(project: ProjectGroup): RoomEntry[] {
    return orderedSidebarChildRooms(project);
  }

  function activeRoomIsBeingRead(): boolean {
    return !app.selectedSnapshotLoading.value
      && (selectedSnapshot.value?.storage?.effectiveMode || "cloud") === roomHistoryMode(app.selectedRoomIdentifier.value)
      && isRoomBeingRead({
      hidden: windowHidden.value,
      focused: windowFocused.value,
      activeRoomIdentifier: app.activeEntry.value.type === "room" ? app.activeEntry.value.roomIdentifier : null,
      snapshotRoomIdentifier: selectedSnapshot.value?.room?.identifier || selectedSnapshot.value?.roomIdentifier,
    });
  }

  function markActiveRoomRead(): void {
    restoreGuard.note(activeRoom());
    if (app.activeEntry.value.type !== "room" || !activeRoomIsBeingRead()) return;
    markRoomEntryRead(app.activeEntry.value, false, selectedSnapshot.value?.messages.at(-1)?.id || null);
    scheduleVisibleRead();
  }

  function markRoomEntryRead(entry: RoomEntry, explicit = false, latestMessageId = latestMessageIdForEntry(entry)): void {
    if (explicit) {
      const bookmark = roomUnread.get(entry.roomIdentifier);
      if (bookmark) roomUnread.clear(entry.roomIdentifier, bookmark.revision);
      // "Mark as read" is the person's own word for the whole room.
      confirmRead(entry.roomIdentifier, latestMessageId);
    }
    const result = markRoomRead(readRoomMessageIds.value, roomReadMarkerKey(entry.roomIdentifier, roomHistoryMode(entry.roomIdentifier)), latestMessageId);
    if (!result.changed) return;
    readRoomMessageIds.value = result.readMarkers;
    app.rememberRoomMessageIds();
  }
  return {
    refreshSidebarRoomMetadata, refreshSidebarLatestMessages, roomUsesLocalHistory,
    roomHistoryMode, sidebarRoomIdentifiers, withRoomUnreadState, latestMessageIdForEntry,
    latestMessageAtForEntry, latestKnownMessageForEntry, latestMessageForEntry,
    selectedSnapshotMatchesEntry, seedReadMarkersForKnownRooms, projectChildRooms,
    activeRoomIsBeingRead, markActiveRoomRead, markRoomEntryRead, confirmedReads,
    /** Called synchronously on every switch of the open entry (useAppHistoryWatchers). */
    noteOpenRoom: (room: string | null) => restoreGuard.note(room),
  };
}

/** Server-pushed room activity, and the sidebar catch-up when its stream drops. */
export function useAppAccountActivityFeed(context: unknown) {
  const app = context as AppContextOf<"useAppSidebarMessages" | "useAppState">;
  const {
    accountRooms, authStatus, refreshSidebarRoomMetadata,
  } = app;
  // Who is working in each room, and each room's latest message, pushed by the server.
  const accountActivity = useAccountActivity({
    authenticated: computed(() => Boolean(authStatus.value?.authenticated)),
    roomIds: computed(() => accountRooms.value.flatMap((room) => [
      room.roomIdentifier,
      ...room.focusRooms.map((focusRoom) => focusRoom.roomIdentifier),
    ])),
  });
  Object.assign(app, { accountActivity });
  // While the stream was open the sidebar barely polled, so catch up the moment it drops.
  watch(() => accountActivity.connected.value, (connected, wasConnected) => {
    if (wasConnected && !connected) void refreshSidebarRoomMetadata();
  });
  return {
    accountActivity,
  };
}

/** Per-account read markers and their storage. */
export function useAppReadMarkers(context: unknown) {
  const app = context as AppContextOf<"useAppState">;
  const {
    authStatus, readRoomMessageIds, readRoomMessagesStorageKey, sidebarLatestMessages,
  } = app;
  let accountReadStorageKey: string | null = null;
  /**
   * The markers this device kept before it reported reads to the server,
   * written once per account on the first start of this version (empty on a
   * fresh install). They are never reported; they only lower a count.
   */
  const legacyReadMarkers = ref<Record<string, string>>({});
  watch(() => authStatus.value?.authenticated ? authStatus.value.account?.id : null, (accountId) => {
    accountReadStorageKey = accountId ? `${readRoomMessagesStorageKey}:${encodeURIComponent(accountId)}` : null;
    sidebarLatestMessages.value = {};
    legacyReadMarkers.value = {};
    if (!accountReadStorageKey || !accountId) {
      readRoomMessageIds.value = {};
      return;
    }
    // Adopt the previous installation-wide markers once, for the first signed-in account.
    const legacyOwnerKey = `${readRoomMessagesStorageKey}:owner`;
    try {
      const owner = window.localStorage.getItem(legacyOwnerKey);
      if (!owner) window.localStorage.setItem(legacyOwnerKey, accountId);
      if ((!owner || owner === accountId) && !window.localStorage.getItem(accountReadStorageKey)) {
        const legacy = window.localStorage.getItem(readRoomMessagesStorageKey);
        if (legacy) window.localStorage.setItem(accountReadStorageKey, legacy);
      }
    } catch { /* Storage failures must not prevent sign-in. */ }
    readRoomMessageIds.value = readStoredRoomMessageIds(window.localStorage, accountReadStorageKey);
    // Before this start seeds any new room: what is stored now was kept by older versions.
    const legacyKey = `${accountReadStorageKey}:before-server-reads`;
    try {
      const stored = window.localStorage.getItem(legacyKey);
      if (stored === null) window.localStorage.setItem(legacyKey, JSON.stringify(readRoomMessageIds.value));
      legacyReadMarkers.value = readStoredRoomMessageIds(window.localStorage, legacyKey);
    } catch { /* Without storage no count is lowered. */ }
  }, { immediate: true, flush: "sync" });

  function rememberRoomMessageIds(): void {
    try {
      if (accountReadStorageKey) window.localStorage.setItem(accountReadStorageKey, JSON.stringify(readRoomMessageIds.value));
    } catch {
      // Local persistence should never block message navigation.
    }
  }
  return {
    rememberRoomMessageIds, legacyReadMarkers,
  };
}

/** Reset sidebar history on storage changes, and track the room being read. */
export function useAppHistoryWatchers(context: unknown) {
  const app = context as AppContextOf<"useAppNavigation" | "useAppSidebarMessages" | "useAppState">;
  const {
    activeEntry, chatStorageSettings, refreshSidebarLatestMessages, selectedRoomIdentifier,
    sidebarLatestMessages,
  } = app;
  watch(() => JSON.stringify(chatStorageSettings.value), () => {
    sidebarLatestMessages.value = {};
    void refreshSidebarLatestMessages();
  });

  watch(() => activeEntry.value.type === "room" ? selectedRoomIdentifier.value : null,
    roomUnread.enter, { immediate: true, flush: "sync" });
  // The read check must know a room was opened before the list restores its
  // saved position (a return from the Inbox restores on the next tick).
  watch(() => activeEntry.value.type === "room" ? activeEntry.value.roomIdentifier : null,
    (room) => app.noteOpenRoom(room), { immediate: true, flush: "sync" });
}
