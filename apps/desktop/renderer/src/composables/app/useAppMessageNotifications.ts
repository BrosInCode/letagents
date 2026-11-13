import { onScopeDispose, ref, watch } from "vue";
import type {
  DesktopAccountActivityState,
  DesktopNotificationStatus,
  DesktopNotificationTarget,
  DesktopRoomMessage,
} from "../../../../electron/ipc-types";
import type { RoomMentionEvent } from "../../../../../../shared/room-mention-events.mjs";
import { mentionsPerson } from "../../../../../../shared/room-notification-preferences.mjs";
import {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
} from "../../components/desktop/content/desktop-chat-message/github-event";
import {
  isHiddenChatMessage,
  messageNumber,
} from "../../components/desktop/content/room-shell/messages";
import {
  notificationsPreferenceRevision,
  readGitHubEventsVisible,
  readNotificationsEnabled,
  readSoundEnabled,
} from "../../components/desktop/content/room-shell/preferences";
import { playRoomInteractionSound } from "../../components/desktop/content/room-shell/roomSounds";
import { roomReadKey } from "../../domain/desktop-room-read-state";
import { desktopMessageOutbox } from "../../domain/message-outbox";
import {
  activateFallbackRoomNotification,
  buildFallbackNotificationTarget,
  formatRoomNotificationCopy,
  isSuppressedViewerPublisherMessage,
  roomMessageAlertGate,
  roomNotificationTag,
} from "../../domain/room-message-alert-gate";
import { sharedRoomMessagePages } from "../../domain/shared-room-message-pages";
import { normalizeRoomIdentifier } from "../../domain/sidebar-rooms";
import { desktopIpc } from "../../ipc/index.js";
import {
  roomNotificationPreferences,
  roomNotificationsMuted,
} from "../useRoomNotificationPreferences";
import type { AppContextOf } from "./context";

const MAX_BATCH_ALERT_MESSAGES = 5;

