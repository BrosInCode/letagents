import {
  getCurrentInstance,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onScopeDispose,
  ref,
  watch,
  type Ref,
} from "vue";
import type { DesktopNotificationStatus, DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import {
  readNotificationPermission,
  readNotificationsEnabled,
  readSoundEnabled,
  writeNotificationsEnabled,
} from "./preferences";
import { playRoomInteractionSound } from "./roomSounds";
import {
  activateFallbackRoomNotification,
  buildFallbackNotificationTarget,
  formatRoomNotificationCopy,
  roomMessageAlertGate,
  roomNotificationTag,
} from "../../../../domain/room-message-alert-gate";
import { roomNotificationPreferences } from "../../../../composables/useRoomNotificationPreferences";

export function useDesktopRoomPreferences(roomIdentifier: () => string) {
  watch(roomIdentifier, (id) => { void roomNotificationPreferences.refresh(id); }, { immediate: true });
  const soundEnabled = ref(readSoundEnabled());
  const notificationsEnabled = ref(readNotificationsEnabled());
  const nativeNotificationsActive = ref(false);
  const notificationPermission = ref<NotificationPermission | "unsupported">(readNotificationPermission());
  let shellActive = true;

  function applyNotificationStatus(status: DesktopNotificationStatus): void {
    notificationsEnabled.value = status.enabled;
    nativeNotificationsActive.value = status.nativeRegistered;
    if (status.nativeSupported) {
      notificationPermission.value = readNotificationPermission();
    }
    writeNotificationsEnabled(status.enabled);
  }

  void window.letagentsDesktop.notifications?.getStatus?.().then(applyNotificationStatus).catch(() => undefined);
  const unsubscribeNotificationStatus = window.letagentsDesktop.notifications?.onStatusChanged?.(applyNotificationStatus) || null;
  if (getCurrentInstance()) {
    onActivated(() => { shellActive = true; });
    onDeactivated(() => { shellActive = false; });
    onBeforeUnmount(() => unsubscribeNotificationStatus?.());
  }
  onScopeDispose(() => {
    shellActive = false;
    unsubscribeNotificationStatus?.();
  });

  function toggleSound(): void {
    soundEnabled.value = !soundEnabled.value;
    window.localStorage.setItem("letagents-desktop:sound", soundEnabled.value ? "on" : "off");
    if (soundEnabled.value) playRoomSound("send");
  }

  async function toggleNotifications(): Promise<void> {
    const nativeBridge = window.letagentsDesktop.notifications;
    const enabling = !notificationsEnabled.value;
    if (enabling && typeof Notification !== "undefined" && Notification.permission === "default") {
      notificationPermission.value = await Notification.requestPermission();
    }
    if (enabling && notificationPermission.value !== "granted") {
      notificationsEnabled.value = false;
      writeNotificationsEnabled(false);
      if (nativeBridge?.setEnabled) await nativeBridge.setEnabled(false);
      return;
    }
    if (nativeBridge?.setEnabled) {
      const status = await nativeBridge.setEnabled(enabling);
      applyNotificationStatus(status);
      if (status.nativeSupported) {
        return;
      }
    }
    if (typeof Notification === "undefined") {
      notificationPermission.value = "unsupported";
      return;
    }
    notificationPermission.value = Notification.permission;
    notificationsEnabled.value = enabling && notificationPermission.value === "granted";
    writeNotificationsEnabled(notificationsEnabled.value);
  }

  function playRoomSound(kind: "send" | "notification"): void {
    if (!soundEnabled.value) return;
    try {
      playRoomInteractionSound(kind);
    } catch {
      // Audio can be unavailable before a user gesture; the toggle will retry later.
    }
  }

  function showRoomNotification(
    message: DesktopRoomMessage,
    roomDisplayName: string,
    agentNames: ReadonlyMap<string, string> | null = null,
  ): void {
    if (nativeNotificationsActive.value) return;
    if (!notificationsEnabled.value || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const id = roomIdentifier();
    const copy = formatRoomNotificationCopy(message, roomDisplayName, agentNames);
    const notification = new Notification(copy.title, {
      body: copy.body,
      silent: true,
      tag: roomNotificationTag(id, message.id),
    });
    notification.onclick = () => {
      activateFallbackRoomNotification(buildFallbackNotificationTarget(id, message));
    };
  }

  return {
    soundEnabled,
    notificationsEnabled,
    notificationPermission,
    toggleSound,
    toggleNotifications,
    playRoomSound,
    showRoomNotification,
    watchRoomNotifications: (options: Parameters<typeof watchRoomNotifications>[0]) => {
      const approvedViewerByMessageId = new Map<string, string | null>();
      return watchRoomNotifications({
        ...options,
        isShellActive: () => shellActive,
        claimAlert: (message) => {
          const id = roomIdentifier();
          const currentViewerId = roomNotificationPreferences.viewerId();
          if (approvedViewerByMessageId.has(message.id)) {
            const expectedViewerId = approvedViewerByMessageId.get(message.id) ?? null;
            approvedViewerByMessageId.delete(message.id);
            if (currentViewerId !== expectedViewerId) return false;
          }
          return roomMessageAlertGate.claim(currentViewerId, id, message.id);
        },
        shouldNotify: async (message) => {
          approvedViewerByMessageId.delete(message.id);
          if (!shellActive) return false;
          const id = roomIdentifier();
          const entryViewerId = roomNotificationPreferences.viewerId();
          if (roomMessageAlertGate.has(entryViewerId, id, message.id)) return false;
          const allowed = await roomNotificationPreferences.allowsAfterRead(id, message.text);
          if (!shellActive || id !== roomIdentifier() || roomNotificationPreferences.viewerId() !== entryViewerId) {
            return false;
          }
          if (roomNotificationPreferences.signedIn() && !roomNotificationPreferences.state(id).ready) {
            await roomNotificationPreferences.refresh(id);
            if (!shellActive || id !== roomIdentifier() || roomNotificationPreferences.viewerId() !== entryViewerId) {
              return false;
            }
            const allowedAfterRefresh = await roomNotificationPreferences.allowsAfterRead(id, message.text);
            if (!shellActive || id !== roomIdentifier() || roomNotificationPreferences.viewerId() !== entryViewerId) {
              return false;
            }
            if (!allowedAfterRefresh) return false;
          }
          const permitted = allowed && roomNotificationPreferences.allows(id, message.text);
          if (permitted) approvedViewerByMessageId.set(message.id, entryViewerId);
          return permitted;
        },
      });
    },
  };
}

export function watchRoomNotifications(options: {
  visibleMessages: Readonly<Ref<readonly DesktopRoomMessage[]>>;
  ownMessageIds: Set<string>;
  playRoomSound(kind: "send" | "notification"): void;
  showRoomNotification(message: DesktopRoomMessage): void;
  shouldNotify?(message: DesktopRoomMessage): boolean | Promise<boolean>;
  claimAlert?(message: DesktopRoomMessage): boolean;
  isShellActive?(): boolean;
}) {
  let observedLatestMessageId: string | null = null;
  let active = true;
  onScopeDispose(() => { active = false; });
  watch(
    () => options.visibleMessages.value.at(-1)?.id || null,
    async (messageId) => {
      if (!messageId) return;
      if (!observedLatestMessageId) {
        observedLatestMessageId = messageId;
        return;
      }
      if (messageId === observedLatestMessageId) return;
      observedLatestMessageId = messageId;
      if (options.isShellActive && !options.isShellActive()) return;
      const message = options.visibleMessages.value.find((entry) => entry.id === messageId);
      if (!message || options.ownMessageIds.has(message.id)) return;
      if (options.shouldNotify && !await options.shouldNotify(message)) return;
      if (!active || observedLatestMessageId !== messageId) return;
      if (options.isShellActive && !options.isShellActive()) return;
      if (options.claimAlert && !options.claimAlert(message)) return;
      options.playRoomSound("notification");
      options.showRoomNotification(message);
    }
  );
}
