import { ref, watch, type Ref } from "vue";
import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
import {
  readLiquidGlassEnabled,
  readNotificationPermission,
  readNotificationsEnabled,
  readSoundEnabled,
} from "./preferences";

export function useDesktopRoomPreferences() {
  const soundEnabled = ref(readSoundEnabled());
  const notificationsEnabled = ref(readNotificationsEnabled());
  const liquidGlassEnabled = ref(readLiquidGlassEnabled());
  const notificationPermission = ref<NotificationPermission | "unsupported">(readNotificationPermission());
  let audioContext: AudioContext | null = null;

  function toggleSound(): void {
    soundEnabled.value = !soundEnabled.value;
    window.localStorage.setItem("letagents-desktop:sound", soundEnabled.value ? "on" : "off");
    if (soundEnabled.value) playRoomSound("send");
  }

  async function toggleNotifications(): Promise<void> {
    if (typeof Notification === "undefined") {
      notificationPermission.value = "unsupported";
      return;
    }
    if (!notificationsEnabled.value && Notification.permission === "default") {
      notificationPermission.value = await Notification.requestPermission();
    } else {
      notificationPermission.value = Notification.permission;
    }
    notificationsEnabled.value = !notificationsEnabled.value && notificationPermission.value === "granted";
    window.localStorage.setItem("letagents-desktop:notifications", notificationsEnabled.value ? "on" : "off");
  }

  function toggleLiquidGlass(): void {
    liquidGlassEnabled.value = !liquidGlassEnabled.value;
    window.localStorage.setItem("letagents-desktop:liquid-glass", liquidGlassEnabled.value ? "on" : "off");
  }

  function playRoomSound(kind: "send" | "notification"): void {
    if (!soundEnabled.value) return;
    try {
      const AudioContextCtor =
        window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      if (!audioContext) audioContext = new AudioContextCtor();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      const now = audioContext.currentTime;
      const startFrequency = kind === "send" ? 740 : 880;
      const endFrequency = kind === "send" ? 980 : 660;
      oscillator.frequency.setValueAtTime(startFrequency, now);
      oscillator.frequency.setValueAtTime(endFrequency, now + 0.07);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
    } catch {
      // Audio can be unavailable before a user gesture; the toggle will retry later.
    }
  }

  function showRoomNotification(message: DesktopRoomMessage, roomDisplayName: string): void {
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
