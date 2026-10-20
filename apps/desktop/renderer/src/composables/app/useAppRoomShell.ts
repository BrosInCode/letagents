import type { ChatScrollPosition } from "../../domain/chat-scroll";
import { watch } from "vue";
import type { DesktopRoomSnapshot } from "../../../../electron/ipc-types";
import { chatScrollPositionKey, shouldRememberChatScrollPosition } from "../../domain/chat-scroll";
import { normalizeRoomIdentifier } from "../../domain/sidebar-rooms";
import { replaceSidebarProjectId, rememberSidebarRoomOrder } from "../../domain/sidebar-room-order";
import type { AppContextOf } from "./context";

/** Room shell events: sent messages, refreshes, message reveal, and chat scroll positions. */
export function useAppRoomShellActions(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppProjectRepo"
    | "useAppRoomContext"
    | "useAppRoomData"
    | "useAppSettingsActions"
    | "useAppSidebarEntries"
    | "useAppSidebarMessages"
    | "useAppState"
  >;
  const {
    chatScrollPositionsByRoom, loadingChatScrollRoomIdentifiers, selectedRootRoomIdentifier,
    selectedSnapshot, sessionGeneration, sidebarLatestMessages, sidebarRoomOrder,
    sidebarRoomOrderStorageKey,
  } = app;
  function handleOwnMessageSent(message: Parameters<typeof app.handleMessageSent>[0]): void {
    app.handleMessageSent(message);
    app.markActiveRoomRead();
  }

  async function handleRoomShellRefresh(snapshot?: DesktopRoomSnapshot): Promise<void> {
    const generation = sessionGeneration.value;
    const selectedIdentifier = selectedSnapshot.value?.roomIdentifier;
    const rootIdentifier = selectedRootRoomIdentifier.value;
    const entryId = app.activeEntry.value.id;
    const localIdentifier = normalizeRoomIdentifier(snapshot?.storage?.localRoom?.roomIdentifier);
    const previousProject = localIdentifier && app.sidebarProjectEntries.value.find((project) =>
      [project.parent, ...project.branchRooms, ...project.focusRooms]
        .some((entry) => normalizeRoomIdentifier(entry.roomIdentifier) === localIdentifier));
    const identityChanged = snapshot?.roomIdentifier
      && snapshot.roomIdentifier !== selectedSnapshot.value?.roomIdentifier;
    const storageChanged = snapshot?.storage
      && snapshot.storage.effectiveMode !== app.roomHistoryMode(snapshot.roomIdentifier);
    if (storageChanged) {
      await app.loadChatStorageSettings();
      if (generation !== sessionGeneration.value
        || selectedIdentifier !== selectedSnapshot.value?.roomIdentifier
        || rootIdentifier !== selectedRootRoomIdentifier.value
        || entryId !== app.activeEntry.value.id) return;
      sidebarLatestMessages.value = {};
    }
    app.handleRefreshRoom(snapshot);
    if (!snapshot?.roomIdentifier) return;
    if (identityChanged && previousProject) {
      const nextProject = app.sidebarProjectEntries.value.find((project) =>
        [project.parent, ...project.branchRooms, ...project.focusRooms]
          .some((entry) => normalizeRoomIdentifier(entry.roomIdentifier) === normalizeRoomIdentifier(snapshot.roomIdentifier)));
      if (nextProject && previousProject.id !== nextProject.id) {
        sidebarRoomOrder.value = replaceSidebarProjectId(sidebarRoomOrder.value, previousProject.id, nextProject.id);
        rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, sidebarRoomOrder.value);
      }
    }
    void app.syncSelectedRoomStream(snapshot.roomIdentifier);
    if (identityChanged) {
      await app.refreshProjectBindings();
      await app.refreshSidebarRoomMetadata();
    }
    if (storageChanged) await app.refreshSidebarLatestMessages();
  }

  function handleRoomMessageRevealUnavailable(_messageId: string, reason?: "not_found" | "too_far_back" | "unavailable"): void {
    if (reason === "not_found") {
      app.pushActionToast("That message is not available.", "info");
    } else if (reason === "too_far_back") {
      app.pushActionToast("That message is too far back to open here yet.", "info");
    } else {
      app.pushActionToast("That earlier message is not available in the loaded room history.", "info");
    }
  }

  function rememberChatScrollPosition(roomIdentifier: string, position: ChatScrollPosition): void {
    const storageKey = chatScrollPositionKey(roomIdentifier) || roomIdentifier;
    if (!shouldRememberChatScrollPosition({
      roomIdentifier,
      selectedRoomIdentifier: app.selectedRoomInfo.value.identifier,
      selectedSnapshotLoading: app.selectedSnapshotLoading.value,
      suppressedRoomIdentifiers: loadingChatScrollRoomIdentifiers.value,
    })) {
      return;
    }
    chatScrollPositionsByRoom.value = {
      ...chatScrollPositionsByRoom.value,
      [storageKey]: position,
    };
  }

  function chatScrollPositionForRoom(roomIdentifier: string): ChatScrollPosition | null {
    const storageKey = chatScrollPositionKey(roomIdentifier);
    if (storageKey && chatScrollPositionsByRoom.value[storageKey] !== undefined) {
      return chatScrollPositionsByRoom.value[storageKey];
    }
    return chatScrollPositionsByRoom.value[roomIdentifier] ?? null;
  }

  function rememberLoadingChatScrollRoom(roomIdentifier: string | null | undefined): void {
    const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
    if (!normalizedRoomIdentifier || loadingChatScrollRoomIdentifiers.value.has(normalizedRoomIdentifier)) return;
    loadingChatScrollRoomIdentifiers.value = new Set([
      ...loadingChatScrollRoomIdentifiers.value,
      normalizedRoomIdentifier,
    ]);
  }

  function forgetLoadingChatScrollRooms(roomIdentifiers: Array<string | null | undefined>): void {
    const normalizedRoomIdentifiers = roomIdentifiers
      .map(normalizeRoomIdentifier)
      .filter((roomIdentifier): roomIdentifier is string => Boolean(roomIdentifier));
    if (!normalizedRoomIdentifiers.length) return;
    const nextRoomIdentifiers = new Set(loadingChatScrollRoomIdentifiers.value);
    for (const roomIdentifier of normalizedRoomIdentifiers) {
      nextRoomIdentifiers.delete(roomIdentifier);
    }
    if (nextRoomIdentifiers.size === loadingChatScrollRoomIdentifiers.value.size) return;
    loadingChatScrollRoomIdentifiers.value = nextRoomIdentifiers;
  }

  function activeChatScrollRoomIdentifier(): string | null {
    if (app.activeEntry.value.type === "room") {
      return app.activeEntry.value.roomIdentifier || app.selectedRoomInfo.value.identifier || null;
    }
    return app.selectedRoomInfo.value.identifier || null;
  }
  return {
    handleOwnMessageSent, handleRoomShellRefresh, handleRoomMessageRevealUnavailable,
    rememberChatScrollPosition, chatScrollPositionForRoom, rememberLoadingChatScrollRoom,
    forgetLoadingChatScrollRooms, activeChatScrollRoomIdentifier,
  };
}

/** Suppress chat scroll memory while a room snapshot loads. */
export function useAppChatScrollWatchers(context: unknown) {
  const app = context as AppContextOf<"useAppRoomData" | "useAppRoomShellActions" | "useAppState">;
  const {
    activeChatScrollRoomIdentifier, forgetLoadingChatScrollRooms, rememberLoadingChatScrollRoom,
    selectedSnapshot, selectedSnapshotLoading,
  } = app;
  watch(
    [() => selectedSnapshotLoading.value, () => activeChatScrollRoomIdentifier()] as const,
    ([loading, roomIdentifier]) => {
      if (loading) rememberLoadingChatScrollRoom(roomIdentifier);
    },
    { flush: "sync" }
  );

  watch(
    [
      () => selectedSnapshotLoading.value,
      () => selectedSnapshot.value?.roomIdentifier || null,
      () => selectedSnapshot.value?.room?.identifier || null,
    ] as const,
    ([loading, roomIdentifier, roomInfoIdentifier]) => {
      if (loading) return;
      forgetLoadingChatScrollRooms([roomIdentifier, roomInfoIdentifier]);
    },
    { flush: "sync" }
  );
}
