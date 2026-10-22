/**
 * Rows for Jev questions (ticket connectors PR6, migration 0125) and the
 * board intents Jev links create. The unique key (kind, room, subject,
 * revision) makes one question per pull request head, per closed pull
 * request, and per card and last message, across API processes.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";

import type { JevQuestionKind, TrackerJevMetrics, TrackerJevMetricsKind } from "../../../../shared/ticket-connectors.mjs";
import { JEV_QUESTION_KINDS } from "../../../../shared/ticket-connectors.mjs";
import { db } from "../../db/client.js";
import { toBoardIntent } from "../../db/mappers.js";
import { board_intents, tracker_connections, tracker_jev_questions } from "../../db/schema.js";
import type { BoardIntent } from "../../db/types.js";

export type JevQuestionRow = typeof tracker_jev_questions.$inferSelect;

export interface JevQuestionClaim {
  connection_id: string;
  room_id: string | null;
  kind: JevQuestionKind;
  subject: string;
  revision: string;
  task_id?: string | null;
}

export const JEV_LINK_INTENT_TYPE = "tracker_jev_link" as const;

export const jevQuestionStore = {
  /** Records the question before Jev is asked. Null when this exact question was already asked. */
  async claim(input: JevQuestionClaim, now: Date = new Date()): Promise<JevQuestionRow | null> {
    const at = now.toISOString();
    const [row] = await db.insert(tracker_jev_questions).values({
      id: `jevq_${randomUUID()}`,
      connection_id: input.connection_id,
      room_id: input.room_id,
      kind: input.kind,
      subject: input.subject,
      revision: input.revision,
      task_id: input.task_id ?? null,
      outcome: "pending",
      created_at: at,
      updated_at: at,
    }).onConflictDoNothing().returning();
    return row ?? null;
  },

  async find(input: Pick<JevQuestionClaim, "kind" | "room_id" | "subject" | "revision">): Promise<JevQuestionRow | null> {
    const [row] = await db.select().from(tracker_jev_questions).where(and(
      eq(tracker_jev_questions.kind, input.kind),
      sql`coalesce(${tracker_jev_questions.room_id}, '') = ${input.room_id ?? ""}`,
      eq(tracker_jev_questions.subject, input.subject),
      eq(tracker_jev_questions.revision, input.revision),
    )).limit(1);
    return row ?? null;
  },

  async get(id: string): Promise<JevQuestionRow | null> {
    const [row] = await db.select().from(tracker_jev_questions).where(eq(tracker_jev_questions.id, id)).limit(1);
    return row ?? null;
  },

  async finish(id: string, input: { outcome: string; answer?: Record<string, unknown> | null; latency_ms?: number | null; task_id?: string | null }): Promise<void> {
    await db.update(tracker_jev_questions).set({
      outcome: input.outcome.slice(0, 64),
      answer: input.answer ?? null,
      latency_ms: input.latency_ms === undefined || input.latency_ms === null ? null : Math.max(0, Math.round(input.latency_ms)),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      updated_at: new Date().toISOString(),
    }).where(eq(tracker_jev_questions.id, id));
  },

  /** Questions of one kind asked for a room since `since`: the per-room rate limit. */
  async countSince(input: { room_id: string; kind: JevQuestionKind; since: Date }): Promise<number> {
    const [row] = await db.select({ value: count() }).from(tracker_jev_questions).where(and(
      eq(tracker_jev_questions.room_id, input.room_id),
      eq(tracker_jev_questions.kind, input.kind),
      gte(tracker_jev_questions.created_at, input.since.toISOString()),
    ));
    return Number(row?.value ?? 0);
  },

  /** Link questions asked for one pull request in a room, every head included. */
  async countForSubject(input: { room_id: string; kind: JevQuestionKind; subject: string }): Promise<number> {
    const [row] = await db.select({ value: count() }).from(tracker_jev_questions).where(and(
      eq(tracker_jev_questions.room_id, input.room_id),
      eq(tracker_jev_questions.kind, input.kind),
      eq(tracker_jev_questions.subject, input.subject),
    ));
    return Number(row?.value ?? 0);
  },

  /** A person rejected a Jev link for this pull request in this room: Jev is not asked again for it. */
  async linkRejected(input: { room_id: string; subject: string }): Promise<boolean> {
    const [row] = await db.select({ id: tracker_jev_questions.id }).from(tracker_jev_questions).where(and(
      eq(tracker_jev_questions.room_id, input.room_id),
      eq(tracker_jev_questions.kind, "link"),
      eq(tracker_jev_questions.subject, input.subject),
      eq(tracker_jev_questions.resolution, "rejected"),
    )).limit(1);
    return Boolean(row);
  },

  /** Records a person's decision on every link question that attached this pull request to this card. */
  async resolveLink(input: { room_id: string; subject: string; task_id: string; resolution: "accepted" | "rejected" }): Promise<void> {
    await db.update(tracker_jev_questions).set({ resolution: input.resolution, updated_at: new Date().toISOString() })
      .where(and(
        eq(tracker_jev_questions.room_id, input.room_id),
        eq(tracker_jev_questions.kind, "link"),
        eq(tracker_jev_questions.subject, input.subject),
        eq(tracker_jev_questions.task_id, input.task_id),
      ));
  },

  /** Count, outcomes and latency of the account's Jev questions since `since`. */
  async metrics(accountId: string, since: Date): Promise<Pick<TrackerJevMetrics, "enabled_connections" | "kinds">> {
    const connections = await db.select({ id: tracker_connections.id, enabled: tracker_connections.jev_linking_enabled })
      .from(tracker_connections).where(eq(tracker_connections.account_id, accountId));
    const ids = connections.map((row) => row.id);
    const enabled = connections.filter((row) => row.enabled).length;
    if (ids.length === 0) return { enabled_connections: 0, kinds: emptyKinds() };
    const rows = await db.execute<{ kind: string; outcome: string; n: number; avg_ms: number | null; p95_ms: number | null }>(sql`
      SELECT ${tracker_jev_questions.kind} AS kind, ${tracker_jev_questions.outcome} AS outcome, count(*)::int AS n,
             avg(${tracker_jev_questions.latency_ms})::float AS avg_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ${tracker_jev_questions.latency_ms})::float AS p95_ms
        FROM ${tracker_jev_questions}
       WHERE ${inArray(tracker_jev_questions.connection_id, ids)}
         AND ${tracker_jev_questions.created_at} >= ${since.toISOString()}::timestamptz
       GROUP BY 1, 2
    `);
    const kinds = emptyKinds();
    const latency = new Map<string, { sum: number; n: number; p95: number | null }>();
    for (const row of rows.rows) {
      const entry = kinds.find((kind) => kind.kind === row.kind);
      if (!entry) continue;
      entry.count += Number(row.n);
      entry.outcomes[row.outcome] = (entry.outcomes[row.outcome] ?? 0) + Number(row.n);
      if (row.avg_ms !== null && row.avg_ms !== undefined) {
        const seen = latency.get(row.kind) ?? { sum: 0, n: 0, p95: null };
        seen.sum += Number(row.avg_ms) * Number(row.n);
        seen.n += Number(row.n);
        // The largest per-outcome p95 is an upper bound of the kind's p95: enough for a diagnostics pane.
        seen.p95 = Math.max(seen.p95 ?? 0, Number(row.p95_ms ?? 0));
        latency.set(row.kind, seen);
      }
    }
    for (const entry of kinds) {
      const seen = latency.get(entry.kind);
      entry.latency_ms_avg = seen && seen.n > 0 ? Math.round(seen.sum / seen.n) : null;
      entry.latency_ms_p95 = seen?.p95 !== null && seen?.p95 !== undefined ? Math.round(seen.p95) : null;
    }
    return { enabled_connections: enabled, kinds };
  },
};

