import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "./client.js";
import { reasoning_session_updates, reasoning_sessions } from "./schema.js";
import type { ReasoningSnapshot } from "./schema.js";
import { clampLimit, reasoningId } from "./utils.js";
import { toReasoningSession, toReasoningSessionUpdate } from "./mappers.js";
import type { ReasoningSession, ReasoningSessionRow, ReasoningSessionUpdate, ReasoningSessionUpdateRow, RoomActivityActorCount } from "./types.js";

export async function createReasoningSession(input: {
  room_id: string;
  task_id?: string | null;
  anchor_message_id?: string | null;
  actor_label: string;
  agent_key?: string | null;
  snapshot: ReasoningSnapshot;
}): Promise<{ session: ReasoningSession; update: ReasoningSessionUpdate }> {
  const now = new Date().toISOString();
  const sessionRow: ReasoningSessionRow = {
    id: reasoningId("rs"),
    room_id: input.room_id,
    task_id: input.task_id ?? null,
    anchor_message_id: input.anchor_message_id ?? null,
    actor_label: input.actor_label,
    agent_key: input.agent_key ?? null,
    status: input.snapshot.status ?? null,
    summary: input.snapshot.summary,
    latest_payload: input.snapshot,
    created_at: now,
    updated_at: now,
    closed_at: null,
  };
  const updateRow: ReasoningSessionUpdateRow = {
    id: reasoningId("ru"),
    room_id: input.room_id,
    session_id: sessionRow.id,
    actor_label: input.actor_label,
    status: input.snapshot.status ?? null,
    summary: input.snapshot.summary,
    milestone: input.snapshot.milestone ?? null,
    payload: input.snapshot,
    created_at: now,
  };

  await db.transaction(async (tx) => {
    await tx.insert(reasoning_sessions).values(sessionRow);
    await tx.insert(reasoning_session_updates).values(updateRow);
  });

  return {
    session: toReasoningSession(sessionRow),
    update: toReasoningSessionUpdate(updateRow),
  };
}

export async function getReasoningSessions(
  roomId: string,
  options?: {
    limit?: number;
    open_only?: boolean;
    actor_label?: string | null;
    task_id?: string | null;
  }
): Promise<ReasoningSession[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const conditions = [eq(reasoning_sessions.room_id, roomId)];

  if (options?.open_only) {
    conditions.push(sql`${reasoning_sessions.closed_at} IS NULL`);
  }
  if (options?.actor_label) {
    conditions.push(eq(reasoning_sessions.actor_label, options.actor_label));
  }
  if (options?.task_id) {
    conditions.push(eq(reasoning_sessions.task_id, options.task_id));
  }

  const rows = await db
    .select()
    .from(reasoning_sessions)
    .where(and(...conditions))
    .orderBy(desc(reasoning_sessions.updated_at), desc(reasoning_sessions.created_at))
    .limit(limit);

  return (rows as ReasoningSessionRow[]).map(toReasoningSession);
}

