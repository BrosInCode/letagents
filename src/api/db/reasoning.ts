import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import type { RoomLiveSnapshot } from "../../../shared/agent-live-trace.mjs";

import { db } from "./client.js";
import { reasoning_session_updates, reasoning_sessions, room_agent_sessions } from "./schema.js";
import type { ReasoningSessionKind, ReasoningSnapshot } from "./schema.js";
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
    kind: "reasoning",
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
    /** Reasoning sessions unless asked otherwise: a live session is never a reasoning one. */
    kind?: ReasoningSessionKind;
  }
): Promise<ReasoningSession[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const conditions = [eq(reasoning_sessions.room_id, roomId), eq(reasoning_sessions.kind, options?.kind ?? "reasoning")];

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
    .where(and(eq(reasoning_sessions.room_id, roomId), eq(reasoning_sessions.kind, "reasoning")))
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
          eq(reasoning_sessions.id, input.session_id),
          // A live session changes only through its own snapshots.
          eq(reasoning_sessions.kind, "reasoning")
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
    .where(and(
      eq(reasoning_sessions.room_id, input.room_id),
      eq(reasoning_sessions.id, input.session_id),
      eq(reasoning_sessions.kind, "reasoning"),
    ))
    .returning();

  return row ? toReasoningSession(row as ReasoningSessionRow) : undefined;
}

/**
 * Update rows kept per live session (one agent turn). Later snapshots still
 * replace the session's latest payload; they add no row.
 */
export const LIVE_ACTIVITY_UPDATE_ROWS_PER_SESSION = 120;

/** The snapshot of a live session: its line, its status, and what the room may see of the turn. */
export type LiveActivitySnapshot = ReasoningSnapshot & { live: RoomLiveSnapshot };

/** An update row keeps only the line and the status; the turn's entries live on the session alone. */
function liveUpdatePayload(snapshot: LiveActivitySnapshot): ReasoningSnapshot {
  return { summary: snapshot.summary, status: snapshot.status ?? null };
}

type Transaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The worker session that tried to share a turn has ended. */
export class LiveActivityWorkerEndedError extends Error {
  constructor() {
    super("The worker session has ended.");
  }
}

