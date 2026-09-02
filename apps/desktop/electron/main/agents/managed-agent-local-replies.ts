import type {
  DesktopRoomMessage,
  DesktopRoomStorageState,
} from "../../ipc-types.js";
import {
  localRoomIdentifierForStorage,
} from "../rooms/local-store.js";
import {
  addLocalChatMessageWithDeferredWriteNotification,
} from "../rooms/messages/local-store.js";
import { mapRoomMessagePayload } from "../rooms/messages/mappers.js";
import type { RoomMessageAttachmentPayload } from "../attachments.js";
import type { StoredAgentSessionState } from "./state.js";
import type { SqliteDatabase } from "../rooms/local-db.js";

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

type PersistDesktopManagedAgentLocalReplyInput = {
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  workerSession: StoredAgentSessionState;
  replyTo: string | null;
  threadRootId?: string | null;
  text: string;
  attachments?: RoomMessageAttachmentPayload[];
  source?: string;
  sender?: string;
  idempotencyKey?: string | null;
  writeInTransaction?: (database: SqliteDatabase) => void;
};

export type DeferredDesktopManagedAgentLocalReply = {
  message: DesktopRoomMessage;
  publishWriteNotification: () => void;
};

export async function persistDesktopManagedAgentLocalReplyWithDeferredWriteNotification(
  input: PersistDesktopManagedAgentLocalReplyInput,
): Promise<DeferredDesktopManagedAgentLocalReply | null> {
  if (input.storage.effectiveMode !== "local") {
    return null;
  }

  const localRoomIdentifier = localRoomIdentifierForStorage(input.storage, input.roomIdentifier);
  const persisted = await addLocalChatMessageWithDeferredWriteNotification(
    localRoomIdentifier,
    {
      sender: input.sender || desktopManagedAgentReplySender(input.workerSession),
      text: input.text,
      reply_to: input.replyTo,
      thread_root_id: input.threadRootId ?? null,
      source: input.source || "agent",
      attachments: input.attachments ?? [],
      idempotency_key: input.idempotencyKey ?? null,
      publisher_agent_key: input.workerSession.agent_key ?? null,
      publisher_agent_session_id: input.workerSession.session_id,
    },
    { writeInTransaction: input.writeInTransaction },
  );

  return {
    message: mapRoomMessagePayload(persisted.message),
    publishWriteNotification: persisted.publishWriteNotification,
  };
}

export async function persistDesktopManagedAgentLocalReply(
  input: PersistDesktopManagedAgentLocalReplyInput,
): Promise<DesktopRoomMessage | null> {
  const persisted = await persistDesktopManagedAgentLocalReplyWithDeferredWriteNotification(input);
  if (!persisted) return null;
  persisted.publishWriteNotification();
  return persisted.message;
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
