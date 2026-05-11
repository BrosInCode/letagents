/**
 * Shared rental meter contract.
 *
 * These types describe how a per-IDE meter adapter reports native quota
 * state and rental usage from the desktop/MCP-local process to the API
 * server. They live in `src/shared/` because both sides import them.
 *
 * Per spec §17.7 (Meter Adapter Contract) and §17.8 (Rental Scope
 * Attribution). Adapters run **desktop-side** (Electron main process
 * or MCP-local) because they read local IDE files such as JSONL session
 * logs and SQLite conversation rows; the API server only ingests the
 * normalized snapshots they report.
 */

/**
 * What unit does a provider expose its quota in?
 *
 * Spec §17.7. Most IDEs expose at least one of these; some expose more
 * than one at the same time (e.g. tokens + credits + rate-limit window).
 */
export type QuotaUnit =
  | "tokens"
  | "credits"
  | "usd"
  | "requests"
  | "percent_window"
  | "time"
  | "unknown";

/**
 * Confidence ladder for a meter reading.
 *
 * Spec §17.5. Drives the safety-buffer stop thresholds in
 * {@link STOP_THRESHOLD_BY_CONFIDENCE} (§17.13).
 *
 * - `official_exact`:  vendor API returns exact remaining
 * - `local_exact`:     local IDE log gives exact token counts (Claude Code)
 * - `derived`:         remaining computed from balance × known price
 * - `calibrated`:      percent-window with empirically observed denominator
 * - `estimated`:       percent-window with default denominator
 * - `weak_estimate`:   wall-clock-only fallback
 * - `unknown`:         meter could not be read
 */
export type QuotaConfidence =
  | "official_exact"
  | "local_exact"
  | "derived"
  | "calibrated"
  | "estimated"
  | "weak_estimate"
  | "unknown";

/**
 * A discovered source the adapter can read from on the local machine.
 *
 * Spec §17.8 names examples: JSONL session log, local SQLite conversation
 * row, tool hook payload, rate-limit sidecar file. An adapter may expose
 * multiple sources (e.g. one per Claude Code profile) and the runtime
 * picks the active one.
 */
export interface MeterSource {
  /** Stable identifier scoped to this adapter (e.g. "jsonl:project-abc"). */
  id: string;
  /** Human-readable label for diagnostics. */
  label: string;
  /** Best-effort hint at what kind of file/store this is. */
  kind: "jsonl" | "sqlite" | "json" | "rate_limit_sidecar" | "api" | "other";
  /** Absolute or platform-relative path/URI, for logs and audit. */
  pathHint: string | null;
  /** When the source was last observed to exist. */
  lastSeenAt: string | null;
}

/**
 * One reading of the provider's native quota state.
 *
 * Spec §17.7 lists the required fields. All numeric fields are nullable
 * because not every IDE exposes everything (e.g. percent-window adapters
 * have no exact `nativeRemaining`).
 */
export interface NativeQuotaSnapshot {
  /** Provider key — matches `renter_lane_provider` / listing.ide_kind. */
  provider: string;
  /** Model lane label — matches `renter_lane_model` / listing.model_label. */
  model: string | null;
  /** Which {@link MeterSource} produced this snapshot. */
  sourceId: string;
  /** The native quota unit being reported. */
  nativeUnit: QuotaUnit;
  /** Numeric remaining, when the IDE exposes one. */
  nativeRemaining: number | null;
  /** Numeric total, when known (lets the server compute %). */
  nativeTotal: number | null;
  /** When the quota window refreshes, if the IDE exposes it. */
  nativeResetAt: string | null;
  /** Confidence the adapter has in this reading. */
  confidence: QuotaConfidence;
  /** When the adapter took this reading. */
  observedAt: string;
  /** Runtime-specific evidence, opaque to the server. */
  raw: Record<string, unknown>;
}

