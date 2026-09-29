export type DesktopNotificationTarget = {
  notificationId: string;
  messageId: string;
  threadRootId: string | null;
} & ({ roomIdentifier: string; conversationId?: never } | { conversationId: string; roomIdentifier?: never });

export interface DesktopNotificationStatus {
  enabled: boolean;
  nativeSupported: boolean;
  nativeRegistered: boolean;
  lastError: string | null;
}
