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
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new AttachmentDownloadError("unavailable");
  const unavailable = (): never => {
    input.signal.throwIfAborted();
    throw new AttachmentDownloadError("unavailable");
  };
  const { room } = await roomAttachmentRequest(input, "", { redirect: "manual" });
  if (!ATTACHMENT_REDIRECT_STATUSES.has(room.status)) {
    const body = await room.text().catch(() => "");
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

/**
 * One request to a route under a message attachment in a room
 * (`/rooms/<room>/messages/<msg>/attachments/<att><suffix>`), with the identity
 * and origin room every room request uses. A refusal of the sign-in or the
 * membership is thrown as the API's own error, after a private repo room asks
 * for its sign-in the way every other room read does.
 */
async function roomAttachmentRequest(
  input: { roomId: string; messageId: string; attachmentId: string; signal: AbortSignal },
  suffix: string,
  init: { redirect?: RequestRedirect },
): Promise<{ room: Response }> {
  if (!ROOM_MESSAGE_ID.test(input.messageId) || !ROOM_ATTACHMENT_ID.test(input.attachmentId)) {
    throw new AttachmentDownloadError("unavailable");
  }
  const supervised = hasSupervisedWorkerAuthority();
  const exactRoomAuthority = supervised ? getCurrentSupervisedRoomAuthority() : null;
  if (supervised && (!exactRoomAuthority || input.roomId !== exactRoomAuthority)) {
    throw new Error("The daemon-supervised API request is missing its exact per-call room authority.");
  }
  const apiRoomId = supervised ? input.roomId : (await resolveLocalRoomStorageIdentifiers(input.roomId)).cloudRoomId || input.roomId;
  // The room this agent works from, as every other room request names it.
  const origin = exactRoomAuthority ?? currentWorkerCall()?.room_id ?? getCurrentRoom()?.room_id;
  const room = await apiRequest(
    `/rooms/${encodeRoomIdPath(apiRoomId)}/messages/${input.messageId}/attachments/${input.attachmentId}${suffix}`,
    { headers: origin ? { [LETAGENTS_ORIGIN_ROOM_ID_HEADER]: origin } : {}, ...init, signal: input.signal },
  ).catch((): never => {
    input.signal.throwIfAborted();
    throw new AttachmentDownloadError("unavailable");
  });
  if (room.status === 401 || room.status === 403) {
    const error = apiErrorFor(room.status, await room.text().catch(() => ""));
    await maybeHandleRepoRoomAuthRequired(error, apiRoomId);
    throw error;
  }
  return { room };
}

/** One window of a PDF attachment's text, as the room's text view answers it. */
export interface RoomAttachmentText {
  page_count: number;
  /** Pages the server read; a very long PDF is read only so far. */
  read_pages: number;
  truncated: boolean;
  first_page: number;
  last_page: number;
  next_page?: number;
  has_text: boolean;
  pages: Array<{ page: number; text: string; cut?: boolean }>;
}

/** The room's text view said no: `code` is its reason (PDF_ENCRYPTED, PAGE_OUT_OF_RANGE, ...). */
export class RoomAttachmentTextRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RoomAttachmentTextRefusedError";
  }
}

const TEXT_REFUSAL_CODES = new Set([
  "PDF_ENCRYPTED", "PDF_INVALID", "PDF_TOO_COMPLEX", "PDF_TOO_LARGE", "PDF_BUSY", "PDF_TEXT_UNAVAILABLE",
  "PDF_FETCH_FAILED", "PDF_TEXT_FAILED", "PAGE_OUT_OF_RANGE", "INVALID_PAGE", "NOT_PDF", "ATTACHMENT_NOT_FOUND",
]);

/**
 * The text of a PDF attached to a message, read by the LetAgents server (the
 * room's `/text` view), from `page` on. Room refusals are thrown as the API's
 * own error; the view's own refusals as RoomAttachmentTextRefusedError; a
 * server without the view, or a broken answer, as AttachmentDownloadError.
 */
export async function readRoomMessageAttachmentText(input: {
  roomId: string;
  messageId: string;
  attachmentId: string;
  page: number;
  signal: AbortSignal;
}): Promise<RoomAttachmentText> {
  if (!Number.isSafeInteger(input.page) || input.page < 1) throw new RoomAttachmentTextRefusedError("INVALID_PAGE", "page must be a whole number from 1.");
  const { room } = await roomAttachmentRequest(input, `/text?page=${input.page}`, { redirect: "manual" });
  const body = await room.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A proxy page or a server without the view.
  }
  const answer = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (room.ok) {
    const pages = Array.isArray(answer.pages) ? answer.pages : null;
    const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (pages && pages.length > 0 && whole(answer.page_count) && whole(answer.read_pages) && whole(answer.first_page) && whole(answer.last_page)
      && pages.every((entry) => entry && typeof entry === "object" && whole((entry as { page?: unknown }).page)
        && typeof (entry as { text?: unknown }).text === "string")) {
      return {
        page_count: answer.page_count as number,
        read_pages: answer.read_pages as number,
        truncated: answer.truncated === true,
        first_page: answer.first_page as number,
        last_page: answer.last_page as number,
        ...(whole(answer.next_page) ? { next_page: answer.next_page as number } : {}),
        has_text: answer.has_text === true,
        pages: pages.map((entry) => {
          const row = entry as { page: number; text: string; cut?: unknown };
          return { page: row.page, text: row.text, ...(row.cut === true ? { cut: true } : {}) };
        }),
      };
    }
    throw new AttachmentDownloadError("unavailable");
  }
  if (room.status === 503 && /object storage is not configured/i.test(body)) throw new RoomAttachmentStorageMissingError();
  if (typeof answer.code === "string" && TEXT_REFUSAL_CODES.has(answer.code)) {
    const message = typeof answer.error === "string" ? answer.error.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) : answer.code;
    throw new RoomAttachmentTextRefusedError(answer.code, message);
  }
  input.signal.throwIfAborted();
  throw new AttachmentDownloadError("unavailable");
}
