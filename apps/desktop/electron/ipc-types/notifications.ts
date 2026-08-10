export interface DesktopNotificationTarget {
  notificationId: string;
  roomIdentifier: string;
  messageId: string;
  threadRootId: string | null;
}

export interface DesktopNotificationStatus {
  enabled: boolean;
  nativeSupported: boolean;
  nativeRegistered: boolean;
  lastError: string | null;
}
