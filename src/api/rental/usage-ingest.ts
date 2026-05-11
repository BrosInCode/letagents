/**
 * Server-side ingest for rental meter snapshots.
 *
 * Receives normalized `NativeQuotaSnapshot + UsageDelta + LrtEstimate`
 * from the desktop-side meter adapter (lands in p2.3 family) or from
 * the MCP `rental_report_usage` tool (lands in p3.2). Persists one row
 * per (session, idempotency_key) and computes the rolling `lrt_total`
 * by summing the previous total with the new `lrt_delta`.
 *
 * The desktop/MCP caller is the only writer for `rental_usage_meters`.
 * Budget Sentinel (p2.8) reads the latest row to gate expensive ops.
 *
 * Spec §17.7 (MeterAdapter contract) + §19.6 (rental_usage_meters table).
 * Part of PR p2.2 (Phase 2 server-side foundation).
 */

import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  rental_sessions,
  rental_usage_meters,
} from "../db/schema.js";

/**
 * Set of confidence values the route layer accepts before reaching the
 * service. Exported so the route can validate without re-importing the
 * drizzle enum.
 */
export const INGEST_CONFIDENCE_VALUES = [
  "official_exact",
  "local_exact",
  "derived",
  "calibrated",
  "estimated",
  "weak_estimate",
  "unknown",
] as const;

// ===== Wire shape =====

/**
 * Confidence values accepted from desktop/MCP. Mirrors the
 * `rentalMeterConfidenceEnum` order — see `src/shared/rental/meter-types.ts`
 * for the canonical definition. Kept as a string-union here so the route
 * layer can validate the request body without importing the full enum
 * machinery.
 */
export type IngestConfidence =
  | "official_exact"
  | "local_exact"
  | "derived"
  | "calibrated"
  | "estimated"
  | "weak_estimate"
  | "unknown";

export type IngestSource = "adapter" | "tool" | "self_reported" | "system";

/**
 * Native quota snapshot — the marketplace-facing surface the adapter
 * produces. Mirrors `NativeQuotaSnapshot` in
 * `src/shared/rental/meter-types.ts` minus the per-process discovery
 * metadata (which the server doesn't persist).
 */
export interface IngestNativeSnapshot {
  provider: string;
  model: string | null;
  nativeUnit: string | null;
  nativeUsed: number | null;
  nativeRemaining: number | null;
  nativeResetAt: string | null;
}

export interface IngestUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  requests?: number;
  credits?: number | null;
  usd?: number | null;
  toolCalls?: number;
  commandRuns?: number;
  filesExposed?: number;
  heartbeats?: number;
}

export interface IngestLrtEstimate {
  lrtUsed: number;
  confidence: IngestConfidence;
}

export interface IngestUsageReport {
  source: IngestSource;
  snapshot: IngestNativeSnapshot;
  delta: IngestUsageDelta;
  lrt: IngestLrtEstimate;
  adapterPayload?: Record<string, unknown> | null;
  /** Idempotency key — required so a flaky caller doesn't double-count. */
  idempotencyKey: string;
  /** Optional heartbeat timestamp — usually `now()` on the adapter side. */
  lastHeartbeatAt?: string | null;
}

export type RentalUsageMeterRow = typeof rental_usage_meters.$inferSelect;

// ===== Errors =====

export class UsageIngestError extends Error {
  constructor(
    message: string,
    readonly code: "session_not_found" | "provider_model_mismatch" | "invalid_input",
    readonly status: number,
  ) {
    super(message);
    this.name = "UsageIngestError";
  }
}

// ===== Service =====

/**
 * Lookup shape used by `ingestUsage`. The default implementation reads
 * `rental_sessions` + the latest `rental_usage_meters` row through
 * `db`. Tests inject mocks via {@link RentalUsageIngestDeps}.
 */
export interface RentalUsageIngestDeps {
  loadSession(sessionId: string): Promise<{
    id: string;
    renter_lane_provider: string | null;
    renter_lane_model: string | null;
  } | null>;

