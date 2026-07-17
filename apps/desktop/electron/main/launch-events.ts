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
 * This buffer is intentionally in-memory and transient: the durable record of a
 * launch is the daemon manifest entry itself. On app restart mid-launch the
 * buffer is empty, and the renderer recovers post-claim progress from the
 * manifest snapshot it already polls. The fully-durable daemon journal is a
 * tracked follow-up.
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
 * True when a supervised entry has EVER bound a room identity — durable,
 * monotonic evidence that the launch succeeded past registration. Binding state
 * only advances none → active → historical and never returns to "none", so this
 * is a historical fact, unlike instantaneous readiness (a ready agent that later
 * degrades to unreachable/recovering is still a launched agent). Stopping such
 * an agent is a lifecycle event, not a cancelled launch, so `launch.cancelled`
 * must not be emitted for it. Kept consistent with the renderer journey's
 * `everBound` check.
 */
export function supervisedLaunchEverBound(
  entry: Pick<DesktopSupervisorManifestEntry, "agentSessionBindingState">,
): boolean {
  return entry.agentSessionBindingState !== "none";
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
