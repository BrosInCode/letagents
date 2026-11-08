export declare const DESKTOP_LINK_SCHEME: 'letagents';

/** A room the desktop app should open, read from a link. */
export interface DesktopRoomLink {
  roomIdentifier: string;
  /** A message to reveal once the room is open, or null. */
  messageId: string | null;
}

export declare function isValidRoomLinkIdentifier(value: unknown): value is string;
export declare function buildDesktopRoomLink(roomIdentifier: string | null | undefined, messageId?: string | null): string;
export declare function parseDesktopRoomLink(url: unknown, origin?: string): DesktopRoomLink | null;
