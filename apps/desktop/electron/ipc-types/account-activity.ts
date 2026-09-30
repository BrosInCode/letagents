/** One room as the account activity stream reports it. */
export interface DesktopAccountRoomActivity {
  roomId: string;
  latestMessageId: string | null;
  latestMessageAt: string | null;
  /** Agents working in the room right now. */
  working: Array<{ displayName: string }>;
}

export interface DesktopAccountActivityState {
  /** Whether the stream is open. While it is not, the renderer refreshes the room list itself. */
  connected: boolean;
  /** Keyed by the server's room id. */
  rooms: Record<string, DesktopAccountRoomActivity>;
}
