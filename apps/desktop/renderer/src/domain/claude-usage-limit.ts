/**
 * What the owner reads when Claude refused an agent's start because the
 * account's usage limit is reached. The background service files that under
 * "convergence scheduler failure: ... Startup observations: ...", which says
 * nothing to the owner. The observation string stays in Diagnostics.
 */
export const CLAUDE_USAGE_LIMIT_REASON = "Claude's usage limit is reached. LetAgents checks again by itself and starts the agent after the limit resets.";

/** The start-up failure the Claude adapter files when the bootstrap turn was rejected with a rate limit. */
export function claudeUsageLimitReached(lastError: string | null | undefined): boolean {
  return /daemon-safe bootstrap turn \(failed_response\).*assistant_error=rate_limit/i.test(lastError ?? "");
}
