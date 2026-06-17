import type {
  DesktopRoomMessage,
  DesktopRoomStorageState,
} from "../../ipc-types.js";
import {
  localRoomIdentifierForStorage,
} from "../rooms/local-store.js";
import { addLocalChatMessage } from "../rooms/messages/local-store.js";
import { mapRoomMessagePayload } from "../rooms/messages/mappers.js";
import type { StoredAgentSessionState } from "./state.js";

export async function persistDesktopManagedAgentLocalReply(input: {
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  workerSession: StoredAgentSessionState;
  replyTo: string | null;
  text: string;
}): Promise<DesktopRoomMessage | null> {
  if (input.storage.effectiveMode !== "local") {
    return null;
  }

  const localRoomIdentifier = localRoomIdentifierForStorage(input.storage, input.roomIdentifier);
  const localMessage = await addLocalChatMessage(localRoomIdentifier, {
    sender: desktopManagedAgentReplySender(input.workerSession),
    text: input.text,
    reply_to: input.replyTo,
    source: "agent",
  });

  return mapRoomMessagePayload(localMessage);
}

function desktopManagedAgentReplySender(workerSession: StoredAgentSessionState): string {
  const displayName = workerSession.display_name?.trim();
  if (!displayName) {
    return workerSession.actor_label?.trim() || "Codex";
  }
  const ownerLabel = workerSession.owner_label?.trim() || "Local desktop";
  const ideLabel = workerSession.ide_label?.trim() || "Codex";
  return `${displayName} | ${ownerLabel} | ${ideLabel}`;
}