export function useAppMessageNotifications(context: unknown) {
  const app = context as AppContextOf<
      "useAppAccountActivityFeed"
    | "useAppNavigation"
    | "useAppSessionActions"
    | "useAppSidebarMessages"
    | "useAppState"
  > & {
    openRoomFromAppAgent?: (roomIdentifier: string) => Promise<void>;
  };
  const {
    accountActivity,
    accountRooms,
    activeEntry,
    authStatus,
    selectedRoomInfo,
  } = app;

  const nativeNotificationsActive = ref(false);
  const notificationsEnabled = ref(readNotificationsEnabled());
  let ipcStatusLoaded = false;
  let sessionVersion = 0;
  const observedLatestByRoom = new Map<string, string | null>();
  const roomQueues = new Map<string, Promise<void>>();

  function currentAccount() {
    return authStatus.value?.authenticated ? authStatus.value.account ?? null : null;
  }

  function isSameAccount(accountId: string): boolean {
    return currentAccount()?.id === accountId;
  }

  watch(
    () => currentAccount()?.id ?? null,
    () => {
      sessionVersion += 1;
      observedLatestByRoom.clear();
      roomQueues.clear();
      roomMessageAlertGate.reset();
    },
    { immediate: true, flush: "sync" },
  );

  watch(notificationsPreferenceRevision, () => {
    if (!ipcStatusLoaded) {
      notificationsEnabled.value = readNotificationsEnabled();
    }
  }, { flush: "sync" });

  function applyNotificationStatus(status: DesktopNotificationStatus): void {
    ipcStatusLoaded = true;
    notificationsEnabled.value = status.enabled;
    nativeNotificationsActive.value = status.nativeRegistered;
  }

  const statusReady =
    desktopIpc.notifications?.getStatus?.().then(applyNotificationStatus).catch(() => undefined)
    ?? Promise.resolve();
  const unsubscribeStatus =
    desktopIpc.notifications?.onStatusChanged?.(applyNotificationStatus) || null;

  function isRoomInFront(roomIdentifier: string): boolean {
    if (
      typeof document !== "undefined"
      && (document.visibilityState !== "visible" || !document.hasFocus())
    ) {
      return false;
    }
    if (activeEntry.value.type !== "room") return false;
    return (
      normalizeRoomIdentifier(selectedRoomInfo.value?.identifier)
      === normalizeRoomIdentifier(roomIdentifier)
    );
  }

  function resolveRoomDisplayName(roomIdentifier: string, fallback?: string | null): string {
    const fallbackTrimmed = fallback?.trim();
    if (fallbackTrimmed) return fallbackTrimmed;
    const target = normalizeRoomIdentifier(roomIdentifier);
    if (target) {
      for (const entry of accountRooms.value ?? []) {
        if (normalizeRoomIdentifier(entry.roomIdentifier) === target) {
          return entry.displayName || entry.name || roomIdentifier;
        }
        for (const focus of entry.focusRooms ?? []) {
          if (normalizeRoomIdentifier(focus.roomIdentifier) === target) {
            return focus.displayName || focus.name || roomIdentifier;
          }
        }
      }
      if (normalizeRoomIdentifier(selectedRoomInfo.value?.identifier) === target) {
        return selectedRoomInfo.value.displayName || selectedRoomInfo.value.name || roomIdentifier;
      }
    }
    return roomIdentifier;
  }

  function isRoomListedInSidebar(roomIdentifier: string): boolean {
    const target = normalizeRoomIdentifier(roomIdentifier);
    if (!target) return false;
    for (const entry of accountRooms.value ?? []) {
      if (normalizeRoomIdentifier(entry.roomIdentifier) === target) return true;
      if (entry.focusRooms?.some((focus) => normalizeRoomIdentifier(focus.roomIdentifier) === target)) {
        return true;
      }
    }
    return false;
  }

  function isOwnMessage(roomIdentifier: string, message: DesktopRoomMessage): boolean {
    if (isSuppressedViewerPublisherMessage(message, currentAccount()?.login)) return true;
    const targetKey = roomReadKey(roomIdentifier);
    if (
      targetKey
      && desktopMessageOutbox.value.some(
        (entry) =>
          roomReadKey(entry.roomIdentifier) === targetKey
          && (
            entry.message.id === message.id
            || (Boolean(message.clientMessageId) && entry.message.clientMessageId === message.clientMessageId)
          ),
      )
    ) {
      return true;
    }
    return false;
  }

  function shouldIgnoreMessage(roomIdentifier: string, message: DesktopRoomMessage): boolean {
    if (isHiddenChatMessage(message)) return true;
    if (isGitHubRoomMessage(message)) {
      if (!readGitHubEventsVisible(roomIdentifier) || isLowSignalGitHubCheckMessage(message)) {
        return true;
      }
    }
    return false;
  }

  function fallbackActivate(target: DesktopNotificationTarget): void {
    if (typeof app.handleNotificationActivation === "function") {
      void app.handleNotificationActivation(target);
      return;
    }
    if (target.roomIdentifier && typeof app.openRoomFromAppAgent === "function") {
      void app.openRoomFromAppAgent(target.roomIdentifier);
    }
  }

  async function deliverCandidateAlert(
    roomIdentifier: string,
    message: DesktopRoomMessage,
    options: { targetedMention: boolean; fallbackRoomDisplayName?: string | null },
  ): Promise<void> {
    const account = currentAccount();
    if (!account?.id || !roomNotificationPreferences.signedIn()) return;
    const version = sessionVersion;
    if (isOwnMessage(roomIdentifier, message) || shouldIgnoreMessage(roomIdentifier, message)) return;
    if (options.targetedMention && account.login && !mentionsPerson(message.text, account.login)) return;
    if (roomMessageAlertGate.has(account.id, roomIdentifier, message.id)) return;

    await statusReady;
    if (version !== sessionVersion || !isSameAccount(account.id)) return;

    await roomNotificationPreferences.allowsAfterRead(roomIdentifier, message.text);
    if (version !== sessionVersion || !isSameAccount(account.id)) return;

    if (!roomNotificationPreferences.state(roomIdentifier).ready) {
      await roomNotificationPreferences.refresh(roomIdentifier);
      if (version !== sessionVersion || !isSameAccount(account.id)) return;
      await roomNotificationPreferences.allowsAfterRead(roomIdentifier, message.text);
      if (version !== sessionVersion || !isSameAccount(account.id)) return;
    }

    // Re-check live mutable preferences and account scope after every await.
    if (!roomNotificationPreferences.signedIn()) return;
    if (options.targetedMention) {
      if (roomNotificationsMuted(roomIdentifier)) return;
      const viewerLogin = roomNotificationPreferences.viewerLogin() || currentAccount()?.login || null;
      if (!viewerLogin || !mentionsPerson(message.text, viewerLogin)) return;
    } else if (!roomNotificationPreferences.allows(roomIdentifier, message.text)) {
      return;
    }

    if (isOwnMessage(roomIdentifier, message) || shouldIgnoreMessage(roomIdentifier, message)) return;
    if (!roomMessageAlertGate.claim(account.id, roomIdentifier, message.id)) return;

    const nativeBackgroundAlert =
      nativeNotificationsActive.value
      && typeof document !== "undefined"
      && (document.visibilityState !== "visible" || !document.hasFocus());
    if (readSoundEnabled() && !nativeBackgroundAlert) {
      try {
        playRoomInteractionSound("notification");
      } catch {
        // Audio can fail before user interaction.
      }
    }

    if (nativeNotificationsActive.value) return;
    if (!ipcStatusLoaded) notificationsEnabled.value = readNotificationsEnabled();
    if (!notificationsEnabled.value || typeof Notification === "undefined" || Notification.permission !== "granted") {
      return;
    }
    if (isRoomInFront(roomIdentifier)) return;

    const roomLabel = resolveRoomDisplayName(roomIdentifier, options.fallbackRoomDisplayName);
    const copy = formatRoomNotificationCopy(message, roomLabel);
    const target = buildFallbackNotificationTarget(roomIdentifier, message);
    const notification = new Notification(copy.title, {
      body: copy.body,
      silent: true,
      tag: roomNotificationTag(roomIdentifier, message.id),
    });
    notification.onclick = () => {
      activateFallbackRoomNotification(target, fallbackActivate);
    };
  }

  function enqueueRoomWork(roomIdentifier: string, task: () => Promise<void>): Promise<void> {
    const key = roomReadKey(roomIdentifier) || roomIdentifier.trim().toLowerCase();
    const version = sessionVersion;
    const next = (roomQueues.get(key) ?? Promise.resolve())
      .then(async () => {
        if (version !== sessionVersion) return;
        await task();
      })
      .catch((error) => {
        console.warn("[desktop-notifications] room message notification check failed", error);
      });
    roomQueues.set(key, next);
    void next.finally(() => {
      if (roomQueues.get(key) === next) roomQueues.delete(key);
    });
    return next;
  }

  async function fetchNewMessages(
    roomIdentifier: string,
    previousMessageId: string | null,
    latestMessageId: string,
    version: number,
  ): Promise<DesktopRoomMessage[]> {
    const roomApi = desktopIpc.room;
    if (!roomApi) return [];
    if (roomApi.getMessagesAfter) {
      try {
        const accountId = currentAccount()?.id;
        // The unread counter asks for this same page at the same moment: one read serves both.
        const page = accountId
          ? await sharedRoomMessagePages.load({
            accountId, reader: "notifications", roomIdentifier, afterMessageId: previousMessageId, latestMessageId,
            loadPage: (room, after) => roomApi.getMessagesAfter!(room, after),
          })
          : await roomApi.getMessagesAfter(roomIdentifier, previousMessageId);
        if (version !== sessionVersion) return [];
        if (Array.isArray(page?.messages) && page.messages.length > 0) {
          const targetNum = messageNumber(latestMessageId);
          const bounded = page.messages.filter((msg) => !targetNum || messageNumber(msg.id) <= targetNum);
          if (bounded.length > 0) return bounded.slice(-MAX_BATCH_ALERT_MESSAGES);
        }
      } catch {
        if (version !== sessionVersion) return [];
      }
    }
    if (roomApi.getMessage) {
      const single = await roomApi.getMessage(roomIdentifier, latestMessageId).catch(() => null);
      if (version !== sessionVersion) return [];
      return single ? [single] : [];
    }
    return [];
  }

  function seedKnownAccountRooms(): void {
    for (const entry of accountRooms.value ?? []) {
      const key = roomReadKey(entry.roomIdentifier);
      if (key && !observedLatestByRoom.has(key)) {
        observedLatestByRoom.set(key, entry.latestMessageId ?? null);
      }
      for (const focus of entry.focusRooms ?? []) {
        const focusKey = roomReadKey(focus.roomIdentifier);
        if (focusKey && !observedLatestByRoom.has(focusKey)) {
          observedLatestByRoom.set(focusKey, focus.latestMessageId ?? null);
        }
      }
    }
  }

  watch(
    () => accountRooms.value,
    () => {
      if (currentAccount()) seedKnownAccountRooms();
    },
    { immediate: true },
  );

  function evaluateActivitySnapshot(state: DesktopAccountActivityState): void {
    const account = currentAccount();
    if (!state.connected || !account?.id) return;
    const version = sessionVersion;
    for (const room of Object.values(state.rooms)) {
      const roomId = room.roomId;
      if (!roomId || app.roomHistoryMode?.(roomId) === "local") continue;
      const key = roomReadKey(roomId);
      if (!key) continue;
      if (!observedLatestByRoom.has(key)) {
        observedLatestByRoom.set(key, room.latestMessageId ?? null);
        continue;
      }
      const previousId = observedLatestByRoom.get(key) ?? null;
      const nextId = room.latestMessageId ?? null;
      if (!nextId || nextId === previousId) continue;
      const prevNumber = previousId ? messageNumber(previousId) : 0;
      const nextNumber = messageNumber(nextId);
      if (nextNumber <= prevNumber) continue;
      observedLatestByRoom.set(key, nextId);
      void enqueueRoomWork(roomId, async () => {
        const candidates = await fetchNewMessages(roomId, previousId, nextId, version);
        for (const candidate of candidates) {
          if (version !== sessionVersion || !isSameAccount(account.id)) return;
          await deliverCandidateAlert(roomId, candidate, { targetedMention: false });
        }
      });
    }
  }

  watch(
    () => accountActivity.state.value,
    (next) => {
      evaluateActivitySnapshot(next);
    },
    { immediate: true },
  );

  function receiveRoomMention(event: RoomMentionEvent): Promise<void> {
    const account = currentAccount();
    if (!account?.id || !event?.room_id || !event?.message_id) return Promise.resolve();
    const version = sessionVersion;
    if (!isRoomListedInSidebar(event.room_id)) {
      void app.refreshSidebarRoomMetadata?.();
    }
    return enqueueRoomWork(event.room_id, async () => {
      if (roomMessageAlertGate.has(account.id, event.room_id, event.message_id)) return;
      const message = await desktopIpc.room?.getMessage?.(event.room_id, event.message_id).catch(() => null);
      if (!message || version !== sessionVersion || !isSameAccount(account.id)) return;
      await deliverCandidateAlert(event.room_id, message, {
        targetedMention: true,
        fallbackRoomDisplayName: event.room_display_name,
      });
    });
  }

  onScopeDispose(() => {
    sessionVersion += 1;
    observedLatestByRoom.clear();
    roomQueues.clear();
    unsubscribeStatus?.();
  });

  return {
    receiveRoomMention,
    evaluateActivitySnapshot,
  };
}
