import { normalizeUsageLimitResetMs } from "../../../../../shared/provider-usage-limit.mjs";
import { formatUsageLimitResetTime, type UsageLimitTimeOptions } from "./provider-usage-limit-presentation";

/**
 * What the owner reads when Claude refused an agent's start because the
 * account's usage limit is reached. The background service files that under
 * "convergence scheduler failure: ... Startup observations: ...", which says
 * nothing to the owner. The observation string stays in Diagnostics.
 * This is the reason when Claude did not say when the limit resets.
 */
export const CLAUDE_USAGE_LIMIT_REASON = "Claude's usage limit is reached. LetAgents checks again by itself and starts the agent after the limit resets.";

/**
 * Agents use the Claude CLI's own sign-in (`claude` then /login), not the
 * Claude desktop app's account, so the hint names the CLI.
 */
const CLAUDE_CLI_ACCOUNT_HINT = "sign the Claude CLI in to an account with usage left";

/** The start-up failure the Claude adapter files when the bootstrap turn was rejected with a rate limit. */
export function claudeUsageLimitReached(lastError: string | null | undefined): boolean {
  return /daemon-safe bootstrap turn \(failed_response\).*assistant_error=rate_limit/i.test(lastError ?? "");
}

/** When the limit resets, from the start-up observation `usage_limit_resets_at=<ISO>`, or null. */
export function claudeUsageLimitResetsAtMs(lastError: string | null | undefined): number | null {
  const match = /\busage_limit_resets_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i.exec(lastError ?? "");
  return match ? normalizeUsageLimitResetMs(match[1]) : null;
}

export interface ClaudeUsageLimitReasonOptions extends UsageLimitTimeOptions {
  /**
   * The control that starts the agent now, as the end of a sentence, such as
   * "use Try again" or "open Recovery options". Null when no control is shown.
   */
  action?: string | null;
  nowMs?: number;
}

/**
 * The plain reason for a start refused at Claude's usage limit: when LetAgents
 * starts the agent by itself, then how the owner can start it sooner.
 */
export function claudeUsageLimitReason(lastError: string | null | undefined, options: ClaudeUsageLimitReasonOptions = {}): string {
  const nowMs = options.nowMs ?? Date.now();
  const action = options.action?.trim() || null;
  const resetsAtMs = claudeUsageLimitResetsAtMs(lastError);
  const sooner = ` To start sooner, ${CLAUDE_CLI_ACCOUNT_HINT}${action ? `, then ${action}` : ""}.`;
  if (resetsAtMs === null) return `${CLAUDE_USAGE_LIMIT_REASON}${sooner}`;
  const time = formatUsageLimitResetTime(resetsAtMs, nowMs, options);
  if (resetsAtMs <= nowMs) {
    return `Claude's usage limit was reached. The limit reset at ${time}. LetAgents checks again by itself and starts the agent.`
      + (action ? ` To start it now, ${action}.` : "");
  }
  return `Claude's usage limit is reached. LetAgents starts the agent by itself after the limit resets at ${time}.${sooner}`;
}
