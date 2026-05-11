/**
 * Rental MCP tool handlers (p3.1).
 *
 * Pure-function wrappers around the rental provider REST endpoints, so the
 * MCP tool registrations in `server.ts` stay thin and the logic remains
 * unit-testable without booting a real MCP transport.
 *
 * Endpoints called (all gated by `LETAGENTS_RENT_ENABLED` server-side):
 *
 *   GET    /api/rental/provider/requests
 *   POST   /api/rental/provider/sessions/:id/accept
 *   POST   /api/rental/provider/sessions/:id/decline
 *
 * Spec refs: §6 (provider flow), §18.2 (accept/decline transitions).
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p3.1.
 *
 * Note: idempotency_key is accepted and forwarded but the server-side
 * accept/decline routes do not yet honour it (repeat calls 409). The
 * key is optional so callers don't break when the backend adds support.
 *
 * Note: reason is forwarded to the decline endpoint body. Whether the
 * server persists it depends on the current route implementation.
 */

export interface RentalToolDeps {
  apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T>;
}

export interface RentalListRequestsResult {
  success: boolean;
  requests: unknown[];
  count: number;
  error?: string;
}

export async function rentalListRequests(
  deps: RentalToolDeps
): Promise<RentalListRequestsResult> {
  try {
    const body = await deps.apiCall<unknown>(
      "/api/rental/provider/requests",
      { method: "GET" }
    );
    const requests = Array.isArray(body)
      ? body
      : Array.isArray((body as { requests?: unknown[] } | null)?.requests)
        ? ((body as { requests: unknown[] }).requests)
        : [];
    return { success: true, requests, count: requests.length };
  } catch (err) {
    return {
      success: false,
      requests: [],
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RentalAcceptInput {
  session_id: string;
  idempotency_key?: string;
}

export interface RentalDeclineInput {
  session_id: string;
  idempotency_key?: string;
  reason?: string;
}

export interface RentalAcceptResult {
  success: boolean;
  session?: unknown;
  error?: string;
  idempotency_key?: string;
}

function validateSessionId(input: { session_id?: string }): string | null {
  const v = input.session_id;
  if (typeof v !== "string" || !v.trim()) return "session_id is required";
  return null;
}


export async function rentalAccept(
  deps: RentalToolDeps,
  input: RentalAcceptInput
): Promise<RentalAcceptResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const path = `/api/rental/provider/sessions/${encodeURIComponent(
    input.session_id.trim()
  )}/accept`;

  const idemKey = input.idempotency_key?.trim() || undefined;
  const headers: Record<string, string> = {};
  const bodyPayload: Record<string, unknown> = {};
  if (idemKey) {
    headers["Idempotency-Key"] = idemKey;
    bodyPayload.idempotency_key = idemKey;
  }

  try {
    const session = await deps.apiCall<unknown>(path, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
    });
    return {
      success: true,
      session,
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// rental_heartbeat (p3.2 — wraps POST /api/rental/sessions/:id/heartbeat)
// ---------------------------------------------------------------------------

export interface RentalHeartbeatInput {
  session_id: string;
}

export interface RentalHeartbeatResult {
  success: boolean;
  /** Whether the server accepted the heartbeat (provider match, valid state). */
  ok?: boolean;
  /** New session status (may have transitioned provisioning → active). */
  status?: string;
  /** Rolling heartbeat count on the session. */
  heartbeat_count?: number;
  /** True if this heartbeat caused a status transition. */
  transitioned?: boolean;
  error?: string;
}

export async function rentalHeartbeat(
  deps: RentalToolDeps,
  input: RentalHeartbeatInput,
): Promise<RentalHeartbeatResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const path = `/api/rental/sessions/${encodeURIComponent(
    input.session_id.trim(),
  )}/heartbeat`;

  try {
    const body = await deps.apiCall<{
      ok?: boolean;
      status?: string;
      heartbeatCount?: number;
      transitioned?: boolean;
    }>(path, { method: "POST" });

    return {
      success: true,
      ok: body?.ok ?? true,
      status: typeof body?.status === "string" ? body.status : undefined,
      heartbeat_count:
        typeof body?.heartbeatCount === "number" ? body.heartbeatCount : undefined,
      transitioned: body?.transitioned ?? false,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// rental_report_usage (p3.2 — wraps POST /api/rental/sessions/:id/usage)
// ---------------------------------------------------------------------------

export interface RentalReportUsageInput {
  session_id: string;
  /**
   * Pre-built IngestUsageReport object the caller has already
   * normalized. The MCP layer does NOT mint a snapshot for the
   * agent — the desktop meter adapter pipeline is the only
   * authoritative source for that shape. This tool exists so an
   * agent can FORWARD an already-built report from a tool-mediated
   * step (e.g. self-reported usage when no native meter is
   * available). The server validates the report shape on receive;
   * we pass it through unchanged.
   */
  report: Record<string, unknown>;
}

export interface RentalReportUsageResult {
  success: boolean;
  /** Returned meter row when the report was accepted. */
  meter?: unknown;
  error?: string;
}

export async function rentalReportUsage(
  deps: RentalToolDeps,
  input: RentalReportUsageInput,
): Promise<RentalReportUsageResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (
    typeof input.report !== "object"
    || input.report === null
    || Array.isArray(input.report)
  ) {
    return { success: false, error: "report must be a JSON object" };
  }

  const path = `/api/rental/sessions/${encodeURIComponent(
    input.session_id.trim(),
  )}/usage`;

  try {
    const meter = await deps.apiCall<unknown>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.report),
    });
    return { success: true, meter };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// rental_request_budget_extension (p3.4)
// ---------------------------------------------------------------------------

export interface RentalRequestBudgetExtensionInput {
  session_id: string;
  requested_additional_lrt: number;
  reason?: string;
}

export interface RentalRequestBudgetExtensionResult {
  success: boolean;
  request?: unknown;
  session?: unknown;
  error?: string;
}

export async function rentalRequestBudgetExtension(
  deps: RentalToolDeps,
  input: RentalRequestBudgetExtensionInput,
): Promise<RentalRequestBudgetExtensionResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (
    typeof input.requested_additional_lrt !== "number"
    || !Number.isFinite(input.requested_additional_lrt)
    || !Number.isInteger(input.requested_additional_lrt)
    || input.requested_additional_lrt <= 0
  ) {
    return {
      success: false,
      error: "requested_additional_lrt must be a finite positive integer",
    };
  }

  const path = `/api/rental/sessions/${encodeURIComponent(
    input.session_id.trim(),
  )}/budget-extension-requests`;

  const bodyPayload: Record<string, unknown> = {
    requestedAdditionalLrt: input.requested_additional_lrt,
  };
  if (typeof input.reason === "string" && input.reason.trim()) {
    bodyPayload.reason = input.reason.trim();
  }

  try {
    const body = await deps.apiCall<{
      request?: unknown;
      session?: unknown;
    }>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });

    return {
      success: true,
      request: body?.request ?? null,
      session: body?.session ?? null,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// rental_refresh_quota (p3.2 — wraps POST /api/rental/sessions/:id/refresh-quota)
// ---------------------------------------------------------------------------

export interface RentalRefreshQuotaInput {
  session_id: string;
  /** Optional provider hint — e.g. "antigravity", "codex". */
  provider?: string;
}

export interface RentalRefreshQuotaResult {
  success: boolean;
  /** Refreshed snapshot returned by the adapter bridge. */
  snapshot?: unknown;
  /** Whether the adapter actually ran a new poll (vs. returned a cached snapshot). */
  refreshed?: boolean;
  error?: string;
}

export async function rentalRefreshQuota(
  deps: RentalToolDeps,
  input: RentalRefreshQuotaInput,
): Promise<RentalRefreshQuotaResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const path = `/api/rental/sessions/${encodeURIComponent(
    input.session_id.trim(),
  )}/refresh-quota`;

  const bodyPayload: Record<string, unknown> = {};
  if (typeof input.provider === "string" && input.provider.trim()) {
    bodyPayload.provider = input.provider.trim();
  }

  try {
    const body = await deps.apiCall<{
      snapshot?: unknown;
      refreshed?: boolean;
    }>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });

    return {
      success: true,
      snapshot: body?.snapshot ?? null,
      refreshed: body?.refreshed ?? true,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function rentalDecline(
  deps: RentalToolDeps,
  input: RentalDeclineInput
): Promise<RentalAcceptResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const path = `/api/rental/provider/sessions/${encodeURIComponent(
    input.session_id.trim()
  )}/decline`;

  const idemKey = input.idempotency_key?.trim() || undefined;
  const headers: Record<string, string> = {};
  const payload: Record<string, unknown> = {};
  if (idemKey) {
    headers["Idempotency-Key"] = idemKey;
    payload.idempotency_key = idemKey;
  }
  if (typeof input.reason === "string" && input.reason.trim()) {
    payload.reason = input.reason.trim();
  }

  try {
    const session = await deps.apiCall<unknown>(path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return {
      success: true,
      session,
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  }
}