/** Serializes every start and removal of one agent's live sessions in a room. */
async function lockLiveActivityTx(tx: Transaction, input: { room_id: string; agent_key: string }): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["live_activity", input.room_id, input.agent_key])}, 0))`);
}

async function deleteLiveActivitySessionsTx(
  tx: Transaction | typeof db,
  input: { room_id: string; agent_key: string },
): Promise<string[]> {
  const rows = await tx
    .delete(reasoning_sessions)
    .where(and(
      eq(reasoning_sessions.room_id, input.room_id),
      eq(reasoning_sessions.agent_key, input.agent_key),
      eq(reasoning_sessions.kind, "live"),
    ))
    .returning({ id: reasoning_sessions.id });
  return rows.map((row) => row.id);
}

/**
 * Start the live session of an agent's turn. The agent's earlier live
 * sessions in the room are removed in the same transaction, so a room holds
 * at most one per agent: the turn other members may see. Throws
 * LiveActivityWorkerEndedError when the worker session has ended.
 */
export async function createLiveActivitySession(input: {
  room_id: string;
  actor_label: string;
  agent_key: string;
  /** The agent's worker session that shares the turn. */
  agent_session_id: string;
  snapshot: LiveActivitySnapshot;
}): Promise<{ session: ReasoningSession; update: ReasoningSessionUpdate; removed_session_ids: string[] }> {
  const now = new Date().toISOString();
  const sessionRow: ReasoningSessionRow = {
    id: reasoningId("rs"),
    room_id: input.room_id,
    task_id: null,
    anchor_message_id: input.snapshot.live.request_message_id,
    actor_label: input.actor_label,
    agent_key: input.agent_key,
    kind: "live",
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
    milestone: null,
    payload: liveUpdatePayload(input.snapshot),
    created_at: now,
  };
  const removed = await db.transaction(async (tx) => {
    // Two starts of the same agent's turn never both survive: the second waits and replaces the first.
    await lockLiveActivityTx(tx, input);
    // A start that was in flight when the worker session ended does not
    // bring the turn back: the end removed it under the same lock.
    const [worker] = await tx
      .select({ session_id: room_agent_sessions.session_id })
      .from(room_agent_sessions)
      .where(and(
        eq(room_agent_sessions.session_id, input.agent_session_id),
        eq(room_agent_sessions.room_id, input.room_id),
        eq(room_agent_sessions.agent_key, input.agent_key),
        isNull(room_agent_sessions.ended_at),
      ))
      .limit(1);
    if (!worker) throw new LiveActivityWorkerEndedError();
    const earlier = await deleteLiveActivitySessionsTx(tx, input);
    await tx.insert(reasoning_sessions).values(sessionRow);
    await tx.insert(reasoning_session_updates).values(updateRow);
    return earlier;
  });
  return {
    session: toReasoningSession(sessionRow),
    update: toReasoningSessionUpdate(updateRow),
    removed_session_ids: removed,
  };
}

/**
 * Store the newest snapshot of the agent's own live session. Null when the
 * session is gone (removed by the agent's owner, a newer turn, or retention)
 * or is not this agent's live session. `update` is null once the session has
 * its quota of update rows.
 */
export async function updateLiveActivitySession(input: {
  room_id: string;
  session_id: string;
  agent_key: string;
  snapshot: LiveActivitySnapshot;
}): Promise<{ session: ReasoningSession; update: ReasoningSessionUpdate | null } | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(reasoning_sessions)
      .where(and(
        eq(reasoning_sessions.room_id, input.room_id),
        eq(reasoning_sessions.id, input.session_id),
        eq(reasoning_sessions.kind, "live"),
        eq(reasoning_sessions.agent_key, input.agent_key),
      ))
      .for("update")
      .limit(1);
    if (!existing) return null;
    const now = new Date().toISOString();
    const [{ count }] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(reasoning_session_updates)
      .where(eq(reasoning_session_updates.session_id, input.session_id));
    let updateRow: ReasoningSessionUpdateRow | null = null;
    if (Number(count) < LIVE_ACTIVITY_UPDATE_ROWS_PER_SESSION) {
      updateRow = {
        id: reasoningId("ru"),
        room_id: input.room_id,
        session_id: input.session_id,
        actor_label: existing.actor_label,
        status: input.snapshot.status ?? null,
        summary: input.snapshot.summary,
        milestone: null,
        payload: liveUpdatePayload(input.snapshot),
        created_at: now,
      };
      await tx.insert(reasoning_session_updates).values(updateRow);
    }
    const nextRow: ReasoningSessionRow = {
      ...(existing as ReasoningSessionRow),
      anchor_message_id: input.snapshot.live.request_message_id,
      status: input.snapshot.status ?? null,
      summary: input.snapshot.summary,
      latest_payload: input.snapshot,
      updated_at: now,
    };
    await tx
      .update(reasoning_sessions)
      .set({
        anchor_message_id: nextRow.anchor_message_id,
        status: nextRow.status,
        summary: nextRow.summary,
        latest_payload: nextRow.latest_payload,
        updated_at: nextRow.updated_at,
      })
      .where(eq(reasoning_sessions.id, input.session_id));
    return { session: toReasoningSession(nextRow), update: updateRow ? toReasoningSessionUpdate(updateRow) : null };
  });
}

/** Remove every live session of one agent in a room, with its update rows. Returns the removed ids. */
export async function deleteLiveActivitySessions(input: { room_id: string; agent_key: string }): Promise<string[]> {
  return deleteLiveActivitySessionsTx(db, input);
}

/**
 * Remove the agent's live sessions in a room once no worker session of the
 * agent is live there, so the room stops showing a turn nobody will update.
 * Runs in the transaction that ends a worker session. Returns the removed
 * ids, for the room to be told after the commit.
 */
export async function deleteLiveActivityOfDepartedAgentTx(
  tx: Transaction,
  input: { room_id: string; agent_key: string },
): Promise<string[]> {
  // Under the lock, a concurrent end of the agent's other session sees this one's end.
  await lockLiveActivityTx(tx, input);
  const [liveWorker] = await tx
    .select({ session_id: room_agent_sessions.session_id })
    .from(room_agent_sessions)
    .where(and(
      eq(room_agent_sessions.room_id, input.room_id),
      eq(room_agent_sessions.agent_key, input.agent_key),
      eq(room_agent_sessions.session_kind, "worker"),
      isNull(room_agent_sessions.ended_at),
    ))
    .limit(1);
  if (liveWorker) return [];
  return deleteLiveActivitySessionsTx(tx, input);
}

/**
 * deleteLiveActivityOfDepartedAgentTx for each room and agent, each in its
 * own transaction. Best effort, and it never throws: a room it cannot clean
 * (a database error, or the agent's lock held past the timeout) is logged
 * and keeps the turn until retention removes it.
 */
export async function deleteLiveActivityOfDepartedAgents(input: {
  room_ids: readonly string[];
  agent_keys: readonly string[];
}): Promise<Array<{ room_id: string; session_ids: string[] }>> {
  const removed: Array<{ room_id: string; session_ids: string[] }> = [];
  for (const room_id of new Set(input.room_ids)) {
    for (const agent_key of new Set(input.agent_keys)) {
      try {
        const sessionIds = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          return deleteLiveActivityOfDepartedAgentTx(tx, { room_id, agent_key });
        });
        if (sessionIds.length > 0) removed.push({ room_id, session_ids: sessionIds });
      } catch (error) {
        console.error("[live activity] could not remove a departed agent's live sessions", { room_id, agent_key }, error);
      }
    }
  }
  return removed;
}

/**
 * After the commit: tell each room its removed live sessions are gone. A
 * room that misses the event drops them at its next read, so a failure is
 * only logged.
 */
export async function announceRemovedLiveActivity(
  removals: ReadonlyArray<{ room_id: string; session_ids: readonly string[] }>,
): Promise<void> {
  if (removals.length === 0) return;
  // Dynamic import: the server event modules import the database modules.
  await import("../server/live-activity-cleanup.js")
    .then(({ announceLiveActivityRemoved }) => {
      for (const removal of removals) announceLiveActivityRemoved(removal);
    })
    .catch((error: unknown) => console.error("[live activity] failed to tell a room its live sessions were removed", error));
}

/**
 * Remove up to `limit` live sessions last updated before `updated_before`,
 * oldest first. Returns what was removed, so each room can be told.
 */
export async function deleteStaleLiveActivitySessions(input: {
  updated_before: string;
  limit: number;
}): Promise<Array<{ id: string; room_id: string }>> {
  const stale = await db
    .select({ id: reasoning_sessions.id })
    .from(reasoning_sessions)
    .where(and(eq(reasoning_sessions.kind, "live"), lt(reasoning_sessions.updated_at, input.updated_before)))
    .orderBy(asc(reasoning_sessions.updated_at), asc(reasoning_sessions.id))
    .limit(Math.max(1, Math.min(input.limit, 500)));
  if (!stale.length) return [];
  return db
    .delete(reasoning_sessions)
    .where(and(
      inArray(reasoning_sessions.id, stale.map((row) => row.id)),
      eq(reasoning_sessions.kind, "live"),
      // A session updated meanwhile is no longer stale.
      lt(reasoning_sessions.updated_at, input.updated_before),
    ))
    .returning({ id: reasoning_sessions.id, room_id: reasoning_sessions.room_id });
}
