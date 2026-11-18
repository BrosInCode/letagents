/**
 * The API's work-item read model (`work_items.*`): tickets read live from a
 * room's tracker source, always inside the room filter.
 *
 * Scoping is the guard that matters. A room reads its tracker with the
 * credentials of the admin who set the room filter, so every read is
 * `(<room filter>) AND (<query>)`, each checked and grouped on its own by
 * `jiraFilterClause`. Without an enabled, non-empty filter on an active
 * connection there is no source at all; a caller can never use the filter
 * owner's token to read the rest of the site.
 *
 * Cache and limits live in this process's memory. The API runs as one
 * process today; with more, each keeps its own cache and its own per-room
 * budget, and a sync generation bump reaches only the process that applied
 * the change (the 60 s expiry still bounds the others).
 */
import { and, eq, inArray } from "drizzle-orm";

import { ApiError } from "../../../shared/api/core.mjs";
import type {
  WorkItem,
  WorkItemHistory,
  WorkItemSearchResult,
  WorkItemSprint,
} from "../../../shared/api/work-items.mjs";
import type { TrackerProvider } from "../../../shared/ticket-connectors.mjs";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { formatTaskId } from "../db/utils.js";
import { createConnectionService } from "./connections.js";
import { ConnectorDecryptError, loadConnectorCipher } from "./crypto.js";
import { formatExternalRef } from "./key-detectors.js";
import { asRecord } from "./providers/http.js";
import { createWorkItemProviders } from "./providers/index.js";
import { assertJiraKey, jiraFilterClause, jiraQueryClause } from "./providers/jira.js";
import { jiraIteration } from "./providers/planning.js";
import {
  type ExternalItem,
  type ExternalStatusChange,
  type ProviderConnection,
  type WorkItemProvider,
  TrackerProviderError,
} from "./providers/types.js";
import { getRoomTrackerScope, type RoomTrackerSource } from "./room-filters.js";
import { trackerConnectionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Sync generation: applyItem bumps a room's generation after a ticket change,
// so a cached read from before the change is never answered again.

const generations = new Map<string, number>();
const MAX_GENERATION_ROOMS = 10_000;
// Survives a sweep: a room forgotten and seen again must not reuse an old number.
let generationFloor = 0;

export function workItemsGeneration(roomId: string): number {
  return generations.get(roomId) ?? generationFloor;
}

export function bumpWorkItemsGeneration(roomId: string): void {
  if (!generations.has(roomId) && generations.size >= MAX_GENERATION_ROOMS) {
    // Forget every room at once and lift the floor past all of them, so each
    // cached read misses; correctness never depends on a room being remembered.
    generationFloor = Math.max(generationFloor, ...generations.values()) + 1;
    generations.clear();
  }
  generations.set(roomId, workItemsGeneration(roomId) + 1);
}

// ---------------------------------------------------------------------------

export const WORK_ITEMS_CACHE_TTL_MS = 60_000;
/** Live tracker searches per room per window (the plan's "2 per 10 s"). */
export const WORK_ITEMS_SEARCH_BUDGET = { limit: 2, windowMs: 10_000 } as const;
/** Live single-ticket reads (get, history) per room per window. */
export const WORK_ITEMS_LOOKUP_BUDGET = { limit: 10, windowMs: 10_000 } as const;
const MAX_CACHE_ENTRIES = 1_000;
const SOURCE_RETRY_AFTER_MS = 30_000;

export interface WorkItemsReaderDeps {
  providers: Record<TrackerProvider, Pick<WorkItemProvider, "listItems" | "listStatusHistory">>;
  /** The room's enabled filters on active connections. */
  sources(roomId: string): Promise<readonly RoomTrackerSource[]>;
  /** A provider-ready connection, or null when it is gone or not active. */
  openConnection(connectionId: string): Promise<ProviderConnection | null>;
  /** Board task ids in the room by external ref (`jira:HT-1`). */
  linkedTasks(roomId: string, refs: readonly string[]): Promise<Map<string, string>>;
  generation?: (roomId: string) => number;
  now?: () => number;
}

export interface WorkItemsReader {
  search(roomId: string, input: { query: string; provider?: TrackerProvider; limit: number; fields?: string | string[] }): Promise<WorkItemSearchResult>;
  get(roomId: string, input: { key: string; provider?: TrackerProvider; fields?: string | string[] }): Promise<WorkItem>;
  history(roomId: string, input: { key: string; provider?: TrackerProvider }): Promise<WorkItemHistory>;
}

interface CacheEntry {
  generation: number;
  expiresAt: number;
  value: Promise<unknown>;
}

export function createWorkItemsReader(deps: WorkItemsReaderDeps): WorkItemsReader {
  const now = deps.now ?? Date.now;
  const generation = deps.generation ?? workItemsGeneration;
  const cache = new Map<string, CacheEntry>();
  const budgets = { search: new Map<string, number[]>(), lookup: new Map<string, number[]>() };

  /** Takes one live read from the room's budget, or says how long to wait. */
  function take(kind: keyof typeof budgets, roomId: string): number {
    const { limit, windowMs } = kind === "search" ? WORK_ITEMS_SEARCH_BUDGET : WORK_ITEMS_LOOKUP_BUDGET;
    const t = now();
    const map = budgets[kind];
    const recent = (map.get(roomId) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      map.set(roomId, recent);
      return Math.max(1, recent[0]! + windowMs - t);
    }
    if (!map.has(roomId) && map.size >= MAX_CACHE_ENTRIES) {
      for (const [room, times] of map) if (!times.some((at) => t - at < windowMs)) map.delete(room);
    }
    recent.push(t);
    map.set(roomId, recent);
    return 0;
  }

  /**
   * One read per key, generation and minute: callers share a read in flight
   * or a finished one; a new live read counts against the room's budget.
   */
  function cached<T>(roomId: string, kind: keyof typeof budgets, key: string, read: () => Promise<T>): Promise<T> {
    const t = now();
    const current = generation(roomId);
    const entry = cache.get(key);
    if (entry && entry.generation === current && entry.expiresAt > t) return entry.value as Promise<T>;
    const retryAfterMs = take(kind, roomId);
    if (retryAfterMs > 0) {
      throw new ApiError("rate_limited", "This room's tracker was read too often just now. Wait and try again.", { retryAfterMs });
    }
    const value = read();
    if (cache.size >= MAX_CACHE_ENTRIES) {
      for (const [k, e] of cache) if (e.expiresAt <= t) cache.delete(k);
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { generation: current, expiresAt: t + WORK_ITEMS_CACHE_TTL_MS, value });
    // A failed read is not kept: the next caller asks the tracker again.
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  }

  async function source(roomId: string, provider: TrackerProvider | undefined): Promise<{ source: RoomTrackerSource; filter: string; conn: ProviderConnection }> {
    const sources = await deps.sources(roomId);
    const picked = provider
      ? sources.find((candidate) => candidate.provider === provider)
      : sources.find((candidate) => candidate.provider === "jira") ?? sources[0];
    if (!picked) {
      throw new ApiError("no_source", provider
        ? `This room has no enabled ${providerName(provider)} filter.`
        : "This room has no enabled tracker filter. A room admin sets one in Room settings.");
    }
    if (picked.provider !== "jira") {
      throw new ApiError("no_source", `Reading ${providerName(picked.provider)} tickets through the API is not available yet; only Jira is.`);
    }
    let filter: string | null;
    try {
      filter = jiraFilterClause(picked.filter);
    } catch {
      throw new ApiError("no_source", "The room's Jira filter is not valid. A room admin fixes it in Room settings.");
    }
    // An empty filter would make the query the whole scope: refuse it.
    if (!filter) throw new ApiError("no_source", "The room's Jira filter is empty. A room admin sets it in Room settings.");
    const conn = await deps.openConnection(picked.connection_id).catch((error: unknown) => {
      if (error instanceof ConnectorDecryptError) return null;
      throw error;
    });
    if (!conn) throw new ApiError("no_source", "The room's Jira connection needs attention in Settings → Connectors.");
    return { source: picked, filter, conn };
  }

  function fieldList(fields: string | string[] | undefined): string[] {
    return [...new Set(typeof fields === "string" ? [fields] : fields ?? [])].sort();
  }

  /** The ticket by key, only if the room filter matches it. Null otherwise. */
  async function scopedTicket(roomId: string, picked: Awaited<ReturnType<typeof source>>, key: string, fields: string[]): Promise<ExternalItem | null> {
    const cacheKey = JSON.stringify(["get", roomId, picked.source.filter_id, picked.source.connection_id, picked.filter, key, fields]);
    return cached(roomId, "lookup", cacheKey, async () => {
      try {
        const [item] = await deps.providers.jira.listItems(picked.conn, picked.filter, {
          extraFilter: `key = "${key}"`,
          limit: 1,
          includePlanning: true,
          detail: true,
          rawFields: fields,
        });
        // A moved ticket answers under its new key: not the ticket asked for.
        return item && item.key === key ? item : null;
      } catch (error) {
        // Jira refuses JQL that names a key it cannot see.
        if (error instanceof TrackerProviderError && error.outcome === "definite" && error.status === 400) return null;
        throw sourceError(error);
      }
    });
  }

  function jiraKey(raw: string): string {
    try {
      return assertJiraKey(raw);
    } catch {
      throw new ApiError("invalid_input", `key: "${raw.slice(0, 40)}" is not a Jira issue key.`);
    }
  }

  async function withLinks(roomId: string, items: readonly ExternalItem[]): Promise<WorkItem[]> {
    const refs = items.map((item) => formatExternalRef(item.provider, item.key));
    const links = refs.length ? await deps.linkedTasks(roomId, refs) : new Map<string, string>();
    return items.map((item, index) => toWorkItem(item, links.get(refs[index]!) ?? null));
  }

  return {
    async search(roomId, input) {
      const picked = await source(roomId, input.provider);
      const query = input.query.trim();
      try {
        jiraQueryClause(query);
      } catch (error) {
        throw new ApiError("invalid_input", `query: ${error instanceof Error ? error.message : "the JQL is not valid."}`);
      }
      const fields = fieldList(input.fields);
      const cacheKey = JSON.stringify(["search", roomId, picked.source.filter_id, picked.source.connection_id, picked.filter, query, fields, input.limit]);
      const result = await cached(roomId, "search", cacheKey, async () => {
        try {
          const items = await deps.providers.jira.listItems(picked.conn, picked.filter, {
            extraFilter: query,
            limit: input.limit,
            includePlanning: true,
            detail: true,
            rawFields: fields,
          });
          return { items, fetchedAt: new Date(now()).toISOString() };
        } catch (error) {
          if (error instanceof TrackerProviderError && error.outcome === "definite" && error.status === 400) {
            // Jira's own text names projects, fields and values the room filter
            // may hide; the caller learns only that the query was refused.
            throw new ApiError("invalid_input", "query: Jira refused the query.");
          }
          throw sourceError(error);
        }
      });
      return { provider: "jira", items: await withLinks(roomId, result.items), fetchedAt: result.fetchedAt };
    },

    async get(roomId, input) {
      const picked = await source(roomId, input.provider);
      const key = jiraKey(input.key);
      const item = await scopedTicket(roomId, picked, key, fieldList(input.fields));
      if (!item) throw new ApiError("not_found", `No ticket ${key} in this room's Jira filter.`);
      return (await withLinks(roomId, [item]))[0]!;
    },

    async history(roomId, input) {
      const picked = await source(roomId, input.provider);
      const key = jiraKey(input.key);
      if (!await scopedTicket(roomId, picked, key, [])) throw new ApiError("not_found", `No ticket ${key} in this room's Jira filter.`);
      const cacheKey = JSON.stringify(["history", roomId, picked.source.connection_id, key]);
      const history = await cached(roomId, "lookup", cacheKey, async () => {
        const read = deps.providers.jira.listStatusHistory;
        if (!read) throw new ApiError("no_source", "This tracker does not give a status history.");
        try {
          return await read(picked.conn, key);
        } catch (error) {
          throw sourceError(error);
        }
      });
      if (!history) throw new ApiError("not_found", `No ticket ${key} in this room's Jira filter.`);
      return { provider: "jira", key, transitions: history.changes.map(toStatusChange), complete: history.complete };
    },
  };
}

function providerName(provider: TrackerProvider): string {
  return provider === "jira" ? "Jira" : provider === "linear" ? "Linear" : "GitHub Issues";
}

function sourceError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ConnectorDecryptError) return new ApiError("no_source", "The room's Jira connection needs attention in Settings → Connectors.");
  if (error instanceof TrackerProviderError && error.outcome === "auth") {
    return new ApiError("no_source", "The room's Jira connection needs attention in Settings → Connectors.");
  }
  if (error instanceof TrackerProviderError) {
    return new ApiError("source_unavailable", "Jira did not answer. Try again shortly.", {
      retryAfterMs: Math.max(error.retryAfterMs ?? 0, SOURCE_RETRY_AFTER_MS),
    });
  }
  throw error;
}

