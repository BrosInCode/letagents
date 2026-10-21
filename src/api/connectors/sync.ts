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
import { formatExternalRef, parseExternalRef, type TicketKeyMatch } from "./key-detectors.js";
import { createWorkItemProviders, type WorkItemProviders } from "./providers/index.js";
import { type ExternalItem, type ExternalItemChange, TrackerProviderError } from "./providers/types.js";
import {
  claimDueRoomTrackerFilters,
  finishRoomTrackerFilterSync,
  getCachedRoomTrackerScope,
  requestRoomTrackerFilterSync,
  roomIdsWithTrackerFilter,
  type RoomTrackerFilterRow,
  type RoomTrackerSource,
} from "./room-filters.js";
import { jiraFilterClause } from "./providers/jira.js";
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
/** Pages of MAX_ITEMS_PER_POLL read per poll before the rest is skipped with a warning. */
const MAX_BATCHES_PER_POLL = 5;
const FILTERS_PER_TICK = 10;
const MAX_WEBHOOK_KEYS = 20;
const MAX_AUTO_IMPORT_KEYS = 3;
const NOT_FOUND_TTL_MS = 10 * 60_000;
const ERROR_SKIP_MS = 60_000;
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

export interface ApplyTrackerItemOptions {
  /**
   * Rooms whose filter matched this ticket: a card is created there if
   * missing, and updated. In other rooms that import from the connection only
   * a card already bound to this ticket (`external_item_id`) is updated, so a
   * key typed on a card never pulls in a ticket the room's filter excludes.
   */
  roomIds?: readonly string[];
}

export interface TrackerSync {
  applyItem(connection: TrackerConnectionRow, item: ExternalItem, options?: ApplyTrackerItemOptions): Promise<ApplyTrackerItemResult>;
  syncFilter(filter: RoomTrackerFilterRow, intervalMs?: number): Promise<{ seen: number; changed: number; error: string | null }>;
  handleWebhook(connection: TrackerConnectionRow, changes: readonly ExternalItemChange[]): Promise<{ applied: number }>;
  importTicketForRoom(roomId: string, matches: readonly TicketKeyMatch[]): Promise<Task | undefined>;
  /** After a person links a card to a ticket: bind it if the room's filter matches the ticket. */
  refreshLinkedCard(roomId: string, externalRef: string): Promise<void>;
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

type ExternalItemRow = typeof external_items.$inferSelect;

function rowToItem(row: ExternalItemRow): ExternalItem {
  return {
    provider: row.provider as TrackerProvider,
    key: row.key,
    title: row.title,
    ticket_state: row.ticket_state as ExternalItem["ticket_state"],
    raw_status: row.raw_status,
    unmapped: false,
    assignee_id: row.assignee_id,
    assignee_label: row.assignee_label,
    url: row.url,
    tracker_updated_at: row.tracker_updated_at,
    payload: row.payload ?? {},
  };
}

/** Whether a Linear ticket matches a room filter's `team:` and `project:` terms. */
export function linearFilterAllows(filter: string, item: ExternalItem): boolean {
  const teamKey = (typeof item.payload.team_key === "string" ? item.payload.team_key : item.key.split("-")[0] ?? "").toUpperCase();
  const projectId = typeof item.payload.project_id === "string" ? item.payload.project_id : null;
  // As parseLinearFilter reads it: the last `team:` and the last `project:` term count.
  let team: string | null = null;
  let project: string | null = null;
  for (const term of filter.trim().split(/\s+/).filter(Boolean)) {
    const [kind, value] = [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)];
    if (kind === "team") team = value.toUpperCase();
    if (kind === "project") project = value;
  }
  return (!team || team === teamKey) && (!project || project === projectId);
}

/** Local failures stay in the server log; the room sees a fixed text. */
const LOCAL_SYNC_ERROR = "Sync failed on the server. It retries at the next poll.";

function cardTitle(item: ExternalItem): string {
  return item.title.trim().slice(0, MAX_TITLE_LENGTH) || item.key;
}

