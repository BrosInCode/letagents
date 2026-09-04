const ELECTRON_INVOKE_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i;
const DESKTOP_API_ERROR_PREFIX = /^DesktopApiError:\s*/i;
const AUTHORIZATION_HEADER = /\bauthorization\s*([:=])\s*(?:"[^"]*"|'[^']*'|(?:bearer\s+)?[^\s,;]+)/gi;
const BEARER_CREDENTIAL = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_SCHEME_CREDENTIAL = /\b(bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const NAMED_CREDENTIAL = /\b((?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password))\s*([:=]|\s+)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const PROVIDER_KEY = /\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{6,}\b/g;
const KNOWN_SECRET = /\b(?:las(?:b|hg)_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gi;
const URL_USERINFO = /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const C0_C1_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Project an arbitrary provider/daemon error into bounded, credential-safe UI copy. */
export function safeUserVisibleErrorDetail(error: unknown, fallback: string): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  const detail = raw
    .replace(BIDI_CONTROL, "")
    .replace(C0_C1_CONTROL, " ")
    .replace(ELECTRON_INVOKE_PREFIX, "")
    .replace(DESKTOP_API_ERROR_PREFIX, "")
    .replace(AUTHORIZATION_HEADER, (_match, separator: string) => `Authorization${separator}[redacted]`)
    .replace(AUTH_SCHEME_CREDENTIAL, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(BEARER_CREDENTIAL, "Bearer [redacted]")
    .replace(NAMED_CREDENTIAL, (_match, label: string, separator: string) => `${label}${separator}[redacted]`)
    .replace(PROVIDER_KEY, "[redacted]")
    .replace(KNOWN_SECRET, "[redacted]")
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) return fallback;
  return detail.length > 800 ? `${detail.slice(0, 797)}...` : detail;
}