const CATEGORY: Record<string, WorkItem["statusCategory"]> = { new: "todo", indeterminate: "in_progress", done: "done" };

export function toWorkItem(item: ExternalItem, linkedTaskId: string | null): WorkItem {
  const detail = item.detail;
  const planning = asRecord(item.payload.planning);
  const estimate = planning.estimate;
  const iterations = Array.isArray(planning.iterations) ? planning.iterations : [];
  const category = detail?.status_category ? CATEGORY[detail.status_category] : undefined;
  return {
    provider: item.provider,
    key: item.key,
    title: item.title,
    url: item.url,
    status: item.raw_status,
    statusCategory: category ?? (item.ticket_state === "todo" || item.ticket_state === "done" ? item.ticket_state : "in_progress"),
    state: item.ticket_state,
    assignee: item.assignee_id ? { id: item.assignee_id, name: item.assignee_label ?? item.assignee_id } : null,
    storyPoints: typeof estimate === "number" && Number.isFinite(estimate) ? estimate : null,
    sprints: iterations.flatMap((value): WorkItemSprint[] => {
      const sprint = jiraIteration(value);
      return sprint ? [{ id: sprint.id, name: sprint.name, state: sprint.state, startDate: sprint.startDate, endDate: sprint.endDate }] : [];
    }),
    parent: detail?.parent ?? null,
    fixVersions: (detail?.fix_versions ?? []).map((version) => ({
      id: version.id, name: version.name, released: version.released, releaseDate: version.release_date,
    })),
    labels: detail?.labels ?? [],
    statusChangedAt: detail?.status_changed_at ?? null,
    updatedAt: item.tracker_updated_at,
    linkedTask: linkedTaskId ? { taskId: linkedTaskId } : null,
    fields: detail?.fields ?? {},
  };
}

