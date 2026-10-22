import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { trackerProviderLabel, type RoomTrackerFilterView, type TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { room_tracker_filters, tracker_connections } from "../db/schema.js";
import { normalizeGitHubRepo } from "./key-detectors.js";

export type RoomTrackerFilterRow = typeof room_tracker_filters.$inferSelect;

export interface RoomTrackerFilterWithConnection extends RoomTrackerFilterRow {
  provider: TrackerProvider;
  connection_label: string;
  connection_account_id: string;
  connection_status: string;
}

export class RoomTrackerFilterProviderTakenError extends Error {
  readonly code = "tracker_filter_provider_taken";
  constructor(provider: TrackerProvider) {
    super(`This room already imports ${trackerProviderLabel(provider)} tickets through another connection. Remove that filter first.`);
    this.name = "RoomTrackerFilterProviderTakenError";
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23505" && (candidate.constraint === constraint
      || (typeof candidate.message === "string" && candidate.message.includes(constraint)))) return true;
    current = candidate.cause;
  }
  return false;
}

export function newRoomTrackerFilterId(): string {
  return `rtf_${randomUUID()}`;
}

const withConnection = {
  id: room_tracker_filters.id,
  room_id: room_tracker_filters.room_id,
  connection_id: room_tracker_filters.connection_id,
  filter: room_tracker_filters.filter,
  enabled: room_tracker_filters.enabled,
  created_by_account_id: room_tracker_filters.created_by_account_id,
  last_synced_at: room_tracker_filters.last_synced_at,
  sync_claimed_at: room_tracker_filters.sync_claimed_at,
  sync_finished_at: room_tracker_filters.sync_finished_at,
  sync_requested_at: room_tracker_filters.sync_requested_at,
  last_error: room_tracker_filters.last_error,
  created_at: room_tracker_filters.created_at,
  updated_at: room_tracker_filters.updated_at,
  provider: tracker_connections.provider,
  connection_label: tracker_connections.display_name,
  connection_account_id: tracker_connections.account_id,
  connection_status: tracker_connections.status,
};

export function toRoomTrackerFilterView(row: RoomTrackerFilterWithConnection, accountId: string | null): RoomTrackerFilterView {
  return {
    id: row.id,
    room_id: row.room_id,
    connection_id: row.connection_id,
    provider: row.provider,
    connection_label: row.connection_label,
    filter: row.filter,
    enabled: row.enabled,
    can_manage: Boolean(accountId && accountId === row.connection_account_id),
    last_synced_at: row.last_synced_at,
    last_error: row.last_error,
  };
}

export async function listRoomTrackerFilters(roomId: string): Promise<RoomTrackerFilterWithConnection[]> {
  const rows = await db.select(withConnection).from(room_tracker_filters)
    .innerJoin(tracker_connections, eq(tracker_connections.id, room_tracker_filters.connection_id))
    .where(eq(room_tracker_filters.room_id, roomId))
    .orderBy(asc(room_tracker_filters.created_at));
  return rows as RoomTrackerFilterWithConnection[];
}

export async function getRoomTrackerFilter(roomId: string, id: string): Promise<RoomTrackerFilterWithConnection | null> {
  const [row] = await db.select(withConnection).from(room_tracker_filters)
    .innerJoin(tracker_connections, eq(tracker_connections.id, room_tracker_filters.connection_id))
    .where(and(eq(room_tracker_filters.room_id, roomId), eq(room_tracker_filters.id, id)))
    .limit(1);
  return (row as RoomTrackerFilterWithConnection | undefined) ?? null;
}

/**
 * One filter per room and connection. A changed filter text starts over: the
 * next poll reads every matching ticket, not only recent changes.
 */
