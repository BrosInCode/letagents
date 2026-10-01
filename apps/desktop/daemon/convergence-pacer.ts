import { PacedQueue } from "../../../shared/paced-queue.mjs";

/**
 * Daemon-wide pacing for convergence work that loads the room server or the
 * machine. A daemon handoff converges every running agent at once. Unpaced,
 * every agent mints, binds and launches in the same few seconds, the server
 * stalls, and fixed per-request timeouts strand agents that would each have
 * succeeded on their own.
 *
 * Only leaf operations are paced: a paced operation never waits for another
 * operation in its own lane, so a lane cannot deadlock on itself. Time spent
 * queued is never part of an operation: callers start their own timeouts and
 * startup budgets after a slot is granted. The queue itself is shared with
 * Electron's grant reconciliation (shared/paced-queue.mjs).
 */

/** Concurrent server-bound authority requests: worker mints, lease continuity and bound announcements. */
export const SERVER_AUTHORITY_CONCURRENCY = 4;
/**
 * Authority slots only a user's action may use, so Reconnect, Restart or a
 * new agent never waits for background convergence to free a slot.
 */
export const INTERACTIVE_RESERVED_AUTHORITY_SLOTS = 1;
/** Concurrent cold provider launches (spawn or resume, including a Claude bootstrap turn). */
export const PROVIDER_LAUNCH_CONCURRENCY = 3;
/** Upper bound of the random pause before an operation that had to queue, so a released batch spreads out. */
export const PACED_START_JITTER_MS = 200;
/** A user action on an agent keeps that agent at the front of every queue for this long. */
export const INTERACTIVE_PRIORITY_WINDOW_MS = 120_000;
/**
 * A slot is handed on after this long even if its operation never settles.
 * Every paced operation has its own timeout; this only guarantees that one
 * wedged call cannot hold the queue forever.
 */
export const PACED_SLOT_LEASE_MS = { authority: 30_000, launch: 120_000 } as const;

export type PacedLane = keyof typeof PACED_SLOT_LEASE_MS;
export type PacedPriority = "interactive" | "pending_work" | "background";

const LANE_CAPACITY: Record<PacedLane, number> = {
  authority: SERVER_AUTHORITY_CONCURRENCY,
  launch: PROVIDER_LAUNCH_CONCURRENCY,
};
const LANE_RESERVED_FOR_INTERACTIVE: Record<PacedLane, number> = {
  authority: INTERACTIVE_RESERVED_AUTHORITY_SLOTS,
  launch: 0,
};
const PRIORITY_RANK: Record<PacedPriority, number> = { interactive: 0, pending_work: 1, background: 2 };

export type ConvergencePacerOptions = {
  /** True when the agent has queued room work that the paced operation unblocks. */
  hasPendingWork(entryId: string): Promise<boolean>;
  nowMs?: () => number;
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type ConvergencePacing = Pick<ConvergencePacer, "run" | "acquire">;

/** The daemon is stopping or handing off; queued work must not reach the server or start providers. */
export class ConvergencePacerClosedError extends Error {
  constructor() {
    super("The daemon is shutting down; queued agent work was cancelled.");
    this.name = "ConvergencePacerClosedError";
  }
}

export class ConvergencePacer {
  private readonly lanes: Record<PacedLane, PacedQueue>;
  private readonly interactiveUntilMs = new Map<string, number>();
  private readonly nowMs: () => number;

  constructor(private readonly options: ConvergencePacerOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    const lane = (name: PacedLane) => new PacedQueue({
      capacity: LANE_CAPACITY[name],
      reservedForUrgent: LANE_RESERVED_FOR_INTERACTIVE[name],
      leaseMs: PACED_SLOT_LEASE_MS[name],
      startJitterMs: PACED_START_JITTER_MS,
      ...(options.random ? { random: options.random } : {}),
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    });
    this.lanes = { authority: lane("authority"), launch: lane("launch") };
  }

  /** Run one leaf operation inside a lane slot. Start its timeouts inside `operation`. */
  async run<T>(lane: PacedLane, entryId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(lane, entryId, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Wait for a lane slot. The returned release is idempotent; callers that
   * need a fence between the grant and the paced work use this form.
   * Aborting `signal` while queued gives up the place and rejects.
   */
  acquire(lane: PacedLane, entryId: string, signal?: AbortSignal): Promise<() => void> {
    return this.lanes[lane].acquire(entryId, {
      ...(signal ? { signal } : {}),
      rank: async () => PRIORITY_RANK[await this.priority(entryId)],
      // User actions start the moment they are admitted.
      pauseWhenQueued: () => !this.isInteractive(entryId),
    });
  }

  /** A user acted on this agent: its queued and future operations go first. */
  markInteractive(entryId: string): void {
    this.interactiveUntilMs.set(entryId, this.nowMs() + INTERACTIVE_PRIORITY_WINDOW_MS);
    for (const lane of Object.values(this.lanes)) lane.reprioritize(entryId, PRIORITY_RANK.interactive);
  }

  /**
   * Final stop and handoff never wait on the queue. Queued work is cancelled
   * rather than released, so a retiring daemon cannot send it all at once.
   */
  close(): void {
    for (const lane of Object.values(this.lanes)) lane.close(() => new ConvergencePacerClosedError());
  }

  snapshot(lane: PacedLane): { active: number; queued: string[] } {
    return this.lanes[lane].snapshot();
  }

  private isInteractive(entryId: string): boolean {
    const until = this.interactiveUntilMs.get(entryId);
    if (until === undefined) return false;
    if (until > this.nowMs()) return true;
    this.interactiveUntilMs.delete(entryId);
    return false;
  }

  private async priority(entryId: string): Promise<PacedPriority> {
    if (this.isInteractive(entryId)) return "interactive";
    try {
      return await this.options.hasPendingWork(entryId) ? "pending_work" : "background";
    } catch {
      return "background";
    }
  }
}
