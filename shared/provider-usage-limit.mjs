/**
 * Provider usage limits: one vocabulary for the desktop daemon, the API, the
 * web app and the desktop app.
 *
 * When an agent's model provider refuses work because the account's usage
 * limit (or prepaid credit) is used up, the room is told once. The notice is a
 * plain room message from "letagents". Its text keeps the reset time as an ISO
 * timestamp, so every app can show that time in the viewer's own time zone,
 * and an agent that reads the room still gets an exact time.
 */

/** Source of the room notice that says an agent reached its usage limit. */
export const PROVIDER_USAGE_LIMIT_SOURCE = "provider_usage_limit";

/** Longest agent name the notice keeps; longer names are cut. */
const AGENT_NAME_MAX_LENGTH = 64;

/** Year 2100 in milliseconds: a later reset time is not a real reset time. */
const MAX_RESET_EPOCH_MS = 4_102_444_800_000;

/**
 * Who owns the limit, as people say it. Open Model connects to a provider the
 * owner chose, so it names that provider generically.
 */
export function providerUsageLimitOwner(provider) {
  switch (String(provider ?? "").trim().toLowerCase()) {
    case "claude":
    case "claude-code": return "Claude";
    case "codex": return "Codex";
    case "cursor": return "Cursor";
    case "antigravity": return "Antigravity";
    default: return "The model provider";
  }
}

/** "Claude's usage limit", "The model provider's usage limit". */
export function providerUsageLimitSubject(provider) {
  return `${providerUsageLimitOwner(provider)}'s usage limit`;
}

/** A reset time that can be shown, as epoch milliseconds, or null. */
export function normalizeUsageLimitResetMs(value) {
  const ms = typeof value === "string" ? Date.parse(value) : value;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= MAX_RESET_EPOCH_MS
    ? Math.trunc(ms) : null;
}

function cleanAgentName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, AGENT_NAME_MAX_LENGTH);
  return name || "An agent";
}

/**
 * The room notice text. `phase` is "start" when the agent could not start and
 * "turn" when the provider refused it during work. A refused turn is not run
 * again; the agent's later messages wait for the reset.
 */
export function providerUsageLimitNoticeText(input) {
  const name = cleanAgentName(input?.agentName);
  const subject = providerUsageLimitSubject(input?.provider);
  const resetMs = normalizeUsageLimitResetMs(input?.resetsAt ?? null);
  const reset = resetMs === null ? null : new Date(resetMs).toISOString();
  if (input?.phase === "start") {
    return reset === null
      ? `${name} couldn't start: ${subject} was reached. LetAgents starts it when the limit allows, or after the owner changes the account.`
      : `${name} couldn't start: ${subject} was reached. LetAgents starts it after the limit resets at ${reset}.`;
  }
  return reset === null
    ? `${name} stopped: ${subject} was reached. Its messages wait until the limit allows, or until the owner changes the account.`
    : `${name} stopped: ${subject} was reached. Its messages wait until the limit resets at ${reset}.`;
}

const ISO = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z)";
const NOTICE_PATTERN = new RegExp(`^(.{1,64}?) (couldn't start|stopped): (.+?)'s usage limit was reached\\. (?:LetAgents starts it after the limit resets at ${ISO}|Its messages wait until the limit resets at ${ISO}|LetAgents starts it when the limit allows, or after the owner changes the account|Its messages wait until the limit allows, or until the owner changes the account)\\.$`);

/**
 * Read a usage-limit notice back. Returns null for any other text, so a
 * person cannot make an ordinary message look like a notice: callers also
 * check the message source.
 */
export function parseProviderUsageLimitNotice(text) {
  const match = NOTICE_PATTERN.exec(String(text ?? "").trim());
  if (!match) return null;
  const phase = match[2] === "couldn't start" ? "start" : "turn";
  const iso = match[4] ?? match[5];
  // A start notice must read as a start, a turn notice as a turn.
  if ((phase === "start") !== /\. LetAgents starts it /.test(match[0])) return null;
  return {
    agentName: match[1],
    phase,
    owner: match[3],
    resetsAtMs: iso ? normalizeUsageLimitResetMs(iso) : null,
  };
}

/**
 * The words that open a delivery held for a usage limit. The desktop daemon
 * writes them, and only a blocked delivery whose reason starts with them and
 * that has a resume time is such a hold.
 */
export function isUsageLimitPauseDetail(text) {
  return /^.+?'s usage limit was reached\. This message waits /.test(String(text ?? ""));
}

/**
 * Whether a provider's error text says the account's usage limit or credit is
 * used up. A short rate limit ("too many requests", "overloaded") is not a
 * usage limit: it clears in seconds, and the provider retries it itself.
 */
export function looksLikeProviderUsageLimit(text) {
  const value = String(text ?? "");
  if (!value.trim()) return false;
  // A per-minute or per-second quota is a short rate limit, not a used-up one.
  if (/per[ _-]?(?:minute|second)|\b(?:rpm|tpm|rps)\b|requests? per min/i.test(value)) return false;
  return /usage[ _-]?limit|\b(?:\d+-hour|weekly|daily|monthly|session|opus|sonnet) limit reached|requires more credits|hit your (?:usage )?limit|you've reached your limit|quota[ _-]?(?:exhausted|exceeded|reached)|insufficient[ _-]?quota|exceeded your (?:current )?quota|out of (?:credits|quota)|insufficient (?:credit|credits|balance)|credit balance is too low|HTTP 402|\b402 payment required|payment required|spend(?:ing)? limit|billing[ _-]?(?:error|limit|hard limit)/i.test(value);
}
