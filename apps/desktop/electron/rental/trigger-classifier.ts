/**
 * D1 trigger classifier (desktop-local).
 *
 * Classifies how confident we are that the renter's IDE quota lane
 * has actually been exhausted, using the renter-side meter adapter
 * snapshots plus a small ring buffer of recent quota-failure
 * observations. Confidence levels feed the §19.2
 * `trigger_confidence` column on the rental session row:
 *
 *   exact     — adapter exposes a structured quota-exhausted event
 *               (or `percent_remaining = 0` with a reset timestamp).
 *               Highest signal-to-noise; we trust the IDE itself.
 *   inferred  — adapter did not surface an exact event but we saw
 *               N consecutive provider-quota failures inside a
 *               short rolling window (e.g. HTTP 429 / `rate_limited`
 *               returns from the renter's IDE in the last 5 minutes).
 *   manual    — the renter clicked the "I'm out of quota" button in
 *               the desktop UI. Always trusted at the UI layer; the
 *               server records the trigger context but the rental
 *               Marketplace makes no claims about meter accuracy.
 *
 * The classifier is pure: tests pass deterministic input and assert
 * the returned `RenterTriggerSignal`. The runtime piece that watches
 * adapter snapshots and feeds this classifier lives in
 * `renter-trigger.ts` (lands next slice).
 *
 * Spec refs:
 *   §1.5 D1 "Entry Paths and Rescue Flow"
 *   §6.2 step 1 (renter session create flow, trigger context)
 *   §19.2 rental_sessions.trigger_confidence enum
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p2.6 (classifier slice).
 */

import type {
  AdapterNativeQuotaSnapshot,
} from "./adapter-types.js";

/**
 * Match the §19.2 `rental_trigger_confidence_enum` exactly. The
 * desktop side never invents a value the server can't accept.
 */
export type RenterTriggerConfidence = "exact" | "inferred" | "manual";

/**
 * Reason codes accompanying a classification. Useful for log lines
 * and for letting the renter UI explain why a rescue offer is being
 * surfaced. Mirrors a §1.5 amendment, but documented here only;
 * spec text update is deferred per workflow rules.
 */
export const RENTER_TRIGGER_REASONS = Object.freeze({
  STRUCTURED_EVENT: "structured_event",
  PERCENT_WINDOW_EXHAUSTED: "percent_window_exhausted",
  CONSECUTIVE_FAILURES: "consecutive_failures",
  USER_DECLARED: "user_declared",
  NO_TRIGGER: "no_trigger",
} as const);

export type RenterTriggerReason =
  (typeof RENTER_TRIGGER_REASONS)[keyof typeof RENTER_TRIGGER_REASONS];

/**
 * Output of the classifier. The renter-trigger runtime (next slice)
 * promotes this to the session-create payload + a stream event for
 * the renderer to render the rescue UI.
 */
export interface RenterTriggerSignal {
  triggered: boolean;
  confidence: RenterTriggerConfidence | null;
  reason: RenterTriggerReason;
  provider: string | null;
  model: string | null;
  observedAt: string | null;
  laneResetAt: string | null;
  // For UI / telemetry; mirrors §19.2 renter_quota_signal jsonb.
  rawSignal: Record<string, unknown> | null;
}

/**
 * Rolling observation a renter-side meter adapter feeds in. Either
 * a structured snapshot from `MeterAdapter.readNativeQuota`, or a
 * lightweight provider-quota-failure pulse (the renter's IDE got an
 * HTTP 429 / rate-limit response).
 */
export type RenterQuotaObservation =
  | {
      kind: "snapshot";
      snapshot: AdapterNativeQuotaSnapshot;
    }
  | {
      kind: "quota_failure";
      provider: string;
      model: string | null;
      occurredAt: string;
      detail?: Record<string, unknown>;
    };

export interface RenterTriggerClassifierOptions {
  /**
   * Number of consecutive quota failures required to escalate to
   * "inferred" confidence. Default 3 — tunable per provider.
   */
  inferredFailureCount?: number;
  /**
   * Rolling window (ms) in which the failures must occur. Default
   * 5 minutes. Older failures get evicted before classification.
   */
  inferredWindowMs?: number;
}

const DEFAULT_INFERRED_FAILURE_COUNT = 3;
const DEFAULT_INFERRED_WINDOW_MS = 5 * 60 * 1000;

export class RenterTriggerClassifier {
  private readonly options: Required<RenterTriggerClassifierOptions>;
  private readonly recentFailures: Array<{
    provider: string;
    model: string | null;
    occurredAt: string;
    detail?: Record<string, unknown>;
  }> = [];

  constructor(options: RenterTriggerClassifierOptions = {}) {
    this.options = {
      inferredFailureCount:
        options.inferredFailureCount ?? DEFAULT_INFERRED_FAILURE_COUNT,
      inferredWindowMs: options.inferredWindowMs ?? DEFAULT_INFERRED_WINDOW_MS,
    };
  }

  /**
   * Feed one observation. Returns the current trigger signal,
   * computed against the cumulative state (the classifier is
   * stateful only over `recentFailures`).
   */
  observe(
    observation: RenterQuotaObservation,
    nowMs: number = Date.now(),
  ): RenterTriggerSignal {
    if (observation.kind === "snapshot") {
      return this.classifySnapshot(observation.snapshot);
    }
    this.recordFailure(observation, nowMs);
    return this.classifyFailures(nowMs);
  }

