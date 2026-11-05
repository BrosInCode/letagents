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
