import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderRoomTurnAttachment, RoomTurnAttachmentOrigin, RoomTurnImageDelivery, RoomTurnImageMimeType } from "./provider-action-port.js";
import type { RoomTurnFileOutcome } from "./prepared-room-context.js";
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
 * The activating message's files come first. Images on a few recent messages
 * before it follow (`recentRoomImageMessages`), within their own smaller
 * limits and never one that the agent's conversation already received.
 * Only png, jpeg, gif and webp reach an agent, decided by the bytes rather
 * than the declared type. Each
 * adapter says how its running provider takes images (`RoomTurnImageDelivery`):
 * Claude Code takes base64 blocks and resizes them itself; Codex resizes a
 * local image before it enters the thread history; an Open Model takes them
 * only when its owner says its model reads images.
 */

export const ROOM_TURN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ROOM_TURN_IMAGES_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/**
 * Images from recent messages share the turn's budget after the activating
 * message's own: at most one full message's worth (the server takes four
 * files per message) and half the turn's bytes. Each is sent once per
 * conversation, so this bounds a single turn.
 */
export const ROOM_TURN_RECENT_IMAGE_LIMIT = 4;
export const ROOM_TURN_RECENT_IMAGES_MAX_BYTES = 10 * 1024 * 1024;
/** Recent-message images described in one prompt, shown or not; the context still lists every file. */
const RECENT_DESCRIBED_LIMIT = 8;
/** The room messages just before the activating one, and the replies of its thread, that are searched for images. */
export const ROOM_TURN_RECENT_MESSAGE_WINDOW = 5;
/** More entries than any server message holds; the rest are not described. */
const DESCRIBED_ATTACHMENT_LIMIT = 10;
/** One deadline for all of a turn's downloads, so a stalled store holds the turn back once, not once per file. */
const PREPARATION_DEADLINE_MS = 60_000;
/** Images of recent messages are extra context: they may hold a turn back this long at most. */
const RECENT_PREPARATION_DEADLINE_MS = 15_000;
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

/** File and sender names are the sender's words; keep them printable and short. */
function printable(value: string | null, limit: number): string {
  // Control, line-breaking, zero-width and direction-changing characters can hide or reorder what a prompt shows.
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .trim().slice(0, limit);
}

