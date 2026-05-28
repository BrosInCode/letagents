import {
  encodeSessionId,
  errorMessage,
  isPositiveInteger,
  validateSessionId,
} from "./shared.js";
import type { RentalToolDeps } from "./types.js";

export interface RentalReadFileInput {
  session_id: string;
  path: string;
  max_bytes?: number;
}

export interface RentalReadFileResult {
  success: boolean;
  path?: string;
  content?: string;
  secretScanStatus?: string;
  redactionCount?: number;
  findings?: unknown[];
  bytes?: number;
  manifestId?: string;
  error?: string;
}

export interface RentalSearchInput {
  session_id: string;
  query: string;
  max_results?: number;
  case_sensitive?: boolean;
}

export interface RentalSearchResult {
  success: boolean;
  query?: string;
  results?: unknown[];
  count?: number;
  truncated?: boolean;
  manifestId?: string;
  error?: string;
}

export async function rentalReadFile(
  deps: RentalToolDeps,
  input: RentalReadFileInput,
): Promise<RentalReadFileResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (typeof input.path !== "string" || !input.path.trim()) {
    return { success: false, error: "path is required" };
  }
  if (input.max_bytes !== undefined && !isPositiveInteger(input.max_bytes)) {
    return { success: false, error: "max_bytes must be a positive integer" };
  }

  const body: Record<string, unknown> = {
    path: input.path.trim(),
  };
  if (input.max_bytes !== undefined) body.maxBytes = input.max_bytes;

  try {
    return await deps.apiCall<RentalReadFileResult>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/context/read-file`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}

export async function rentalSearch(
  deps: RentalToolDeps,
  input: RentalSearchInput,
): Promise<RentalSearchResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (typeof input.query !== "string" || !input.query.trim()) {
    return { success: false, error: "query is required" };
  }
  if (input.max_results !== undefined && !isPositiveInteger(input.max_results)) {
    return { success: false, error: "max_results must be a positive integer" };
  }

  const body: Record<string, unknown> = {
    query: input.query.trim(),
  };
  if (input.max_results !== undefined) body.maxResults = input.max_results;
  if (typeof input.case_sensitive === "boolean") {
    body.caseSensitive = input.case_sensitive;
  }

  try {
    return await deps.apiCall<RentalSearchResult>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/context/search`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err),
    };
  }
}
