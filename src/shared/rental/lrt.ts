/**
 * LetAgents Rental Token (LRT) primitives.
 *
 * Pure functions. No I/O, no IDE-local reads, no DB. Importable from
 * both the desktop main process and the API server.
 *
 * Spec §17.3 (LRT definition + suggested weights) and §17.13
 * (confidence-based safety buffers).
 */

import type {
  QuotaConfidence,
  UsageDelta,
} from "./meter-types.js";

/**
 * Weight table for one provider/model. Configurable per provider/model
 * because vendor pricing and hidden-quota weighting differ.
 *
 * Spec §17.3.
 */
export interface LrtWeights {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  /** Per-tool-call multiplier; default 0 unless a provider charges for it. */
  tool: number;
  /** Per-command-run cost; default 0. */
  command: number;
  /** Per-request multiplier for request-based plans (e.g. Cursor). */
  request: number;
  /** USD-to-LRT exchange rate when the IDE only exposes USD. */
  usdToLrt: number;
  /** Credits-to-LRT exchange rate when the IDE only exposes credits. */
  creditsToLrt: number;
}

/**
 * Default LRT weights. Match the suggested starting values in §17.3:
 * input=1, output=4, cache_creation=1.25, cache_read=0.1, reasoning=4,
 * tool=0. Other weights extend the formula for providers that bill on
 * those axes.
 *
 * These are the public defaults; individual providers (per
 * {@link PROVIDER_LRT_WEIGHTS}) may override any field.
 */
export const DEFAULT_LRT_WEIGHTS: LrtWeights = Object.freeze({
  input: 1.0,
  output: 4.0,
  cacheCreation: 1.25,
  cacheRead: 0.1,
  reasoning: 4.0,
  tool: 0.0,
  command: 0.0,
  request: 0.0,
  usdToLrt: 0.0,
  creditsToLrt: 0.0,
}) as LrtWeights;

/**
 * Per-provider overrides applied on top of {@link DEFAULT_LRT_WEIGHTS}.
 *
 * Add an entry here when a specific provider needs different weights
 * (e.g. Cursor charges per request; Antigravity bills monthly credits).
 * Any field omitted falls back to the default.
 */
export const PROVIDER_LRT_WEIGHTS: Readonly<Record<string, Partial<LrtWeights>>> =
  Object.freeze({
    claude_code: {
      // Claude Code emits exact token logs locally; defaults work.
    },
    codex: {
      // Codex exposes token logs + credits; rely on tokens when present.
    },
    antigravity: {
      // Antigravity exposes percent-window + reset only; token weights still
      // apply when tokens can be observed, otherwise the calibrated estimator
      // does the heavy lifting (see estimateLrtFromPercentWindow below).
    },
    cursor: {
      // Cursor's "included usage" surface is request-based for many plans.
      // Set a non-zero per-request weight so request-only deltas count.
      request: 50,
    },
  });

/**
 * Resolve the effective weight table for one provider.
 */
export function resolveWeights(provider: string): LrtWeights {
  const override = PROVIDER_LRT_WEIGHTS[provider] ?? {};
  return { ...DEFAULT_LRT_WEIGHTS, ...override };
}

/**
 * Compute LRT consumed by a {@link UsageDelta}.
 *
 * Spec §17.3. The formula is:
 *
 *   lrt =
 *     input_tokens          × input_weight
 *   + output_tokens         × output_weight
 *   + cache_creation_tokens × cache_creation_weight
 *   + cache_read_tokens     × cache_read_weight
 *   + reasoning_tokens      × reasoning_weight
 *   + tool_events           × tool_weight
 *   + command_runs          × command_weight
 *   + requests              × request_weight
 *   + credits               × credits_to_lrt
 *   + usd                   × usd_to_lrt
 *
 * Negative deltas are clamped to zero — a meter that goes "backwards"
 * is treated as a reset event, not a refund.
 */
