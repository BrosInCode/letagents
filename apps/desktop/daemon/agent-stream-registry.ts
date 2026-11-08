import type { DaemonActivityEvent, DaemonAgentStreamEvent } from "./types.js";

const DEFAULT_BUFFER_LIMIT = 400;
const DEFAULT_MAX_BATCH = 64;
const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_MS = 30_000;
/** A latest value (live command output) reaches the feed at most this often per key. */
const DEFAULT_LATEST_INTERVAL_MS = 250;
/** Latest values that the size limit keeps (background commands); more than this are evicted as usual. */
const MAX_STICKY_LATEST = 16;

type AgentStreamBuffer = {
  sequence: number;
  generation: number;
  generationStartSequence: number;
  events: DaemonAgentStreamEvent[];
  ended: boolean;
  /** Newest sequence that the size limit (or a reset) removed. A replaced latest value is not a loss. */
  evictedThrough: number;
  /** The buffered sequence of each latest-value key. */
  latest: Map<string, number>;
  /** Latest-value keys that the size limit keeps. */
  sticky: Set<string>;
};

type PendingLatest = {
  event: DaemonActivityEvent;
  sticky: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export type AgentStreamLatestOptions = {
  /** Kept by the size limit while it is the newest value of its key: a background command that still runs. */
  sticky?: boolean;
  /** Skip the pace: a final value (a command that ended) is sent at once. */
  immediate?: boolean;
};

export type AgentStreamWatchInput = {
  entryId: string;
  afterSequence: number;
  waitMs: number;
};

export type AgentStreamWatchResult = {
  sequence: number;
  stream_generation: number;
  dropped_events: number;
  events: DaemonAgentStreamEvent[];
  ended: boolean;
};

export type AgentStreamRegistryOptions = {
  isHandoffScheduled?: () => boolean;
  bufferLimit?: number;
  maxBatch?: number;
  latestIntervalMs?: number;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

/**
 * Process-local, bounded live-event feeds for focused agent inspectors.
 *
 * The registry deliberately owns both buffers and long-poll waiters so an
 * entry deletion cannot leave either its ephemeral transcript or a resident
 * watcher behind.
 */
export class AgentStreamRegistry {
  private readonly streams = new Map<string, AgentStreamBuffer>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly pendingLatest = new Map<string, Map<string, PendingLatest>>();
  private readonly latestSentAt = new Map<string, Map<string, number>>();
  private readonly isHandoffScheduled: () => boolean;
  private readonly bufferLimit: number;
  private readonly maxBatch: number;
  private readonly latestIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: AgentStreamRegistryOptions = {}) {
    this.isHandoffScheduled = options.isHandoffScheduled ?? (() => false);
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.latestIntervalMs = options.latestIntervalMs ?? DEFAULT_LATEST_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  /** Append one redacted event to an agent's ephemeral live feed. Returns it as the feed holds it, or null for an ended feed. */
  push(entryId: string, event: DaemonActivityEvent): DaemonAgentStreamEvent | null {
    return this.append(entryId, event, null, false);
  }

  /**
   * Put the newest value of one key in the feed: the live output of a running
   * command, or the state of a background command. A key has at most one
   * event in the feed: a new value takes the place of the one before it, so
   * long output never pushes the agent's other events out of the bounded
   * buffer. Values reach the feed at most once per interval per key; the last
   * value of a burst is always sent. The feed's consumers receive the key as
   * `latest_key` and drop an earlier event with the same key.
   */
  pushLatest(entryId: string, key: string, event: DaemonActivityEvent, options: AgentStreamLatestOptions = {}): void {
    const sticky = options.sticky === true;
    const entryPending = this.pendingLatest.get(entryId) ?? new Map<string, PendingLatest>();
    const waiting = entryPending.get(key);
    const sentAt = this.latestSentAt.get(entryId)?.get(key);
    const now = this.now();
    if (options.immediate || (!waiting && (sentAt === undefined || now - sentAt >= this.latestIntervalMs))) {
      if (waiting?.timer) this.clearTimer(waiting.timer);
      entryPending.delete(key);
      if (entryPending.size === 0) this.pendingLatest.delete(entryId);
      this.sendLatest(entryId, key, event, sticky);
      return;
    }
    if (waiting) {
      waiting.event = event;
      waiting.sticky = sticky;
      return;
    }
    const pending: PendingLatest = { event, sticky, timer: null };
    pending.timer = this.setTimer(() => {
      const current = this.pendingLatest.get(entryId);
      if (current?.get(key) !== pending) return;
      current.delete(key);
      if (current.size === 0) this.pendingLatest.delete(entryId);
      this.sendLatest(entryId, key, pending.event, pending.sticky);
    }, Math.max(0, (sentAt ?? now) + this.latestIntervalMs - now));
    (pending.timer as { unref?: () => void }).unref?.();
    entryPending.set(key, pending);
    this.pendingLatest.set(entryId, entryPending);
  }

  /** Forget a value of this key that waits for its turn: its command has ended, and its final event says so. */
  dropLatest(entryId: string, key: string): void {
    const entryPending = this.pendingLatest.get(entryId);
    const waiting = entryPending?.get(key);
    if (!entryPending || !waiting) return;
    if (waiting.timer) this.clearTimer(waiting.timer);
    entryPending.delete(key);
    if (entryPending.size === 0) this.pendingLatest.delete(entryId);
  }

  private sendLatest(entryId: string, key: string, event: DaemonActivityEvent, sticky: boolean): void {
    const buffer = this.streams.get(entryId);
    if (buffer && !buffer.ended) {
      const previous = buffer.latest.get(key);
      if (previous !== undefined) {
        const index = buffer.events.findIndex((stored) => stored.sequence === previous);
        if (index >= 0) buffer.events.splice(index, 1);
        buffer.latest.delete(key);
        buffer.sticky.delete(key);
      }
    }
    if (!this.append(entryId, event, key, sticky)) return;
    const sent = this.latestSentAt.get(entryId) ?? new Map<string, number>();
    sent.set(key, this.now());
    this.latestSentAt.set(entryId, sent);
  }

  private append(entryId: string, event: DaemonActivityEvent, latestKey: string | null, sticky: boolean): DaemonAgentStreamEvent | null {
    const buffer = this.streams.get(entryId) ?? newBuffer(1);
    if (buffer.ended) return null;
    buffer.sequence += 1;
    const stored: DaemonAgentStreamEvent = {
      sequence: buffer.sequence,
      observed_at: event.observed_at,
      kind: event.kind,
      method: event.method,
      summary: event.summary || null,
      payload: event.payload,
      ...(latestKey ? { latest_key: latestKey } : {}),
    };
    buffer.events.push(stored);
    if (latestKey) {
      buffer.latest.set(latestKey, stored.sequence);
      if (sticky && (buffer.sticky.has(latestKey) || buffer.sticky.size < MAX_STICKY_LATEST)) buffer.sticky.add(latestKey);
    }
    while (buffer.events.length > this.bufferLimit) {
      // The oldest event goes, unless it is the newest value of a sticky key: a background command that still runs.
      const keep = (stored: DaemonAgentStreamEvent) => stored.latest_key !== undefined && buffer.sticky.has(stored.latest_key)
        && buffer.latest.get(stored.latest_key) === stored.sequence;
      const index = Math.max(0, buffer.events.findIndex((stored) => !keep(stored)));
      const [evicted] = buffer.events.splice(index, 1);
      buffer.evictedThrough = Math.max(buffer.evictedThrough, evicted!.sequence);
      if (evicted!.latest_key && buffer.latest.get(evicted!.latest_key) === evicted!.sequence) {
        buffer.latest.delete(evicted!.latest_key);
        buffer.sticky.delete(evicted!.latest_key);
      }
    }
    this.streams.set(entryId, buffer);
    this.notifyWaiters(entryId);
    return stored;
  }

  /** Start one bounded display generation without replaying an older turn. */
  reset(entryId: string): void {
    const buffer = this.streams.get(entryId) ?? newBuffer(0);
    this.forgetLatest(entryId);
    buffer.generation += 1;
    buffer.generationStartSequence = buffer.sequence + 1;
    buffer.evictedThrough = buffer.sequence;
    buffer.events = [];
    buffer.latest.clear();
    buffer.sticky.clear();
    buffer.ended = false;
    this.streams.set(entryId, buffer);
    this.notifyWaiters(entryId);
  }

  /** Mark an agent's live feed closed and wake its watchers. */
  end(entryId: string): void {
    const buffer = this.streams.get(entryId);
    if (!buffer || buffer.ended) return;
    this.forgetLatest(entryId);
    buffer.ended = true;
    this.notifyWaiters(entryId);
  }

  /** Wake outstanding watches, then forget all ephemeral state for an entry. */
  delete(entryId: string): void {
    this.notifyWaiters(entryId);
    this.forgetLatest(entryId);
    this.streams.delete(entryId);
    this.waiters.delete(entryId);
  }

  private forgetLatest(entryId: string): void {
    for (const waiting of this.pendingLatest.get(entryId)?.values() ?? []) {
      if (waiting.timer) this.clearTimer(waiting.timer);
    }
    this.pendingLatest.delete(entryId);
    this.latestSentAt.delete(entryId);
  }

  /** The newest sequence an agent's feed has given out; 0 before its first event. */
  highWater(entryId: string): number {
    return this.streams.get(entryId)?.sequence ?? 0;
  }

  /**
   * Every retained event after `afterSequence`, oldest first, without waiting
   * or advancing any watcher. `dropped` says the buffer no longer holds some
   * of them.
   */
  retainedAfter(entryId: string, afterSequence: number): { events: DaemonAgentStreamEvent[]; dropped: boolean } {
    const buffer = this.streams.get(entryId);
    if (!buffer) return { events: [], dropped: false };
    const events = buffer.events.filter((event) => event.sequence > afterSequence);
    return { events, dropped: buffer.evictedThrough > afterSequence };
  }

  async watch(input: AgentStreamWatchInput): Promise<AgentStreamWatchResult> {
    const waitMs = Number.isFinite(input.waitMs)
      ? Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(input.waitMs)))
      : DEFAULT_WAIT_MS;
    let current = this.snapshot(input.entryId, input.afterSequence);
    if (!this.isHandoffScheduled() && current.events.length === 0 && !current.ended && waitMs > 0) {
      // There is only one focused inspector consumer. A replacement watch must
      // release an older long poll for the same entry instead of leaving it
      // resident until its timeout after rapid close/reopen cycles.
      this.notifyWaiters(input.entryId);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          this.waiters.get(input.entryId)?.delete(finish);
          resolve();
        };
        const timer = this.setTimer(finish, waitMs);
        const waiters = this.waiters.get(input.entryId) ?? new Set<() => void>();
        waiters.add(finish);
        this.waiters.set(input.entryId, waiters);
      });
      current = this.snapshot(input.entryId, input.afterSequence);
    }
    return current;
  }

  private snapshot(entryId: string, afterSequence: number): AgentStreamWatchResult {
    const buffer = this.streams.get(entryId);
    if (!buffer) {
      return {
        sequence: afterSequence,
        stream_generation: 0,
        dropped_events: 0,
        events: [],
        ended: false,
      };
    }
    const effectiveAfter = Math.max(afterSequence, buffer.generationStartSequence - 1);
    const events = buffer.events
      .filter((event) => event.sequence > effectiveAfter)
      .slice(0, this.maxBatch);
    // Advance only to the last delivered event. Advancing to the producer's
    // high-water mark would strand events beyond the batch cap.
    const sequence = events.length > 0
      ? events[events.length - 1]!.sequence
      : Math.max(afterSequence, buffer.generationStartSequence - 1);
    // Evicted events after the cursor; a sticky value kept from before an eviction is not one of them.
    const keptBefore = buffer.events.filter((event) => event.sequence > effectiveAfter
      && event.sequence <= buffer.evictedThrough).length;
    const droppedEvents = Math.max(0, buffer.evictedThrough - effectiveAfter - keptBefore);
    // An ended generation remains drainable until every retained event has
    // crossed the returned cursor.
    const ended = buffer.ended && sequence >= buffer.sequence;
    return {
      sequence,
      stream_generation: buffer.generation,
      dropped_events: droppedEvents,
      events,
      ended,
    };
  }

  private notifyWaiters(entryId: string): void {
    const waiters = this.waiters.get(entryId);
    if (!waiters) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
}

function newBuffer(generation: number): AgentStreamBuffer {
  return {
    sequence: 0,
    generation,
    generationStartSequence: 1,
    events: [],
    ended: false,
    evictedThrough: 0,
    latest: new Map(),
    sticky: new Set(),
  };
}