export async function getRoomReasoningSessionCountsByActor(roomId: string): Promise<RoomActivityActorCount[]> {
  const rows = await db
    .select({
      actor_label: reasoning_sessions.actor_label,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(reasoning_sessions)
    .where(eq(reasoning_sessions.room_id, roomId))
    .groupBy(reasoning_sessions.actor_label);

  return rows.map((row) => ({
    actor_label: row.actor_label,
    count: Number(row.count) || 0,
  }));
}

export async function getReasoningSessionById(
  roomId: string,
  sessionId: string
): Promise<ReasoningSession | undefined> {
  const [row] = await db
    .select()
    .from(reasoning_sessions)
    .where(and(eq(reasoning_sessions.room_id, roomId), eq(reasoning_sessions.id, sessionId)))
    .limit(1);

  return row ? toReasoningSession(row as ReasoningSessionRow) : undefined;
}

export async function getReasoningSessionUpdates(
  roomId: string,
  sessionId: string,
  options?: { limit?: number }
): Promise<ReasoningSessionUpdate[]> {
  const limit = clampLimit(options?.limit, 200, 500);
  const rows = await db
    .select()
    .from(reasoning_session_updates)
    .where(
      and(
        eq(reasoning_session_updates.room_id, roomId),
        eq(reasoning_session_updates.session_id, sessionId)
      )
    )
    .orderBy(asc(reasoning_session_updates.created_at), asc(reasoning_session_updates.id))
    .limit(limit);

  return (rows as ReasoningSessionUpdateRow[]).map(toReasoningSessionUpdate);
}

export async function appendReasoningSessionUpdate(input: {
  room_id: string;
  session_id: string;
  actor_label?: string | null;
  snapshot: ReasoningSnapshot;
}): Promise<{ session: ReasoningSession; update: ReasoningSessionUpdate } | null> {
  return db.transaction(async (tx) => {
    const [existingSession] = await tx
      .select()
      .from(reasoning_sessions)
      .where(
        and(
          eq(reasoning_sessions.room_id, input.room_id),
          eq(reasoning_sessions.id, input.session_id)
        )
      )
      .limit(1);

    if (!existingSession) {
      return null;
    }

    const now = new Date().toISOString();
    const mergedPayload: ReasoningSnapshot = {
      ...(existingSession.latest_payload ?? {}),
      ...input.snapshot,
    };
    const nextStatus = Object.prototype.hasOwnProperty.call(input.snapshot, "status")
      ? input.snapshot.status ?? null
      : existingSession.status;
    const updateRow: ReasoningSessionUpdateRow = {
      id: reasoningId("ru"),
      room_id: input.room_id,
      session_id: input.session_id,
      actor_label: input.actor_label ?? existingSession.actor_label,
      status: nextStatus ?? null,
      summary: input.snapshot.summary,
      milestone: input.snapshot.milestone ?? null,
      payload: input.snapshot,
      created_at: now,
    };

    await tx.insert(reasoning_session_updates).values(updateRow);

    const nextSessionRow: ReasoningSessionRow = {
      ...(existingSession as ReasoningSessionRow),
      status: nextStatus ?? null,
      summary: input.snapshot.summary,
      latest_payload: mergedPayload,
      updated_at: now,
      closed_at: existingSession.closed_at,
    };

    await tx
      .update(reasoning_sessions)
      .set({
        status: nextSessionRow.status,
        summary: nextSessionRow.summary,
        latest_payload: nextSessionRow.latest_payload,
        updated_at: nextSessionRow.updated_at,
        closed_at: nextSessionRow.closed_at,
      })
      .where(
        and(
          eq(reasoning_sessions.room_id, input.room_id),
          eq(reasoning_sessions.id, input.session_id)
        )
      );

    return {
      session: toReasoningSession(nextSessionRow),
      update: toReasoningSessionUpdate(updateRow),
    };
  });
}

export async function updateReasoningSession(input: {
  room_id: string;
  session_id: string;
  task_id?: string | null;
  anchor_message_id?: string | null;
  closed_at?: string | null;
}): Promise<ReasoningSession | undefined> {
  const now = new Date().toISOString();
  const patch: Partial<typeof reasoning_sessions.$inferInsert> = {
    updated_at: now,
  };

  if ("task_id" in input) {
    patch.task_id = input.task_id ?? null;
  }
  if ("anchor_message_id" in input) {
    patch.anchor_message_id = input.anchor_message_id ?? null;
  }
  if ("closed_at" in input) {
    patch.closed_at = input.closed_at ?? null;
  }

  const [row] = await db
    .update(reasoning_sessions)
    .set(patch)
    .where(and(eq(reasoning_sessions.room_id, input.room_id), eq(reasoning_sessions.id, input.session_id)))
    .returning();

  return row ? toReasoningSession(row as ReasoningSessionRow) : undefined;
}
