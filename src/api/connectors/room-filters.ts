import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import type { RoomTrackerFilterView, TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { room_tracker_filters, tracker_connections } from "../db/schema.js";

export type RoomTrackerFilterRow = typeof room_tracker_filters.$inferSelect;

export interface RoomTrackerFilterWithConnection extends RoomTrackerFilterRow {
  provider: TrackerProvider;
  connection_label: string;
  connection_account_id: string;
  connection_status: string;
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
  filter: string;
  enabled: boolean;
  account_id: string;
}): Promise<RoomTrackerFilterRow> {
  const now = new Date().toISOString();
  const [row] = await db.insert(room_tracker_filters).values({
    id: newRoomTrackerFilterId(),
    room_id: input.room_id,
    connection_id: input.connection_id,
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
      last_error: null,
      updated_at: now,
    },
  }).returning();
  invalidateRoomTrackerScope(input.room_id);
  return row!;
}

export async function deleteRoomTrackerFilter(roomId: string, id: string): Promise<boolean> {
  const rows = await db.delete(room_tracker_filters)
    .where(and(eq(room_tracker_filters.room_id, roomId), eq(room_tracker_filters.id, id)))
    .returning({ id: room_tracker_filters.id });
  invalidateRoomTrackerScope(roomId);
  return rows.length > 0;
}

/**
 * Claims up to `limit` enabled filters whose last claim is older than
 * `intervalMs`. Two API processes never claim the same filter at once:
 * `FOR UPDATE SKIP LOCKED` and the age check make the claim single-flight.
 */
export async function claimDueRoomTrackerFilters(input: {
  now: Date;
  intervalMs: number;
  limit: number;
}): Promise<RoomTrackerFilterRow[]> {
  const claimedAt = input.now.toISOString();
  const cutoff = new Date(input.now.getTime() - input.intervalMs).toISOString();
  const result = await db.execute(sql`
    UPDATE ${room_tracker_filters} SET sync_claimed_at = ${claimedAt}
     WHERE ${room_tracker_filters.id} IN (
       SELECT ${room_tracker_filters.id} FROM ${room_tracker_filters}
        WHERE ${room_tracker_filters.enabled}
          AND (${room_tracker_filters.sync_claimed_at} IS NULL OR ${room_tracker_filters.sync_claimed_at} < ${cutoff})
        ORDER BY ${room_tracker_filters.sync_claimed_at} ASC NULLS FIRST
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    room_id: String(row.room_id),
    connection_id: String(row.connection_id),
    filter: String(row.filter),
    enabled: Boolean(row.enabled),
    created_by_account_id: String(row.created_by_account_id),
    last_synced_at: toIso(row.last_synced_at),
    sync_claimed_at: toIso(row.sync_claimed_at),
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

/** Records a finished poll. A filter changed meanwhile (claim cleared) keeps its fresh state. */
export async function finishRoomTrackerFilterSync(input: {
  id: string;
  /** The claim the poll ran under; null for a poll run without one. */
  claimed_at: string | null;
  started_at: string;
  error: string | null;
}): Promise<void> {
  await db.update(room_tracker_filters).set(input.error
    ? { last_error: input.error }
    : { last_synced_at: input.started_at, last_error: null })
    .where(and(
      eq(room_tracker_filters.id, input.id),
      sql`${room_tracker_filters.sync_claimed_at} IS NOT DISTINCT FROM ${input.claimed_at}::timestamptz`,
    ));
}

/** Makes a connection's filters due now, unless a poll claimed them in the last few seconds. */
export async function releaseRoomTrackerFilterClaims(connectionId: string, now = new Date(), minAgeMs = 10_000): Promise<number> {
  const cutoff = new Date(now.getTime() - minAgeMs).toISOString();
  const rows = await db.update(room_tracker_filters).set({ sync_claimed_at: null })
    .where(and(
      eq(room_tracker_filters.connection_id, connectionId),
      eq(room_tracker_filters.enabled, true),
      sql`${room_tracker_filters.sync_claimed_at} < ${cutoff}`,
    ))
    .returning({ id: room_tracker_filters.id });
  return rows.length;
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
}

const NO_TRACKER: RoomTrackerScope = { sources: [], linearTeamKeys: [] };

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