function emptyKinds(): TrackerJevMetricsKind[] {
  return JEV_QUESTION_KINDS.map((kind) => ({ kind, count: 0, outcomes: {}, latency_ms_avg: null, latency_ms_p95: null }));
}

export type JevQuestionStore = typeof jevQuestionStore;

/** Board intents for Jev links. They are decided by a person only; the server runs what they approve. */
export const jevIntentStore = {
  /** Pending "Move KEY?" intents for one pull request on one card. */
  async pendingForLink(input: { room_id: string; task_id: string; pr_url: string }): Promise<BoardIntent[]> {
    const rows = await db.select().from(board_intents).where(and(
      eq(board_intents.room_id, input.room_id),
      eq(board_intents.action_type, JEV_LINK_INTENT_TYPE),
      eq(board_intents.status, "pending"),
      sql`${board_intents.payload}->>'task_id' = ${input.task_id}`,
      sql`${board_intents.payload}->>'pr_url' = ${input.pr_url}`,
    ));
    return rows.map(toBoardIntent);
  },

  /** The link was rejected: its other pending intents no longer apply. */
  async supersedeForLink(input: { room_id: string; task_id: string; pr_url: string; reason: string }): Promise<number> {
    const now = new Date().toISOString();
    const rows = await db.update(board_intents).set({
      status: "superseded", decision_reason: input.reason.slice(0, 500), decided_at: now, updated_at: now,
    }).where(and(
      eq(board_intents.room_id, input.room_id),
      eq(board_intents.action_type, JEV_LINK_INTENT_TYPE),
      eq(board_intents.status, "pending"),
      sql`${board_intents.payload}->>'task_id' = ${input.task_id}`,
      sql`${board_intents.payload}->>'pr_url' = ${input.pr_url}`,
    )).returning({ id: board_intents.id });
    return rows.length;
  },

  /**
   * An approved Jev intent is carried out by the server, not by a proposer
   * with a token: mark it used so no token can carry it out again.
   */
  async markUsed(input: { room_id: string; intent_id: string }): Promise<void> {
    const now = new Date().toISOString();
    await db.update(board_intents).set({ status: "used", approval_token_hash: null, updated_at: now })
      .where(and(
        eq(board_intents.room_id, input.room_id),
        eq(board_intents.id, input.intent_id),
        eq(board_intents.action_type, JEV_LINK_INTENT_TYPE),
        eq(board_intents.status, "approved"),
      ));
  },
};

export type JevIntentStore = typeof jevIntentStore;
