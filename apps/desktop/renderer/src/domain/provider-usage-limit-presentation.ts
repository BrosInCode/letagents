import {
  PROVIDER_USAGE_LIMIT_SOURCE,
  parseProviderUsageLimitNotice,
} from "../../../../../shared/provider-usage-limit.mjs";

/** Locale and time zone for a reset time; both default to the viewer's own. */
export interface UsageLimitTimeOptions {
  locale?: string;
  timeZone?: string;
}

function calendarDay(ms: number, options: UsageLimitTimeOptions): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));
}

/**
 * A reset time as the viewer reads it: "3:00 PM" today, or with the day,
 * like "Sat 10 Oct, 3:00 PM", on another day.
 */
export function formatUsageLimitResetTime(resetsAtMs: number, nowMs = Date.now(), options: UsageLimitTimeOptions = {}): string {
  const date = new Date(resetsAtMs);
  const time = date.toLocaleTimeString(options.locale, { hour: "numeric", minute: "2-digit", timeZone: options.timeZone });
  if (calendarDay(resetsAtMs, options) === calendarDay(nowMs, options)) return time;
  const day = date.toLocaleDateString(options.locale, { weekday: "short", day: "numeric", month: "short", timeZone: options.timeZone });
  return `${day}, ${time}`;
}

export interface UsageLimitNoticePresentation {
  /** "CalmLake stopped: Claude's usage limit was reached". */
  title: string;
  /** What happens next, with the reset time in the viewer's time zone. */
  detail: string;
}

/**
 * The room notice that an agent reached its provider's usage limit, as a
 * short title and next step. Null for any other message, including a person's
 * message with the same words: only a LetAgents notice with that source counts.
 */
export function usageLimitNoticePresentation(
  message: { sender: string; source?: string | null; text?: string | null },
  nowMs = Date.now(),
  options: UsageLimitTimeOptions = {},
): UsageLimitNoticePresentation | null {
  if (message.source !== PROVIDER_USAGE_LIMIT_SOURCE) return null;
  if (!["letagents", "system"].includes(String(message.sender || "").trim().toLowerCase())) return null;
  const notice = parseProviderUsageLimitNotice(message.text);
  if (!notice) return null;
  const starting = notice.phase === "start";
  const title = `${notice.agentName} ${starting ? "couldn't start" : "stopped"}: ${notice.owner}'s usage limit was reached`;
  if (notice.resetsAtMs === null) {
    return { title, detail: starting
      ? "Starts when the limit allows, or after the owner changes the account"
      : "Its messages wait until the limit allows, or until the owner changes the account" };
  }
  const time = formatUsageLimitResetTime(notice.resetsAtMs, nowMs, options);
  if (notice.resetsAtMs <= nowMs) return { title, detail: `The limit reset at ${time}` };
  return { title, detail: starting ? `Starts after the limit resets at ${time}` : `Its messages wait until the limit resets at ${time}` };
}
