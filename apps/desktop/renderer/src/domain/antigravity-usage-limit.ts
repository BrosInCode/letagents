import { formatDate } from "./formatters";
import type { ClaudeLimitNotice } from "./claude-usage-limit";

/**
 * The adapter's words for a request that Antigravity turned down with a usage
 * limit error: the current ones, and the ones of earlier releases.
 */
const LIMIT_ERROR = /^(?:You may have run out of Antigravity usage\b|Antigravity's usage limit for this model is reached\b)/;
/** A turn agy ended as refused with no text of its own: agy reports an exhausted quota that way. */
const REFUSED_TURN = /^Antigravity refused this turn\. (?:You may have run out of usage|The account may have reached its usage limit)\.$/;

/**
 * What the owner reads when an Antigravity agent's request failed on a usage
 * limit. LetAgents reads no account limits to prove it (that needs a call to
 * Google outside ACP), so the notice says "may". The reset time shows only
 * while it is still ahead.
 */
export function antigravityLimitNotice(error: string | null | undefined, provider: string | null | undefined, now = Date.now()): ClaudeLimitNotice | null {
  if (provider !== "antigravity" || !error) return null;
  const text = error.trim();
  const limitError = LIMIT_ERROR.test(text);
  if (!limitError && !REFUSED_TURN.test(text)) return null;
  const resetAt = Date.parse(/\bresets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(text)?.[1] ?? "");
  return {
    title: "You may have run out of usage",
    detail: limitError
      ? "Antigravity turned this request down with a usage limit error. Try again after the limit resets, or choose another model in Settings."
      : "Antigravity refused this request without a reason. A usage limit is the usual cause. Try again later, or choose another model in Settings.",
    modelFamily: null,
    reset: Number.isFinite(resetAt) && resetAt > now ? formatDate("weekdayHourMinute", new Date(resetAt)) : null,
    usageLink: null,
  };
}
