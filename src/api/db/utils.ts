import crypto from "crypto";
import { inArray, sql } from "drizzle-orm";

import { db } from "./client.js";
import { id_sequences } from "./schema.js";

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

export function isUniqueConstraintError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

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
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(id);
  if (!match) {
    return null;
  }

  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export const AUTH_STATE_TTL_MS = 15 * 60 * 1000;

export async function nextPrefixedId(sequenceName: string, prefix: string): Promise<string> {
  const [next] = await db
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

export function coordinationId(prefix: "tl" | "lock" | "ce"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function reasoningId(prefix: "rs" | "ru"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
