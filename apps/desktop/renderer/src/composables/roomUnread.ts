import { type InjectionKey } from "vue";
import { createRoomUnreadClient } from "../../../../../shared/room-unread-client";

export const roomUnread = createRoomUnreadClient("letagents-desktop:room-unread");
export const unreadRevealKey: InjectionKey<(messageId: string) => Promise<boolean>> = Symbol("unread-reveal");
