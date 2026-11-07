export type DesktopNotificationTarget =
  | ({
    notificationId: string;
    messageId: string;
    threadRootId: string | null;
    joinRequestId?: never;
  } & ({ roomIdentifier: string; conversationId?: never } | { conversationId: string; roomIdentifier?: never }))
  | {
    /** A request to join a room: a click opens the room's settings at Members. */
    notificationId: string;
    roomIdentifier: string;
    joinRequestId: string;
    messageId?: never;
    threadRootId?: never;
    conversationId?: never;
  };

export interface DesktopNotificationStatus {
  enabled: boolean;
  nativeSupported: boolean;
  nativeRegistered: boolean;
  lastError: string | null;
}