export function computeLrt(delta: UsageDelta, provider: string): number {
  const w = resolveWeights(provider);
  const tokens =
    Math.max(0, delta.inputTokens) * w.input
    + Math.max(0, delta.outputTokens) * w.output
    + Math.max(0, delta.cacheCreationTokens) * w.cacheCreation
    + Math.max(0, delta.cacheReadTokens) * w.cacheRead
    + Math.max(0, delta.reasoningTokens) * w.reasoning;
  const events =
    Math.max(0, delta.toolCalls) * w.tool
    + Math.max(0, delta.commandRuns) * w.command
    + Math.max(0, delta.requests) * w.request;
  const money =
    Math.max(0, delta.credits) * w.creditsToLrt
    + Math.max(0, delta.usd) * w.usdToLrt;
  return tokens + events + money;
}

/**
 * Estimate LRT remaining when the only signal is a percent-window
 * reading plus observed LRT consumed in the current window.
 *
 *   used_so_far  = LRT observed since window start
 *   percent_used = 1 - percent_remaining
 *   window_total = used_so_far / percent_used
 *   remaining    = window_total - used_so_far
 *
 * Spec §17.4 percent-window calibration example.
 *
 * Returns `null` when the estimate cannot be computed (e.g. we have
 * not observed any LRT yet, so the denominator is undefined).
 */
export function estimateLrtFromPercentWindow(
  percentRemaining: number,
  lrtObservedThisWindow: number,
): number | null {
  if (!Number.isFinite(percentRemaining) || percentRemaining < 0 || percentRemaining > 1) {
    return null;
  }
  if (!Number.isFinite(lrtObservedThisWindow) || lrtObservedThisWindow <= 0) {
    return null;
  }
  const percentUsed = 1 - percentRemaining;
  if (percentUsed <= 0) {
    return null;
  }
  const windowTotal = lrtObservedThisWindow / percentUsed;
  const remaining = windowTotal * percentRemaining;
  return Math.max(0, remaining);
}

/**
 * Confidence-based stop thresholds.
 *
 * Spec §17.13: lower confidence stops earlier to avoid overrun when
 * the meter lags.
 *
 *   official_exact / local_exact  → stop at 98 %
 *   derived                       → stop at 95 %
 *   calibrated                    → stop at 92 %
 *   estimated                     → stop at 87 %
 *   weak_estimate                 → stop at 80 %
 *   unknown                       → stop at 75 % (or earlier per policy)
 *
 * Returned as the *fraction of budget* at which we close the rails.
 * The Budget Sentinel multiplies an LRT limit by this to compute the
 * effective ceiling before exhaustion.
 */
export const STOP_THRESHOLD_BY_CONFIDENCE: Readonly<Record<QuotaConfidence, number>> =
  Object.freeze({
    official_exact: 0.98,
    local_exact: 0.98,
    derived: 0.95,
    calibrated: 0.92,
    estimated: 0.87,
    weak_estimate: 0.80,
    unknown: 0.75,
  });

/**
 * Return the effective LRT ceiling a session is allowed to spend given
 * its budget and the meter's confidence.
 *
 * The result is `Math.floor(lrtLimit × stopThreshold)`.
 */
export function effectiveLrtCeiling(lrtLimit: number, confidence: QuotaConfidence): number {
  if (!Number.isFinite(lrtLimit) || lrtLimit <= 0) {
    return 0;
  }
  const fraction = STOP_THRESHOLD_BY_CONFIDENCE[confidence] ?? STOP_THRESHOLD_BY_CONFIDENCE.unknown;
  return Math.floor(lrtLimit * fraction);
}

/**
 * Order on confidence levels — exact > local_exact > derived > calibrated
 * > estimated > weak_estimate > unknown. Used to decide whether a new
 * snapshot upgrades or downgrades meter confidence on a session.
 */
const CONFIDENCE_ORDER: ReadonlyArray<QuotaConfidence> = [
  "unknown",
  "weak_estimate",
  "estimated",
  "calibrated",
  "derived",
  "local_exact",
  "official_exact",
];

/**
 * Compare two confidence values. Returns a negative number when `a` is
 * weaker than `b`, positive when stronger, 0 when equal.
 */
export function compareConfidence(a: QuotaConfidence, b: QuotaConfidence): number {
  return CONFIDENCE_ORDER.indexOf(a) - CONFIDENCE_ORDER.indexOf(b);
}

/**
 * Whether the meter signal qualifies as "exact" for marketplace
 * eligibility (§7.4 preflight). Either local-exact or vendor-exact.
 */
export function isExactConfidence(confidence: QuotaConfidence): boolean {
  return confidence === "official_exact" || confidence === "local_exact";
}
