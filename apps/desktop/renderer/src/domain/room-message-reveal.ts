import type { DesktopRoomMessage, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import type { AgentInspectorRequest } from "../components/desktop/content/desktop-chat-message/types";

/** Startup prompts have retained work, but no room-chat message to scroll to. */
export function initialMessageInspectorRequest(
  messageId: string,
  roomId: string,
  entries: readonly DesktopSupervisorManifestEntry[],
): AgentInspectorRequest | null {
  const entry = entries.find((candidate) => candidate.roomId === roomId
    && messageId === `desktop-initial-message:${candidate.id}`);
  if (!entry) return null;
  return {
    kind: "supervised",
    supervisorEntryId: entry.id,
    target: {
      messageId: null, clientMessageId: null, messageSource: null,
      actorLabel: entry.displayName, displayName: entry.displayName,
      ownerAttribution: null, ideLabel: null, sender: entry.displayName,
      agentKey: entry.agentKey ?? null, agentSessionId: entry.agentSessionId ?? null,
    },
  };
}

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
