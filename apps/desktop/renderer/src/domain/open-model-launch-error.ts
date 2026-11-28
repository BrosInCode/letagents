import { safeUserVisibleErrorDetail } from "./user-visible-error";

const SCHEDULER_FAILURE_PREFIX = /^convergence scheduler failure:\s*/i;

function isOpenModelProvider(provider: string | null | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "open-model" || normalized === "open_model";
}

/**
 * Actionable Open Model setup and limit errors thrown before OpenCode starts
 * (missing or invalid context window, rejected endpoint authentication, invalid
 * endpoint URL, or missing desktop-held endpoint credentials).
 *
 * The daemon files these under "convergence scheduler failure: ...", which
 * otherwise collapses to a generic private-project-area error in the UI. Strip
 * the internal prefix and keep the actionable setup guidance intact.
 */
const OPEN_MODEL_SETUP_FAILURE = /^(?:The model endpoint (?:did not provide a context window|rejected authentication|URL\b)|The model context window must be\b|Open Model is waiting for its desktop-held endpoint credential\b|Waiting for desktop Open Model credential handoff\b)/i;

export function openModelLaunchFailureReason(
  lastError: string | null | undefined,
  provider?: string | null,
): string | null {
  if (provider !== undefined && !isOpenModelProvider(provider)) return null;
  const detail = lastError?.trim() ?? "";
  if (!detail) return null;
  const stripped = detail.replace(SCHEDULER_FAILURE_PREFIX, "").trim();
  if (!OPEN_MODEL_SETUP_FAILURE.test(stripped)) return null;
  return safeUserVisibleErrorDetail(stripped, "") || null;
}
