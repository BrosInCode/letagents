import { EventEmitter } from "node:events";

import type {
  DesktopLaunchEvent,
  DesktopLaunchEventType,
  DesktopLaunchRecoveryAction,
  DesktopSupervisorManifestEntry,
} from "../ipc-types.js";

/**
 * Electron-owned launch event hub (task_84).
 *
 * Electron owns the pre-durable launch facts — an unreachable background
 * service cannot report its own unreachability — so the desktop records the
 * connect/save/activate window here and pushes it to the renderer. Each launch
 * has its own monotonically increasing `sequence`; `getLaunchEvents` lets a
 * reopened modal replay everything after a cursor (at-least-once + idempotent).
 *
 * This buffer remains the live source for pre-claim observations. Once the
 * daemon is reachable those observations are imported into its audit-backed
 * launch journal; post-claim facts are daemon-owned. A reopened renderer merges
 * this buffer with the durable replay, preferring the daemon for matching
 * sequences.
 */

const MAX_EVENTS_PER_LAUNCH = 64;
const MAX_TRACKED_LAUNCHES = 128;

interface LaunchRecord {
  events: DesktopLaunchEvent[];
  sequence: number;
  updatedAt: number;
}

const launches = new Map<string, LaunchRecord>();
const emitter = new EventEmitter();
const DURABLE_LAUNCH_TERMINALS = new Set<DesktopLaunchEventType>([
  "agent.ready", "launch.blocked", "launch.failed", "launch.cancelled",
]);

export interface EmitLaunchEventInput {
  launchId: string;
  roomIdentifier: string;
  provider: string;
  type: DesktopLaunchEventType;
  entryId?: string | null;
  detail?: string | null;
  recovery?: DesktopLaunchRecoveryAction | null;
  durable?: boolean;
}

export function emitLaunchEvent(input: EmitLaunchEventInput): DesktopLaunchEvent {
  let record = launches.get(input.launchId);
  if (!record) {
    pruneLaunches();
    record = { events: [], sequence: 0, updatedAt: 0 };
    launches.set(input.launchId, record);
  }
  record.sequence += 1;
  record.updatedAt = Date.now();
  const event: DesktopLaunchEvent = {
    launchId: input.launchId,
    entryId: input.entryId ?? null,
    roomIdentifier: input.roomIdentifier,
    provider: input.provider,
    sequence: record.sequence,
    type: input.type,
    at: new Date().toISOString(),
    detail: input.detail ?? null,
    recovery: input.recovery ?? null,
    durable: input.durable ?? false,
  };
  record.events.push(event);
  if (record.events.length > MAX_EVENTS_PER_LAUNCH) {
    record.events.splice(0, record.events.length - MAX_EVENTS_PER_LAUNCH);
  }
  emitter.emit("launch-event", event);
  return event;
}

/** Replay a launch's events after `afterSequence` (exclusive). Empty when the
 * launch is unknown to this desktop process (e.g. after an app restart). */
export function getLaunchEvents(launchId: string, afterSequence?: number | null): DesktopLaunchEvent[] {
  const record = launches.get(launchId);
  if (!record) return [];
  const cursor = typeof afterSequence === "number" && Number.isFinite(afterSequence) ? afterSequence : 0;
  return record.events.filter((event) => event.sequence > cursor);
}

/**
 * Replace the transient buffer with the daemon-authoritative replay. This also
 * advances the local sequence allocator, which is essential when a retry under
 * the same launch id follows daemon-owned milestones created after Electron's
 * last local event.
 */
export function reconcileLaunchEvents(events: readonly DesktopLaunchEvent[]): void {
  if (events.length === 0) return;
  const launchId = events[0]!.launchId;
  if (events.some((event) => event.launchId !== launchId)) throw new Error("Launch replay contains mixed launch ids.");
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  const ordered = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-MAX_EVENTS_PER_LAUNCH);
  launches.set(launchId, {
    events: ordered,
    sequence: ordered.reduce((maximum, event) => Math.max(maximum, event.sequence), 0),
    updatedAt: Date.now(),
  });
  // Live consumers fold at-least-once and prefer the durable fact for an
  // occupied sequence, so replaying the reconciled tail is safe.
  for (const event of ordered) emitter.emit("launch-event", event);
}

