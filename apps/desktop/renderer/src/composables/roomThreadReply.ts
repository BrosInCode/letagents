import { type InjectionKey } from "vue";

/**
 * Posts a reply in a message thread through the same path as the thread's own
 * composer. Resolves to whether the app accepted the reply (it delivers it
 * after that, and shows its progress on the message).
 */
export type RoomThreadReply = (
  threadRootId: string,
  text: string,
  attachments: Array<{ upload_id: string }>,
) => Promise<boolean>;

export const roomThreadReplyKey: InjectionKey<RoomThreadReply> = Symbol("room-thread-reply");

/** Opens a message's thread in the thread panel, as its reply count does. */
export type RoomThreadOpen = (threadRootId: string) => void;

export const roomThreadOpenKey: InjectionKey<RoomThreadOpen> = Symbol("room-thread-open");