  loadLatestMeter(sessionId: string): Promise<RentalUsageMeterRow | null>;

  loadByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<RentalUsageMeterRow | null>;

  insertMeter(
    row: typeof rental_usage_meters.$inferInsert,
  ): Promise<RentalUsageMeterRow>;
}

/**
 * Default deps wired to the live db. The route module uses this; tests
 * inject their own.
 */
export const defaultUsageIngestDeps: RentalUsageIngestDeps = {
  async loadSession(sessionId) {
    const [row] = await db
      .select({
        id: rental_sessions.id,
        renter_lane_provider: rental_sessions.renter_lane_provider,
        renter_lane_model: rental_sessions.renter_lane_model,
      })
      .from(rental_sessions)
      .where(eq(rental_sessions.id, sessionId));
    return row ?? null;
  },
  async loadLatestMeter(sessionId) {
    const [row] = await db
      .select()
      .from(rental_usage_meters)
      .where(eq(rental_usage_meters.session_id, sessionId))
      .orderBy(desc(rental_usage_meters.created_at))
      .limit(1);
    return row ?? null;
  },
  async loadByIdempotency(sessionId, idempotencyKey) {
    const [row] = await db
      .select()
      .from(rental_usage_meters)
      .where(
        and(
          eq(rental_usage_meters.session_id, sessionId),
          eq(rental_usage_meters.idempotency_key, idempotencyKey),
        ),
      );
    return row ?? null;
  },
  async insertMeter(row) {
    const [inserted] = await db.insert(rental_usage_meters).values(row).returning();
    return inserted;
  },
};