export function createTrackerSync(deps: TrackerSyncDeps): TrackerSync {
  const now = deps.now ?? (() => new Date());
  // Per filter and key: until when auto import does not ask the tracker again.
  const skipped = new Map<string, number>();
  const skip = (key: string, ms: number) => {
    if (skipped.size > 10_000) skipped.clear();
    skipped.set(key, now().getTime() + ms);
  };

  async function applyItem(
    connection: TrackerConnectionRow,
    item: ExternalItem,
    options: ApplyTrackerItemOptions = {},
  ): Promise<ApplyTrackerItemResult> {
    const provider = connection.provider as TrackerProvider;
    const ref = formatExternalRef(provider, item.key);
    const created: Array<{ room_id: string; row: TaskRow }> = [];
    const updated: Array<{ room_id: string; row: TaskRow }> = [];

    const outcome = await db.transaction(async (tx) => {
      // One writer per ticket across API processes: a poll and a webhook for
      // the same change serialize here, and the second finds nothing to do.
      // Keyed by ticket ref, not connection: cards are matched by ref, so two
      // connections to one tracker serialize too.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tracker-item:${ref}`}, 0))`);
      const [cached] = await tx.select().from(external_items)
        .where(and(eq(external_items.connection_id, connection.id), eq(external_items.key, item.key)))
        .limit(1);
      // An older copy (a slow poll, a lagging search index) never undoes a
      // newer one; the cached copy still creates cards a matching room lacks.
      const stale = Boolean(cached && isOlder(item.tracker_updated_at, cached.tracker_updated_at));
      if (stale) item = rowToItem(cached!);

      const syncedAt = now().toISOString();
      const itemChanged = !stale && (!cached
        || cached.title !== item.title
        || cached.ticket_state !== item.ticket_state
        || cached.raw_status !== item.raw_status
        || cached.assignee_id !== item.assignee_id
        || cached.assignee_label !== item.assignee_label
        || cached.url !== item.url
        || !sameTime(cached.tracker_updated_at, item.tracker_updated_at));
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
      // Events are recorded only on a card change under the item lock, so this
      // id never repeats a write; the time keeps A → B → A distinct without
      // a tracker timestamp.
      const changeId = item.tracker_updated_at ?? syncedAt;

      // Ticket states belong only in rooms that import from this connection.
      const filterRooms = await roomIdsWithTrackerFilter(connection.id, tx);
      const matchedRooms = (options.roomIds ?? []).filter((roomId) => filterRooms.includes(roomId));
      const cards = (filterRooms.length === 0 ? [] : await tx.select().from(tasks)
        .where(and(inArray(tasks.room_id, filterRooms), eq(tasks.external_ref, ref)))
        .orderBy(tasks.room_id, tasks.number)
        .for("update") as TaskRow[])
        .filter((card) => matchedRooms.includes(card.room_id) || card.external_item_id === itemId);

      for (const card of cards) {
        const patch: Partial<TaskRow> = {};
        if (card.ticket_state !== item.ticket_state) patch.ticket_state = item.ticket_state;
        if (card.external_item_id !== itemId) patch.external_item_id = itemId;
        // A person's own card keeps its title. An imported card follows the
        // ticket until someone renames it: a title that no longer equals the
        // last synced one is theirs.
        const syncedTitle = cached ? cardTitle(rowToItem(cached)) : null;
        if (isTrackerImportCreator(card.created_by) && card.title !== cardTitle(item)
          && (syncedTitle === null || card.title === syncedTitle)) patch.title = cardTitle(item);
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

      for (const roomId of matchedRooms) {
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
      return { stale, changed: itemChanged || created.length > 0 || updated.length > 0 };
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

  /** Error text for the filter row: the tracker's own answer, or a fixed text for a local failure. */
  async function failureText(connection: TrackerConnectionRow, error: unknown): Promise<string> {
    if (error instanceof TrackerProviderError || error instanceof ConnectorDecryptError) {
      return deps.connections.recordFailure(connection, error);
    }
    console.error("Tracker sync failed:", connectorErrorText(error));
    return LOCAL_SYNC_ERROR;
  }

  async function syncFilter(filter: RoomTrackerFilterRow, intervalMs = trackerPollIntervalMs()) {
    const claimedAt = filter.sync_claimed_at;
    const startedAt = now().toISOString();
    const connection = await deps.store.get(filter.connection_id);
    if (!connection || connection.status !== "active") {
      const error = connection ? "The tracker connection needs attention in Settings → Ticket trackers." : "The tracker connection was removed.";
      await finishRoomTrackerFilterSync({ id: filter.id, claimed_at: claimedAt, started_at: startedAt, advance: false, error, failed: { intervalMs } });
      return { seen: 0, changed: 0, error };
    }
    try {
      const provider = deps.providers[connection.provider as TrackerProvider];
      const open = deps.connections.open(connection);
      const since = filter.last_synced_at
        ? new Date(Date.parse(filter.last_synced_at) - POLL_OVERLAP_MS).toISOString()
        : undefined;
      let seen = 0;
      let changed = 0;
      let before: string | undefined;
      let capped = false;
      // Trackers answer newest first. A full page means older changes remain:
      // read the next page below the oldest ticket seen, a bounded number of times.
      for (let batch = 0; batch < MAX_BATCHES_PER_POLL; batch += 1) {
        const items = await provider.listItems(open, filter.filter.trim() || null, {
          updatedSince: since,
          updatedBefore: before,
          limit: MAX_ITEMS_PER_POLL,
        });
        await deps.store.addUnmapped(connection.id, [...new Set(items.filter((item) => item.unmapped).map((item) => item.raw_status))]);
        seen += items.length;
        for (const item of items) {
          const result = await applyItem(connection, item, { roomIds: [filter.room_id] });
          if (result.changed) changed += 1;
        }
        capped = items.length >= MAX_ITEMS_PER_POLL;
        if (!capped) break;
        const oldest = items.map((item) => Date.parse(item.tracker_updated_at ?? "")).filter(Number.isFinite).sort((x, y) => x - y)[0];
        // No older bound to page by (or no progress): stop here.
        if (oldest === undefined || (before !== undefined && oldest >= Date.parse(before))) break;
        before = new Date(oldest).toISOString();
      }
      const warning = capped
        ? `More than ${MAX_ITEMS_PER_POLL * MAX_BATCHES_PER_POLL} tickets changed in one poll; the oldest changes were skipped. Narrow the filter.`
        : null;
      await finishRoomTrackerFilterSync({ id: filter.id, claimed_at: claimedAt, started_at: startedAt, advance: true, error: warning });
      return { seen, changed, error: warning };
    } catch (error) {
      const text = await failureText(connection, error).catch(() => LOCAL_SYNC_ERROR);
      await finishRoomTrackerFilterSync({
        id: filter.id,
        claimed_at: claimedAt,
        started_at: startedAt,
        advance: false,
        error: text,
        failed: { intervalMs, retryAfterMs: error instanceof TrackerProviderError ? error.retryAfterMs : null },
      });
      return { seen: 0, changed: 0, error: text };
    }
  }

  async function handleWebhook(connection: TrackerConnectionRow, changes: readonly ExternalItemChange[]) {
    if (connection.status !== "active") return { applied: 0 };
    const provider = deps.providers[connection.provider as TrackerProvider];
    const named = [...new Set(changes.filter((change) => !change.deleted).map((change) => change.key))].slice(0, MAX_WEBHOOK_KEYS);
    // Only tickets LetAgents already holds are read: a cached item, or a card
    // naming the key in a room that imports from this connection. Any other
    // key is left to the filters' next poll.
    const keys = named.length === 0 ? [] : await knownKeys(connection, named);
    let applied = 0;
    for (const key of keys) {
      try {
        // The payload only names the ticket: it is read again so the webhook
        // maps it exactly as a poll would. It updates bound cards only; new
        // tickets wait for the poll, which checks the room's filter.
        const item = await provider.getItem(deps.connections.open(connection), key);
        if (!item) continue;
        const result = await applyItem(connection, item);
        if (result.changed) applied += 1;
      } catch (error) {
        await failureText(connection, error).catch(() => undefined);
        if (error instanceof TrackerProviderError && error.outcome === "auth") break;
      }
    }
    // A ticket new to LetAgents may match a room's filter: poll soon.
    if (named.length > keys.length) await requestRoomTrackerFilterSync(connection.id, now());
    return { applied };
  }

  async function knownKeys(connection: TrackerConnectionRow, keys: readonly string[]): Promise<string[]> {
    const provider = connection.provider as TrackerProvider;
    const cached = await db.select({ key: external_items.key }).from(external_items)
      .where(and(eq(external_items.connection_id, connection.id), inArray(external_items.key, [...keys])));
    const known = new Set(cached.map((row) => row.key));
    const rest = keys.filter((key) => !known.has(key));
    if (rest.length > 0) {
      const rooms = await roomIdsWithTrackerFilter(connection.id);
      if (rooms.length > 0) {
        const cards = await db.select({ ref: tasks.external_ref }).from(tasks)
          .where(and(inArray(tasks.room_id, rooms), inArray(tasks.external_ref, rest.map((key) => formatExternalRef(provider, key)))));
        for (const card of cards) if (card.ref) known.add(card.ref.slice(card.ref.indexOf(":") + 1));
      }
    }
    return keys.filter((key) => known.has(key));
  }

  /**
   * The ticket, only if it matches the source's filter. Jira asks the tracker
   * with the filter's JQL; Linear compares the ticket's team and project.
   */
  async function fetchMatchingItem(source: RoomTrackerSource, connection: TrackerConnectionRow, key: string): Promise<ExternalItem | null> {
    const open = deps.connections.open(connection);
    // Read the ticket first: a key that does not exist is a 404 (null), while
    // JQL naming a missing key is an error.
    const item = await deps.providers[source.provider].getItem(open, key);
    if (!item) return null;
    if (source.provider === "linear") return linearFilterAllows(source.filter, item) ? item : null;
    const base = jiraFilterClause(source.filter.trim() || null);
    if (!base) return item;
    try {
      const [match] = await deps.providers.jira.listItems(open, `(${base}) AND key = "${item.key}"`, { limit: 1 });
      return match && match.key === item.key ? match : null;
    } catch (error) {
      // Jira refuses JQL that names a key it cannot see: not a match.
      if (error instanceof TrackerProviderError && error.outcome === "definite") return null;
      throw error;
    }
  }

  /** Each enabled filter on an active connection for the key's provider, until one matches. */
  async function importMatching(roomId: string, match: TicketKeyMatch): Promise<boolean> {
    const scope = await getCachedRoomTrackerScope(roomId);
    for (const source of scope.sources.filter((candidate) => candidate.provider === match.provider)) {
      const missKey = `${source.filter_id}:${match.key}`;
      const skipUntil = skipped.get(missKey);
      if (skipUntil !== undefined && now().getTime() < skipUntil) continue;
      const connection = await activeConnection(source.connection_id);
      if (!connection) continue;
      try {
        const item = await fetchMatchingItem(source, connection, match.key);
        if (!item) {
          skip(missKey, NOT_FOUND_TTL_MS);
          continue;
        }
        await applyItem(connection, item, { roomIds: [roomId] });
        return true;
      } catch (error) {
        // This runs inline in the GitHub projection path: a failing tracker is
        // not asked again for this key for a minute, or as long as it asked.
        const retryAfter = error instanceof TrackerProviderError ? error.retryAfterMs ?? 0 : 0;
        skip(missKey, Math.max(ERROR_SKIP_MS, retryAfter));
        await failureText(connection, error).catch(() => undefined);
      }
    }
    return false;
  }

  async function importTicketForRoom(roomId: string, matches: readonly TicketKeyMatch[]): Promise<Task | undefined> {
    for (const match of matches.slice(0, MAX_AUTO_IMPORT_KEYS)) {
      if (!await importMatching(roomId, match)) continue;
      const [row] = await db.select().from(tasks)
        .where(and(eq(tasks.room_id, roomId), eq(tasks.external_ref, match.ref)))
        .limit(1) as TaskRow[];
      if (row) return toTask(row);
    }
    return undefined;
  }

  async function refreshLinkedCard(roomId: string, externalRef: string): Promise<void> {
    const match = parseExternalRef(externalRef);
    if (!match) return;
    const scope = await getCachedRoomTrackerScope(roomId);
    if (!scope.sources.some((source) => source.provider === match.provider)) return;
    await importMatching(roomId, match);
  }

  async function tick(intervalMs = trackerPollIntervalMs()) {
    // An early poll (a webhook named a new ticket) waits half an interval:
    // the worker ticks every quarter interval, so a stream of webhooks polls
    // at most twice an interval.
    const due = await claimDueRoomTrackerFilters({
      now: now(),
      intervalMs,
      limit: FILTERS_PER_TICK,
      earlyGapMs: Math.max(MIN_TRACKER_POLL_MS, Math.round(intervalMs / 2)),
    });
    for (const filter of due) {
      try {
        await syncFilter(filter, intervalMs);
      } catch (error) {
        // One filter's failure never stops the others. It is counted and
        // backs off like a tracker failure, and its claim is finished.
        console.error("Tracker filter sync failed:", connectorErrorText(error));
        await finishRoomTrackerFilterSync({
          id: filter.id,
          claimed_at: filter.sync_claimed_at,
          started_at: now().toISOString(),
          advance: false,
          error: LOCAL_SYNC_ERROR,
          failed: { intervalMs },
        }).catch(() => undefined);
      }
    }
    return due.length;
  }

  return { applyItem, syncFilter, handleWebhook, importTicketForRoom, refreshLinkedCard, tick };
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
    // Open boards and MCP streams get the card at once. Wake rules read the
    // card's work state, which sync never changes.
    onTaskChanged: (roomId, task) => {
      void import("../server/events.js").then(({ taskEvents }) => {
        taskEvents.emit("task:updated", { projectId: roomId, task });
      }).catch(() => undefined);
    },
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
