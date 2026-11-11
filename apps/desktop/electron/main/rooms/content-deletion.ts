import type { DesktopContentDeletion } from "../../ipc-types/api.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { deleteLocalMessageContent, getSyncedCloudMessageId, getLocalMessageAttachment, getLocalMessageIdForCloudMessage, rememberDeletedCloudMessages, findLocalAttachmentForCloud } from "./messages/local-store.js";
import { deleteLocalTask, getLocalTaskCloudId, getLocalTaskIdForCloudTask, rememberDeletedCloudTask, getLocalRoomByCloudRoomIncludingArchived, cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";
import type { RoomMessagePayload } from "./messages/mappers.js";

export async function deleteDesktopRoomContent(roomIdentifier: string, input: DesktopContentDeletion): Promise<void> {
  if (!roomIdentifier?.trim() || !input || !["message", "thread", "attachment", "task"].includes(input.kind) || typeof input.id !== "string" || (input.kind === "attachment" && typeof input.attachmentId !== "string")) throw new Error("Choose the content to delete.");
  const storage = await resolveLocalAwareRoomStorageMode(roomIdentifier);
  const isLocal = storage.effectiveMode === "local";
  const localId = storage.localRoom?.roomIdentifier ?? (await getLocalRoomByCloudRoomIncludingArchived(roomIdentifier))?.roomIdentifier;
  const cloudId = isLocal ? storage.localRoom?.cloudRoomIdentifier : cloudRoomIdentifierForStorage(storage, roomIdentifier);
  const remoteId = isLocal && localId
    ? input.kind === "task" ? await getLocalTaskCloudId({ roomId: localId, taskId: input.id }) : await getSyncedCloudMessageId({ roomId: localId, localMessageId: input.id })
    : input.id;
  const localContentId = isLocal ? input.id : localId && remoteId
    ? input.kind === "task" ? await getLocalTaskIdForCloudTask(localId, remoteId) : await getLocalMessageIdForCloudMessage(localId, remoteId)
    : null;
  let attachmentId = input.kind === "attachment" ? input.attachmentId : null;
  // Imported attachments keep cloud IDs. Published local attachments may have a
  // local ID, so match the remote metadata before any deletion is attempted.
  if (isLocal && localId && cloudId && remoteId && input.kind === "attachment") {
    const localAttachment = await getLocalMessageAttachment(localId, input.id, input.attachmentId);
    const { message } = await apiFetch<{ message: RoomMessagePayload | null }>(`/rooms/${encodeURIComponent(cloudId)}/messages/${encodeURIComponent(remoteId)}`).catch(error => {
      if (error instanceof DesktopApiError && error.status === 404) return { message: null };
      throw error;
    });
    const candidates = message?.attachments?.filter(item => item.id === attachmentId || (
      localAttachment && (item.file_name || item.filename) === (localAttachment.file_name || localAttachment.filename)
      && (item.size_bytes ?? item.byte_size) === (localAttachment.size_bytes ?? localAttachment.byte_size)
    )) ?? [];
    if (candidates.length > 1) throw new Error("Open the cloud room to delete this attachment; its local copy cannot be matched uniquely.");
    attachmentId = candidates[0]?.id || null; // Already removed remotely: finish local cleanup.
  }
  let localAttachmentId = input.kind === "attachment" ? input.attachmentId : undefined;
  if (!isLocal && localId && localContentId && cloudId && remoteId && input.kind === "attachment") {
    const { message } = await apiFetch<{ message: RoomMessagePayload | null }>(`/rooms/${encodeURIComponent(cloudId)}/messages/${encodeURIComponent(remoteId)}`).catch(error => {
      if (error instanceof DesktopApiError && error.status === 404) return { message: null };
      throw error;
    });
    const selected = message?.attachments?.find(item => item.id === input.attachmentId);
    localAttachmentId = selected ? await findLocalAttachmentForCloud(localId, localContentId, selected) ?? undefined : undefined;
  }
  const hasLocalTarget = localId && localContentId && (input.kind !== "attachment" || localAttachmentId);
  const localOptions = { thread: input.kind === "thread", ...(input.kind === "attachment" ? { attachmentId: localAttachmentId } : {}) };
  if (hasLocalTarget) {
    if (input.kind === "task") await deleteLocalTask(localId, localContentId, true);
    else await deleteLocalMessageContent(localId, localContentId, { ...localOptions, validateOnly: true });
  }
  let removedMessageIds: string[] = remoteId && input.kind !== "attachment" && input.kind !== "task" ? [remoteId] : [];
  if (cloudId && remoteId && (input.kind !== "attachment" || attachmentId)) {
    const path = input.kind === "task" ? `tasks/${encodeURIComponent(remoteId)}`
      : `messages/${encodeURIComponent(remoteId)}${input.kind === "thread" ? "/thread" : input.kind === "attachment" ? `/attachments/${encodeURIComponent(attachmentId!)}` : ""}`;
    try {
      const result = await apiFetch<{ message_ids?: string[] }>(`/rooms/${encodeURIComponent(cloudId)}/${path}`, { method: "DELETE" });
      removedMessageIds = result.message_ids ?? removedMessageIds;
    } catch (error) {
      if (!(error instanceof DesktopApiError && error.status === 404)) throw error;
    }
  }
  if (localId) {
    if (hasLocalTarget) {
      if (input.kind === "task") await deleteLocalTask(localId, localContentId);
      else await deleteLocalMessageContent(localId, localContentId, localOptions);
    }
    if (input.kind === "task" && remoteId) await rememberDeletedCloudTask(localId, remoteId);
    else await rememberDeletedCloudMessages(localId, removedMessageIds);
  }
}
