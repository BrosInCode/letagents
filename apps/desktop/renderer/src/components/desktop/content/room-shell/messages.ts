import type { DesktopRoomMessage } from "../../../../../../electron/ipc-types";
export { encodeRoomPathIdentifier } from "../../../../domain/room-urls";

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
  return [...byId.values()].sort(compareRoomMessages);
}

export function isHiddenChatMessage(message: DesktopRoomMessage): boolean {
  if (message.agentPromptKind === "auto" && !message.text.trim()) return true;
  return message.source === "agent" && /^\[status\]\s*/i.test(message.text || "");
}

export function compareRoomMessages(left: DesktopRoomMessage, right: DesktopRoomMessage): number {
  const leftNumber = messageNumber(left.id);
  const rightNumber = messageNumber(right.id);
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  const leftTime = Date.parse(left.timestamp || "");
  const rightTime = Date.parse(right.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (leftNumber && !rightNumber) return -1;
  if (!leftNumber && rightNumber) return 1;
  return left.id.localeCompare(right.id);
}

export function messageNumber(messageId: string): number {
  return Number(/^msg_(\d+)$/.exec(messageId)?.[1] || 0);
}
