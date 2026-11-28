import { onScopeDispose, ref, watch } from "vue";
import type { DesktopNotificationStatus } from "../../../../electron/ipc-types";
import { conversationAlertText, type IncomingConversationMessage } from "../../../../../../shared/conversation-alerts.mjs";
import { readNotificationsEnabled, readSoundEnabled } from "../../components/desktop/content/room-shell/preferences";
import { playRoomInteractionSound } from "../../components/desktop/content/room-shell/roomSounds";
import { activateFallbackRoomNotification } from "../../domain/room-message-alert-gate";
import { desktopIpc } from "../../ipc/index.js";
import type { AppContextOf } from "./context";

/**
 * What happens when a private message arrives that the person is not looking
 * at: the notification sound (when sounds are on), and a desktop notification
 * unless the native (APNs) alert covers it. The words match the server push:
 * the sender, and no message text. A click opens the conversation.
 */
export function useAppConversationAlerts(context: unknown) {
  const app = context as AppContextOf<"useAppInboxActions" | "useAppState">;
  const { authStatus } = app;
  const nativeNotificationsActive = ref(false);
  const notificationsEnabled = ref(readNotificationsEnabled());
  let sessionVersion = 0;
  watch(() => authStatus.value?.account?.id, () => { sessionVersion += 1; }, { flush: "sync" });

  function applyNotificationStatus(status: DesktopNotificationStatus): void {
    notificationsEnabled.value = status.enabled;
    nativeNotificationsActive.value = status.nativeRegistered;
  }
  const statusReady = desktopIpc.notifications?.getStatus?.().then(applyNotificationStatus).catch(() => undefined);
  const unsubscribeStatus = desktopIpc.notifications?.onStatusChanged?.(applyNotificationStatus) || null;

  async function alertForIncomingConversation({ conversation, message }: IncomingConversationMessage): Promise<void> {
    if (!authStatus.value?.authenticated) return;
    const version = sessionVersion;
    await statusReady;
    if (version !== sessionVersion || !authStatus.value?.authenticated) return;
    const background = typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus());
    // The APNs alert plays its own sound while the app is in the background.
    if (readSoundEnabled() && !(nativeNotificationsActive.value && background)) {
      try {
        playRoomInteractionSound("notification");
      } catch {
        // Audio can fail before user interaction.
      }
    }
    // The signed app's APNs alert already shows this on macOS, even while the app is in front.
    if (nativeNotificationsActive.value) return;
    if (!notificationsEnabled.value || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const text = conversationAlertText(conversation, message);
    const notification = new Notification(text.title, {
      body: text.body,
      silent: true,
      tag: `conversation-message:${conversation.id}:${message.number}`,
    });
    // The main process brings the window forward and opens the conversation, as for an APNs click.
    const target = {
      notificationId: `fallback-conversation:${conversation.id}:${message.number}`,
      conversationId: conversation.id,
      messageId: String(message.number),
      threadRootId: null,
    };
    notification.onclick = () => {
      activateFallbackRoomNotification(target, () => app.openMessages(conversation.id));
    };
  }

  onScopeDispose(() => {
    sessionVersion += 1;
    unsubscribeStatus?.();
  });

  return {
    alertForIncomingConversation(incoming: IncomingConversationMessage): void {
      void alertForIncomingConversation(incoming).catch((error) => console.warn("Could not announce this private message.", error));
    },
  };
}
