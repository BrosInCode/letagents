import { PageCallFailure, type PageCallError } from "./page-policy.js";

/**
 * Reads a page may keep watching, and the room stream resources that make
 * main run them again. A tracker search re-runs at most every 2 minutes: each
 * run can reach Jira or Linear, and the server caches it for 60 s anyway.
 */
export const PAGE_WATCHABLE_METHODS: Readonly<Record<string, { resources: readonly string[]; floorMs: number }>> = {
  "work_items.search": { resources: ["work_items"], floorMs: 120_000 },
  "work_items.get": { resources: ["work_items"], floorMs: 120_000 },
  "work_items.history": { resources: ["work_items"], floorMs: 120_000 },
  "data.list": { resources: ["documents"], floorMs: 0 },
  "data.get": { resources: ["documents"], floorMs: 0 },
  "jobs.list": { resources: ["jobs"], floorMs: 0 },
  "jobs.get": { resources: ["jobs"], floorMs: 0 },
  "intents.list": { resources: ["intents"], floorMs: 0 },
  "intents.get": { resources: ["intents"], floorMs: 0 },
  "tasks.list": { resources: ["tasks"], floorMs: 0 },
  "tasks.get": { resources: ["tasks"], floorMs: 0 },
  "planning.get": { resources: ["tasks"], floorMs: 0 },
};

/** Room stream resources main relays to pages; any other pointer is not theirs. */
export const PAGE_RELAY_RESOURCES: ReadonlySet<string> = new Set(["work_items", "documents", "jobs", "intents", "pages", "tasks"]);
/** Pointers often come in bursts (a sync writes many tickets); one re-read follows the last. */
export const PAGE_WATCH_DEBOUNCE_MS = 250;
export const MAX_PAGE_WATCHES = 16;
const WATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What main pushes to a page for one watch: the read's answer, or its error. */
export type PageWatchMessage = { event: "watch"; id: string; value: unknown } | { event: "watch"; id: string; error: PageCallError };

interface Watch {
  id: string;
  method: string;
  input: unknown;
  resources: readonly string[];
  floorMs: number;
  lastRunAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** A pointer came while the read ran: run once more after it. */
  dirty: boolean;
  stopped: boolean;
}

/**
 * The watches of every open page, run in main: a page names a read once, main
 * runs it now and again after each pointer for its resource (or a stream
 * gap), and pushes each answer. The page keeps only its callbacks.
 */
export function createPageWatches<Lease extends object>(deps: {
  /** The read, with the lease's own grant; refusals are `PageCallFailure`. */
  run(lease: Lease, method: string, input: unknown): Promise<unknown>;
  push(lease: Lease, message: PageWatchMessage): void;
  /** Contract methods the page may call at all. */
  methods: ReadonlySet<string>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const byLease = new WeakMap<Lease, Map<string, Watch>>();

  async function runWatch(lease: Lease, watch: Watch): Promise<void> {
    if (watch.stopped) return;
    if (watch.running) {
      watch.dirty = true;
      return;
    }
    watch.running = true;
    watch.lastRunAt = now();
    let message: PageWatchMessage;
    try {
      const value = await deps.run(lease, watch.method, watch.input);
      message = { event: "watch", id: watch.id, value: value === undefined ? null : value };
    } catch (error) {
      const failure = error instanceof PageCallFailure ? error : new PageCallFailure("source_unavailable", "The read failed. It runs again on the next change.");
      message = { event: "watch", id: watch.id, error: failure.toError() };
    } finally {
      watch.running = false;
    }
    if (watch.stopped) return;
    deps.push(lease, message);
    if (watch.dirty) {
      watch.dirty = false;
      schedule(lease, watch);
    }
  }

  function schedule(lease: Lease, watch: Watch): void {
    if (watch.stopped || watch.timer) return;
    const delay = Math.max(PAGE_WATCH_DEBOUNCE_MS, watch.lastRunAt + watch.floorMs - now());
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void runWatch(lease, watch);
    }, delay);
  }

  function stopWatch(watch: Watch): void {
    watch.stopped = true;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
  }

  return {
    start(lease: Lease, id: unknown, method: unknown, input: unknown): void {
      if (typeof id !== "string" || !WATCH_ID.test(id)) throw new PageCallFailure("invalid_input", "A watch needs an id of letters, digits, _ or -.");
      const spec = typeof method === "string" && deps.methods.has(method) && Object.hasOwn(PAGE_WATCHABLE_METHODS, method)
        ? PAGE_WATCHABLE_METHODS[method]
        : undefined;
      if (!spec) throw new PageCallFailure("not_found", `${typeof method === "string" ? method.slice(0, 100) : "This"} cannot be watched.`);
      const watches = byLease.get(lease) ?? new Map<string, Watch>();
      byLease.set(lease, watches);
      const previous = watches.get(id);
      if (previous) stopWatch(previous);
      else if (watches.size >= MAX_PAGE_WATCHES) throw new PageCallFailure("too_large", `A page can keep at most ${MAX_PAGE_WATCHES} watches.`);
      const watch: Watch = {
        id, method: method as string, input, resources: spec.resources, floorMs: spec.floorMs,
        lastRunAt: Number.NEGATIVE_INFINITY, timer: null, running: false, dirty: false, stopped: false,
      };
      watches.set(id, watch);
      void runWatch(lease, watch);
    },
    stop(lease: Lease, id: unknown): void {
      const watches = byLease.get(lease);
      const watch = typeof id === "string" ? watches?.get(id) : undefined;
      if (!watch) return;
      stopWatch(watch);
      watches!.delete(watch.id);
    },
    stopAll(lease: Lease): void {
      for (const watch of byLease.get(lease)?.values() ?? []) stopWatch(watch);
      byLease.delete(lease);
    },
    /** A pointer for one resource, or `gap` for everything, in this lease's room. */
    notify(lease: Lease, resource: string | "gap"): void {
      for (const watch of byLease.get(lease)?.values() ?? []) {
        if (resource === "gap" || watch.resources.includes(resource)) schedule(lease, watch);
      }
    },
    count(lease: Lease): number {
      return byLease.get(lease)?.size ?? 0;
    },
  };
}

export type PageWatches<Lease extends object> = ReturnType<typeof createPageWatches<Lease>>;
