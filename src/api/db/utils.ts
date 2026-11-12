import crypto from "crypto";
import { inArray, sql } from "drizzle-orm";

import { db } from "./client.js";
import { id_sequences } from "./schema.js";
import { parsePositivePgIntegerScopedId } from "../../shared/scoped-ids.js";

export const DEFAULT_LIST_LIMIT = 200;

export const MAX_LIST_LIMIT = 500;

export function clampLimit(requested: number | undefined, defaultVal = DEFAULT_LIST_LIMIT, maxVal = MAX_LIST_LIMIT): number {
  if (requested === undefined || requested === null || Number.isNaN(requested) || requested <= 0) {
    return defaultVal;
  }
  return Math.min(requested, maxVal);
}

export function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const seg2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const seg3 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg1}-${seg2}-${seg3}`;
}

/** The fields of a Postgres error that callers branch on. */
export interface PgErrorFields {
  code: string;
  constraint?: string;
  message?: string;
}

const MAX_ERROR_CAUSE_DEPTH = 5;
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The Postgres error inside `error`. Drizzle 0.45 wraps a database error in a
 * DrizzleQueryError whose own `code` is undefined; the driver's error, with
 * the SQLSTATE `code`, is its `cause`. Looks at the error and up to five
 * causes below it.
 */
export function findPgError(error: unknown): PgErrorFields | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return current as PgErrorFields;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The SQLSTATE of a Postgres error, wrapped or not. */
export function pgErrorCode(error: unknown): string | undefined {
  return findPgError(error)?.code;
}

/** A duplicate key (23505), wrapped by Drizzle or not. */
export function isUniqueConstraintError(error: unknown): boolean {
  return pgErrorCode(error) === "23505";
}

/**
 * The insert was refused because the room id was permanently deleted
 * (trigger rooms_deleted_replay_before_insert, migration 0147: check
 * violation 23514 with this message).
 */
export function isDeletedRoomInsertError(error: unknown): boolean {
  const pg = findPgError(error);
  return pg?.code === "23514" && /This room was permanently deleted/.test(pg.message ?? "");
}

/** A room id that was permanently deleted; routes answer 410 ROOM_DELETED. */
export class RoomDeletedError extends Error {
  readonly status = 410;
  readonly code = "ROOM_DELETED";

  constructor(readonly roomId: string) {
    super("Room was permanently deleted.");
    this.name = "RoomDeletedError";
  }
}

/** How many times a create retries after a collision before it gives up. */
export const MAX_ROOM_CREATE_ATTEMPTS = 5;

export function formatMessageId(number: number): string {
  return `msg_${number}`;
}

export function formatAttachmentId(number: number): string {
  return `att_${number}`;
}

export function formatTaskId(number: number): string {
  return `task_${number}`;
}

export function parseScopedId(id: string, prefix: string): number | null {
  return parsePositivePgIntegerScopedId(id, prefix);
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export const AUTH_STATE_TTL_MS = 15 * 60 * 1000;

export async function nextPrefixedId(
  sequenceName: string,
  prefix: string,
  executor: RoomSequenceExecutor = db
): Promise<string> {
  const [next] = await executor
    .insert(id_sequences)
    .values({ name: sequenceName, value: 1 })
    .onConflictDoUpdate({
      target: id_sequences.name,
      set: {
        value: sql`${id_sequences.value} + 1`,
      },
    })
    .returning({ value: id_sequences.value });

  return `${prefix}_${next.value}`;
}

export type RoomSequenceExecutor = Pick<typeof db, "insert" | "delete" | "select" | "update">;

export async function nextRoomScopedNumber(
  sequenceName: string,
  roomId: string,
  executor: RoomSequenceExecutor = db
): Promise<number> {
  const [next] = await executor
    .insert(id_sequences)
    .values({ name: `${sequenceName}:${roomId}`, value: 1 })
    .onConflictDoUpdate({
      target: id_sequences.name,
      set: {
        value: sql`${id_sequences.value} + 1`,
      },
    })
    .returning({ value: id_sequences.value });

  return next.value;
}

export function getRoomScopedSequenceNames(roomId: string): [string, string] {
  return [`messages:${roomId}`, `tasks:${roomId}`];
}

export function coordinationId(prefix: "tl" | "lock" | "ce" | "bi" | "bm" | "tlra"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function reasoningId(prefix: "rs" | "ru"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
