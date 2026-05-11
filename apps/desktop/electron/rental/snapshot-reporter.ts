/**
 * Desktop-side reporter that ships normalized meter snapshots to the
 * LetAgents API endpoint `POST /api/rental/sessions/:id/usage`.
 *
 * This module is intentionally thin and testable:
 *
 *   • `buildUsageReport(...)` is a pure function that converts the
 *     adapter-internal `AdapterNativeQuotaSnapshot + AdapterUsageDelta +
 *     AdapterLrtEstimate` triple into the wire shape the server expects
 *     (`IngestUsageReport`-compatible), and computes a deterministic
 *     idempotency key.
 *
 *   • `reportSnapshot(...)` POSTs the body via an injected `fetchFn`
 *     (default: global `fetch`). No retry logic in V1: a failure logs
 *     and waits for the next polling interval. Production retry/backoff
 *     is tracked for a follow-up.
 *
 * Part of PR p2.3b (Phase 2, finishes the Claude Code vertical slice).
 * Server contract: see `src/api/routes/rental-internal.ts` + spec §17.7.
 */

import { createHash } from "node:crypto";

import type {
  AdapterLrtEstimate,
  AdapterNativeQuotaSnapshot,
  AdapterUsageDelta,
} from "./adapter-types.js";

/**
 * Wire shape the server accepts at POST /api/rental/sessions/:id/usage.
 * Kept here as an exact mirror to avoid importing across the
 * desktop/api tsconfig boundary.
 */
export interface SnapshotReportBody {
  source: "adapter" | "tool" | "self_reported" | "system";
  snapshot: {
    provider: string;
    model: string | null;
    nativeUnit: string | null;
    nativeUsed: number | null;
    nativeRemaining: number | null;
    nativeResetAt: string | null;
  };
  delta: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    requests: number;
    credits: number | null;
    usd: number | null;
    toolCalls: number;
    commandRuns: number;
  };
  lrt: {
    lrtUsed: number;
    confidence: string;
  };
  adapterPayload: Record<string, unknown> | null;
  idempotencyKey: string;
  lastHeartbeatAt: string | null;
}

export interface ReportSnapshotInputs {
  sessionId: string;
  snapshot: AdapterNativeQuotaSnapshot;
  delta: AdapterUsageDelta;
  lrt: AdapterLrtEstimate;
  source?: SnapshotReportBody["source"];
  /** Override the idempotency key (rare; tests use this). */
  idempotencyKey?: string;
  lastHeartbeatAt?: string | null;
}

/**
 * Deterministic idempotency key derived from the session id, the
 * adapter's `observedAt`, and a stable hash of the totals. Retried
 * desktop calls hit the same key and the server short-circuits.
 *
 * The hash includes `lrtUsed` so that, in the (rare) case the adapter
 * recomputes its observation at the same millisecond after a fresh
 * read, the key still reflects the actual snapshot.
 */
export function computeIdempotencyKey(
  sessionId: string,
  snapshot: AdapterNativeQuotaSnapshot,
  delta: AdapterUsageDelta,
  lrt: AdapterLrtEstimate,
): string {
  const h = createHash("sha256");
  h.update(sessionId);
  h.update("|");
  h.update(snapshot.observedAt);
  h.update("|");
  h.update(snapshot.provider);
  h.update("|");
  h.update(snapshot.model ?? "");
  h.update("|");
  h.update(String(delta.inputTokens));
  h.update(":");
  h.update(String(delta.outputTokens));
  h.update(":");
  h.update(String(delta.cacheCreationTokens));
  h.update(":");
  h.update(String(delta.cacheReadTokens));
  h.update(":");
  h.update(String(delta.reasoningTokens));
  h.update("|");
  h.update(String(Math.round(lrt.lrtUsed)));
  return `desktop_${h.digest("hex").slice(0, 32)}`;
}

export function buildUsageReport(inputs: ReportSnapshotInputs): SnapshotReportBody {
  const source: SnapshotReportBody["source"] = inputs.source ?? "adapter";
  const idempotencyKey = inputs.idempotencyKey
    ?? computeIdempotencyKey(inputs.sessionId, inputs.snapshot, inputs.delta, inputs.lrt);
  return {
    source,
    snapshot: {
      provider: inputs.snapshot.provider,
      model: inputs.snapshot.model,
      nativeUnit: inputs.snapshot.nativeUnit,
      nativeUsed: null,
      nativeRemaining: inputs.snapshot.nativeRemaining,
      nativeResetAt: inputs.snapshot.nativeResetAt,
    },
    delta: {
      inputTokens: inputs.delta.inputTokens,
      outputTokens: inputs.delta.outputTokens,
      cacheCreationTokens: inputs.delta.cacheCreationTokens,
      cacheReadTokens: inputs.delta.cacheReadTokens,
      reasoningTokens: inputs.delta.reasoningTokens,
      requests: inputs.delta.requests,
      credits: inputs.delta.credits || null,
      usd: inputs.delta.usd || null,
      toolCalls: inputs.delta.toolCalls,
      commandRuns: inputs.delta.commandRuns,
    },
    lrt: {
      lrtUsed: inputs.lrt.lrtUsed,
      confidence: inputs.lrt.confidence,
    },
    adapterPayload: (inputs.snapshot.raw as Record<string, unknown>) ?? null,
    idempotencyKey,
    lastHeartbeatAt: inputs.lastHeartbeatAt ?? null,
  };
}

// ===== HTTP transport =====

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ReportSnapshotConfig {
  /** Base URL of the LetAgents API (e.g. `https://letagents.chat`). */
  apiBaseUrl: string;
  /** Bearer token to authenticate the desktop session, if available. */
  authToken?: string | null;
  /** Override `fetch` for tests. */
  fetchFn?: FetchLike;
}

export interface ReportSnapshotResult {
  ok: boolean;
  status: number;
  /** Idempotency key actually sent — useful for logging. */
  idempotencyKey: string;
  /** Parsed server response (the new or existing meter row). */
  body: unknown;
  /** Error message when ok=false. */
  error: string | null;
}

/**
 * POST one snapshot to the server. Returns a structured result rather
 * than throwing so the caller (the adapter runtime) can log and move on.
 */
export async function reportSnapshot(
  inputs: ReportSnapshotInputs,
  config: ReportSnapshotConfig,
): Promise<ReportSnapshotResult> {
  const body = buildUsageReport(inputs);
  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}/api/rental/sessions/${encodeURIComponent(inputs.sessionId)}/usage`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.authToken) {
    headers.authorization = `Bearer ${config.authToken}`;
  }
  const fetchFn: FetchLike = config.fetchFn ?? (globalThis.fetch as FetchLike);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      idempotencyKey: body.idempotencyKey,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed !== null && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${response.status}`;
    return {
      ok: false,
      status: response.status,
      idempotencyKey: body.idempotencyKey,
      body: parsed,
      error: message,
    };
  }
  return {
    ok: true,
    status: response.status,
    idempotencyKey: body.idempotencyKey,
    body: parsed,
    error: null,
  };
}
