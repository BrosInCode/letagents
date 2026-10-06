export interface RoomUnreadBookmark {
  room: string;
  messageId: string;
  revision: string;
  markedAt: number;
}
export function unreadRoomKey(room: string | null | undefined): string;
export function createRoomUnreadStore(options: {
  storage(): Pick<Storage, "getItem" | "setItem">;
  namespace: string;
  changed?(): void;
}): {
  get(account: string | null, room: string | null | undefined): RoomUnreadBookmark | null;
  mark(account: string | null, room: string | null | undefined, messageId: string): RoomUnreadBookmark | null;
  clear(account: string | null, room: string | null | undefined, revision: string): boolean;
  acceptsStorageEvent(key: string | null): boolean;
};
export function canClearUnreadBookmark(input: {
  enteredRevision: string | null;
  current: RoomUnreadBookmark | null;
  revealed: boolean;
  atBottom: boolean;
  visible: boolean;
  focused: boolean;
}): boolean;
