/**
 * Ticket sync (ticket connectors PR3). Polls each enabled room filter, takes
 * tracker webhooks, and imports a ticket a pull request names. All three end
 * in `applyTrackerItem`, so a poll and a webhook can never disagree: one
 * transaction per ticket, under an advisory lock on (connection, key), writes
 * the cached item and the cards only when something changed.
 *
 * Two states, two owners (invariant 2): sync writes `ticket_state` and never
 * the card's work `status`.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  isTrackerImportCreator,
  trackerImportCreator,
  type TrackerProvider,
} from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { toTask } from "../db/mappers.js";
import { external_items, tasks } from "../db/schema.js";
import { invalidateRoomExternalRefScope } from "../db/task-external-refs.js";
import type { Task, TaskRow } from "../db/types.js";
import { nextRoomScopedNumber } from "../db/utils.js";
import { type ConnectionService, connectorErrorText, createConnectionService } from "./connections.js";
import { ConnectorDecryptError, loadConnectorCipher } from "./crypto.js";
import { formatExternalRef, type TicketKeyMatch } from "./key-detectors.js";
import { createWorkItemProviders, type WorkItemProviders } from "./providers/index.js";
import { type ExternalItem, type ExternalItemChange, TrackerProviderError } from "./providers/types.js";
import {
  claimDueRoomTrackerFilters,
  finishRoomTrackerFilterSync,
  getCachedRoomTrackerScope,
  releaseRoomTrackerFilterClaims,
  roomIdsWithTrackerFilter,
  type RoomTrackerFilterRow,
} from "./room-filters.js";
import { trackerConnectionStore, type TrackerConnectionRow, type TrackerConnectionStore } from "./store.js";
import { recordTrackerTicketEvent } from "./tracker-events.js";

export const TRACKER_POLL_MS_ENV = "LETAGENTS_TRACKER_POLL_MS";
export const DEFAULT_TRACKER_POLL_MS = 2 * 60_000;
const MIN_TRACKER_POLL_MS = 15_000;
const MAX_TRACKER_POLL_MS = 60 * 60_000;
/** A poll asks for changes since the last one began, less this overlap (clock skew). */
const POLL_OVERLAP_MS = 5 * 60_000;
/** Tickets read per poll. A larger filter imports its most recently updated tickets. */
export const MAX_ITEMS_PER_POLL = 200;
const FILTERS_PER_TICK = 10;
const MAX_WEBHOOK_KEYS = 20;
const MAX_AUTO_IMPORT_KEYS = 3;
const NOT_FOUND_TTL_MS = 10 * 60_000;
const MAX_TITLE_LENGTH = 500;

export function trackerPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[TRACKER_POLL_MS_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TRACKER_POLL_MS;
  return Math.min(Math.max(Math.round(raw), MIN_TRACKER_POLL_MS), MAX_TRACKER_POLL_MS);
}

export interface ApplyTrackerItemResult {
  /** False when the cached item and every card already matched. */
  changed: boolean;
  /** The ticket was older than the cached copy and was ignored. */
  stale: boolean;
  created: Task[];
  updated: Task[];
}

export interface TrackerSyncDeps {
  providers: WorkItemProviders;
  connections: Pick<ConnectionService, "open" | "recordFailure">;
  store: Pick<TrackerConnectionStore, "get" | "addUnmapped">;
  now?: () => Date;
  /** Called after commit for every card sync created or changed. */
  onTaskChanged?: (roomId: string, task: Task) => void;
}

export interface TrackerSync {
  applyItem(connection: TrackerConnectionRow, item: ExternalItem, options?: { createInRoomIds?: readonly string[] }): Promise<ApplyTrackerItemResult>;
  syncFilter(filter: RoomTrackerFilterRow): Promise<{ seen: number; changed: number; error: string | null }>;
  handleWebhook(connection: TrackerConnectionRow, changes: readonly ExternalItemChange[]): Promise<{ applied: number }>;
  importTicketForRoom(roomId: string, matches: readonly TicketKeyMatch[]): Promise<Task | undefined>;
  /** Claim and poll due filters once. */
  tick(intervalMs?: number): Promise<number>;
}

