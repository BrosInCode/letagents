import type {
  DesktopRoomMessage,
  DesktopRoomStorageState,
} from "../../ipc-types.js";
import {
  localRoomIdentifierForStorage,
} from "../rooms/local-store.js";
import { addLocalChatMessage } from "../rooms/messages/local-store.js";
import { mapRoomMessagePayload } from "../rooms/messages/mappers.js";
import type { RoomMessageAttachmentPayload } from "../attachments.js";
import type { StoredAgentSessionState } from "./state.js";

export type DesktopManagedAgentReplyTarget = {
  replyTo: string | null;
  threadRootId: string | null;
};

export function desktopManagedAgentReplyTargetForMessage(
  message: Pick<DesktopRoomMessage, "id" | "replyTo" | "threadRootId">,
): DesktopManagedAgentReplyTarget {
  const threadRootId = message.threadRootId?.trim() || null;
  return {
    replyTo: message.replyTo?.id ?? null,
    threadRootId: threadRootId && threadRootId !== message.id ? threadRootId : null,
  };
}

export async function persistDesktopManagedAgentLocalReply(input: {
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  workerSession: StoredAgentSessionState;
  replyTo: string | null;
  threadRootId?: string | null;
  text: string;
  attachments?: RoomMessageAttachmentPayload[];
  source?: string;
  sender?: string;
}): Promise<DesktopRoomMessage | null> {
  if (input.storage.effectiveMode !== "local") {
    return null;
  }

  const localRoomIdentifier = localRoomIdentifierForStorage(input.storage, input.roomIdentifier);
  const localMessage = await addLocalChatMessage(localRoomIdentifier, {
    sender: input.sender || desktopManagedAgentReplySender(input.workerSession),
    text: input.text,
    reply_to: input.replyTo,
    thread_root_id: input.threadRootId ?? null,
    source: input.source || "agent",
    attachments: input.attachments ?? [],
  });

  return mapRoomMessagePayload(localMessage);
}

function desktopManagedAgentReplySender(workerSession: StoredAgentSessionState): string {
  const actorLabel = workerSession.actor_label?.trim();
  if (actorLabel?.includes(" | ")) {
    return actorLabel;
  }
  const displayName = workerSession.display_name?.trim();
  if (!displayName) {
    return "Codex";
  }
  const ownerLabel = workerSession.owner_label?.trim() || "Local desktop";
  const ideLabel = workerSession.ide_label?.trim() || "Codex";
  return `${displayName} | ${ownerLabel} | ${ideLabel}`;
}