function toStatusChange(change: ExternalStatusChange) {
  return { from: change.from, to: change.to, at: change.at };
}

// ---------------------------------------------------------------------------

export async function linkedTaskIds(roomId: string, refs: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.select({ number: tasks.number, ref: tasks.external_ref }).from(tasks)
    .where(and(eq(tasks.room_id, roomId), inArray(tasks.external_ref, [...refs])));
  return new Map(rows.flatMap((row) => (row.ref ? [[row.ref, formatTaskId(row.number)] as const] : [])));
}

let defaultReader: WorkItemsReader | null | undefined;

/** The server's reader, or null when LETAGENTS_CONNECTOR_SECRET_KEY is missing (no connections can exist). */
export function getDefaultWorkItemsReader(): WorkItemsReader | null {
  if (defaultReader !== undefined) return defaultReader;
  const cipher = loadConnectorCipher();
  if (!cipher) return (defaultReader = null);
  const providers = createWorkItemProviders();
  const connections = createConnectionService({ store: trackerConnectionStore, cipher, providers });
  defaultReader = createWorkItemsReader({
    providers,
    // Read fresh on every call, not through the 30 s scope memo: a filter an
    // admin just disabled must stop reads at once.
    sources: async (roomId) => (await getRoomTrackerScope(roomId)).sources,
    openConnection: async (connectionId) => {
      const row = await trackerConnectionStore.get(connectionId);
      return row && row.status === "active" ? connections.open(row) : null;
    },
    linkedTasks: linkedTaskIds,
  });
  return defaultReader;
}
