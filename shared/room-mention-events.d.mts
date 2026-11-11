export declare const ROOM_MENTION_EVENT: 'room_mention';

export interface RoomMentionEvent {
  room_id: string;
  room_display_name: string;
  message_id: string;
  thread_root_id: string | null;
}

export declare function parseRoomMentionEvent(value: unknown): RoomMentionEvent | null;