function generateMeterId(): string {
  return `rusg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function numericString(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value.toString();
}

/**
 * Ingest one usage report for a rental session.
 *
 * Validates:
 *   • session exists (FK guard ahead of the actual insert constraint)
 *   • snapshot.provider matches session.renter_lane_provider when set
 *   • snapshot.model matches session.renter_lane_model when set
 *
 * Idempotency:
 *   • If (session_id, idempotency_key) already exists, return that row
 *     unchanged. No new write.
 *
 * Rolling total:
 *   • `lrt_total = (previousLatest?.lrt_total ?? 0) + report.lrt.lrtUsed`
 *   • Counters carry forward from the previous row, plus the deltas
 *     reported in `report.delta`.
 */
/**
 * Predicate for the Postgres unique-violation error code (`23505`).
 * Drizzle/pg surfaces this either via `err.code` or via the message
 * mentioning the constraint name, depending on the path.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "23505") return true;
  if (typeof e.message === "string" && e.message.includes("rental_usage_meters_session_idempotency_uq")) {
    return true;
  }
  return false;
}

export async function ingestUsage(
  sessionId: string,
  report: IngestUsageReport,
  deps: RentalUsageIngestDeps = defaultUsageIngestDeps,
): Promise<RentalUsageMeterRow> {
  if (!report.idempotencyKey || !report.idempotencyKey.trim()) {
    throw new UsageIngestError("idempotencyKey is required", "invalid_input", 400);
  }
  if (!report.snapshot || typeof report.snapshot.provider !== "string") {
    throw new UsageIngestError("snapshot.provider is required", "invalid_input", 400);
  }
  if (!report.lrt || typeof report.lrt.lrtUsed !== "number" || !Number.isFinite(report.lrt.lrtUsed)) {
    throw new UsageIngestError("lrt.lrtUsed must be a finite number", "invalid_input", 400);
  }
  if (typeof report.lrt.confidence !== "string"
      || !(INGEST_CONFIDENCE_VALUES as readonly string[]).includes(report.lrt.confidence)) {
    throw new UsageIngestError("lrt.confidence must be a valid confidence value", "invalid_input", 400);
  }

  // Idempotency short-circuit (best-effort — the unique index below is
  // the actual guarantee under concurrent retries).
  const existing = await deps.loadByIdempotency(sessionId, report.idempotencyKey);
  if (existing) return existing;

  // Session must exist; FK alone is fine but we want a clean 404 vs 23503.
  const session = await deps.loadSession(sessionId);
  if (!session) {
    throw new UsageIngestError("session not found", "session_not_found", 404);
  }

  if (
    session.renter_lane_provider
    && session.renter_lane_provider !== report.snapshot.provider
  ) {
    throw new UsageIngestError(
      `snapshot provider ${report.snapshot.provider} does not match session lane ${session.renter_lane_provider}`,
      "provider_model_mismatch",
      409,
    );
  }
  if (
    session.renter_lane_model
    && report.snapshot.model
    && session.renter_lane_model !== report.snapshot.model
  ) {
    throw new UsageIngestError(
      `snapshot model ${report.snapshot.model} does not match session lane ${session.renter_lane_model}`,
      "provider_model_mismatch",
      409,
    );
  }

  const previous = await deps.loadLatestMeter(sessionId);
  // LRT columns are `integer` in pg; the shared weights produce
  // fractional values (e.g. cache_creation * 1.25). Round at the DB
  // boundary so totals stay representable; document the rounding so
  // Budget Sentinel knows what to expect.
  const lrtDelta = Math.max(0, Math.round(numberOr(report.lrt?.lrtUsed, 0)));
  const lrtTotal = (previous?.lrt_total ?? 0) + lrtDelta;

  const delta = report.delta ?? {};
  const insertRow: typeof rental_usage_meters.$inferInsert = {
    id: generateMeterId(),
    session_id: sessionId,
    source: report.source,
    native_unit: report.snapshot.nativeUnit ?? null,
    native_used: numericString(report.snapshot.nativeUsed),
    native_remaining: numericString(report.snapshot.nativeRemaining),
    native_reset_at:
      report.snapshot.nativeResetAt ? new Date(report.snapshot.nativeResetAt) : null,
    input_tokens: Math.round(numberOr(delta.inputTokens, 0)),
    output_tokens: Math.round(numberOr(delta.outputTokens, 0)),
    cache_creation_tokens: Math.round(numberOr(delta.cacheCreationTokens, 0)),
    cache_read_tokens: Math.round(numberOr(delta.cacheReadTokens, 0)),
    reasoning_tokens: Math.round(numberOr(delta.reasoningTokens, 0)),
    requests_used: Math.round(numberOr(delta.requests, 0)),
    credits_used: numericString(delta.credits ?? null),
    usd_used: numericString(delta.usd ?? null),
    lrt_delta: lrtDelta,
    lrt_total: lrtTotal,
    confidence: report.lrt.confidence,
    adapter_payload: report.adapterPayload ?? null,
    tool_call_count: (previous?.tool_call_count ?? 0) + Math.round(numberOr(delta.toolCalls, 0)),
    command_run_count: (previous?.command_run_count ?? 0) + Math.round(numberOr(delta.commandRuns, 0)),
    files_exposed_count:
      (previous?.files_exposed_count ?? 0) + Math.round(numberOr(delta.filesExposed, 0)),
    heartbeat_count: (previous?.heartbeat_count ?? 0) + Math.round(numberOr(delta.heartbeats, 0)),
    last_heartbeat_at: report.lastHeartbeatAt ? new Date(report.lastHeartbeatAt) : null,
    idempotency_key: report.idempotencyKey,
  };

  // Race-safe insert. If two concurrent requests with the same
  // (session_id, idempotency_key) both pass the loadByIdempotency
  // check above, the unique index `rental_usage_meters_session_idempotency_uq`
  // makes exactly one win. The loser re-reads and returns the winner's row.
  //
  // Note (V1 trade-off): under high concurrency for *different*
  // idempotency keys on the same session, two reports can race past
  // loadLatestMeter() and both compute the same lrt_total, missing
  // one delta. Budget Sentinel reconciles on the next snapshot.
  // A SELECT FOR UPDATE / advisory-lock guarantee is tracked for v2.
  try {
    return await deps.insertMeter(insertRow);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await deps.loadByIdempotency(sessionId, report.idempotencyKey);
    if (winner) return winner;
    throw err;
  }
}
