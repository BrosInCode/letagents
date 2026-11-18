import { PageCallFailure, type PageCallError } from "./page-policy.js";

/**
 * Reads a page may keep watching, and the room stream resources that make
 * main run them again. A pointer re-runs a read after the debounce. A tracker
 * read also re-runs every 2 minutes when no pointer came: a ticket can change
 * in a tracker without a webhook, and the server's poll catches it then.
 */
export const PAGE_WATCHABLE_METHODS: Readonly<Record<string, { resources: readonly string[]; pollMs: number | null }>> = {
  "work_items.search": { resources: ["work_items"], pollMs: 120_000 },
  "work_items.get": { resources: ["work_items"], pollMs: 120_000 },
  "work_items.history": { resources: ["work_items"], pollMs: 120_000 },
  "data.list": { resources: ["documents"], pollMs: null },
  "data.get": { resources: ["documents"], pollMs: null },
  "jobs.list": { resources: ["jobs"], pollMs: null },
  "jobs.get": { resources: ["jobs"], pollMs: null },
  "intents.list": { resources: ["intents"], pollMs: null },
  "intents.get": { resources: ["intents"], pollMs: null },
  "tasks.list": { resources: ["tasks"], pollMs: null },
  "tasks.get": { resources: ["tasks"], pollMs: null },
  "planning.get": { resources: ["tasks"], pollMs: null },
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
  pollMs: number | null;
  /** The next run: after a pointer's debounce, a rate limit's wait, or the poll. */
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number;
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
    let message: PageWatchMessage | null;
    let retryAfterMs: number | null = null;
    try {
      const value = await deps.run(lease, watch.method, watch.input);
      message = { event: "watch", id: watch.id, value: value === undefined ? null : value };
    } catch (error) {
      const failure = error instanceof PageCallFailure ? error : new PageCallFailure("source_unavailable", "The read failed. It runs again on the next change.");
      // The server allows a few live tracker searches per room at a time: wait as long as it asks, then read again.
      if (failure.code === "rate_limited") {
        retryAfterMs = Math.max(PAGE_WATCH_DEBOUNCE_MS, failure.retryAfterMs ?? 1_000);
        message = null;
      } else {
        message = { event: "watch", id: watch.id, error: failure.toError() };
      }
    } finally {
      watch.running = false;
    }
    if (watch.stopped) return;
    if (message) deps.push(lease, message);
    if (retryAfterMs !== null) {
      schedule(lease, watch, retryAfterMs);
    } else if (watch.dirty) {
      watch.dirty = false;
      schedule(lease, watch, PAGE_WATCH_DEBOUNCE_MS);
    } else if (watch.pollMs !== null) {
      schedule(lease, watch, watch.pollMs);
    }
  }

  /**
   * Run the watch after `delay`, or sooner when a run is already due sooner.
   * A pointer (250 ms) brings a waiting poll forward; it never waits for it.
   */
  function schedule(lease: Lease, watch: Watch, delay: number): void {
    if (watch.stopped) return;
    const at = now() + delay;
    if (watch.timer) {
      if (watch.timerAt <= at) return;
      clearTimeout(watch.timer);
    }
    watch.timerAt = at;
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
        id, method: method as string, input, resources: spec.resources, pollMs: spec.pollMs,
        timer: null, timerAt: 0, running: false, dirty: false, stopped: false,
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
        if (resource !== "gap" && !watch.resources.includes(resource)) continue;
        // A pointer while the read runs means its answer may already be old: run once more after it.
        if (watch.running) watch.dirty = true;
        else schedule(lease, watch, PAGE_WATCH_DEBOUNCE_MS);
      }
    },
    count(lease: Lease): number {
      return byLease.get(lease)?.size ?? 0;
    },
  };
}

export type PageWatches<Lease extends object> = ReturnType<typeof createPageWatches<Lease>>;