  /**
   * Classify a single snapshot in isolation (no failure history).
   * Exported via the public `observe` path; this method is exposed
   * for tests that want to skip the rolling buffer.
   */
  classifySnapshot(snapshot: AdapterNativeQuotaSnapshot): RenterTriggerSignal {
    const raw = (snapshot.raw ?? {}) as Record<string, unknown>;

    // Structured event = the IDE wrote an explicit exhaustion flag
    // into its local sidecar. Highest signal.
    if (
      raw.exhausted === true
      || raw.exhausted_event === true
      || raw.quota_event === "exhausted"
    ) {
      return {
        triggered: true,
        confidence: "exact",
        reason: RENTER_TRIGGER_REASONS.STRUCTURED_EVENT,
        provider: snapshot.provider,
        model: snapshot.model,
        observedAt: snapshot.observedAt,
        laneResetAt: snapshot.nativeResetAt,
        rawSignal: {
          source: "structured_event",
          unit: snapshot.nativeUnit,
          remaining: snapshot.nativeRemaining,
          reset_at: snapshot.nativeResetAt,
        },
      };
    }

    // Percent-window meter sitting at zero remaining with a known
    // reset time is treated as exact — the IDE knows the lane is
    // dead even though the snapshot is "estimated" confidence in
    // the LRT sense. The trigger is about the user's IDE state,
    // not the LRT projection.
    if (
      snapshot.nativeUnit === "percent_window"
      && typeof snapshot.nativeRemaining === "number"
      && snapshot.nativeRemaining <= 0
    ) {
      return {
        triggered: true,
        confidence: "exact",
        reason: RENTER_TRIGGER_REASONS.PERCENT_WINDOW_EXHAUSTED,
        provider: snapshot.provider,
        model: snapshot.model,
        observedAt: snapshot.observedAt,
        laneResetAt: snapshot.nativeResetAt,
        rawSignal: {
          source: "percent_window",
          remaining: snapshot.nativeRemaining,
          reset_at: snapshot.nativeResetAt,
        },
      };
    }

    return {
      triggered: false,
      confidence: null,
      reason: RENTER_TRIGGER_REASONS.NO_TRIGGER,
      provider: snapshot.provider,
      model: snapshot.model,
      observedAt: snapshot.observedAt,
      laneResetAt: snapshot.nativeResetAt,
      rawSignal: null,
    };
  }

  /**
   * Explicit user click. Always produces a `manual` signal — we
   * trust the user even when no adapter signal is available.
   */
  declareManual(input: {
    provider?: string | null;
    model?: string | null;
    note?: string | null;
    occurredAt?: string;
  } = {}): RenterTriggerSignal {
    return {
      triggered: true,
      confidence: "manual",
      reason: RENTER_TRIGGER_REASONS.USER_DECLARED,
      provider: input.provider ?? null,
      model: input.model ?? null,
      observedAt: input.occurredAt ?? new Date().toISOString(),
      laneResetAt: null,
      rawSignal: {
        source: "user_declared",
        note: input.note ?? null,
      },
    };
  }

  /**
   * Clear the rolling failure buffer. Called once a rescue session
   * is opened so the next series of failures starts fresh.
   */
  reset(): void {
    this.recentFailures.length = 0;
  }

  /**
   * For tests + telemetry: how many quota failures are currently
   * inside the rolling window.
   */
  failureCount(nowMs: number = Date.now()): number {
    this.evictExpired(nowMs);
    return this.recentFailures.length;
  }

  private recordFailure(
    observation: Extract<RenterQuotaObservation, { kind: "quota_failure" }>,
    nowMs: number,
  ): void {
    this.recentFailures.push({
      provider: observation.provider,
      model: observation.model,
      occurredAt: observation.occurredAt,
      detail: observation.detail,
    });
    this.evictExpired(nowMs);
  }

  private classifyFailures(nowMs: number): RenterTriggerSignal {
    this.evictExpired(nowMs);
    if (this.recentFailures.length < this.options.inferredFailureCount) {
      return {
        triggered: false,
        confidence: null,
        reason: RENTER_TRIGGER_REASONS.NO_TRIGGER,
        provider: null,
        model: null,
        observedAt: null,
        laneResetAt: null,
        rawSignal: null,
      };
    }
    const latest = this.recentFailures[this.recentFailures.length - 1]!;
    return {
      triggered: true,
      confidence: "inferred",
      reason: RENTER_TRIGGER_REASONS.CONSECUTIVE_FAILURES,
      provider: latest.provider,
      model: latest.model,
      observedAt: latest.occurredAt,
      laneResetAt: null,
      rawSignal: {
        source: "consecutive_failures",
        count: this.recentFailures.length,
        window_ms: this.options.inferredWindowMs,
        recent: this.recentFailures.map((f) => ({
          provider: f.provider,
          model: f.model,
          occurred_at: f.occurredAt,
          detail: f.detail ?? null,
        })),
      },
    };
  }

  private evictExpired(nowMs: number): void {
    const cutoff = nowMs - this.options.inferredWindowMs;
    while (this.recentFailures.length > 0) {
      const head = this.recentFailures[0]!;
      if (Date.parse(head.occurredAt) >= cutoff) break;
      this.recentFailures.shift();
    }
  }
}
