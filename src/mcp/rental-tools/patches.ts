import {
  encodeSessionId,
  errorMessage,
  isPositiveInteger,
  validateSessionId,
} from "./shared.js";
import type { RentalToolDeps } from "./types.js";

export interface RentalProposeEditInput {
  session_id: string;
  idempotency_key: string;
  path: string;
  before_content: string;
  after_content: string;
  summary?: string;
}

export interface RentalProposePatchInput {
  session_id: string;
  idempotency_key: string;
  files: unknown[];
  summary?: string;
}

export interface RentalRunCommandInput {
  session_id: string;
  argv: string[];
  timeout_ms?: number;
}

export interface RentalPatchToolResult {
  success: boolean;
  proposalId?: string;
  gateStatus?: string;
  warnings?: unknown[];
  rejectionReasons?: unknown[];
  checks?: unknown[];
  patch?: string;
  idempotent?: boolean;
  error?: string;
}

export interface RentalRunCommandResult {
  success: boolean;
  argv?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  manifestId?: string;
  error?: string;
}

export async function rentalProposeEdit(
  deps: RentalToolDeps,
  input: RentalProposeEditInput,
): Promise<RentalPatchToolResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim()) {
    return { success: false, error: "idempotency_key is required" };
  }
  if (typeof input.path !== "string" || !input.path.trim()) {
    return { success: false, error: "path is required" };
  }
  if (typeof input.before_content !== "string" || typeof input.after_content !== "string") {
    return { success: false, error: "before_content and after_content are required" };
  }

  const body: Record<string, unknown> = {
    idempotencyKey: input.idempotency_key.trim(),
    path: input.path.trim(),
    beforeContent: input.before_content,
    afterContent: input.after_content,
  };
  if (typeof input.summary === "string" && input.summary.trim()) {
    body.summary = input.summary.trim();
  }

  try {
    return await deps.apiCall<RentalPatchToolResult>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/patches/propose-edit`,
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

export async function rentalProposePatch(
  deps: RentalToolDeps,
  input: RentalProposePatchInput,
): Promise<RentalPatchToolResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim()) {
    return { success: false, error: "idempotency_key is required" };
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { success: false, error: "files must be a non-empty array" };
  }

  const body: Record<string, unknown> = {
    idempotencyKey: input.idempotency_key.trim(),
    files: input.files,
  };
  if (typeof input.summary === "string" && input.summary.trim()) {
    body.summary = input.summary.trim();
  }

  try {
    return await deps.apiCall<RentalPatchToolResult>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/patches/propose-patch`,
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

export async function rentalRunCommand(
  deps: RentalToolDeps,
  input: RentalRunCommandInput,
): Promise<RentalRunCommandResult> {
  const sessionIdError = validateSessionId(input);
  if (sessionIdError) return { success: false, error: sessionIdError };
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    return { success: false, error: "argv must be a non-empty array" };
  }
  if (input.argv.some((part) => typeof part !== "string" || !part.trim())) {
    return { success: false, error: "argv entries must be non-empty strings" };
  }
  if (input.timeout_ms !== undefined && !isPositiveInteger(input.timeout_ms)) {
    return { success: false, error: "timeout_ms must be a positive integer" };
  }

  const body: Record<string, unknown> = {
    argv: input.argv.map((part) => part.trim()),
  };
  if (input.timeout_ms !== undefined) body.timeoutMs = input.timeout_ms;

  try {
    return await deps.apiCall<RentalRunCommandResult>(
      `/api/rental/sessions/${encodeSessionId(input.session_id)}/commands/run`,
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
