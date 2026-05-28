import {
  encodeSessionId,
  errorMessage,
  validateSessionId,
} from "./shared.js";
import type { RentalToolDeps } from "./types.js";

export interface RentalHeartbeatInput {
  session_id: string;
}

export interface RentalHeartbeatResult {
  success: boolean;
  ok?: boolean;
  status?: string;
  heartbeat_count?: number;
  transitioned?: boolean;
  error?: string;
}

export interface RentalReportUsageInput {
  session_id: string;
  report: Record<string, unknown>;
}

export interface RentalReportUsageResult {
  success: boolean;
  meter?: unknown;
  error?: string;
}

export interface RentalRefreshQuotaInput {
  session_id: string;
  provider?: string;
}

export interface RentalRefreshQuotaResult {
  success: boolean;
  snapshot?: unknown;
  refreshed?: boolean;
  error?: string;
}

export async function rentalHeartbeat(
  deps: RentalToolDeps,
  input: RentalHeartbeatInput,
): Promise<RentalHeartbeatResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  try {
    const body = await deps.apiCall<{
      ok?: boolean;
      status?: string;
      heartbeatCount?: number;
      transitioned?: boolean;
    }>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/heartbeat`,
      { method: "POST" },
    );

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
      error: errorMessage(err),
    };
  }
}

export async function rentalReportUsage(
  deps: RentalToolDeps,
  input: RentalReportUsageInput,
): Promise<RentalReportUsageResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (
    typeof input.report !== "object" ||
    input.report === null ||
    Array.isArray(input.report)
  ) {
    return { success: false, error: "report must be a JSON object" };
  }

  try {
    const meter = await deps.apiCall<unknown>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/usage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.report),
      },
    );
    return { success: true, meter };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}

export async function rentalRefreshQuota(
  deps: RentalToolDeps,
  input: RentalRefreshQuotaInput,
): Promise<RentalRefreshQuotaResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };

  const bodyPayload: Record<string, unknown> = {};
  if (typeof input.provider === "string" && input.provider.trim()) {
    bodyPayload.provider = input.provider.trim();
  }

  try {
    const body = await deps.apiCall<{
      snapshot?: unknown;
      refreshed?: boolean;
    }>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/refresh-quota`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyPayload),
      },
    );

    return {
      success: true,
      snapshot: body?.snapshot ?? null,
      refreshed: body?.refreshed ?? true,
    };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}
