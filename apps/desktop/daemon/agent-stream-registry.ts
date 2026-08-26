import type { DaemonActivityEvent, DaemonAgentStreamEvent } from "./types.js";

const DEFAULT_BUFFER_LIMIT = 400;
const DEFAULT_MAX_BATCH = 64;
const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_MS = 30_000;

type AgentStreamBuffer = {
  sequence: number;
  generation: number;
  generationStartSequence: number;
  events: DaemonAgentStreamEvent[];
  ended: boolean;
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
  private readonly isHandoffScheduled: () => boolean;
  private readonly bufferLimit: number;
  private readonly maxBatch: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: AgentStreamRegistryOptions = {}) {
    this.isHandoffScheduled = options.isHandoffScheduled ?? (() => false);
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
  }

  /** Append one redacted event to an agent's ephemeral live feed. */
  push(entryId: string, event: DaemonActivityEvent): void {
    const buffer = this.streams.get(entryId) ?? {
      sequence: 0,
      generation: 1,
      generationStartSequence: 1,
      events: [],
      ended: false,
    };
    if (buffer.ended) return;
    buffer.sequence += 1;
    buffer.events.push({
      sequence: buffer.sequence,
      observed_at: event.observed_at,
      kind: event.kind,
      method: event.method,
      summary: event.summary || null,
      payload: event.payload,
    });
    if (buffer.events.length > this.bufferLimit) {
      buffer.events.splice(0, buffer.events.length - this.bufferLimit);
    }
    this.streams.set(entryId, buffer);
    this.notifyWaiters(entryId);
  }

  /** Start one bounded display generation without replaying an older turn. */
  reset(entryId: string): void {
    const buffer = this.streams.get(entryId) ?? {
      sequence: 0,
      generation: 0,
      generationStartSequence: 1,
      events: [],
      ended: false,
    };
    buffer.generation += 1;
    buffer.generationStartSequence = buffer.sequence + 1;
    buffer.events = [];
    buffer.ended = false;
    this.streams.set(entryId, buffer);
    this.notifyWaiters(entryId);
  }

  /** Mark an agent's live feed closed and wake its watchers. */
  end(entryId: string): void {
    const buffer = this.streams.get(entryId);
    if (!buffer || buffer.ended) return;
    buffer.ended = true;
    this.notifyWaiters(entryId);
  }

  /** Wake outstanding watches, then forget all ephemeral state for an entry. */
  delete(entryId: string): void {
    this.notifyWaiters(entryId);
    this.streams.delete(entryId);
    this.waiters.delete(entryId);
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
    const oldestRetained = buffer.events[0]?.sequence ?? buffer.sequence + 1;
    const droppedEvents = Math.max(0, oldestRetained - effectiveAfter - 1);
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
