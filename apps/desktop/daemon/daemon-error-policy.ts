import { SupervisorGrantRequestError } from "./cloud-http.js";
import { redactCredentialText } from "./credential-redaction.js";

export function schedulerErrorDetail(error: unknown, depth = 0): string {
  if (depth > 3) return "nested error omitted";
  if (!(error instanceof Error)) return redactCredentialText(String(error || "unknown error")).value;
  const cause = (error as Error & { cause?: unknown }).cause;
  const detail = cause === undefined ? error.message : `${error.message}; cause: ${schedulerErrorDetail(cause, depth + 1)}`;
  return redactCredentialText(detail).value;
}

export function retryableWorkerMintFailure(error: unknown): boolean {
  if (!(error instanceof SupervisorGrantRequestError)) return true;
  return error.status >= 500 || [408, 425, 429].includes(error.status);
}

export function authoritativeRoomJoinRejection(error: unknown): boolean {
  return error instanceof SupervisorGrantRequestError
    && [400, 401, 403, 404, 409, 422].includes(error.status);
}

export class WorkerCredentialMintError extends Error {
  constructor(
    readonly attempts: number,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(`Worker credential mint failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${schedulerErrorDetail(cause)}`, { cause });
    this.name = "WorkerCredentialMintError";
  }
}

export function exhaustedTransientWorkerMint(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof WorkerCredentialMintError) return current.retryable;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** Provider adapters mark launch timeouts that a fresh attempt may resolve. */
export function transientProviderStartFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if ((current as { transientProviderStart?: unknown } | null)?.transientProviderStart === true) return true;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** A saved provider runtime that is provably gone cannot be resumed. */
export function providerRuntimeGoneFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if ((current as { providerRuntimeGone?: unknown } | null)?.providerRuntimeGone === true) return true;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
