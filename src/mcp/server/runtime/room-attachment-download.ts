import {
  ATTACHMENT_REDIRECT_STATUSES,
  AttachmentDownloadError,
  attachmentStorageUrl,
  isLoopbackApiUrl,
  readBoundedBody,
  storageResolvesToThisMachine,
} from "../../../../shared/attachment-download.mjs";
import { resolveLocalRoomStorageIdentifiers } from "../../local-state.js";
import { LETAGENTS_ORIGIN_ROOM_ID_HEADER } from "../../../shared/request-headers.js";
import { encodeRoomIdPath } from "../../room-id.js";
import { apiErrorFor, apiRequest, getApiUrl } from "./api.js";
import { maybeHandleRepoRoomAuthRequired } from "./device-auth.js";
import { getCurrentRoom, getCurrentSupervisedRoomAuthority } from "./room-state.js";
import { currentWorkerCall } from "../../worker-call-context.js";
import { hasSupervisedWorkerAuthority } from "./worker-bearer.js";

export const ROOM_MESSAGE_ID = /^msg_[1-9]\d{0,15}$/;
export const ROOM_ATTACHMENT_ID = /^att_[1-9]\d{0,15}$/;

/** The LetAgents server has no object storage configured, so it keeps no files. */
export class RoomAttachmentStorageMissingError extends Error {
  constructor() {
    super("This LetAgents server has no file storage, so it keeps no attachments.");
    this.name = "RoomAttachmentStorageMissingError";
  }
}

/**
 * The bytes of one attachment of one message in a room on the LetAgents
 * server, read the way the desktop daemon reads them: the room's route
 * answers with a redirect to presigned object storage, and that address is
 * checked (absolute, HTTPS, not this machine unless the room API is) and
 * fetched with no credential and no further redirect, so this process's
 * sign-in never leaves the room API. At most `maxBytes` are read.
 *
 * A room refusal (sign-in, membership) is thrown as the API's own error, so
 * the tool can answer it with its next step. Anything else is an
 * `AttachmentDownloadError`: "too_large" or "unavailable".
 */
export async function downloadRoomMessageAttachment(input: {
  roomId: string;
  messageId: string;
  attachmentId: string;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<Uint8Array> {
  if (!ROOM_MESSAGE_ID.test(input.messageId) || !ROOM_ATTACHMENT_ID.test(input.attachmentId)
    || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new AttachmentDownloadError("unavailable");
  }
  const supervised = hasSupervisedWorkerAuthority();
  const exactRoomAuthority = supervised ? getCurrentSupervisedRoomAuthority() : null;
  if (supervised && (!exactRoomAuthority || input.roomId !== exactRoomAuthority)) {
    throw new Error("The daemon-supervised API request is missing its exact per-call room authority.");
  }
  const apiRoomId = supervised ? input.roomId : (await resolveLocalRoomStorageIdentifiers(input.roomId)).cloudRoomId || input.roomId;
  const unavailable = (): never => {
    input.signal.throwIfAborted();
    throw new AttachmentDownloadError("unavailable");
  };
  // The room this agent works from, as every other room request names it.
  const origin = exactRoomAuthority ?? currentWorkerCall()?.room_id ?? getCurrentRoom()?.room_id;
  const room = await apiRequest(
    `/rooms/${encodeRoomIdPath(apiRoomId)}/messages/${input.messageId}/attachments/${input.attachmentId}`,
    { headers: origin ? { [LETAGENTS_ORIGIN_ROOM_ID_HEADER]: origin } : {}, redirect: "manual", signal: input.signal },
  ).catch(unavailable);
  if (!ATTACHMENT_REDIRECT_STATUSES.has(room.status)) {
    const body = await room.text().catch(() => "");
    if (room.status === 401 || room.status === 403) {
      const error = apiErrorFor(room.status, body);
      // A private repo room asks for a sign-in the way every other room read does.
      await maybeHandleRepoRoomAuthRequired(error, apiRoomId);
      throw error;
    }
    // The room's own answer when it has no storage; a proxy's 503 is only unavailable for now.
    if (room.status === 503 && /object storage is not configured/i.test(body)) throw new RoomAttachmentStorageMissingError();
    return unavailable();
  }
  await room.body?.cancel().catch(() => {});
  const apiUrl = getApiUrl();
  const storage = attachmentStorageUrl(room.headers.get("location"), apiUrl);
  if (!isLoopbackApiUrl(apiUrl) && await storageResolvesToThisMachine(storage.hostname, input.signal)) unavailable();
  const response = await fetch(storage, { redirect: "error", signal: input.signal }).catch(unavailable);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    unavailable();
  }
  try {
    return await readBoundedBody(response, input.maxBytes);
  } catch (error) {
    if (error instanceof AttachmentDownloadError) throw error;
    return unavailable();
  }
}
