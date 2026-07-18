import { safeUserVisibleErrorDetail } from "../../../../domain/user-visible-error";

export type AddAgentFeedbackTone = "status" | "warning" | "error";

/** Preserve useful local diagnostics while removing transport noise and the
 * credential shapes most likely to appear in third-party/provider failures. */
export function addAgentErrorDetail(error: unknown, fallback: string): string {
  return safeUserVisibleErrorDetail(error, fallback);
}

export function contextualAddAgentError(
  context: string,
  error: unknown,
  fallback: string,
): string {
  const detail = addAgentErrorDetail(error, fallback);
  return detail.toLowerCase().startsWith(context.toLowerCase())
    ? detail
    : `${context}: ${detail}`;
}