/**
 * Follow the daemon's long-poll journal feed until this attempt reaches a
 * semantic terminal. This is event delivery, not manifest polling: each wait
 * blocks inside the daemon and wakes only when the audit journal appends.
 */
export async function followDurableLaunchEvents(
  launchId: string,
  waitForEvents: (afterSequence: number) => Promise<DesktopLaunchEvent[]>,
  retryDelay: () => Promise<void>,
): Promise<void> {
  let cursor = getLaunchEvents(launchId).reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  while (true) {
    try {
      const durable = await waitForEvents(cursor);
      if (!durable.length) continue;
      reconcileLaunchEvents([...getLaunchEvents(launchId), ...durable]);
      cursor = durable.reduce((maximum, event) => Math.max(maximum, event.sequence), cursor);
      if (latestLaunchAttemptIsTerminal(getLaunchEvents(launchId))) return;
    } catch {
      await retryDelay();
    }
  }
}

/**
 * A launch id survives retries, so replay can contain a terminal from an old
 * attempt followed by a newer `launch.requested`. Only the newest attempt may
 * stop the live follower; otherwise reopening during a retry would silently
 * miss every durable fact appended after that historical terminal.
 */
function latestLaunchAttemptIsTerminal(events: readonly DesktopLaunchEvent[]): boolean {
  let sawRequest = false;
  let terminal = false;
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "launch.requested") {
      sawRequest = true;
      terminal = false;
      continue;
    }
    if (sawRequest && DURABLE_LAUNCH_TERMINALS.has(event.type)) terminal = true;
  }
  return sawRequest && terminal;
}

export function onLaunchEvent(listener: (event: DesktopLaunchEvent) => void): () => void {
  emitter.on("launch-event", listener);
  return () => emitter.off("launch-event", listener);
}

/** Test seam: drop all buffered launches and listeners. */
export function resetLaunchEventsForTest(): void {
  launches.clear();
  emitter.removeAllListeners("launch-event");
}

function pruneLaunches(): void {
  if (launches.size < MAX_TRACKED_LAUNCHES) return;
  // Drop the least-recently-updated launches first to bound memory.
  const ordered = [...launches.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  const dropCount = launches.size - MAX_TRACKED_LAUNCHES + 1;
  for (let index = 0; index < dropCount && index < ordered.length; index += 1) {
    launches.delete(ordered[index]![0]);
  }
}

/**
 * A launch that cannot proceed until the owner changes something (bad room,
 * capability gate, provider sign-in). Distinct from an unexpected failure: it
 * maps to `launch.blocked` with a plain recovery action, and its message is
 * already product-safe so it can surface directly to the user.
 */
export class LaunchBlockedError extends Error {
  readonly recovery: DesktopLaunchRecoveryAction;
  constructor(message: string, recovery: DesktopLaunchRecoveryAction) {
    super(message);
    this.name = "LaunchBlockedError";
    this.recovery = recovery;
  }
}

/**
 * Map a create-agent failure to a terminal launch fact. Blocked errors carry a
 * product-safe message and recovery; anything else is an unexpected failure and
 * gets a generic, secret-free message with a retry affordance (the raw error is
 * still thrown to the caller for diagnostics).
 */
/**
 * True when a supervised entry has EVER reached ready — durable, monotonic
 * evidence (the daemon stamps `readyReachedAt` once and never clears it) that
 * the launch succeeded. This is stronger than "ever bound": a bound-but-never-
 * reachable, pre-ready attempt has no ready stamp, so cancelling it is correctly
 * a cancelled launch; while a ready agent that later degrades to
 * unreachable/recovering keeps its stamp, so stopping it is a lifecycle event
 * (not a cancelled launch). Kept consistent with the renderer journey's
 * `everReady` check.
 */
export function supervisedLaunchEverReady(
  entry: Pick<DesktopSupervisorManifestEntry, "readyReachedAt">,
): boolean {
  return entry.readyReachedAt != null;
}

export function classifyLaunchFailure(error: unknown): {
  type: Extract<DesktopLaunchEventType, "launch.blocked" | "launch.failed">;
  recovery: DesktopLaunchRecoveryAction;
  detail: string;
} {
  if (error instanceof LaunchBlockedError) {
    return { type: "launch.blocked", recovery: error.recovery, detail: error.message };
  }
  return {
    type: "launch.failed",
    recovery: "retry",
    detail: "The launch could not be completed. You can try again.",
  };
}
