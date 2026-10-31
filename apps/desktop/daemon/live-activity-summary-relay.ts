import {
  isHumanVisibleSupervisorActivity,
  publicLiveActivitySummary,
  roomVisibleSupervisorActivitySummary,
} from "../../../shared/live-activity-summary.mjs";
import { redactCredentialText } from "./credential-redaction.js";
import type { DaemonActivityEvent } from "./types.js";

/** A changed activity line reaches the room at most this often per agent. */
export const LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS = 3_000;

/** The presence status a summary publication reports, or null when it must not publish now (the line stays pending). */
export type LiveActivitySummaryStatus = () => "working" | "idle" | null | Promise<"working" | "idle" | null>;

type SummaryState = {
  latest: string | null;
  /** The value the room last received, or is receiving. */
  sent: string | null;
  sentAtMs: number;
  status: LiveActivitySummaryStatus;
  timer: ReturnType<typeof setTimeout> | null;
};

export type LiveActivitySummaryRelayOptions = {
  /** Publish native activity for the agent; the publication attaches `take()`. */
  publish(entryId: string, status: "working" | "idle"): Promise<unknown>;
  nowMs?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  minIntervalMs?: number;
};

/**
 * The room's version of the owner's live-strip line, from the same event (the
 * newest human-visible working event of the turn). Provider free text never
 * passes, except the Codex reasoning summary: its credentials are redacted
 * and its machine paths reduced to file names. Returns undefined when the
 * event says nothing about the line, so the last line stays, as it does on
 * the owner's desktop.
 */
export function liveActivitySummaryForEvent(
  event: Pick<DaemonActivityEvent, "kind" | "method" | "summary" | "status">,
): string | undefined {
  if (event.status !== "working" && event.status !== "reviewing") return undefined;
  if (!isHumanVisibleSupervisorActivity(event)) return undefined;
  const summary = redactCredentialText(event.summary, 2_000).value;
  return publicLiveActivitySummary(roomVisibleSupervisorActivitySummary({ ...event, summary })) ?? undefined;
}

/**
 * Keeps the newest activity line of each agent and decides when it reaches
 * the room. A change is published at most once per minimum interval; a change
 * inside the interval waits for its end, and only the newest line is sent.
 * Every publication of a working agent, the heartbeat included, carries the
 * newest line the interval allows, so a lost publication is repaired by the
 * next heartbeat.
 */
export class LiveActivitySummaryRelay {
  private readonly states = new Map<string, SummaryState>();
  private readonly nowMs: () => number;
  private readonly setTimer: NonNullable<LiveActivitySummaryRelayOptions["setTimeout"]>;
  private readonly clearTimer: NonNullable<LiveActivitySummaryRelayOptions["clearTimeout"]>;
  private readonly minIntervalMs: number;

  constructor(private readonly options: LiveActivitySummaryRelayOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    this.minIntervalMs = options.minIntervalMs ?? LIVE_ACTIVITY_SUMMARY_MIN_INTERVAL_MS;
  }

  /** Record the agent's newest line; null clears it (the turn ended). */
  observe(entryId: string, summary: string | null, status: LiveActivitySummaryStatus): void {
    const value = publicLiveActivitySummary(summary);
    let state = this.states.get(entryId);
    if (!state) {
      if (value === null) return;
      state = { latest: null, sent: null, sentAtMs: Number.NEGATIVE_INFINITY, status, timer: null };
      this.states.set(entryId, state);
    }
    state.status = status;
    if (value === state.latest) return;
    state.latest = value;
    this.schedule(entryId, state);
  }

  /**
   * The line a working publication carries now. A change is taken only when
   * the interval allows it; otherwise the line the room already has is kept
   * and the waiting change goes out when the interval ends.
   */
  take(entryId: string): string | null {
    const state = this.states.get(entryId);
    if (!state) return null;
    if (state.latest !== state.sent && this.nowMs() - state.sentAtMs >= this.minIntervalMs) {
      state.sent = state.latest;
      state.sentAtMs = this.nowMs();
    }
    return state.sent;
  }

  /** The agent is idle or gone: its line is cleared and nothing waits to be sent. */
  reset(entryId: string): void {
    const state = this.states.get(entryId);
    if (!state) return;
    if (state.timer) this.clearTimer(state.timer);
    this.states.delete(entryId);
  }

  private schedule(entryId: string, state: SummaryState): void {
    if (state.timer || state.latest === state.sent) return;
    const delayMs = Math.max(0, state.sentAtMs + this.minIntervalMs - this.nowMs());
    state.timer = this.setTimer(() => {
      state.timer = null;
      void this.flush(entryId, state);
    }, delayMs);
  }

  private async flush(entryId: string, state: SummaryState): Promise<void> {
    if (this.states.get(entryId) !== state || state.latest === state.sent) return;
    if (this.nowMs() - state.sentAtMs < this.minIntervalMs) {
      // Another publication took the interval meanwhile.
      this.schedule(entryId, state);
      return;
    }
    let status: "working" | "idle" | null;
    try { status = await state.status(); } catch { status = null; }
    // Not permitted now: the line stays pending, and the next heartbeat or change carries it.
    if (!status || this.states.get(entryId) !== state) return;
    const target = state.latest;
    try {
      await this.options.publish(entryId, status);
    } catch {
      // Best effort: the next heartbeat carries the newest line.
    }
    if (this.states.get(entryId) !== state) return;
    if (state.sent !== target && state.latest === target) {
      // A publication that could not attach the line (no binding yet) must not
      // retry in a tight loop: the next heartbeat carries it.
      state.sent = target;
      state.sentAtMs = this.nowMs();
    }
    // A newer line that arrived during the publication waits for its interval.
    this.schedule(entryId, state);
  }
}
