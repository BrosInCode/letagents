import { watch } from "vue";
import { createRoomUnreadClient } from "../../../../shared/room-unread-client";
import { useAuth } from "./useAuth";

const roomUnread = createRoomUnreadClient("letagents-web:room-unread");
export function useRoomUnread() {
  const { user, isSignedIn } = useAuth();
  watch(() => isSignedIn.value ? user.value?.id ?? null : null,
    id => { roomUnread.account.value = id; }, { immediate: true, flush: "sync" });
  return roomUnread;
}
