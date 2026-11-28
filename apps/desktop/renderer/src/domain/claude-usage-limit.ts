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

export const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

export function isFableModel(model: string | null | undefined): boolean {
  return /^(?:claude-)?fable(?:[-\s]|$)/i.test(model?.trim() ?? "");
}

export function isFableUsageWindow(id: string): boolean {
  return /(?:^|[_:-])fable(?:[_:-]|$)/i.test(id);
}

/** Claude's message is evidence for the limit it names, even after a model change. */
export function claudeLimitNotice(error: string | null | undefined, provider?: string | null): ClaudeLimitNotice | null {
  if (!error || (provider && provider !== "claude-code" && provider !== "claude")) return null;
  const family = /(?:reached|hit|exceeded)\s+your\s+(fable|opus|sonnet)(?:\s+[\d.]+)?\s+limit/i.exec(error)?.[1]?.toLowerCase();
  const credits = /^(?:fable(?:\s+[\d.]+)?\s+requires usage credits|you['’]re out of (?:usage credits|extra usage)|credit balance is too low)/i.test(error.trim());
  const namedClaude = /claude\.ai\/(?:settings|admin-settings)\/usage|^claude(?: ai| code)? usage limit/i.test(error);
  const account = (provider || namedClaude) && /(?:hit|reached|exceeded) your (?:weekly|session|usage) limit|^claude(?: ai| code)? usage limit reached/i.test(error);
  if (!family && !credits && !account) return null;
  if (!provider && !namedClaude && family !== "fable" && !/^fable/i.test(error.trim())) return null;
  const label = family ? family[0]!.toUpperCase() + family.slice(1) : /^fable/i.test(error.trim()) ? "Fable" : null;
  const reset = /[·•]\s*resets?\s+([^·•\n]{1,72})/i.exec(error)?.[1]?.trim().replace(/[.]+$/, "") ?? null;
  return {
    title: credits ? label ? `${label} needs usage credits` : "Claude usage credits depleted" : label ? `${label} limit reached` : "Claude usage limit reached",
    detail: label
      ? `Claude paused this request. Choose another model or check ${label} usage and credits in Claude.`
      : "Claude paused this request. Check your allowance and usage credits in Claude.",
    modelFamily: label?.toLowerCase() ?? null,
    reset: reset && !/[:/]{2}|https?:/i.test(reset) ? reset : null,
    usageLink: { url: CLAUDE_USAGE_URL, label: "Manage Claude usage" },
  };
}

/** A provider's usage-limit notice. `usageLink` is the provider's own usage page, when it has one. */
export type ClaudeLimitNotice = {
  title: string; detail: string; modelFamily: string | null; reset: string | null;
  usageLink: { url: string; label: string } | null;
};
