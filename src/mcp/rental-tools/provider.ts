import { encodeSessionId, errorMessage, validateSessionId } from "./shared.js";
import type { RentalToolDeps } from "./types.js";

export interface RentalListRequestsResult {
  success: boolean;
  requests: unknown[];
  count: number;
  error?: string;
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

export interface RentalProvisionInput {
  session_id: string;
  parent_room_id: string;
  provider_display_name?: string;
}

export interface RentalProvisionResult {
  success: boolean;
  room_id?: string;
  participant_id?: string;
  session?: unknown;
  error?: string;
}

export async function rentalListRequests(
  deps: RentalToolDeps,
): Promise<RentalListRequestsResult> {
  try {
    const body = await deps.apiCall<unknown>(
      "/api/rental/provider/requests",
      { method: "GET" },
    );
    const requests = Array.isArray(body)
      ? body
      : Array.isArray((body as { requests?: unknown[] } | null)?.requests)
        ? (body as { requests: unknown[] }).requests
        : [];
    return { success: true, requests, count: requests.length };
  } catch (err) {
    return {
      success: false,
      requests: [],
      count: 0,
      error: errorMessage(err),
    };
  }
}

export async function rentalAccept(
  deps: RentalToolDeps,
  input: RentalAcceptInput,
): Promise<RentalAcceptResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const path = `/api/rental/provider/sessions/${encodeSessionId(input.session_id)}/accept`;
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
      error: errorMessage(err),
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  }
}

export async function rentalProvision(
  deps: RentalToolDeps,
  input: RentalProvisionInput,
): Promise<RentalProvisionResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  const parentRoomId = input.parent_room_id?.trim();
  if (!parentRoomId) {
    return { success: false, error: "parent_room_id is required" };
  }

  const body: Record<string, unknown> = { parentRoomId };
  const displayName = input.provider_display_name?.trim();
  if (displayName) body.providerDisplayName = displayName;

  try {
    const result = await deps.apiCall<{
      roomId?: string;
      participantId?: string;
      session?: unknown;
    }>(
      `/api/rental/provider/sessions/${encodeSessionId(input.session_id)}/provision`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    return {
      success: true,
      room_id: typeof result?.roomId === "string" ? result.roomId : undefined,
      participant_id:
        typeof result?.participantId === "string" ? result.participantId : undefined,
      session: result?.session,
    };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}

export async function rentalDecline(
  deps: RentalToolDeps,
  input: RentalDeclineInput,
): Promise<RentalAcceptResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

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
    const session = await deps.apiCall<unknown>(
      `/api/rental/provider/sessions/${encodeSessionId(input.session_id)}/decline`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
    return {
      success: true,
      session,
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
      ...(idemKey ? { idempotency_key: idemKey } : {}),
    };
  }
}
