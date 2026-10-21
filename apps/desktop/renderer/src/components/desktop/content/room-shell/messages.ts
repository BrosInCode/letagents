import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
export { encodeRoomPathIdentifier } from "../../../../domain/room-urls";
import { compareText } from "../../../../domain/formatters";

export function mergeRoomMessages(
  current: readonly DesktopRoomMessage[],
  incoming: readonly DesktopRoomMessage[],
): DesktopRoomMessage[] {
  const byId = new Map<string, DesktopRoomMessage>();
  for (const message of current) {
    if (!isHiddenChatMessage(message)) {
      byId.set(message.id, message);
    }
  }
  for (const message of incoming) {
    if (!isHiddenChatMessage(message)) {
      byId.set(message.id, message);
    }
  }
  const canonicalClientIds = new Set([...byId.values()].filter(message => !message.outgoing && message.clientMessageId).map(message => message.clientMessageId));
  return [...byId.values()].filter(message => !message.outgoing || !canonicalClientIds.has(message.clientMessageId)).sort(compareRoomMessages);
}

export function isHiddenChatMessage(message: DesktopRoomMessage): boolean {
  if (message.agentPromptKind === "auto" && !message.text.trim()) return true;
  return message.source === "agent" && /^\[status\]\s*/i.test(message.text || "");
}

interface RoomMessageSortKey {
  id: string;
  timestamp: string | undefined;
  number: number;
  time: number;
}

// Sorting calls the comparator O(n log n) times; the key is built once per
// message object. The key remembers the id and timestamp it was built from,
// so a message object that was edited in place gets a fresh key.
// WeakMap: entries go away with their messages, so there is no size to bound.
const sortKeys = new WeakMap<object, RoomMessageSortKey>();

/** Counts key builds so tests can prove a message is parsed once. */
export const roomMessageSortKeyBuilds = { count: 0 };

function sortKeyOf(message: DesktopRoomMessage): RoomMessageSortKey {
  const cached = sortKeys.get(message);
  if (cached && cached.id === message.id && cached.timestamp === message.timestamp) return cached;
  roomMessageSortKeyBuilds.count += 1;
  const key = {
    id: message.id,
    timestamp: message.timestamp,
    number: messageNumber(message.id),
    time: Date.parse(message.timestamp || ""),
  };
  sortKeys.set(message, key);
  return key;
}

export function compareRoomMessages(left: DesktopRoomMessage, right: DesktopRoomMessage): number {
  const leftKey = sortKeyOf(left);
  const rightKey = sortKeyOf(right);
  const leftNumber = leftKey.number;
  const rightNumber = rightKey.number;
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  const leftTime = leftKey.time;
  const rightTime = rightKey.time;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (leftNumber && !rightNumber) return -1;
  if (!leftNumber && rightNumber) return 1;
  return compareText(left.id, right.id);
}

export function messageNumber(messageId: string): number {
  return Number(/^msg_(\d+)$/.exec(messageId)?.[1] || 0);
}

/**
 * Returns a function that maps a message list to a number that changes only
 * when the list's ids or client message ids change. It replaces a watch source
 * that joined every id into one string on each event. The comparison reuses two
 * arrays of strings, so an unchanged list allocates nothing.
 */
export function createMessageIdentityVersion() {
  let ids: string[] = [];
  let clientIds: string[] = [];
  let version = 0;
  return (messages: readonly Pick<DesktopRoomMessage, "id" | "clientMessageId">[]): number => {
    let same = messages.length === ids.length;
    if (same) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (message.id !== ids[index] || (message.clientMessageId || "") !== clientIds[index]) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      ids = messages.map((message) => message.id);
      clientIds = messages.map((message) => message.clientMessageId || "");
      version += 1;
    }
    return version;
  };
}
