/** One room's server-side read point and unread counts (`GET /account/unread`). */
export interface DesktopServerRoomUnread {
  roomId: string;
  /** The furthest message this account read in the room, on any device or the web; null before the first report. */
  readMessageId: string | null;
  /** Unread messages after the read point, GitHub events left out. */
  unreadCount: number | null;
  /** GitHub events after the read point that show when the room shows GitHub events in chat. */
  githubUnreadCount: number | null;
}

export interface DesktopAccountUnread {
  rooms: DesktopServerRoomUnread[];
}
