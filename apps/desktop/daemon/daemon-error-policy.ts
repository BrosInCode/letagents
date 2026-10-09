import { NativeActivityRejectedError, SupervisorGrantRequestError } from "./cloud-http.js";
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

/**
 * A native-activity announcement that a later heartbeat can make instead:
 * the request timed out, never reached the server, or the server reported
 * itself unavailable. Everything else fails the bind as before: a server
 * that refused the bearer or the observation, and any local failure (store,
 * credential custody, shutdown, malformed response).
 */
export function deferrableNativeActivityFailure(error: unknown): boolean {
  if (error instanceof NativeActivityRejectedError) {
    return error.status !== null && (error.status >= 500 || [408, 425, 429].includes(error.status));
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  // fetch reports a server it could not reach this way.
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  // A connection dropped or stalled mid-response (undici's "terminated", or
  // a socket error) names the transport failure in its cause.
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
    ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DEFERRABLE_TRANSPORT_CODES.has(code);
}

const DEFERRABLE_TRANSPORT_CODES = new Set([
  "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
]);

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

/** The provider account's usage limit rejected the launch; it clears only when the limit resets. */
export function providerQuotaExhaustedFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if ((current as { providerQuotaExhausted?: unknown } | null)?.providerQuotaExhausted === true) return true;
    if (!(current instanceof Error)) return false;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** When the provider said the usage limit that rejected a launch resets (epoch ms), if it said so. */
export function providerQuotaResetAtMs(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const resetsAtMs = (current as { providerQuotaResetsAtMs?: unknown } | null)?.providerQuotaResetsAtMs;
    if (typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs)) return resetsAtMs;
    if (!(current instanceof Error)) return null;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
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
