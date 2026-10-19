/**
 * Shared Intl instances. `toLocaleTimeString()` and friends build a new
 * formatter on every call, which is the slow part of formatting a date. The
 * formatters here are created once, on first use, and then reused.
 *
 * Cache rule: one instance per preset below (a closed set, so the cache cannot
 * grow). They resolve the default locale when first used. The app does not
 * change locale while it runs, and a restart builds fresh instances.
 */

const dateTimePresets = {
  /** 09:41 */
  clockTime: { hour: "2-digit", minute: "2-digit" },
  /** Mon, Jun 1, 2026 */
  dateDivider: { weekday: "short", month: "short", day: "numeric", year: "numeric" },
  /** Jun 1, 09:41 (two-digit hour) */
  monthDayTime2: { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  /** Jun 1, 9:41 AM */
  monthDayTime: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  /** 9:41 AM */
  hourMinute: { hour: "numeric", minute: "2-digit" },
  /** Mon 9:41 AM */
  weekdayHourMinute: { weekday: "short", hour: "numeric", minute: "2-digit" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateTimePreset = keyof typeof dateTimePresets;

const dateTimeFormats = new Map<DateTimePreset, Intl.DateTimeFormat>();
let compactNumberFormat: Intl.NumberFormat | null = null;
let decimalNumberFormat: Intl.NumberFormat | null = null;
let textCollator: Intl.Collator | null = null;

/** Count of Intl objects built, so tests can prove the cache is hit. */
export const formatterBuildCount = { dateTime: 0, number: 0, collator: 0 };

/**
 * Format a date with a preset. Matches `Date#toLocale*String` output, including
 * its "Invalid Date" result (a bare `Intl.DateTimeFormat#format` throws).
 */
export function formatDate(preset: DateTimePreset, value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  let format = dateTimeFormats.get(preset);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, dateTimePresets[preset]);
    dateTimeFormats.set(preset, format);
    formatterBuildCount.dateTime += 1;
  }
  return format.format(date);
}

/** `Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })`. */
export function formatCompactNumber(value: number): string {
  if (!compactNumberFormat) {
    compactNumberFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
    formatterBuildCount.number += 1;
  }
  return compactNumberFormat.format(value);
}

/** `new Intl.NumberFormat().format(value)`. */
export function formatDecimalNumber(value: number): string {
  if (!decimalNumberFormat) {
    decimalNumberFormat = new Intl.NumberFormat();
    formatterBuildCount.number += 1;
  }
  return decimalNumberFormat.format(value);
}

/**
 * Same ordering as `left.localeCompare(right)` with no arguments, without
 * building a collator for each comparison.
 */
export function compareText(left: string, right: string): number {
  if (!textCollator) {
    textCollator = new Intl.Collator();
    formatterBuildCount.collator += 1;
  }
  return textCollator.compare(left, right);
}
