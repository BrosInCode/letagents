import type { DesktopNotificationTarget } from "../ipc-types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function parseDesktopNotificationTarget(value: unknown): DesktopNotificationTarget | null {
  const input = asRecord(value);
  if (!input) return null;
  const notificationId = typeof input.notification_id === "string"
    ? input.notification_id
    : typeof input.notificationId === "string" ? input.notificationId : "";
  const roomIdentifier = typeof input.room_id === "string"
    ? input.room_id
    : typeof input.roomIdentifier === "string" ? input.roomIdentifier : "";
  const messageId = typeof input.message_id === "string"
    ? input.message_id
    : typeof input.messageId === "string" ? input.messageId : "";
  const threadRootId = typeof input.thread_root_id === "string"
    ? input.thread_root_id
    : typeof input.threadRootId === "string" ? input.threadRootId : null;
  if (!notificationId || !roomIdentifier || !messageId) return null;
  return { notificationId, roomIdentifier, messageId, threadRootId };
}

export function parseDesktopNotificationLaunchInfo(value: unknown): DesktopNotificationTarget | null {
  const launchInfo = asRecord(value);
  if (!launchInfo) return null;
  const userInfo = asRecord(launchInfo.userInfo) ?? launchInfo;
  return parseDesktopNotificationTarget(userInfo.letagents);
}
