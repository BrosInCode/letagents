import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderRoomTurnAttachment, RoomTurnImageDelivery, RoomTurnImageMimeType } from "./provider-action-port.js";
import type { SupervisedDeliveryHttp } from "./supervised-agent-delivery.js";

/**
 * Images on the room message that wakes an agent. The daemon alone holds the
 * worker bearer, so it alone downloads them; an adapter receives the bytes in
 * memory or, for a provider whose own process reads a file, a daemon-owned
 * path. Nothing here is persisted with the turn, and no failure here stops
 * the turn: a file that cannot be given becomes a note in the prompt.
 *
 * A local room has no download: the same request reads the file from local
 * room storage in this process, looked up by the message and attachment ids.
 * Its bytes then take the same checks and limits as a hosted image.
 *
 * Only the activating message is read, never history, and only png, jpeg,
 * gif and webp, decided by the bytes rather than the declared type. Each
 * adapter says how its running provider takes images (`RoomTurnImageDelivery`):
 * Claude Code takes base64 blocks and resizes them itself; Codex resizes a
 * local image before it enters the thread history; an Open Model takes them
 * only when its owner says its model reads images.
 */

export const ROOM_TURN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ROOM_TURN_IMAGES_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** More entries than any server message holds; the rest are not described. */
const DESCRIBED_ATTACHMENT_LIMIT = 10;
/** One deadline for all of a turn's downloads, so a stalled store holds the turn back once, not once per file. */
const PREPARATION_DEADLINE_MS = 60_000;
/**
 * A staged file is read when its turn starts, so a folder this old belongs to
 * no running turn. Generous on purpose: a turn whose observation detached
 * leaves its files to this age, and the native turn may still be starting.
 */
export const STAGED_FOLDER_MAX_AGE_MS = 6 * 60 * 60_000;
const STAGED_FOLDER_PREFIX = "turn-";
const DECLARED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
/** A local upload id ("local:<uuid>"), an older row's UUID, or the id of a message imported from a hosted room. */
export const LOCAL_ROOM_ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const IMAGE_EXTENSIONS: Record<RoomTurnImageMimeType, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

/** A download that did not give usable bytes. Its message never holds an address or a credential. */
export class RoomAttachmentDownloadError extends Error {
  constructor(readonly reason: "too_large" | "unavailable") {
    super(reason === "too_large" ? "The attachment is larger than the image limit." : "The attachment could not be downloaded.");
    this.name = "RoomAttachmentDownloadError";
  }
}

