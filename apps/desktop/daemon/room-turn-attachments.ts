import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createPrivateDir, isOwnedByCurrentUser, isOwnerPrivate, openNoFollow, ownerPrivatePlatform, privateEntryCreated, protectOwnerPrivate } from "../../../shared/owner-private-fs.mjs";
import { renameWithRetryAsync } from "../../../shared/rename-retry.mjs";

import type { ProviderRoomTurnAttachment, RoomTurnAttachmentOrigin, RoomTurnFileAccess, RoomTurnImageDelivery, RoomTurnImageMimeType } from "./provider-action-port.js";
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

/**
 * Files that are not images reach an agent as a daemon-owned copy it opens
 * with its own tools, never as bytes in its prompt. Only text files and PDFs,
 * by name or declared type; the bytes then decide which of the two it is.
 */
export const ROOM_TURN_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const ROOM_TURN_FILES_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ROOM_TURN_RECENT_FILE_LIMIT = 4;
export const ROOM_TURN_RECENT_FILES_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set(["txt", "log", "md", "markdown", "json", "jsonl", "ndjson", "csv", "tsv", "yaml", "yml", "xml", "diff", "patch"]);
const FILE_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv", "text/tab-separated-values", "application/json",
  "application/x-ndjson", "application/jsonl", "application/xml", "text/xml", "application/yaml", "application/x-yaml", "text/yaml",
  "text/x-yaml", "text/x-diff", "text/x-patch", "application/pdf"]);
/** A file kept for a recent message is reused this long after its last turn, so a thread's log is downloaded once. */
export const FILE_CACHE_MAX_AGE_MS = 6 * 60 * 60_000;
const FILE_CACHE_FOLDER = "file-cache";
const SWEEP_INTERVAL_MS = 10 * 60_000;
/** The server's own pattern for a declared type; anything else is not trusted as a type. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** A download that did not give usable bytes. Its message never holds an address or a credential. */
export class RoomAttachmentDownloadError extends Error {
  constructor(readonly reason: "too_large" | "unavailable") {
    super(reason === "too_large" ? "The attachment is larger than the limit." : "The attachment could not be downloaded.");
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

/** A declared type the server's pattern accepts; a local room keeps whatever its sender wrote. */
function declaredType(value: string | null): string {
  const type = (value ?? "").toLowerCase().split(";")[0]!.trim().slice(0, 128);
  return MIME_TYPE.test(type) ? type : "application/octet-stream";
}

function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match ? match[1]!.toLowerCase() : "";
}

/** A file that may reach an agent: an image, a text file or PDF by name or declared type, or neither. */
function candidateKind(file: { fileName: string; mimeType: string }): "image" | "file" | "other" {
  if (DECLARED_IMAGE_TYPES.has(file.mimeType)) return "image";
  const extension = extensionOf(file.fileName);
  return TEXT_FILE_EXTENSIONS.has(extension) || extension === "pdf" || FILE_TYPES.has(file.mimeType) ? "file" : "other";
}

function declaresPdf(file: { fileName: string; mimeType: string }): boolean {
  return extensionOf(file.fileName) === "pdf" || file.mimeType === "application/pdf";
}

/** What a file's bytes are. A NUL byte means binary, as Git decides; text need not be valid UTF-8. */
export function detectRoomTurnFile(bytes: Uint8Array):
  | { kind: "empty" } | { kind: "binary" } | { kind: "pdf" }
  | { kind: "text"; bytes: Uint8Array; encoding: "utf-8" | "utf-16" | "unknown"; lines: number; longestLine: number } {
  if (!bytes.byteLength) return { kind: "empty" };
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return { kind: "pdf" };
  let text = bytes;
  let encoding: "utf-8" | "utf-16" | "unknown" = "utf-8";
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
  if (utf16) {
    let decoded: string;
    try { decoded = new TextDecoder(utf16, { fatal: true }).decode(bytes); } catch { return { kind: "binary" }; }
    if (decoded.includes("\u0000")) return { kind: "binary" };
    text = new TextEncoder().encode(decoded);
    encoding = "utf-16";
  } else {
    if (bytes.includes(0)) return { kind: "binary" };
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { encoding = "unknown"; }
  }
  let lines = 0;
  let longestLine = 0;
  let start = 0;
  for (let index = 0; index <= text.byteLength; index++) {
    if (index === text.byteLength ? index > start : text[index] === 0x0a) {
      lines += 1;
      longestLine = Math.max(longestLine, index - start);
      start = index + 1;
    }
  }
  return { kind: "text", bytes: text, encoding, lines, longestLine };
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
      mimeType: declaredType(text(row.content_type) ?? text(row.mime_type)),
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
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    /** A daemon-owned folder, e.g. ~/.letagents/room-turn-attachments. */
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
    private readonly preparationDeadlineMs = PREPARATION_DEADLINE_MS,
    private readonly recentPreparationDeadlineMs = RECENT_PREPARATION_DEADLINE_MS,
  ) {}

