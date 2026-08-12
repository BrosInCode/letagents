import crypto from "node:crypto";
import { and, asc, eq, gt, lt, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { rental_provider_events } from "../db/schema.js";

export type RentalProviderEventKind =
  | "request.created"
  | "request.cancelled"
  | "session.accepted"
  | "launch.updated";

const RENTAL_PROVIDER_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export async function emitRentalProviderEvent(input: {
  providerAccountId: string;
  sessionId?: string | null;
  kind: RentalProviderEventKind;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(rental_provider_events).values({
      id: `rpevt_${crypto.randomUUID().replaceAll("-", "")}`,
      provider_account_id: input.providerAccountId,
      session_id: input.sessionId ?? null,
      kind: input.kind,
      payload: input.payload ?? {},
      created_at: now,
    });
    await tx.delete(rental_provider_events).where(and(
      eq(rental_provider_events.provider_account_id, input.providerAccountId),
      lt(rental_provider_events.created_at, new Date(now.getTime() - RENTAL_PROVIDER_EVENT_RETENTION_MS)),
    ));
  });
}

export interface RentalProviderEventCursor {
  createdAt: Date;
  id: string;
}

export function encodeRentalProviderEventCursor(cursor: RentalProviderEventCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeRentalProviderEventCursor(value: string | undefined): RentalProviderEventCursor | null {
  if (!value) return null;
  try {
    const [createdAtValue, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const createdAt = new Date(createdAtValue ?? "");
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function listRentalProviderEvents(
  providerAccountId: string,
  cursor: RentalProviderEventCursor | null,
  limit = 100,
) {
  const cursorCondition = cursor
    ? or(
        gt(rental_provider_events.created_at, cursor.createdAt),
        and(
          eq(rental_provider_events.created_at, cursor.createdAt),
          gt(rental_provider_events.id, cursor.id),
        ),
      )
    : undefined;
  const rows = await db
    .select()
    .from(rental_provider_events)
    .where(and(eq(rental_provider_events.provider_account_id, providerAccountId), cursorCondition))
    .orderBy(asc(rental_provider_events.created_at), asc(rental_provider_events.id))
    .limit(Math.max(1, Math.min(250, Math.floor(limit))));
  const last = rows.at(-1);
  return {
    events: rows,
    cursor: last
      ? encodeRentalProviderEventCursor({ createdAt: last.created_at, id: last.id })
      : cursor
        ? encodeRentalProviderEventCursor(cursor)
        : null,
  };
}
