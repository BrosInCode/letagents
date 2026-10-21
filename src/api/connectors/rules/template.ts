import type { TrackerProvider, TrackerRuleTemplateVariable } from "../../../../shared/ticket-connectors.mjs";
import { TRACKER_COMMENT_MAX_LENGTH } from "../../workflow-effects/broker.js";

export type TrackerRuleTemplateValues = Partial<Record<TrackerRuleTemplateVariable, string | number | null | undefined>>;

const VALUE_MAX_LENGTH = 300;
const URL_MAX_LENGTH = 2_048;
const URL_VARIABLES = new Set<string>(["pr_url"]);
const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
// Linear renders comments as Markdown. Escaping these keeps a value plain text:
// no links, images, emphasis, headings, code, tables or HTML from a PR title.
const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~=:]/g;

/**
 * One value as plain text on one line: control characters and line breaks
 * become spaces, and it is cut to a bounded length.
 */
function plainValue(value: string, max: number): string {
  // C0 and C1 controls, line and paragraph separators, and bidi overrides.
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cut(flat, max);
}

/** Cut by code points, so a surrogate pair is never split. */
function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

/** Only an https URL is inserted as a URL; anything else becomes empty. */
function urlValue(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value.length <= URL_MAX_LENGTH && !/[\s<>"`]/.test(value) ? url.toString() : "";
  } catch {
    return "";
  }
}

function escapeForProvider(provider: TrackerProvider, value: string): string {
  if (provider !== "linear") return value; // Jira comments are sent as plain ADF text nodes.
  // A zero-width space after "@" stops a value from mentioning a Linear user.
  return value.replace(MARKDOWN_SPECIAL, (char) => `\\${char}`).replace(/@/g, "@\u200b");
}

/**
 * Fills a comment template. The template is the rule owner's text and is kept
 * as written; every variable comes from the repo event, so each value is
 * inserted as plain text for the tracker it goes to (no Markdown on Linear,
 * no line breaks anywhere). Unknown placeholders were refused when the rule
 * was saved; any left are removed.
 */
export function renderTrackerRuleTemplate(
  template: string,
  values: TrackerRuleTemplateValues,
  provider: TrackerProvider,
): string {
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const raw = values[name as TrackerRuleTemplateVariable];
    if (raw === null || raw === undefined) return "";
    const text = String(raw);
    if (URL_VARIABLES.has(name)) return urlValue(text);
    return escapeForProvider(provider, plainValue(text, VALUE_MAX_LENGTH));
  });
  if (rendered.length <= TRACKER_COMMENT_MAX_LENGTH) return rendered;
  // Never end on half an escape ("\\") or half a surrogate pair.
  return Array.from(rendered.slice(0, TRACKER_COMMENT_MAX_LENGTH - 1)).join("").replace(/(?<!\\)\\$/, "").replace(/[\ud800-\udbff]$/, "");
}
