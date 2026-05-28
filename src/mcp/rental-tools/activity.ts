import { encodeSessionId, errorMessage, validateSessionId } from "./shared.js";
import type { RentalToolDeps } from "./types.js";

export interface RentalEmitActivityInput {
  session_id: string;
  event_type: string;
  source?: string;
  payload?: Record<string, unknown>;
  verified?: boolean;
}

export interface RentalEmitActivityResult {
  success: boolean;
  event?: unknown;
  error?: string;
}

export async function rentalEmitActivity(
  deps: RentalToolDeps,
  input: RentalEmitActivityInput,
): Promise<RentalEmitActivityResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (typeof input.event_type !== "string" || !input.event_type.trim()) {
    return { success: false, error: "event_type is required" };
  }

  const body: Record<string, unknown> = {
    event_type: input.event_type.trim(),
    source:
      typeof input.source === "string" && input.source.trim()
        ? input.source.trim()
        : "agent",
    payload:
      typeof input.payload === "object" &&
      input.payload !== null &&
      !Array.isArray(input.payload)
        ? input.payload
        : {},
  };
  if (typeof input.verified === "boolean") {
    body.verified = input.verified;
  }

  try {
    const event = await deps.apiCall<unknown>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/activity`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { success: true, event };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}
