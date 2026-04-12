/**
 * Compute Unit metering for rental sessions.
 *
 * Handles heartbeat timing, budget tracking, stale/dead detection,
 * and CU conversion from raw token reports.
 *
 * Pure TypeScript — no Node/Express dependencies.
 */

import { tokensToComputeUnits } from "./compute-units.js";

// ─── Constants ──────────────────────────────────────────────

/** How often agents must heartbeat (1 minute). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** After this long without a heartbeat, session is paused (5 minutes). */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** After this long without a heartbeat, session is expired (15 minutes). */
export const HEARTBEAT_DEAD_MS = 15 * 60_000;

/** Budget warning threshold — alert at 80% used. */
export const CU_WARNING_THRESHOLD = 0.8;

/** Minimum CU budget for a session. */
export const MIN_SESSION_CU_BUDGET = 1_000;

/** Maximum CU budget for a session. */
export const MAX_SESSION_CU_BUDGET = 10_000_000;

/** Default session duration (4 hours). */
export const DEFAULT_SESSION_DURATION_MINUTES = 240;

// ─── Meter State ────────────────────────────────────────────

export interface CUMeterState {
  /** Total CU budget for this session. */
  cu_budget: number;
  /** CU consumed so far. */
  cu_used: number;
  /** CU remaining. */
  cu_remaining: number;
  /** True when >= 80% of budget is used. */
  budget_warning: boolean;
  /** True when budget is fully exhausted. */
  budget_exhausted: boolean;
}

export interface CUMeterHeartbeatState extends CUMeterState {
  /** Timestamp (ms) of last heartbeat. */
  last_heartbeat_at_ms: number;
  /** True if heartbeat is > HEARTBEAT_STALE_MS old. */
  heartbeat_stale: boolean;
  /** True if heartbeat is > HEARTBEAT_DEAD_MS old. */
  heartbeat_dead: boolean;
  /** Estimated minutes remaining based on recent burn rate. */
  estimated_minutes_remaining: number | null;
}

/**
 * Compute the current meter state for a rental session.
 *
 * @param session - The session's budget and usage.
 * @param lastHeartbeatMs - Timestamp (ms) of the last heartbeat.
 * @param nowMs - Current time (ms). Defaults to Date.now().
 * @param recentBurnRateCUPerMin - Optional recent CU/min burn rate for time estimation.
 */
export function computeCUMeterState(
  session: { cu_budget: number; cu_used: number },
  lastHeartbeatMs: number,
  nowMs: number = Date.now(),
  recentBurnRateCUPerMin?: number
): CUMeterHeartbeatState {
  const cu_remaining = Math.max(0, session.cu_budget - session.cu_used);
  const budget_exhausted = cu_remaining <= 0;
  const budget_warning = !budget_exhausted && session.cu_used >= session.cu_budget * CU_WARNING_THRESHOLD;

  const timeSinceHeartbeat = nowMs - lastHeartbeatMs;
  const heartbeat_stale = timeSinceHeartbeat > HEARTBEAT_STALE_MS;
  const heartbeat_dead = timeSinceHeartbeat > HEARTBEAT_DEAD_MS;

  let estimated_minutes_remaining: number | null = null;
  if (recentBurnRateCUPerMin && recentBurnRateCUPerMin > 0 && cu_remaining > 0) {
    estimated_minutes_remaining = Math.round(cu_remaining / recentBurnRateCUPerMin);
  }

  return {
    cu_budget: session.cu_budget,
    cu_used: session.cu_used,
    cu_remaining,
    budget_warning,
    budget_exhausted,
    last_heartbeat_at_ms: lastHeartbeatMs,
    heartbeat_stale,
    heartbeat_dead,
    estimated_minutes_remaining,
  };
}

/**
 * Process a heartbeat — convert raw tokens to CU and return
 * the delta + updated totals.
 *
 * @param model - The agent's model identifier (for CU conversion).
 * @param tokensInput - Raw input tokens reported in this heartbeat.
 * @param tokensOutput - Raw output tokens reported in this heartbeat.
 * @param currentCUUsed - Current total CU used before this heartbeat.
 * @param cuBudget - The session's total CU budget.
 */
export function processHeartbeat(
  model: string,
  tokensInput: number,
  tokensOutput: number,
  currentCUUsed: number,
  cuBudget: number
): {
  cu_delta: number;
  cu_used_total: number;
  cu_remaining: number;
  budget_warning: boolean;
  budget_exhausted: boolean;
} {
  const cu_delta = tokensToComputeUnits(model, tokensInput, tokensOutput);
  const cu_used_total = currentCUUsed + cu_delta;
  const cu_remaining = Math.max(0, cuBudget - cu_used_total);
  const budget_exhausted = cu_remaining <= 0;
  const budget_warning = !budget_exhausted && cu_used_total >= cuBudget * CU_WARNING_THRESHOLD;

  return { cu_delta, cu_used_total, cu_remaining, budget_warning, budget_exhausted };
}