function displayFileName(value: string | null, index: number): string {
  return printable(value, 160) || `attachment ${index}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The number of a room message id, or null. */
function messageNumber(value: unknown): number | null {
  const match = typeof value === "string" ? /^msg_([1-9]\d*)$/.exec(value) : null;
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

/** The activating message's attachments, under either field name the server sends. */
export function declaredRoomAttachments(sourceMessage: unknown): DeclaredAttachment[] {
  const message = record(sourceMessage);
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

/** The root of the thread the activating message replies in, or null for a top-level message. */
export function activatingThreadRootId(sourceMessage: unknown, sourceMessageId: string): string | null {
  const rootId = text(record(sourceMessage)?.thread_root_id);
  const root = messageNumber(rootId);
  const source = messageNumber(sourceMessageId);
  return rootId && root !== null && source !== null && root < source ? rootId : null;
}

/** A recent message whose images a turn may carry, in the order they are wanted. */
export type RecentRoomImageMessage = RoomTurnAttachmentOrigin & { message: unknown };

/**
 * The recent messages whose images may follow the activating message's, in
 * the conversation it belongs to: the message it quotes first, then for a
 * thread reply its thread (the root, then its latest earlier replies, newest
 * first), or for a top-level message the top-level messages just before it
 * (newest first). Only messages before the activating one, never this
 * agent's own, each message once.
 */
export function recentRoomImageMessages(input: {
  sourceMessage: unknown;
  sourceMessageId: string;
  /** The room context this turn's prompt shows. */
  context: readonly unknown[];
  /** The activating message's thread as the room returned it, when the context lacks its root. */
  thread?: { root: unknown; replies: readonly unknown[] } | null;
  /** This agent's worker session; its own messages carry nothing it needs to see. */
  agentSessionId: string;
}): RecentRoomImageMessage[] {
  const sourceNumber = messageNumber(input.sourceMessageId);
  if (sourceNumber === null) return [];
  const threadRootId = activatingThreadRootId(input.sourceMessage, input.sourceMessageId);
  const known = new Map<unknown, Record<string, unknown>>();
  for (const value of [...(input.thread ? [input.thread.root, ...input.thread.replies] : []), ...input.context]) {
    const message = record(value);
    const number = messageNumber(message?.id);
    if (message && number !== null && number < sourceNumber && !known.has(message.id)) known.set(message.id, message);
  }
  const messages = [...known.values()];
  const newestFirst = (list: Record<string, unknown>[]) =>
    [...list].sort((left, right) => messageNumber(right.id)! - messageNumber(left.id)!);
  const inThread = (message: Record<string, unknown>) =>
    threadRootId !== null && (message.id === threadRootId || text(message.thread_root_id) === threadRootId);
  const topLevel = (message: Record<string, unknown>) => {
    const root = text(message.thread_root_id);
    return !root || root === message.id;
  };
  // A message the room context lacks is not in the prompt; its note carries the start of its text.
  const inContext = new Set(input.context.map(value => record(value)?.id));
  const quoted = known.get(text(record(record(input.sourceMessage)?.reply_to)?.id));
  const lane = threadRootId
    ? [known.get(threadRootId), ...newestFirst(messages.filter(message => message.id !== threadRootId && inThread(message)))
      .slice(0, ROOM_TURN_RECENT_MESSAGE_WINDOW)]
    : newestFirst(messages.filter(topLevel)).slice(0, ROOM_TURN_RECENT_MESSAGE_WINDOW);
  const seen = new Set<unknown>();
  return [quoted, ...lane].flatMap((message): RecentRoomImageMessage[] => {
    if (!message || seen.has(message.id)) return [];
    seen.add(message.id);
    if (record(message.agent_identity)?.agent_session_id === input.agentSessionId) return [];
    if (!Array.isArray(message.attachments) || !message.attachments.length) return [];
    const preview = inContext.has(message.id) ? "" : printable(text(message.text)?.replace(/\s+/g, " ") ?? null, 120);
    return [{ messageId: String(message.id), sender: printable(text(message.sender), 80) || "unknown sender",
      inThread: inThread(message), ...(preview ? { preview } : {}), message }];
  });
}

/**
 * Of a turn's outcomes, those a provider's conversation keeps. Cursor gets
 * only a path its agent may leave unopened, and the file is removed with the
 * turn: a Cursor image never counts as received.
 */
export function rememberedRoomTurnFiles(provider: string, outcomes: PreparedRoomTurnAttachments["outcomes"]): PreparedRoomTurnAttachments["outcomes"] {
  return outcomes.filter(file => provider !== "cursor" || file.outcome !== "image");
}

/** The key under which a conversation remembers a room file. */
export function roomTurnFileKey(messageId: string, attachmentId: string): string {
  return `${messageId}\n${attachmentId}`;
}

export type PreparedRoomTurnAttachments = {
  attachments: ProviderRoomTurnAttachment[];
  /**
   * The files this turn hands the provider, and those its bytes refused for
   * good, to remember for this conversation once the provider has the turn.
   */
  outcomes: Array<{ messageId: string; attachmentId: string; outcome: RoomTurnFileOutcome }>;
  /** Removes this turn's staged files. Call it once the provider turn has ended. */
  release(): Promise<void>;
  /**
   * The delivery stopped waiting while the native turn may still run and
   * read its files. They are left for the sweep, past the age no turn reads.
   */
  abandon(): void;
};

const NOTHING_PREPARED: PreparedRoomTurnAttachments = { attachments: [], outcomes: [], release: async () => {}, abandon: () => {} };

export class RoomTurnAttachmentStager {
  /** Folders of turns that have not been released. A sweep never removes them. */
  private readonly active = new Set<string>();

  constructor(
    /** A daemon-owned folder, e.g. ~/.letagents/room-turn-attachments. */
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
    private readonly preparationDeadlineMs = PREPARATION_DEADLINE_MS,
    private readonly recentPreparationDeadlineMs = RECENT_PREPARATION_DEADLINE_MS,
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
   * Prepare the activating message's files, then images on recent messages,
   * for one turn. Only an abort of `signal` rejects; every other failure
   * becomes a per-file status.
   */
  async prepare(input: {
    delivery: RoomTurnImageDelivery;
    /** A local room's attachment ids are local upload ids, read from local storage. */
    localRoom: boolean;
    sourceMessage: unknown;
    sourceMessageId: string;
    /** From `recentRoomImageMessages`, in the order their images are wanted. */
    recentMessages?: readonly RecentRoomImageMessage[];
    /**
     * By `roomTurnFileKey`, what earlier turns of this agent's conversation
     * received or had refused for good: those recent files are not sent or
     * fetched again. The activating message's own files always are.
     */
    earlierOutcomes?: ReadonlyMap<string, RoomTurnFileOutcome>;
    roomId: string;
    apiUrl: string;
    bearer: string;
    http: Pick<SupervisedDeliveryHttp, "downloadAttachment">;
    signal: AbortSignal;
  }): Promise<PreparedRoomTurnAttachments> {
    type Candidate = DeclaredAttachment & { messageId: string; origin?: RoomTurnAttachmentOrigin };
    const candidates: Candidate[] = declaredRoomAttachments(input.sourceMessage)
      .map(file => ({ ...file, messageId: input.sourceMessageId }));
    let recentDescribed = 0;
    let earlierDescribed = 0;
    for (const recent of input.recentMessages ?? []) {
      const origin = { messageId: recent.messageId, sender: recent.sender, inThread: recent.inThread,
        ...(recent.preview ? { preview: recent.preview } : {}) };
      for (const file of declaredRoomAttachments(recent.message)) {
        // Only images come from recent messages; their other files stay in the context as metadata.
        if (!DECLARED_IMAGE_TYPES.has(file.mimeType)) continue;
        const earlier = file.id ? input.earlierOutcomes?.get(roomTurnFileKey(recent.messageId, file.id)) : undefined;
        // A refusal for good, or a note that this agent cannot view images, was given once already.
        if (earlier && earlier !== "image") continue;
        // A received image never takes the place of a new one in the notes.
        if (earlier ? earlierDescribed++ >= RECENT_DESCRIBED_LIMIT : recentDescribed++ >= RECENT_DESCRIBED_LIMIT) continue;
        candidates.push({ ...file, messageId: recent.messageId, origin });
      }
    }
    if (!candidates.length) return NOTHING_PREPARED;
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
    let recentSignal: AbortSignal | null = null;
    const attachments: ProviderRoomTurnAttachment[] = [];
    const outcomes: PreparedRoomTurnAttachments["outcomes"] = [];
    let total = 0;
    let recentImages = 0;
    let recentBytes = 0;
    try {
      for (const file of candidates) {
        input.signal.throwIfAborted();
        const recent = Boolean(file.origin);
        const base = { index: file.index, ...(file.origin ? { origin: file.origin } : {}), fileName: file.fileName,
          mimeType: file.mimeType, sizeBytes: file.sizeBytes };
        const status = (value: ProviderRoomTurnAttachment["status"]) => { attachments.push({ ...base, status: value }); };
        if (!DECLARED_IMAGE_TYPES.has(file.mimeType)) { status("not_image"); continue; }
        if (recent && file.id && input.earlierOutcomes?.get(roomTurnFileKey(file.messageId, file.id)) === "image") { status("earlier_turn"); continue; }
        if (!input.delivery) {
          if (file.id) outcomes.push({ messageId: file.messageId, attachmentId: file.id, outcome: "provider_unsupported" });
          status("provider_unsupported");
          continue;
        }
        if (file.sizeBytes !== null && file.sizeBytes > ROOM_TURN_IMAGE_MAX_BYTES) {
          // The room records each file's size, so this refusal is as final as one by the bytes.
          if (file.id) outcomes.push({ messageId: file.messageId, attachmentId: file.id, outcome: "too_large" });
          status("too_large");
          continue;
        }
        if (recent && (recentImages >= ROOM_TURN_RECENT_IMAGE_LIMIT
          || recentBytes + (file.sizeBytes ?? 0) > ROOM_TURN_RECENT_IMAGES_MAX_BYTES)) { status("context_limit"); continue; }
        if (total + (file.sizeBytes ?? 0) > ROOM_TURN_IMAGES_MAX_TOTAL_BYTES) { status("turn_limit"); continue; }
        if (!input.http.downloadAttachment || !file.id || !/^msg_[1-9]\d*$/.test(file.messageId)
          || !(input.localRoom ? LOCAL_ROOM_ATTACHMENT_ID : /^att_[1-9]\d*$/).test(file.id)) { status("unavailable"); continue; }
        const turnRoom = ROOM_TURN_IMAGES_MAX_TOTAL_BYTES - total;
        const recentRoom = recent ? ROOM_TURN_RECENT_IMAGES_MAX_BYTES - recentBytes : Infinity;
        const maxBytes = Math.min(ROOM_TURN_IMAGE_MAX_BYTES, turnRoom, recentRoom);
        // Past the per-image limit, the budget that ran out names the note.
        const overLimit = () => maxBytes === ROOM_TURN_IMAGE_MAX_BYTES ? "too_large" : turnRoom <= recentRoom ? "turn_limit" : "context_limit";
        if (maxBytes < 1) { status(turnRoom <= recentRoom ? "turn_limit" : "context_limit"); continue; }
        downloadSignal ??= AbortSignal.any([input.signal, AbortSignal.timeout(this.preparationDeadlineMs)]);
        // Once recent images have had their time, the rest are not asked for.
        if (recent) recentSignal ??= AbortSignal.any([downloadSignal, AbortSignal.timeout(this.recentPreparationDeadlineMs)]);
        const signal = recent ? recentSignal! : downloadSignal;
        if (signal.aborted) { status("unavailable"); continue; }
        // Only a refusal at the full per-image limit, or by the bytes' own type, is final for this conversation.
        const final = (outcome: "too_large" | "not_image") => { outcomes.push({ messageId: file.messageId, attachmentId: file.id!, outcome }); };
        let bytes: Uint8Array;
        try {
          bytes = await input.http.downloadAttachment({
            roomId: input.roomId, apiUrl: input.apiUrl, bearer: input.bearer,
            messageId: file.messageId, attachmentId: file.id, maxBytes, signal,
          });
        } catch (error) {
          input.signal.throwIfAborted();
          const tooLarge = error instanceof RoomAttachmentDownloadError && error.reason === "too_large";
          if (tooLarge && overLimit() === "too_large") final("too_large");
          status(tooLarge ? overLimit() : "unavailable");
          continue;
        }
        if (bytes.byteLength > maxBytes) {
          if (overLimit() === "too_large") final("too_large");
          status(overLimit());
          continue;
        }
        const mimeType = sniffRoomTurnImageType(bytes);
        if (!mimeType) { final("not_image"); status("not_image"); continue; }
        let image: NonNullable<ProviderRoomTurnAttachment["image"]>;
        if (input.delivery === "memory") image = { mimeType, data: bytes };
        else {
          try {
            folder ??= await this.createTurnFolder();
            // Files of recent messages follow the activating message's in one numbering.
            const path = join(folder, `${attachments.length + 1}.${IMAGE_EXTENSIONS[mimeType]}`);
            await writeExclusive(path, bytes);
            image = { mimeType, path };
          } catch {
            input.signal.throwIfAborted();
            status("unavailable");
            continue;
          }
        }
        total += bytes.byteLength;
        if (recent) { recentImages += 1; recentBytes += bytes.byteLength; }
        attachments.push({ ...base, mimeType, status: "image", image });
        outcomes.push({ messageId: file.messageId, attachmentId: file.id, outcome: "image" });
      }
    } catch (error) {
      await release();
      throw error;
    }
    return { attachments, outcomes, release, abandon };
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
