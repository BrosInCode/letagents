import { computed, ref, watch } from "vue";
import type { DesktopAccountRoomJoinRequest } from "../../../../electron/ipc-types";
import { roomJoinRequests } from "../useRoomJoinRequests";
import { joinRequestsForRoom } from "../../components/desktop/content/room-shell/join-requests";
import { roomMembershipErrorMessage } from "../../components/desktop/content/room-shell/room-members";
import type { RoomShellContextOf } from "./context";

/** The requests to join this room, shown to its admins at the top of the room. */
export function useRoomShellJoinRequests(context: unknown) {
  const { emit, isLocalRoom, openActionPanelAt, props } = context as RoomShellContextOf<
      "inputs"
    | "useRoomShellConversation"
    | "useRoomShellToolActions"
  >;
  const joinRequestBanner = computed(() => joinRequestsForRoom(roomJoinRequests.items.value, props.room, {
    localRoom: isLocalRoom.value,
    dismissed: roomJoinRequests.dismissed.value,
  }));
  const joinRequestBusy = ref<string | null>(null);
  const joinRequestError = ref<string | null>(null);

  async function decideJoinRequest(request: DesktopAccountRoomJoinRequest, decision: "approve" | "decline"): Promise<void> {
    if (joinRequestBusy.value) return;
    joinRequestBusy.value = `${decision}:${request.id}`;
    joinRequestError.value = null;
    try {
      const result = await roomJoinRequests.decide(request, decision);
      // A request another admin answered first is gone from the banner already.
      if (!result.ok && result.code !== "ROOM_JOIN_REQUEST_NOT_PENDING") joinRequestError.value = roomMembershipErrorMessage(result);
    } catch (cause) {
      joinRequestError.value = cause instanceof Error && cause.message ? cause.message : "The request could not be decided.";
    } finally {
      joinRequestBusy.value = null;
    }
  }

  function dismissJoinRequests(): void {
    roomJoinRequests.dismiss(joinRequestBanner.value.map((item) => item.id));
    joinRequestError.value = null;
  }

  function openJoinRequests(): void {
    openActionPanelAt("members");
  }

  // An admin who opens a room sees the requests already waiting there.
  watch(() => [props.room.identifier, props.room.role === "admin" && !isLocalRoom.value] as const, ([, admin]) => {
    joinRequestError.value = null;
    if (admin) void roomJoinRequests.refresh();
  }, { immediate: true });

  // A desktop notification click asks for the room's settings at one section,
  // once: the app clears the request as soon as it is acted on, so a later
  // visit to the room (a new shell) does not open the panel again.
  watch(() => [props.settingsSectionRequest?.section ?? null, props.settingsSectionRequest?.nonce ?? 0, props.roomLoading] as const,
    ([section, , roomLoading]) => {
      if (!section || roomLoading) return;
      openActionPanelAt(section);
      emit("settings-section-opened");
    }, { immediate: true });

  return { joinRequestBanner, joinRequestBusy, joinRequestError, decideJoinRequest, dismissJoinRequests, openJoinRequests };
}
