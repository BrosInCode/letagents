import {
  encodeSessionId,
  errorMessage,
  isPositiveInteger,
  validateSessionId,
} from "./shared.js";
import type { RentalToolDeps } from "./types.js";

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
  if (!isPositiveInteger(input.requested_additional_lrt)) {
    return {
      success: false,
      error: "requested_additional_lrt must be a finite positive integer",
    };
  }

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
    }>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/budget-extension-requests`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyPayload),
      },
    );

    return {
      success: true,
      request: body?.request ?? null,
      session: body?.session ?? null,
    };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}