export async function upsertRoomTrackerFilter(input: {
  room_id: string;
  connection_id: string;
  provider: TrackerProvider;
  filter: string;
  enabled: boolean;
  account_id: string;
}): Promise<RoomTrackerFilterRow> {
  const now = new Date().toISOString();
  const write = () => db.insert(room_tracker_filters).values({
    id: newRoomTrackerFilterId(),
    room_id: input.room_id,
    connection_id: input.connection_id,
    provider: input.provider,
    filter: input.filter,
    enabled: input.enabled,
    created_by_account_id: input.account_id,
    created_at: now,
    updated_at: now,
  }).onConflictDoUpdate({
    target: [room_tracker_filters.room_id, room_tracker_filters.connection_id],
    set: {
      filter: input.filter,
      enabled: input.enabled,
      last_synced_at: sql`CASE WHEN ${room_tracker_filters.filter} = ${input.filter} THEN ${room_tracker_filters.last_synced_at} ELSE NULL END`,
      sync_claimed_at: null,
      sync_finished_at: null,
      failure_count: 0,
      backoff_until: null,
      last_error: null,
      updated_at: now,
    },
  }).returning();
  let rows: RoomTrackerFilterRow[];
  try {
    rows = await write();
  } catch (error) {
    // The unique index settles two admins adding filters at the same moment.
    if (isUniqueViolation(error, "room_tracker_filters_room_provider_uq")) throw new RoomTrackerFilterProviderTakenError(input.provider);
    throw error;
  }
  invalidateRoomTrackerScope(input.room_id);
  return rows[0]!;
}

export async function deleteRoomTrackerFilter(roomId: string, id: string): Promise<boolean> {
  const rows = await db.delete(room_tracker_filters)
    .where(and(eq(room_tracker_filters.room_id, roomId), eq(room_tracker_filters.id, id)))
    .returning({ id: room_tracker_filters.id });
  invalidateRoomTrackerScope(roomId);
  return rows.length > 0;
}

/**
 * Claims up to `limit` enabled filters that are due: never polled, finished
 * longer than `intervalMs` ago, or asked for by a webhook since their last
 * claim. A poll still running is not claimed again unless its claim is older
 * than `staleMs` (its process died). `FOR UPDATE SKIP LOCKED` keeps two API
 * processes from claiming the same filter at once.
 */
