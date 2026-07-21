import type { DesktopRoomMessage } from "../../../electron/ipc-types";

export type RoomMessageRevealDestination =
  | { kind: "main" }
  | { kind: "thread"; threadRootId: string }
  | { kind: "history" };

/** Decide whether a causal link is already renderable or needs bounded history recovery. */
export function roomMessageRevealDestination(
  messageId: string,
  timelineMessages: readonly Pick<DesktopRoomMessage, "id">[],
  threadMessages: readonly Pick<DesktopRoomMessage, "id" | "threadRootId">[],
): RoomMessageRevealDestination {
  if (timelineMessages.some((message) => message.id === messageId)) return { kind: "main" };
  const threadMessage = threadMessages.find((message) => message.id === messageId);
  if (threadMessage) return { kind: "thread", threadRootId: threadMessage.threadRootId || threadMessage.id };
  return { kind: "history" };
}
