import { encodeSessionId, errorMessage, validateSessionId } from "./shared.js";
import type { RentalToolDeps } from "./types.js";

export interface RentalCompleteInput {
  session_id: string;
  summary?: string;
}

export interface RentalCompleteResult {
  success: boolean;
  session?: unknown;
  error?: string;
}

export interface RentalCancelInput {
  session_id: string;
  reason?: string;
}

export interface RentalCancelResult {
  success: boolean;
  session?: unknown;
  error?: string;
}

export async function rentalComplete(
  deps: RentalToolDeps,
  input: RentalCompleteInput,
): Promise<RentalCompleteResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const body: Record<string, unknown> = {};
  if (typeof input.summary === "string" && input.summary.trim()) {
    body.summary = input.summary.trim();
  }

  try {
    const session = await deps.apiCall<unknown>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { success: true, session };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}

export async function rentalCancel(
  deps: RentalToolDeps,
  input: RentalCancelInput,
): Promise<RentalCancelResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const body: Record<string, unknown> = {};
  if (typeof input.reason === "string" && input.reason.trim()) {
    body.reason = input.reason.trim();
  }

  try {
    const session = await deps.apiCall<unknown>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { success: true, session };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}