export async function claimDueRoomTrackerFilters(input: {
  now: Date;
  intervalMs: number;
  limit: number;
  staleMs?: number;
  /** A webhook's early poll waits at least this long after the last claim. Default: half the interval. */
  earlyGapMs?: number;
}): Promise<RoomTrackerFilterRow[]> {
  const claimedAt = input.now.toISOString();
  const dueCutoff = new Date(input.now.getTime() - input.intervalMs).toISOString();
  const earlyCutoff = new Date(input.now.getTime() - Math.min(input.earlyGapMs ?? Math.round(input.intervalMs / 2), input.intervalMs)).toISOString();
  const staleCutoff = new Date(input.now.getTime() - Math.max(input.staleMs ?? 10 * 60_000, input.intervalMs)).toISOString();
  const f = room_tracker_filters;
  const result = await db.execute(sql`
    UPDATE ${f} SET sync_claimed_at = ${claimedAt}
     WHERE ${f.id} IN (
       SELECT ${f.id} FROM ${f}
        WHERE ${f.enabled}
          AND (${f.backoff_until} IS NULL OR ${f.backoff_until} <= ${claimedAt})
          AND (
            ${f.sync_claimed_at} IS NULL
            OR ${f.sync_claimed_at} < ${staleCutoff}
            OR (${f.sync_finished_at} >= ${f.sync_claimed_at}
                AND (${f.sync_claimed_at} < ${dueCutoff}
                     OR (${f.sync_requested_at} > ${f.sync_claimed_at} AND ${f.sync_claimed_at} < ${earlyCutoff})))
          )
        ORDER BY ${f.sync_claimed_at} ASC NULLS FIRST
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    room_id: String(row.room_id),
    connection_id: String(row.connection_id),
    provider: String(row.provider),
    filter: String(row.filter),
    enabled: Boolean(row.enabled),
    created_by_account_id: String(row.created_by_account_id),
    last_synced_at: toIso(row.last_synced_at),
    sync_claimed_at: toIso(row.sync_claimed_at),
    sync_finished_at: toIso(row.sync_finished_at),
    sync_requested_at: toIso(row.sync_requested_at),
    failure_count: Number(row.failure_count ?? 0),
    backoff_until: toIso(row.backoff_until),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: toIso(row.created_at) ?? claimedAt,
    updated_at: toIso(row.updated_at) ?? claimedAt,
  }));
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const MAX_FILTER_BACKOFF_MS = 30 * 60_000;

/**
 * Records a finished poll under its claim. A filter changed meanwhile (its
 * claim was cleared) keeps its fresh state. `advance` moves the cursor;
 * `error` is shown to the room (a warning when the cursor still advances).
 * A failed poll (`failed`) backs off: the interval doubles per failure in a
 * row, at most 30 minutes, and never less than the tracker's Retry-After.
 */
export async function finishRoomTrackerFilterSync(input: {
  id: string;
  /** The claim the poll ran under; null for a poll run without one. */
  claimed_at: string | null;
  started_at: string;
  advance: boolean;
  error: string | null;
  failed?: { intervalMs: number; retryAfterMs?: number | null };
}): Promise<void> {
  const now = new Date();
  const f = room_tracker_filters;
  const failed = input.failed;
  await db.update(f).set({
    ...(input.advance ? { last_synced_at: input.started_at } : {}),
    last_error: input.error,
    sync_finished_at: now.toISOString(),
    ...(failed
      ? {
          failure_count: sql`${f.failure_count} + 1`,
          backoff_until: sql`${now.toISOString()}::timestamptz + make_interval(secs => GREATEST(
            ${Math.max(0, Math.round((failed.retryAfterMs ?? 0) / 1000))},
            LEAST(${MAX_FILTER_BACKOFF_MS / 1000}, ${Math.round(failed.intervalMs / 1000)} * power(2, LEAST(${f.failure_count}, 16)))
          ))`,
        }
      : { failure_count: 0, backoff_until: null }),
  })
    .where(and(
      eq(f.id, input.id),
      sql`${f.sync_claimed_at} IS NOT DISTINCT FROM ${input.claimed_at}::timestamptz`,
    ));
}

/** Asks for an early poll of a connection's filters. A running poll is left alone and runs again after it finishes. */
export async function requestRoomTrackerFilterSync(connectionId: string, now = new Date()): Promise<number> {
  const rows = await db.update(room_tracker_filters).set({ sync_requested_at: now.toISOString() })
    .where(and(eq(room_tracker_filters.connection_id, connectionId), eq(room_tracker_filters.enabled, true)))
    .returning({ id: room_tracker_filters.id });
  return rows.length;
}

/**
 * Asks for an early poll of only the connection's filters that `accept` names,
 * and not again within `minGapMs` of the last ask. GitHub Issues uses it: any
 * GitHub user can open an issue on a public repository, so an event must not
 * poll every repository of the installation.
 */
export async function requestMatchingRoomTrackerFilterSync(
  connectionId: string,
  accept: (filter: string) => boolean,
  minGapMs: number,
  now = new Date(),
): Promise<number> {
  const f = room_tracker_filters;
  const rows = await db.select({ id: f.id, filter: f.filter }).from(f)
    .where(and(eq(f.connection_id, connectionId), eq(f.enabled, true)));
  const ids = rows.filter((row) => accept(row.filter)).map((row) => row.id);
  if (ids.length === 0) return 0;
  const cutoff = new Date(now.getTime() - minGapMs).toISOString();
  const updated = await db.update(f).set({ sync_requested_at: now.toISOString() })
    .where(and(inArray(f.id, ids), sql`(${f.sync_requested_at} IS NULL OR ${f.sync_requested_at} < ${cutoff})`))
    .returning({ id: f.id });
  return updated.length;
}

/** Rooms that import from the connection: where its ticket states belong. */
export async function roomIdsWithTrackerFilter(connectionId: string, executor: Pick<typeof db, "select"> = db): Promise<string[]> {
  const rows = await executor.select({ room_id: room_tracker_filters.room_id }).from(room_tracker_filters)
    .where(and(eq(room_tracker_filters.connection_id, connectionId), eq(room_tracker_filters.enabled, true)));
  return [...new Set(rows.map((row) => row.room_id))].sort();
}

export interface RoomTrackerSource {
  filter_id: string;
  connection_id: string;
  provider: TrackerProvider;
  filter: string;
}

export interface RoomTrackerScope {
  sources: RoomTrackerSource[];
  /** Linear team keys the room's filters name (`team:ENG`). */
  linearTeamKeys: string[];
  /** Repositories the room's GitHub Issues filters name (`owner/repo`, lower case). */
  githubRepos: string[];
}

const NO_TRACKER: RoomTrackerScope = { sources: [], linearTeamKeys: [], githubRepos: [] };

/** The `owner/repo` terms of a GitHub Issues filter, lower case; invalid terms are skipped. */
export function githubReposInFilter(filter: string): string[] {
  return [...new Set(filter.split(/[\s,]+/).map(normalizeGitHubRepo).filter((repo): repo is string => Boolean(repo)))];
}

/** Linear `team:<KEY>` terms in a filter. */
export function linearTeamKeysInFilter(filter: string): string[] {
  return [...filter.matchAll(/(?:^|\s)team:([A-Za-z0-9_-]{1,64})(?=\s|$)/g)].map((match) => match[1]!.toUpperCase());
}

/** The room's enabled filters on active connections. One indexed query; none for most rooms. */
export async function getRoomTrackerScope(roomId: string): Promise<RoomTrackerScope> {
  const rows = await db.select({
    filter_id: room_tracker_filters.id,
    connection_id: room_tracker_filters.connection_id,
    provider: tracker_connections.provider,
    filter: room_tracker_filters.filter,
  }).from(room_tracker_filters)
    .innerJoin(tracker_connections, eq(tracker_connections.id, room_tracker_filters.connection_id))
    .where(and(
      eq(room_tracker_filters.room_id, roomId),
      eq(room_tracker_filters.enabled, true),
      eq(tracker_connections.status, "active"),
    ))
    .orderBy(asc(room_tracker_filters.created_at));
  if (rows.length === 0) return NO_TRACKER;
  const sources = rows as RoomTrackerSource[];
  return {
    sources,
    linearTeamKeys: [...new Set(sources.filter((source) => source.provider === "linear")
      .flatMap((source) => linearTeamKeysInFilter(source.filter)))],
    githubRepos: [...new Set(sources.filter((source) => source.provider === "github")
      .flatMap((source) => githubReposInFilter(source.filter)))],
  };
}

// Same memo shape as the external-ref scope: a room with no filter pays no query per repo event.
const TRACKER_SCOPE_TTL_MS = 30_000;
const MAX_CACHED_TRACKER_SCOPES = 5_000;
const trackerScopeCache = new Map<string, { scope: RoomTrackerScope; expiresAt: number }>();
const trackerScopeVersions = new Map<string, number>();

export async function getCachedRoomTrackerScope(roomId: string): Promise<RoomTrackerScope> {
  const entry = trackerScopeCache.get(roomId);
  if (entry && entry.expiresAt > Date.now()) return entry.scope;
  const version = trackerScopeVersions.get(roomId) ?? 0;
  const scope = await getRoomTrackerScope(roomId);
  if ((trackerScopeVersions.get(roomId) ?? 0) !== version) return scope;
  trackerScopeCache.delete(roomId);
  if (trackerScopeCache.size >= MAX_CACHED_TRACKER_SCOPES) {
    const oldest = trackerScopeCache.keys().next().value;
    if (oldest !== undefined) trackerScopeCache.delete(oldest);
  }
  trackerScopeCache.set(roomId, { scope, expiresAt: Date.now() + TRACKER_SCOPE_TTL_MS });
  return scope;
}

export function invalidateRoomTrackerScope(roomId: string): void {
  trackerScopeCache.delete(roomId);
  trackerScopeVersions.set(roomId, (trackerScopeVersions.get(roomId) ?? 0) + 1);
}
