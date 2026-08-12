import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { DesktopNotificationStatus, DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import {
  readLiquidGlassEnabled,
  readNotificationPermission,
  readNotificationsEnabled,
  readSoundEnabled,
} from "./preferences";
import { playRoomInteractionSound } from "./roomSounds";

export function useDesktopRoomPreferences() {
  const soundEnabled = ref(readSoundEnabled());
  const notificationsEnabled = ref(readNotificationsEnabled());
  const nativeNotificationsActive = ref(false);
  const liquidGlassEnabled = ref(readLiquidGlassEnabled());
  const notificationPermission = ref<NotificationPermission | "unsupported">(readNotificationPermission());

  function applyNotificationStatus(status: DesktopNotificationStatus): void {
    notificationsEnabled.value = status.enabled;
    nativeNotificationsActive.value = status.nativeRegistered;
    if (status.nativeSupported) {
      notificationPermission.value = readNotificationPermission();
    }
    window.localStorage.setItem("letagents-desktop:notifications", status.enabled ? "on" : "off");
  }

  void window.letagentsDesktop.notifications?.getStatus?.().then(applyNotificationStatus).catch(() => undefined);
  const unsubscribeNotificationStatus = window.letagentsDesktop.notifications?.onStatusChanged?.(applyNotificationStatus) || null;
  onBeforeUnmount(() => unsubscribeNotificationStatus?.());

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
      window.localStorage.setItem("letagents-desktop:notifications", "off");
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
    window.localStorage.setItem("letagents-desktop:notifications", notificationsEnabled.value ? "on" : "off");
  }

  function toggleLiquidGlass(): void {
    liquidGlassEnabled.value = !liquidGlassEnabled.value;
    window.localStorage.setItem("letagents-desktop:liquid-glass", liquidGlassEnabled.value ? "on" : "off");
  }

  function playRoomSound(kind: "send" | "notification"): void {
    if (!soundEnabled.value) return;
    try {
      playRoomInteractionSound(kind);
    } catch {
      // Audio can be unavailable before a user gesture; the toggle will retry later.
    }
  }

  function showRoomNotification(message: DesktopRoomMessage, roomDisplayName: string): void {
    if (nativeNotificationsActive.value) return;
    if (!notificationsEnabled.value || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const sender = message.sender.split("|")[0]?.trim() || "LetAgents";
    const body = message.text.trim() || `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
    new Notification(`${sender} in ${roomDisplayName}`, {
      body,
      silent: true,
    });
  }

  return {
    soundEnabled,
    notificationsEnabled,
    liquidGlassEnabled,
    notificationPermission,
    toggleSound,
    toggleNotifications,
    toggleLiquidGlass,
    playRoomSound,
    showRoomNotification,
  };
}

export function watchRoomNotifications(options: {
  visibleMessages: Readonly<Ref<readonly DesktopRoomMessage[]>>;
  ownMessageIds: Set<string>;
  playRoomSound(kind: "send" | "notification"): void;
  showRoomNotification(message: DesktopRoomMessage): void;
}) {
  let observedLatestMessageId: string | null = null;
  watch(
    () => options.visibleMessages.value.at(-1)?.id || null,
    (messageId) => {
      if (!messageId) return;
      if (!observedLatestMessageId) {
        observedLatestMessageId = messageId;
        return;
      }
      if (messageId === observedLatestMessageId) return;
      observedLatestMessageId = messageId;
      const message = options.visibleMessages.value.find((entry) => entry.id === messageId);
      if (!message || options.ownMessageIds.has(message.id)) return;
      options.playRoomSound("notification");
      options.showRoomNotification(message);
    }
  );
}
