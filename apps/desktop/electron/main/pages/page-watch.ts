import { PageCallFailure, type PageCallError } from "./page-policy.js";

/**
 * Reads a page may keep watching, and the room stream resources that make
 * main run them again. A pointer re-runs a read after the debounce. A tracker
 * read also re-runs every 2 minutes when no pointer came: a ticket can change
 * in a tracker without a webhook, and the server's poll catches it then.
 *
 * The planning read re-runs every minute, the cadence of the app's own
 * release widget: an edit of a sprint or a release sends no room event, so
 * only a task change would run it again. (Until 2026-11 every stream
 * keep-alive counted as a gap and re-ran all watches every 15 seconds.)
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
  "planning.get": { resources: ["tasks"], pollMs: 60_000 },
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
  /** The next run of this watch alone: a rate limit's wait, the call budget's, or the poll. */
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number;
  running: boolean;
  /** A pointer came while the read ran: run once more after it. */
  dirty: boolean;
  stopped: boolean;
  /** The first run is part of the `events.watch` call, which paid for it. */
  started: boolean;
}

interface LeaseWatches {
  watches: Map<string, Watch>;
  /** Watches a pointer named since the last batch; they run together. */
  pending: Set<Watch>;
  batch: ReturnType<typeof setTimeout> | null;
}

/**
 * The watches of every open page, run in main: a page names a read once, main
 * runs it now and again after each pointer for its resource (or a stream
 * gap), and pushes each answer. The page keeps only its callbacks.
 *
 * Pointers are batched per lease: the first starts a 250 ms wait, and every
 * watch named until it ends runs once then. Each re-run also costs a token
 * from the page's own call budget (`take`), so 16 watches cannot call faster
 * than the page itself may; a watch out of budget runs later, never not at all.
 */
export function createPageWatches<Lease extends object>(deps: {
  /** The read, with the lease's own grant; refusals are `PageCallFailure`. */
  run(lease: Lease, method: string, input: unknown): Promise<unknown>;
  push(lease: Lease, message: PageWatchMessage): void;
  /** Contract methods the page may call at all. */
  methods: ReadonlySet<string>;
  /** Takes one call from the lease's budget: 0 when taken, else the wait in ms. */
  take?(lease: Lease): number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const byLease = new WeakMap<Lease, LeaseWatches>();

  async function runWatch(lease: Lease, watch: Watch): Promise<void> {
    if (watch.stopped) return;
    if (watch.running) {
      watch.dirty = true;
      return;
    }
    if (watch.started) {
      const wait = deps.take?.(lease) ?? 0;
      if (wait > 0) {
        schedule(lease, watch, Math.max(PAGE_WATCH_DEBOUNCE_MS, wait));
        return;
      }
    }
    // This run answers whatever the scheduled one would have.
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    watch.started = true;
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
      queue(lease, watch);
    } else if (watch.pollMs !== null) {
      schedule(lease, watch, watch.pollMs);
    }
  }

  /** Run this watch alone after `delay`, or sooner when a run is already due sooner. */
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

  /** Run this watch with the lease's next batch; the first pointer of a burst starts it. */
  function queue(lease: Lease, watch: Watch): void {
    const state = byLease.get(lease);
    if (!state || watch.stopped) return;
    state.pending.add(watch);
    if (state.batch) return;
    state.batch = setTimeout(() => {
      state.batch = null;
      const due = [...state.pending];
      state.pending.clear();
      for (const next of due) void runWatch(lease, next);
    }, PAGE_WATCH_DEBOUNCE_MS);
  }

  function stopWatch(state: LeaseWatches, watch: Watch): void {
    watch.stopped = true;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    state.pending.delete(watch);
  }

  return {
    start(lease: Lease, id: unknown, method: unknown, input: unknown): void {
      if (typeof id !== "string" || !WATCH_ID.test(id)) throw new PageCallFailure("invalid_input", "A watch needs an id of letters, digits, _ or -.");
      const spec = typeof method === "string" && deps.methods.has(method) && Object.hasOwn(PAGE_WATCHABLE_METHODS, method)
        ? PAGE_WATCHABLE_METHODS[method]
        : undefined;
      if (!spec) throw new PageCallFailure("not_found", `${typeof method === "string" ? method.slice(0, 100) : "This"} cannot be watched.`);
      const state = byLease.get(lease) ?? { watches: new Map<string, Watch>(), pending: new Set<Watch>(), batch: null };
      byLease.set(lease, state);
      const previous = state.watches.get(id);
      if (previous) stopWatch(state, previous);
      else if (state.watches.size >= MAX_PAGE_WATCHES) throw new PageCallFailure("too_large", `A page can keep at most ${MAX_PAGE_WATCHES} watches.`);
      const watch: Watch = {
        id, method: method as string, input, resources: spec.resources, pollMs: spec.pollMs,
        timer: null, timerAt: 0, running: false, dirty: false, stopped: false, started: false,
      };
      state.watches.set(id, watch);
      void runWatch(lease, watch);
    },
    stop(lease: Lease, id: unknown): void {
      const state = byLease.get(lease);
      const watch = typeof id === "string" ? state?.watches.get(id) : undefined;
      if (!state || !watch) return;
      stopWatch(state, watch);
      state.watches.delete(watch.id);
    },
    stopAll(lease: Lease): void {
      const state = byLease.get(lease);
      if (!state) return;
      for (const watch of state.watches.values()) stopWatch(state, watch);
      if (state.batch) clearTimeout(state.batch);
      byLease.delete(lease);
    },
    /** A pointer for one resource, or `gap` for everything, in this lease's room. */
    notify(lease: Lease, resource: string | "gap"): void {
      for (const watch of byLease.get(lease)?.watches.values() ?? []) {
        if (resource !== "gap" && !watch.resources.includes(resource)) continue;
        // A pointer while the read runs means its answer may already be old: run once more after it.
        if (watch.running) watch.dirty = true;
        else queue(lease, watch);
      }
    },
    count(lease: Lease): number {
      return byLease.get(lease)?.watches.size ?? 0;
    },
  };
}

export type PageWatches<Lease extends object> = ReturnType<typeof createPageWatches<Lease>>;
