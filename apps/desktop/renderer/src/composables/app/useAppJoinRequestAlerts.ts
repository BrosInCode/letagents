import { onScopeDispose, ref, watch } from "vue";
import type { DesktopNotificationStatus } from "../../../../electron/ipc-types";
import { joinRequestNotificationText } from "../../../../../../shared/room-join-requests.mjs";
import { createJoinRequestKnock } from "../../../../../../shared/ui/join-request-sound";
import { readNotificationsEnabled, readSoundEnabled } from "../../components/desktop/content/room-shell/preferences";
import { normalizeRoomIdentifier } from "../../domain/sidebar-rooms";
import { desktopIpc } from "../../ipc/index.js";
import { roomJoinRequests, type JoinRequestArrival } from "../useRoomJoinRequests";
import { roomNotificationPreferences, roomNotificationsMuted } from "../useRoomNotificationPreferences";
import type { AppContextOf } from "./context";

/**
 * What happens the moment a request to join one of this account's rooms
 * arrives: one sound (when sounds are on and the room is not muted), and a
 * desktop notification unless the native (APNs) alert covers it or the person
 * is looking at that room right now, where the banner is enough. A click on
 * the notification opens the room's settings at Members.
 */
export function useAppJoinRequestAlerts(context: unknown) {
  const app = context as AppContextOf<"useAppArchivedRooms" | "useAppNavigation" | "useAppState">;
  const { activeEntry, authStatus, selectedRoomInfo, roomSettingsSectionRequest } = app;
  const nativeNotificationsActive = ref(false);
  const notificationsEnabled = ref(readNotificationsEnabled());
  const knock = createJoinRequestKnock();
  let sessionVersion = 0;
  watch(() => authStatus.value?.account?.id, () => { sessionVersion += 1; knock.stop(); }, { flush: "sync" });

  function applyNotificationStatus(status: DesktopNotificationStatus): void {
    notificationsEnabled.value = status.enabled;
    nativeNotificationsActive.value = status.nativeRegistered;
  }
  const statusReady = desktopIpc.notifications?.getStatus?.().then(applyNotificationStatus).catch(() => undefined);
  const unsubscribeStatus = desktopIpc.notifications?.onStatusChanged?.(applyNotificationStatus) || null;

  function roomIsInFront(roomId: string): boolean {
    if (typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus())) return false;
    if (activeEntry.value.type !== "room") return false;
    const open = selectedRoomInfo.value;
    const accessRoom = open.kind === "focus" ? open.parentRoomId : open.identifier;
    return normalizeRoomIdentifier(accessRoom) === normalizeRoomIdentifier(roomId);
  }

  /** Opens the room and its settings at Members, as a notification click does. */
  async function openJoinRequestSettings(roomIdentifier: string): Promise<void> {
    try {
      await app.openRoomFromAppAgent(roomIdentifier);
      roomSettingsSectionRequest.value = { roomIdentifier, section: "members", nonce: (roomSettingsSectionRequest.value?.nonce ?? 0) + 1 };
    } catch (error) {
      console.warn("Could not open the room for this join request.", error);
    }
  }

  async function alertForArrival({ request, playSound }: JoinRequestArrival): Promise<void> {
    if (!authStatus.value?.authenticated || !roomNotificationPreferences.signedIn()) return;
    const version = sessionVersion;
    const wasPending = roomJoinRequests.items.value.some(item => item.id === request.id);
    await statusReady;
    if (version !== sessionVersion) return;
    await roomNotificationPreferences.allowsAfterRead(request.room_id, "");
    if (version !== sessionVersion) return;
    if (!roomNotificationPreferences.state(request.room_id).ready) await roomNotificationPreferences.refresh(request.room_id);
    if (version !== sessionVersion || !authStatus.value?.authenticated || roomNotificationsMuted(request.room_id)) return;
    if (wasPending && !roomJoinRequests.items.value.some(item => item.id === request.id)) return;
    const nativeBackgroundAlert = nativeNotificationsActive.value && typeof document !== "undefined"
      && (document.visibilityState !== "visible" || !document.hasFocus());
    if (playSound && readSoundEnabled() && !nativeBackgroundAlert) {
      knock.play();
    }
    // The signed app's APNs alert already shows this on macOS, even while the app is in front.
    if (nativeNotificationsActive.value) return;
    if (!notificationsEnabled.value || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (roomNotificationsMuted(request.room_id) || roomIsInFront(request.room_id)) return;
    const text = joinRequestNotificationText(request);
    const notification = new Notification(text.title, { body: text.body, silent: true, tag: `join-request:${request.id}` });
    notification.onclick = () => { void openJoinRequestSettings(request.room_id); };
  }

  const unsubscribeArrivals = roomJoinRequests.onArrival(arrival => {
    void alertForArrival(arrival).catch(error => console.warn("Could not announce this join request.", error));
  });
  onScopeDispose(() => {
    sessionVersion += 1;
    knock.dispose();
    unsubscribeStatus?.();
    unsubscribeArrivals();
  });

  return { openJoinRequestSettings, alertForArrival };
}