function sameTime(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/** True when `incoming` is known to be older than what is cached. */
function isOlder(incoming: string | null, cached: string | null): boolean {
  if (!incoming || !cached) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(cached);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

function cardTitle(item: ExternalItem): string {
  return item.title.trim().slice(0, MAX_TITLE_LENGTH) || item.key;
}

export function createTrackerSync(deps: TrackerSyncDeps): TrackerSync {
  const now = deps.now ?? (() => new Date());
  const notFound = new Map<string, number>();

  async function applyItem(
    connection: TrackerConnectionRow,
    item: ExternalItem,
    options: { createInRoomIds?: readonly string[] } = {},
  ): Promise<ApplyTrackerItemResult> {
    const provider = connection.provider as TrackerProvider;
    const ref = formatExternalRef(provider, item.key);
    const created: Array<{ room_id: string; row: TaskRow }> = [];
    const updated: Array<{ room_id: string; row: TaskRow }> = [];

    const outcome = await db.transaction(async (tx) => {
      // One writer per ticket across API processes: a poll and a webhook for
      // the same change serialize here, and the second finds nothing to do.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tracker-item:${connection.id}:${item.key}`}, 0))`);
      const [cached] = await tx.select().from(external_items)
        .where(and(eq(external_items.connection_id, connection.id), eq(external_items.key, item.key)))
        .limit(1);
      if (cached && isOlder(item.tracker_updated_at, cached.tracker_updated_at)) return { stale: true, changed: false };

      const syncedAt = now().toISOString();
      const itemChanged = !cached
        || cached.title !== item.title
        || cached.ticket_state !== item.ticket_state
        || cached.raw_status !== item.raw_status
        || cached.assignee_id !== item.assignee_id
        || cached.assignee_label !== item.assignee_label
        || cached.url !== item.url
        || !sameTime(cached.tracker_updated_at, item.tracker_updated_at);
      const itemId = cached?.id ?? `xitem_${randomUUID()}`;
      if (itemChanged) {
        await tx.insert(external_items).values({
          id: itemId,
          connection_id: connection.id,
          provider,
          key: item.key,
          title: item.title,
          ticket_state: item.ticket_state,
          raw_status: item.raw_status,
          assignee_id: item.assignee_id,
          assignee_label: item.assignee_label,
          url: item.url,
          payload: item.payload,
          tracker_updated_at: item.tracker_updated_at,
          synced_at: syncedAt,
        }).onConflictDoUpdate({
          target: [external_items.connection_id, external_items.key],
          set: {
            title: item.title,
            ticket_state: item.ticket_state,
            raw_status: item.raw_status,
            assignee_id: item.assignee_id,
            assignee_label: item.assignee_label,
            url: item.url,
            payload: item.payload,
            tracker_updated_at: item.tracker_updated_at,
            synced_at: syncedAt,
          },
        });
      }
      const changeId = item.tracker_updated_at ?? `${item.ticket_state}:${item.raw_status}`;

      // Ticket states belong only in rooms that import from this connection.
      const filterRooms = await roomIdsWithTrackerFilter(connection.id, tx);
      const createIn = (options.createInRoomIds ?? []).filter((roomId) => filterRooms.includes(roomId));
      const cards = filterRooms.length === 0 ? [] : await tx.select().from(tasks)
        .where(and(inArray(tasks.room_id, filterRooms), eq(tasks.external_ref, ref)))
        .for("update") as TaskRow[];

      for (const card of cards) {
        const patch: Partial<TaskRow> = {};
        if (card.ticket_state !== item.ticket_state) patch.ticket_state = item.ticket_state;
        if (card.external_item_id !== itemId) patch.external_item_id = itemId;
        // A person's own card keeps its title; an imported card follows the ticket.
        if (isTrackerImportCreator(card.created_by) && card.title !== cardTitle(item)) patch.title = cardTitle(item);
        if (Object.keys(patch).length === 0) continue;
        const [row] = await tx.update(tasks).set({ ...patch, updated_at: syncedAt })
          .where(and(eq(tasks.room_id, card.room_id), eq(tasks.number, card.number)))
          .returning() as TaskRow[];
        if (!row) continue;
        updated.push({ room_id: row.room_id, row });
        if (patch.ticket_state !== undefined) {
          await recordTrackerTicketEvent(tx, {
            room_id: row.room_id,
            task_number: row.number,
            provider,
            key: item.key,
            external_ref: ref,
            title: item.title,
            url: item.url,
            action: "ticket_state_changed",
            ticket_state: item.ticket_state,
            previous_ticket_state: card.ticket_state ?? null,
            raw_status: item.raw_status,
            connection_id: connection.id,
            change_id: changeId,
          });
        }
      }

      for (const roomId of createIn) {
        if (cards.some((card) => card.room_id === roomId)) continue;
        const createdAt = syncedAt;
        const number = await nextRoomScopedNumber("tasks", roomId, tx);
        // A card someone else gave this key in the meantime wins; the unique
        // index turns this insert into nothing.
        const [row] = await tx.insert(tasks).values({
          room_id: roomId,
          number,
          title: cardTitle(item),
          description: null,
          status: "proposed",
          assignee: null,
          assignee_agent_key: null,
          created_by: trackerImportCreator(provider),
          source_message_id: null,
          client_task_id: null,
          pr_url: null,
          workflow_artifacts: [],
          external_ref: ref,
          ticket_state: item.ticket_state,
          external_item_id: itemId,
          created_at: createdAt,
          updated_at: createdAt,
        }).onConflictDoNothing().returning() as TaskRow[];
        if (!row) continue;
        created.push({ room_id: roomId, row });
        await recordTrackerTicketEvent(tx, {
          room_id: roomId,
          task_number: row.number,
          provider,
          key: item.key,
          external_ref: ref,
          title: item.title,
          url: item.url,
          action: "imported",
          ticket_state: item.ticket_state,
          previous_ticket_state: null,
          raw_status: item.raw_status,
          connection_id: connection.id,
          change_id: "import",
        });
      }
      return { stale: false, changed: itemChanged || created.length > 0 || updated.length > 0 };
    });

    for (const roomId of new Set(created.map((entry) => entry.room_id))) invalidateRoomExternalRefScope(roomId);
    const result: ApplyTrackerItemResult = {
      ...outcome,
      created: created.map((entry) => toTask(entry.row)),
      updated: updated.map((entry) => toTask(entry.row)),
    };
    for (const task of [...result.created, ...result.updated]) {
      try {
        deps.onTaskChanged?.(task.room_id, task);
      } catch {
        // The change is committed; a missed live update is fixed by the next board read.
      }
    }
    return result;
  }

  async function activeConnection(connectionId: string): Promise<TrackerConnectionRow | null> {
    const row = await deps.store.get(connectionId);
    return row && row.status === "active" ? row : null;
  }

  async function syncFilter(filter: RoomTrackerFilterRow) {
    const claimedAt = filter.sync_claimed_at;
    const startedAt = now().toISOString();
    const connection = await deps.store.get(filter.connection_id);
    if (!connection || connection.status !== "active") {
      const error = connection ? "The tracker connection needs attention in Settings → Ticket trackers." : "The tracker connection was removed.";
      await finishRoomTrackerFilterSync({ id: filter.id, claimed_at: claimedAt, started_at: startedAt, error });
      return { seen: 0, changed: 0, error };
    }
    try {
      const provider = deps.providers[connection.provider as TrackerProvider];
      const since = filter.last_synced_at
        ? new Date(Date.parse(filter.last_synced_at) - POLL_OVERLAP_MS).toISOString()
        : undefined;
      const items = await provider.listItems(deps.connections.open(connection), filter.filter.trim() || null, {
        updatedSince: since,
        limit: MAX_ITEMS_PER_POLL,
      });
      await deps.store.addUnmapped(connection.id, [...new Set(items.filter((item) => item.unmapped).map((item) => item.raw_status))]);
      let changed = 0;
      for (const item of items) {
        const result = await applyItem(connection, item, { createInRoomIds: [filter.room_id] });
        if (result.changed) changed += 1;
      }
      await finishRoomTrackerFilterSync({ id: filter.id, claimed_at: claimedAt, started_at: startedAt, error: null });
      return { seen: items.length, changed, error: null };
    } catch (error) {
      // Only a tracker's answer says something about the connection; a local
      // failure (the database, say) is recorded on the filter alone.
      const text = error instanceof TrackerProviderError || error instanceof ConnectorDecryptError
        ? await deps.connections.recordFailure(connection, error)
        : connectorErrorText(error);
      await finishRoomTrackerFilterSync({ id: filter.id, claimed_at: claimedAt, started_at: startedAt, error: text });
      return { seen: 0, changed: 0, error: text };
    }
  }

  async function handleWebhook(connection: TrackerConnectionRow, changes: readonly ExternalItemChange[]) {
    if (connection.status !== "active") return { applied: 0 };
    const provider = deps.providers[connection.provider as TrackerProvider];
    const keys = [...new Set(changes.filter((change) => !change.deleted).map((change) => change.key))].slice(0, MAX_WEBHOOK_KEYS);
    let applied = 0;
    for (const key of keys) {
      // The payload only names the ticket: it is read again so the webhook maps
      // it exactly as a poll would.
      const item = await provider.getItem(deps.connections.open(connection), key);
      if (!item) continue;
      const result = await applyItem(connection, item);
      if (result.changed) applied += 1;
    }
    // A new ticket may match a room's filter: poll this connection's filters soon.
    if (keys.length > 0) await releaseRoomTrackerFilterClaims(connection.id, now());
    return { applied };
  }

  async function importTicketForRoom(roomId: string, matches: readonly TicketKeyMatch[]): Promise<Task | undefined> {
    const scope = await getCachedRoomTrackerScope(roomId);
    if (scope.sources.length === 0) return undefined;
    for (const match of matches.slice(0, MAX_AUTO_IMPORT_KEYS)) {
      const source = scope.sources.find((candidate) => candidate.provider === match.provider);
      if (!source) continue;
      const missKey = `${source.connection_id}:${match.key}`;
      const missedAt = notFound.get(missKey);
      if (missedAt !== undefined && now().getTime() - missedAt < NOT_FOUND_TTL_MS) continue;
      const connection = await activeConnection(source.connection_id);
      if (!connection) continue;
      try {
        const item = await deps.providers[match.provider].getItem(deps.connections.open(connection), match.key);
        if (!item) {
          if (notFound.size > 10_000) notFound.clear();
          notFound.set(missKey, now().getTime());
          continue;
        }
        await applyItem(connection, item, { createInRoomIds: [roomId] });
        const [row] = await db.select().from(tasks)
          .where(and(eq(tasks.room_id, roomId), eq(tasks.external_ref, formatExternalRef(match.provider, item.key))))
          .limit(1) as TaskRow[];
        if (row) return toTask(row);
      } catch (error) {
        if (error instanceof TrackerProviderError || error instanceof ConnectorDecryptError) {
          await deps.connections.recordFailure(connection, error).catch(() => undefined);
        } else {
          console.warn("Ticket auto import failed:", connectorErrorText(error));
        }
      }
    }
    return undefined;
  }

  async function tick(intervalMs = trackerPollIntervalMs()) {
    const due = await claimDueRoomTrackerFilters({ now: now(), intervalMs, limit: FILTERS_PER_TICK });
    for (const filter of due) await syncFilter(filter);
    return due.length;
  }

  return { applyItem, syncFilter, handleWebhook, importTicketForRoom, tick };
}

let defaultSync: TrackerSync | null | undefined;

/** The server's sync, or null when LETAGENTS_CONNECTOR_SECRET_KEY is missing. */
export function getDefaultTrackerSync(): TrackerSync | null {
  if (defaultSync !== undefined) return defaultSync;
  const cipher = loadConnectorCipher();
  if (!cipher) {
    defaultSync = null;
    return null;
  }
  const providers = createWorkItemProviders();
  defaultSync = createTrackerSync({
    providers,
    connections: createConnectionService({ store: trackerConnectionStore, cipher, providers }),
    store: trackerConnectionStore,
    // No task event: boards read cards on their own refresh, and a ticket
    // change must not look like room work to wake rules (invariant 4).
  });
  return defaultSync;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerPass: Promise<void> | null = null;

/**
 * Polls due room filters on a bounded interval (`LETAGENTS_TRACKER_POLL_MS`,
 * default 2 minutes). Does nothing on a server without a connector key, and a
 * server with no filters runs one indexed query per tick.
 */
export function startTrackerSyncWorker(): () => Promise<void> {
  const sync = getDefaultTrackerSync();
  if (!sync || workerTimer) return async () => undefined;
  const intervalMs = trackerPollIntervalMs();
  const run = () => {
    if (workerPass) return;
    workerPass = sync.tick(intervalMs).then(() => undefined, (error: unknown) => {
      console.error("Tracker sync pass failed:", error instanceof Error ? error.message : String(error));
    }).finally(() => { workerPass = null; });
  };
  workerTimer = setInterval(run, Math.min(Math.max(Math.round(intervalMs / 4), 5_000), 60_000));
  workerTimer.unref?.();
  run();
  return async () => {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
    await workerPass;
  };
}
