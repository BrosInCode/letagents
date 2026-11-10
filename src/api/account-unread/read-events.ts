import { EventEmitter } from "node:events";

/** An account recorded new reads in a room. In-process only: a missed one leaves a count stale until the room changes. */
export const ACCOUNT_ROOM_READ = "account_room_read";
export const ACCOUNT_ROOM_READ_STREAM_EVENT = "room_read";

export interface AccountRoomReadEvent {
  accountId: string;
  roomId: string;
  /** The highest message the newly recorded ranges cover. */
  lastMessageId: string;
}

export const accountReadEvents = new EventEmitter();
accountReadEvents.setMaxListeners(0);
