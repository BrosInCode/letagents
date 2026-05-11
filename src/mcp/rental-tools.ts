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