/** The image type the bytes show, or null. */
export function sniffRoomTurnImageType(bytes: Uint8Array): RoomTurnImageMimeType | null {
  const startsWith = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (startsWith(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (startsWith(0, 0x52, 0x49, 0x46, 0x46) && startsWith(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

type DeclaredAttachment = { index: number; id: string | null; fileName: string; mimeType: string; sizeBytes: number | null };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** File names are the sender's words; keep them printable and short. */
function displayFileName(value: string | null, index: number): string {
  const name = (value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim().slice(0, 160);
  return name || `attachment ${index}`;
}

/** The activating message's attachments, under either field name the server sends. */
export function declaredRoomAttachments(sourceMessage: unknown): DeclaredAttachment[] {
  const message = sourceMessage && typeof sourceMessage === "object" && !Array.isArray(sourceMessage)
    ? sourceMessage as Record<string, unknown> : null;
  const list = Array.isArray(message?.attachments) ? message.attachments : [];
  return list.slice(0, DESCRIBED_ATTACHMENT_LIMIT).flatMap((value, position): DeclaredAttachment[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const index = position + 1;
    const size = row.byte_size ?? row.size_bytes;
    return [{
      index,
      id: text(row.id),
      fileName: displayFileName(text(row.filename) ?? text(row.file_name) ?? text(row.name), index),
      mimeType: (text(row.content_type) ?? text(row.mime_type) ?? "application/octet-stream").toLowerCase().slice(0, 128),
      sizeBytes: typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null,
    }];
  });
}

export type PreparedRoomTurnAttachments = {
  attachments: ProviderRoomTurnAttachment[];
  /** Removes this turn's staged files. Call it once the provider turn has ended. */
  release(): Promise<void>;
  /**
   * The delivery stopped waiting while the native turn may still run and
   * read its files. They are left for the sweep, past the age no turn reads.
   */
  abandon(): void;
};

const NOTHING_PREPARED: PreparedRoomTurnAttachments = { attachments: [], release: async () => {}, abandon: () => {} };

export class RoomTurnAttachmentStager {
  /** Folders of turns that have not been released. A sweep never removes them. */
  private readonly active = new Set<string>();

  constructor(
    /** A daemon-owned folder, e.g. ~/.letagents/room-turn-attachments. */
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
    private readonly preparationDeadlineMs = PREPARATION_DEADLINE_MS,
  ) {}

  /** Remove staged folders that no running turn can still need. */
  async sweep(): Promise<void> {
    try {
      const root = await lstat(this.root);
      if (!root.isDirectory() || root.isSymbolicLink()) return;
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        const path = join(this.root, entry.name);
        if (this.active.has(path) || !entry.name.startsWith(STAGED_FOLDER_PREFIX)) continue;
        const folder = await lstat(path).catch(() => null);
        if (folder && this.now() - folder.mtimeMs > STAGED_FOLDER_MAX_AGE_MS) await rm(path, { recursive: true, force: true });
      }
    } catch { /* A missing or unreadable root has nothing to sweep. */ }
  }

  /**
   * Prepare the activating message's files for one turn. Only an abort of
   * `signal` rejects; every other failure becomes a per-file status.
   */
  async prepare(input: {
    delivery: RoomTurnImageDelivery;
    /** A local room's attachment ids are local upload ids, read from local storage. */
    localRoom: boolean;
    sourceMessage: unknown;
    sourceMessageId: string;
    roomId: string;
    apiUrl: string;
    bearer: string;
    http: Pick<SupervisedDeliveryHttp, "downloadAttachment">;
    signal: AbortSignal;
  }): Promise<PreparedRoomTurnAttachments> {
    const declared = declaredRoomAttachments(input.sourceMessage);
    if (!declared.length) return NOTHING_PREPARED;
    let folder: string | null = null;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (!folder) return;
      this.active.delete(folder);
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    };
    const abandon = () => {
      if (released) return;
      released = true;
      if (!folder) return;
      this.active.delete(folder);
      setTimeout(() => { void this.sweep(); }, STAGED_FOLDER_MAX_AGE_MS + 60_000).unref();
    };
    let downloadSignal: AbortSignal | null = null;
    const attachments: ProviderRoomTurnAttachment[] = [];
    let total = 0;
    try {
      for (const file of declared) {
        input.signal.throwIfAborted();
        const base = { index: file.index, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes };
        const status = (value: ProviderRoomTurnAttachment["status"]) => { attachments.push({ ...base, status: value }); };
        if (!DECLARED_IMAGE_TYPES.has(file.mimeType)) { status("not_image"); continue; }
        if (!input.delivery) { status("provider_unsupported"); continue; }
        if (file.sizeBytes !== null && file.sizeBytes > ROOM_TURN_IMAGE_MAX_BYTES) { status("too_large"); continue; }
        if (total + (file.sizeBytes ?? 0) > ROOM_TURN_IMAGES_MAX_TOTAL_BYTES) { status("turn_limit"); continue; }
        if (!input.http.downloadAttachment || !file.id || !/^msg_[1-9]\d*$/.test(input.sourceMessageId)
          || !(input.localRoom ? LOCAL_ROOM_ATTACHMENT_ID : /^att_[1-9]\d*$/).test(file.id)) { status("unavailable"); continue; }
        const maxBytes = Math.min(ROOM_TURN_IMAGE_MAX_BYTES, ROOM_TURN_IMAGES_MAX_TOTAL_BYTES - total);
        if (maxBytes < 1) { status("turn_limit"); continue; }
        let bytes: Uint8Array;
        try {
          bytes = await input.http.downloadAttachment({
            roomId: input.roomId, apiUrl: input.apiUrl, bearer: input.bearer,
            messageId: input.sourceMessageId, attachmentId: file.id, maxBytes,
            signal: downloadSignal ??= AbortSignal.any([input.signal, AbortSignal.timeout(this.preparationDeadlineMs)]),
          });
        } catch (error) {
          input.signal.throwIfAborted();
          const tooLarge = error instanceof RoomAttachmentDownloadError && error.reason === "too_large";
          status(!tooLarge ? "unavailable" : maxBytes < ROOM_TURN_IMAGE_MAX_BYTES ? "turn_limit" : "too_large");
          continue;
        }
        if (bytes.byteLength > maxBytes) { status(maxBytes < ROOM_TURN_IMAGE_MAX_BYTES ? "turn_limit" : "too_large"); continue; }
        const mimeType = sniffRoomTurnImageType(bytes);
        if (!mimeType) { status("not_image"); continue; }
        total += bytes.byteLength;
        if (input.delivery === "memory") {
          attachments.push({ ...base, mimeType, status: "image", image: { mimeType, data: bytes } });
          continue;
        }
        try {
          folder ??= await this.createTurnFolder();
          const path = join(folder, `${file.index}.${IMAGE_EXTENSIONS[mimeType]}`);
          await writeExclusive(path, bytes);
          attachments.push({ ...base, mimeType, status: "image", image: { mimeType, path } });
        } catch {
          input.signal.throwIfAborted();
          status("unavailable");
        }
      }
    } catch (error) {
      await release();
      throw error;
    }
    return { attachments, release, abandon };
  }

  private async createTurnFolder(): Promise<string> {
    await this.sweep();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("The staged attachment folder is not a plain folder.");
    if (typeof process.getuid === "function" && root.uid !== process.getuid()) throw new Error("The staged attachment folder belongs to another user.");
    if ((root.mode & 0o077) !== 0) await chmod(this.root, 0o700);
    const folder = await mkdtemp(join(this.root, STAGED_FOLDER_PREFIX));
    this.active.add(folder);
    return folder;
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}