/**
 * The delta of work attributed to one rental session, captured between
 * the prior snapshot and {@link NativeQuotaSnapshot.observedAt}.
 *
 * Spec §17.7 + §17.8. Adapters that cannot scope usage to a single
 * rental should populate only the fields they can attribute confidently
 * and leave the rest at zero.
 */
export interface UsageDelta {
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
}

/**
 * Normalized LetAgents Rental Tokens estimate, computed from
 * {@link UsageDelta} via {@link computeLrt} in `./lrt.ts`.
 *
 * Spec §17.3.
 */
export interface LrtEstimate {
  /** LRT consumed in the delta being reconciled. */
  lrtUsed: number;
  /** LRT estimated remaining on the lane after the delta. */
  lrtRemaining: number | null;
  /** Confidence in the estimate (mirrors snapshot confidence). */
  confidence: QuotaConfidence;
}

/**
 * Capability flags an adapter advertises in its readiness payload (§7.4).
 *
 * - `supportsExact`:           can produce `local_exact` snapshots
 * - `supportsLaneRecovery`:    can detect when the renter's own lane
 *                              refreshes mid-rental (drives D4 callout)
 * - `supportsTier2Continuity`: can capture local IDE state for the
 *                              Continuity Pack Tier 2 ingest (§8.5)
 */
export interface AdapterCapabilities {
  supportsExact: boolean;
  supportsLaneRecovery: boolean;
  supportsTier2Continuity: boolean;
}

/**
 * Calibration history the adapter can refer to when estimating LRT
 * remaining from percent-window data. Server-maintained, opaque to the
 * adapter beyond `lrtPerFullWindow`.
 */
export interface CalibrationHistory {
  /** Estimated LRT in one full quota window for this provider/model/lane. */
  lrtPerFullWindow: number | null;
  /** Number of historical sessions used to compute the estimate. */
  sampleCount: number;
}

/**
 * Per-rental scope marker used to attribute usage to a specific session.
 *
 * Spec §17.8: adapters may write a unique workspace marker
 * (`letagents-rental/<session_id>`) into the IDE's project so usage
 * deltas can be filtered back to one rental.
 */
export interface RentalMeterScope {
  sessionId: string;
  /** Workspace marker the adapter should look for in IDE logs. */
  workspaceMarker: string;
  /** Optional conversation/thread id when the IDE exposes one. */
  conversationId?: string | null;
}

/**
 * The adapter contract every per-IDE adapter implements. Lives in
 * `apps/desktop/electron/rental/adapters/<ide>.ts` for runtime
 * adapters; the shape is shared so the server can type-check ingest.
 */
export interface MeterAdapter {
  /** Stable provider key, e.g. `"claude_code"` or `"antigravity"`. */
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;

  /** Enumerate {@link MeterSource}s visible on the local machine. */
  discoverSources(): Promise<MeterSource[]>;

  /** Read the current native quota snapshot from one source. */
  readNativeQuota(source: MeterSource): Promise<NativeQuotaSnapshot | null>;

  /** Read the usage delta attributable to one rental scope. */
  readUsageDelta(scope: RentalMeterScope): Promise<UsageDelta>;

  /** Estimate LRT from a snapshot + calibration history. */
  estimateAvailableLrt(
    snapshot: NativeQuotaSnapshot,
    history: CalibrationHistory,
  ): LrtEstimate;
}

/**
 * Wire shape the server receives at `POST /api/rental/sessions/:id/usage`.
 *
 * The desktop or MCP-local adapter runtime sends this; the server stores
 * it in `rental_usage_meters` and feeds it to Budget Sentinel.
 */
export interface RentalUsageReport {
  sessionId: string;
  snapshot: NativeQuotaSnapshot;
  delta: UsageDelta;
  lrt: LrtEstimate;
  /** Adapter capability set at the time of report. */
  capabilities: AdapterCapabilities;
  /** Idempotency key — repeated identical reports are dedup'd. */
  idempotencyKey: string;
}