  /** Remove staged folders that no running turn can still need, and kept files no turn has used for a while. */
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
      const cache = join(this.root, FILE_CACHE_FOLDER);
      const folder = await lstat(cache).catch(() => null);
      if (!folder?.isDirectory() || folder.isSymbolicLink()) return;
      for (const entry of await readdir(cache, { withFileTypes: true })) {
        const path = join(cache, entry.name);
        const file = await lstat(path).catch(() => null);
        if (file && this.now() - file.mtimeMs > FILE_CACHE_MAX_AGE_MS) await rm(path, { recursive: true, force: true });
      }
    } catch { /* A missing or unreadable root has nothing to sweep. */ }
  }

  /**
   * Prepare the activating message's files, then files on recent messages,
   * for one turn. Images go first, so a slow file never spends their time.
   * Only an abort of `signal` rejects; every other failure becomes a
   * per-file status.
   */
  async prepare(input: {
    delivery: RoomTurnImageDelivery;
    /** Which staged files the agent can open; absent or null means it gets none. */
    fileAccess?: RoomTurnFileAccess;
    /** A local room's attachment ids are local upload ids, read from local storage. */
    localRoom: boolean;
    sourceMessage: unknown;
    sourceMessageId: string;
    /** From `recentRoomImageMessages`, in the order their files are wanted. */
    recentMessages?: readonly RecentRoomImageMessage[];
    /**
     * By `roomTurnFileKey`, what earlier turns of this agent's conversation
     * received or had refused for good: those recent images are not sent or
     * fetched again. The activating message's own files always are.
     */
    earlierOutcomes?: ReadonlyMap<string, RoomTurnFileOutcome>;
    roomId: string;
    apiUrl: string;
    bearer: string;
    http: Pick<SupervisedDeliveryHttp, "downloadAttachment">;
    signal: AbortSignal;
  }): Promise<PreparedRoomTurnAttachments> {
    type Candidate = DeclaredAttachment & { messageId: string; origin?: RoomTurnAttachmentOrigin; kind: "image" | "file" | "other"; order: number };
    const candidates: Candidate[] = declaredRoomAttachments(input.sourceMessage)
      .map((file, order) => ({ ...file, messageId: input.sourceMessageId, kind: candidateKind(file), order }));
    const described = { image: 0, earlierImage: 0, file: 0, earlierFile: 0 };
    for (const recent of input.recentMessages ?? []) {
      const origin = { messageId: recent.messageId, sender: recent.sender, inThread: recent.inThread,
        ...(recent.preview ? { preview: recent.preview } : {}) };
      for (const file of declaredRoomAttachments(recent.message)) {
        // Other files of a recent message stay in the context as metadata.
        const kind = candidateKind(file);
        if (kind === "other") continue;
        const earlier = file.id ? input.earlierOutcomes?.get(roomTurnFileKey(recent.messageId, file.id)) : undefined;
        // A refusal for good, or a note that this agent cannot open it, was given once already.
        if (earlier && earlier !== "image" && earlier !== "file") continue;
        // A file or image given before never takes the place of a new one in the notes.
        const slot = kind === "file" ? (earlier === "file" ? "earlierFile" : "file") : earlier === "image" ? "earlierImage" : "image";
        if (described[slot]++ >= RECENT_DESCRIBED_LIMIT) continue;
        candidates.push({ ...file, messageId: recent.messageId, origin, kind, order: candidates.length });
      }
    }
    if (!candidates.length) return NOTHING_PREPARED;
    // Old turn folders and kept files go at most this often, also for a turn that stages nothing (images in memory).
    if (this.now() - this.lastSweep > SWEEP_INTERVAL_MS) { this.lastSweep = this.now(); void this.sweep(); }
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
    // Recent images and recent files each have their own time, started at their first download.
    const recentSignals: { image: AbortSignal | null; file: AbortSignal | null } = { image: null, file: null };
    const results: Array<{ order: number; attachment: ProviderRoomTurnAttachment }> = [];
    const outcomes: PreparedRoomTurnAttachments["outcomes"] = [];
    let staged = 0;
    const budgets = {
      // Downloads count what is fetched; `staged` and `recentStaged` count the copies, which a UTF-16 text can outgrow.
      image: { total: 0, staged: 0, recentCount: 0, recentBytes: 0, recentStaged: 0, max: ROOM_TURN_IMAGE_MAX_BYTES,
        turn: ROOM_TURN_IMAGES_MAX_TOTAL_BYTES, recentLimit: ROOM_TURN_RECENT_IMAGE_LIMIT, recentMax: ROOM_TURN_RECENT_IMAGES_MAX_BYTES },
      file: { total: 0, staged: 0, recentCount: 0, recentBytes: 0, recentStaged: 0, max: ROOM_TURN_FILE_MAX_BYTES,
        turn: ROOM_TURN_FILES_MAX_TOTAL_BYTES, recentLimit: ROOM_TURN_RECENT_FILE_LIMIT, recentMax: ROOM_TURN_RECENT_FILES_MAX_BYTES },
    };
    const stage = async (name: string, bytes: Uint8Array): Promise<string> => {
      folder ??= await this.createTurnFolder();
      // Files of recent messages follow the activating message's in one numbering, so names never collide.
      const path = join(folder, `${++staged}.${name}`);
      await writeExclusive(path, bytes);
      return path;
    };
    try {
      // Images first; then files, a file given before last, so it never spends a new one's limits.
      const repeated = (file: Candidate) => Boolean(file.origin && file.id
        && input.earlierOutcomes?.get(roomTurnFileKey(file.messageId, file.id)) === "file");
      const ordered = [...candidates.filter(file => file.kind === "image"),
        ...candidates.filter(file => file.kind !== "image" && !repeated(file)), ...candidates.filter(file => file.kind !== "image" && repeated(file))];
      for (const file of ordered) {
        input.signal.throwIfAborted();
        const recent = Boolean(file.origin);
        const isFile = file.kind !== "image";
        const base = { index: file.index, ...(file.origin ? { origin: file.origin } : {}), fileName: file.fileName,
          mimeType: file.mimeType, sizeBytes: file.sizeBytes, ...(isFile ? { category: "file" as const } : {}) };
        const status = (value: ProviderRoomTurnAttachment["status"]) => { results.push({ order: file.order, attachment: { ...base, status: value } }); };
        // Only a refusal at the full per-file limit, by the bytes, or by what this agent can open is final for this conversation.
        const final = (outcome: RoomTurnFileOutcome) => { if (file.id) outcomes.push({ messageId: file.messageId, attachmentId: file.id, outcome }); };
        if (file.kind === "other") { status("unsupported_type"); continue; }
        const earlier = recent && file.id ? input.earlierOutcomes?.get(roomTurnFileKey(file.messageId, file.id)) : undefined;
        if (earlier === "image") { status("earlier_turn"); continue; }
        if (!isFile && !input.delivery) { final("provider_unsupported"); status("provider_unsupported"); continue; }
        if (isFile && !input.fileAccess) { final("cannot_read"); status("cannot_read"); continue; }
        if (isFile && declaresPdf(file) && !input.fileAccess!.pdf) { final("cannot_read"); status("cannot_read_pdf"); continue; }
        const budget = budgets[isFile ? "file" : "image"];
        if (file.sizeBytes !== null && file.sizeBytes > budget.max) {
          // The room records each file's size, so this refusal is as final as one by the bytes.
          final(isFile ? "file_too_large" : "too_large");
          status("too_large");
          continue;
        }
        if (recent && (budget.recentCount >= budget.recentLimit
          || budget.recentBytes + (file.sizeBytes ?? 0) > budget.recentMax)) { status("context_limit"); continue; }
        if (budget.total + (file.sizeBytes ?? 0) > budget.turn) { status("turn_limit"); continue; }
        if (!input.http.downloadAttachment || !file.id || !/^msg_[1-9]\d*$/.test(file.messageId)
          || !(input.localRoom ? LOCAL_ROOM_ATTACHMENT_ID : /^att_[1-9]\d*$/).test(file.id)) { status("unavailable"); continue; }
        const turnRoom = budget.turn - budget.total;
        const recentRoom = recent ? budget.recentMax - budget.recentBytes : Infinity;
        const maxBytes = Math.min(budget.max, turnRoom, recentRoom);
        // Past the per-file limit, the budget that ran out names the note.
        const overLimit = () => maxBytes === budget.max ? "too_large" : turnRoom <= recentRoom ? "turn_limit" : "context_limit";
        const refuseOverLimit = () => {
          const reason = overLimit();
          if (reason === "too_large") final(isFile ? "file_too_large" : "too_large");
          status(reason);
        };
        if (maxBytes < 1) { status(turnRoom <= recentRoom ? "turn_limit" : "context_limit"); continue; }
        const cacheKey = isFile ? fileCacheKey(input.apiUrl, input.roomId, file.messageId, file.id) : null;
        const kept = cacheKey ? await this.cachedFile(cacheKey, maxBytes) : null;
        if (kept === "too_large") { refuseOverLimit(); continue; }
        let bytes = kept;
        if (!bytes) {
          downloadSignal ??= AbortSignal.any([input.signal, AbortSignal.timeout(this.preparationDeadlineMs)]);
          // Once recent files of a kind have had their time, the rest are not asked for.
          const kind = isFile ? "file" : "image";
          if (recent) recentSignals[kind] ??= AbortSignal.any([downloadSignal, AbortSignal.timeout(this.recentPreparationDeadlineMs)]);
          const signal = recent ? recentSignals[kind]! : downloadSignal;
          if (signal.aborted) { status("unavailable"); continue; }
          try {
            bytes = await input.http.downloadAttachment({
              roomId: input.roomId, apiUrl: input.apiUrl, bearer: input.bearer,
              messageId: file.messageId, attachmentId: file.id, maxBytes, signal,
            });
          } catch (error) {
            input.signal.throwIfAborted();
            if (error instanceof RoomAttachmentDownloadError && error.reason === "too_large") refuseOverLimit();
            else status("unavailable");
            continue;
          }
          if (bytes.byteLength > maxBytes) { refuseOverLimit(); continue; }
          if (cacheKey) await this.cacheFile(cacheKey, bytes);
        }
        if (!isFile) {
          const mimeType = sniffRoomTurnImageType(bytes);
          if (!mimeType) { final("not_image"); status("not_image"); continue; }
          let image: NonNullable<ProviderRoomTurnAttachment["image"]>;
          if (input.delivery === "memory") image = { mimeType, data: bytes };
          else {
            try { image = { mimeType, path: await stage(IMAGE_EXTENSIONS[mimeType], bytes) }; } catch {
              input.signal.throwIfAborted();
              status("unavailable");
              continue;
            }
          }
          budget.total += bytes.byteLength;
          if (recent) { budget.recentCount += 1; budget.recentBytes += bytes.byteLength; }
          results.push({ order: file.order, attachment: { ...base, mimeType, status: "image", image } });
          outcomes.push({ messageId: file.messageId, attachmentId: file.id, outcome: "image" });
          continue;
        }
        const detected = detectRoomTurnFile(bytes);
        if (detected.kind === "empty") { final("empty"); status("empty"); continue; }
        if (detected.kind === "binary") { final("binary"); status("binary"); continue; }
        if (detected.kind === "pdf" && !input.fileAccess!.pdf) { final("cannot_read"); status("cannot_read_pdf"); continue; }
        const extension = extensionOf(file.fileName);
        // A converted text can be longer than the bytes it came from: the copy keeps within the limits too.
        const copy = detected.kind === "text" ? detected.bytes : bytes;
        if (copy.byteLength > budget.max) { final("file_too_large"); status("too_large"); continue; }
        if (budget.staged + copy.byteLength > budget.turn) { status("turn_limit"); continue; }
        if (recent && budget.recentStaged + copy.byteLength > budget.recentMax) { status("context_limit"); continue; }
        let path: string;
        try {
          path = await stage(detected.kind === "pdf" ? "pdf" : TEXT_FILE_EXTENSIONS.has(extension) ? extension : "txt", copy);
        } catch {
          input.signal.throwIfAborted();
          status("unavailable");
          continue;
        }
        budget.total += bytes.byteLength;
        budget.staged += copy.byteLength;
        if (recent) { budget.recentCount += 1; budget.recentBytes += bytes.byteLength; budget.recentStaged += copy.byteLength; }
        results.push({ order: file.order, attachment: { ...base, mimeType: detected.kind === "pdf" ? "application/pdf" : file.mimeType,
          status: "file", file: detected.kind === "pdf" ? { path, kind: "pdf", ...(earlier === "file" ? { repeated: true } : {}) }
            : { path, kind: "text", encoding: detected.encoding, lines: detected.lines, longestLine: detected.longestLine,
              ...(earlier === "file" ? { repeated: true } : {}) } } });
        outcomes.push({ messageId: file.messageId, attachmentId: file.id, outcome: "file" });
      }
    } catch (error) {
      await release();
      throw error;
    }
    return { attachments: results.sort((left, right) => left.order - right.order).map(result => result.attachment), outcomes, release, abandon };
  }

  /** A file kept for an earlier turn, if it is still a plain file of this user's within the limit. */
  private async cachedFile(key: string, maxBytes: number): Promise<Uint8Array | "too_large" | null> {
    const cache = join(this.root, FILE_CACHE_FOLDER);
    try {
      // The folders on the way must be this user's own plain folders, not links to somewhere else.
      // Windows reads a file's permissions by path, so the folders must also be private (no swap during the read).
      const folderIsSafe = ownerPrivatePlatform() === "win32" ? isPrivateFolder : isOwnedFolder;
      if (!await folderIsSafe(this.root) || !await folderIsSafe(cache)) return null;
      const handle = await openNoFollow(join(cache, key), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !await isOwnedByCurrentUser(join(cache, key), stat)) return null;
        // The kept copy is the file itself: one over the space left needs no new download to be refused.
        if (stat.size > maxBytes) return "too_large";
        const bytes = new Uint8Array(await handle.readFile());
        const now = new Date(this.now());
        await handle.utimes(now, now).catch(() => {});
        return bytes.byteLength <= maxBytes ? bytes : null;
      } finally { await handle.close(); }
    } catch { return null; }
  }

  /** Keep a downloaded file for later turns; a cache that cannot be written only costs a download. */
  private async cacheFile(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.ownedFolder(this.root);
      const cache = await this.ownedFolder(join(this.root, FILE_CACHE_FOLDER));
      const temporary = join(cache, `${key}.${randomUUID()}.tmp`);
      await writeExclusive(temporary, bytes);
      await renameWithRetryAsync(temporary, join(cache, key)).catch(async () => { await rm(temporary, { force: true }); });
    } catch { /* Optional. */ }
  }

  private async createTurnFolder(): Promise<string> {
    await this.ownedFolder(this.root);
    const folder = await mkdtemp(join(this.root, STAGED_FOLDER_PREFIX));
    this.active.add(folder);
    // POSIX mkdtemp makes it 0700; Windows gives it the private DACL.
    await privateEntryCreated(folder, "directory");
    return folder;
  }

  /** A plain 0700 folder of this user's, made if missing; a link or another user's folder is refused. */
  private async ownedFolder(path: string): Promise<string> {
    await createPrivateDir(path, { recursive: true });
    const folder = await lstat(path);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("The staged attachment folder is not a plain folder.");
    if (!await isOwnedByCurrentUser(path, folder)) throw new Error("The staged attachment folder belongs to another user.");
    if (!await isOwnerPrivate(path, folder)) await protectOwnerPrivate(path, "directory", { force: true });
    return path;
  }
}

/** One server's room, message and attachment: two servers can use the same ids. */
function fileCacheKey(apiUrl: string, roomId: string, messageId: string, attachmentId: string): string {
  let origin = apiUrl;
  try { origin = new URL(apiUrl).origin; } catch { /* A local room's address is already one name. */ }
  return createHash("sha256").update(`${origin}\n${roomId}\n${messageId}\n${attachmentId}`).digest("hex");
}

async function isOwnedFolder(path: string): Promise<boolean> {
  const folder = await lstat(path).catch(() => null);
  return Boolean(folder?.isDirectory() && !folder.isSymbolicLink() && await isOwnedByCurrentUser(path, folder));
}

async function isPrivateFolder(path: string): Promise<boolean> {
  const folder = await lstat(path).catch(() => null);
  return Boolean(folder?.isDirectory() && !folder.isSymbolicLink() && await isOwnerPrivate(path, folder));
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await privateEntryCreated(path, "file");
    await handle.writeFile(bytes);
  } finally { await handle.close(); }
}
