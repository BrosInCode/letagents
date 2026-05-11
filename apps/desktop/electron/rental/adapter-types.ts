/**
 * Desktop-side mirror of the rental meter adapter contract.
 *
 * The canonical types live in `src/shared/rental/meter-types.ts` (landed
 * via p2.1, PR #357). The desktop Electron tsconfig has `rootDir:
 * "electron"`, so it can't directly import sources from `src/shared/`.
 * Instead we mirror the relevant pieces here and the IPC layer (in p2.3b)
 * converts between adapter-internal types and the shared contract /
 * the `DesktopRental*` types in `electron/ipc-types.ts`.
 *
 * The shape MUST stay structurally equivalent to
 * `src/shared/rental/meter-types.ts`. Any change here should mirror
 * the canonical types and vice versa.
 *
 * Spec §17.7 (Meter Adapter Contract) + §17.8 (Rental Scope Attribution).
 */

/** Mirror of `QuotaUnit` from src/shared/rental/meter-types.ts. */
export type AdapterQuotaUnit =
  | "tokens"
  | "credits"
  | "usd"
  | "requests"
  | "percent_window"
  | "time"
  | "unknown";

/** Mirror of `QuotaConfidence` from src/shared/rental/meter-types.ts. */
export type AdapterQuotaConfidence =
  | "official_exact"
  | "local_exact"
  | "derived"
  | "calibrated"
  | "estimated"
  | "weak_estimate"
  | "unknown";

/** Mirror of `MeterSource`. */
export interface AdapterMeterSource {
  id: string;
  label: string;
  kind: "jsonl" | "sqlite" | "json" | "rate_limit_sidecar" | "api" | "other";
  pathHint: string | null;
  lastSeenAt: string | null;
}

/** Mirror of `NativeQuotaSnapshot`. */
export interface AdapterNativeQuotaSnapshot {
  provider: string;
  model: string | null;
  sourceId: string;
  nativeUnit: AdapterQuotaUnit;
  nativeRemaining: number | null;
  nativeTotal: number | null;
  nativeResetAt: string | null;
  confidence: AdapterQuotaConfidence;
  observedAt: string;
  raw: Record<string, unknown>;
}

/** Mirror of `UsageDelta`. */
export interface AdapterUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  requests: number;
  credits: number;
  usd: number;
  toolCalls: number;
  commandRuns: number;
  filesExposed: number;
  heartbeats: number;
}

/** Mirror of `LrtEstimate`. */
export interface AdapterLrtEstimate {
  lrtUsed: number;
  lrtRemaining: number | null;
  confidence: AdapterQuotaConfidence;
}

/** Mirror of `AdapterCapabilities`. */
export interface AdapterCapabilities {
  supportsExact: boolean;
  supportsLaneRecovery: boolean;
  supportsTier2Continuity: boolean;
}

/** Mirror of `RentalMeterScope`. */
export interface AdapterRentalMeterScope {
  sessionId: string;
  workspaceMarker: string;
  conversationId?: string | null;
}

/** Mirror of `CalibrationHistory`. */
export interface AdapterCalibrationHistory {
  lrtPerFullWindow: number | null;
  sampleCount: number;
}

/**
 * Desktop-side mirror of `MeterAdapter`. The actual instances live in
 * `electron/rental/adapters/<ide>.ts`. The runtime in
 * `electron/rental/adapter-runtime.ts` polls them periodically and the
 * IPC layer (p2.3b) reports their output to the server.
 */
export interface DesktopMeterAdapter {
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;
  discoverSources(): Promise<AdapterMeterSource[]>;
  readNativeQuota(source: AdapterMeterSource): Promise<AdapterNativeQuotaSnapshot | null>;
  readUsageDelta(scope: AdapterRentalMeterScope): Promise<AdapterUsageDelta>;
  estimateAvailableLrt(
    snapshot: AdapterNativeQuotaSnapshot,
    history: AdapterCalibrationHistory,
  ): AdapterLrtEstimate;
}

/**
 * The §17.3 LRT formula, restated for the desktop process.
 *
 * Pure function. Mirrors `computeLrt` from `src/shared/rental/lrt.ts`.
 * When p2.3b lands the IPC layer, the runtime will be able to call
 * either implementation — both should produce the same number for the
 * same input.
 */
export const ADAPTER_DEFAULT_LRT_WEIGHTS = Object.freeze({
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
});

export type AdapterLrtWeights = typeof ADAPTER_DEFAULT_LRT_WEIGHTS;

/**
 * Compute LRT for a {@link AdapterUsageDelta}, optionally with a
 * session-level calibrated override (e.g. observed LRT-per-request
 * for Cursor sessions; see p2.1 PR #357).
 *
 * Negative components are clamped to zero.
 */
export function computeAdapterLrt(
  delta: AdapterUsageDelta,
  weights: Partial<AdapterLrtWeights> = {},
): number {
  const w = { ...ADAPTER_DEFAULT_LRT_WEIGHTS, ...weights };
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
