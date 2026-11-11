import type {
  DesktopNotificationTarget,
  DesktopRoomMessage,
} from "../../../electron/ipc-types";
import { mentionsPerson } from "../../../../../shared/room-notification-preferences.mjs";
import { roomMessageVisibleText } from "./attention-response";
import { roomReadKey } from "./desktop-room-read-state";

export interface RoomMessageAlertGate {
  has(accountScope: string | null | undefined, roomIdentifier: string, messageId: string): boolean;
  claim(accountScope: string | null | undefined, roomIdentifier: string, messageId: string): boolean;
  reset(): void;
}

function alertGateKey(
  accountScope: string | null | undefined,
  roomIdentifier: string,
  messageId: string,
): string | null {
  const roomKey = roomReadKey(roomIdentifier) || roomIdentifier.trim().toLowerCase();
  const normalizedMessageId = messageId.trim();
  if (!roomKey || !normalizedMessageId) return null;
  const scope = accountScope?.trim() || "local";
  return `${scope}\n${roomKey}\n${normalizedMessageId}`;
}

/**
 * Deduplicates sound + fallback desktop notifications across the active room
 * stream (`useDesktopRoomPreferences`), `/account/activity/stream` `room`
 * updates, and targeted `room_mention` frames so any `(account, room, message)`
 * alerts at most once.
 */
export function createRoomMessageAlertGate(maxEntries = 1000): RoomMessageAlertGate {
  const claimed = new Set<string>();
  return {
    has(accountScope, roomIdentifier, messageId) {
      const key = alertGateKey(accountScope, roomIdentifier, messageId);
      return Boolean(key && claimed.has(key));
    },
    claim(accountScope, roomIdentifier, messageId) {
      const key = alertGateKey(accountScope, roomIdentifier, messageId);
      if (!key || claimed.has(key)) return false;
      claimed.add(key);
      if (claimed.size > maxEntries) {
        const oldest = claimed.values().next().value;
        if (oldest !== undefined) claimed.delete(oldest);
      }
      return true;
    },
    reset() {
      claimed.clear();
    },
  };
}

export const roomMessageAlertGate = createRoomMessageAlertGate();

export function roomNotificationTag(roomIdentifier: string, messageId: string): string {
  const roomKey = roomReadKey(roomIdentifier) || roomIdentifier.trim().toLowerCase();
  return `room-message:${roomKey}:${messageId.trim()}`;
}

export function buildFallbackNotificationTarget(
  roomIdentifier: string,
  message: Pick<DesktopRoomMessage, "id"> & Partial<Pick<DesktopRoomMessage, "threadRootId" | "threadReplyToId">>,
): DesktopNotificationTarget {
  const roomKey = roomReadKey(roomIdentifier) || roomIdentifier.trim().toLowerCase();
  const threadRootId = message.threadReplyToId ? (message.threadRootId || null) : null;
  return {
    notificationId: `fallback:${roomKey}:${message.id}`,
    roomIdentifier,
    messageId: message.id,
    threadRootId,
  };
}

export function activateFallbackRoomNotification(
  target: DesktopNotificationTarget,
  fallback?: (target: DesktopNotificationTarget) => void | Promise<void>,
): void {
  const desktopWindow = (globalThis as {
    window?: {
      focus?: () => void;
      letagentsDesktop?: {
        notifications?: {
          activate?: (nextTarget: DesktopNotificationTarget) => Promise<boolean>;
        };
      };
    };
  }).window;
  const activate = desktopWindow?.letagentsDesktop?.notifications?.activate;
  if (activate) {
    void activate(target)
      .then((handled) => {
        if (!handled && fallback) void fallback(target);
      })
      .catch(() => {
        desktopWindow?.focus?.();
        if (fallback) void fallback(target);
      });
    return;
  }
  desktopWindow?.focus?.();
  if (fallback) void fallback(target);
}

export function formatRoomNotificationCopy(
  message: DesktopRoomMessage,
  roomDisplayName: string,
  agentNames: ReadonlyMap<string, string> | null = null,
): { title: string; body: string } {
  const sender = (message.sender || "").split("|")[0]?.trim() || "LetAgents";
  const roomLabel = (roomDisplayName || "").trim() || "LetAgents";
  const visibleText = roomMessageVisibleText(message, agentNames).trim();
  const attachmentCount = message.attachments?.length ?? 0;
  const body =
    visibleText
    || (message.gif?.title ? `GIF: ${message.gif.title}` : message.gif ? "Sent a GIF" : "")
    || (attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}` : "New message");
  return {
    title: `${sender} in ${roomLabel}`,
    body,
  };
}

/**
 * Matches server push publisher rules:
 * - A human's own message never alerts that human (even if self-mentioning).
 * - An ordinary message from a human's own agent does not alert on room-wide
 *   `All messages` fan-out, EXCEPT when the agent explicitly `@mention`s its
 *   human owner.
 */
export function isSuppressedViewerPublisherMessage(
  message: Pick<DesktopRoomMessage, "text" | "senderProfile" | "agentIdentity" | "outgoing">,
  viewerLogin: string | null | undefined,
): boolean {
  if (message.outgoing) return true;
  const login = viewerLogin?.trim().toLowerCase() || "";
  if (!login) return false;
  if (!message.agentIdentity) {
    const senderLogin = message.senderProfile?.login?.trim().toLowerCase() || "";
    return Boolean(senderLogin && senderLogin === login);
  }
  const agentKey = message.agentIdentity.agentKey?.trim() || "";
  const slashIndex = agentKey.indexOf("/");
  const keyOwner = slashIndex > 0 ? agentKey.slice(0, slashIndex).toLowerCase() : "";
  const ownerLabel =
    message.agentIdentity.ownerLabel
      ?.trim()
      .replace(/['’]s\s+agent$/i, "")
      .trim()
      .toLowerCase() || "";
  const isOwnAgent = (keyOwner && keyOwner === login) || (ownerLabel && ownerLabel === login);
  if (!isOwnAgent) return false;
  return !mentionsPerson(message.text, login);
}
