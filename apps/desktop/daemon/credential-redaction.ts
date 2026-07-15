import type { DaemonActivityEvent } from "./types.js";

const REDACTED = "[REDACTED]";
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_STRING_CHARS = 8 * 1024;
const MAX_COLLECTION_ENTRIES = 100;
const MAX_DEPTH = 12;

const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|credential|credentials|password|passwd|secret|api[_-]?key|private[_-]?key|token)$|(?:authorization|apiKey|privateKey|setCookie|clientSecret|dbPassword|accessToken|refreshToken|authToken|bearerToken|sessionToken|letagentsToken|credential|credentials|password|passwd|secret|token)$/i;
const AUTHORIZATION_ASSIGNMENT = /((?:\\?["']?)\b(?:authorization|proxy[_-]?authorization)(?:\\?["']?)\s*[:=]\s*(?:\\?["']?))(?!(?:bearer|basic)\b)([^\\\s"',}\]]{4,})/gi;
const EMBEDDED_ASSIGNMENT = /((?:\\?["']?)\b(?:[a-z0-9_.-]*(?:cookie|setCookie|set[_-]?cookie|credential|credentials|password|passwd|secret|clientSecret|dbPassword|apiKey|api[_-]?key|privateKey|private[_-]?key|token|accessToken|refreshToken|authToken|bearerToken|sessionToken|letagentsToken|(?:access|refresh|auth|bearer|session|letagents)[_-]?token))(?:\\?["']?)\s*[:=]\s*(?:\\?["']?))(?!\[REDACTED\]|<redacted>|\*{3,})([^\\\s"',}\]]{4,})/gi;
const AUTHORIZATION_SCHEME_VALUE = /(\b(?:bearer|basic)\s+)([a-z0-9._~+\/-]{8,}={0,2})/gi;
const KNOWN_TOKEN = /\b(?:las(?:b|hg)_[a-z0-9_-]{20,}|github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gi;
const URL_PASSWORD = /(https?:\/\/[^\s/:@]+:)([^\s/@]{4,})(@)/gi;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

export type RedactionResult<T = unknown> = { value: T; redacted: boolean; truncated: boolean };

export function redactCredentialText(value: string, maxChars = MAX_STRING_CHARS): RedactionResult<string> {
  let redacted = false;
  let output = value
    .replace(PRIVATE_KEY, () => { redacted = true; return REDACTED; })
    .replace(AUTHORIZATION_SCHEME_VALUE, (_match, prefix: string) => { redacted = true; return `${prefix}${REDACTED}`; })
    .replace(AUTHORIZATION_ASSIGNMENT, (_match, prefix: string) => { redacted = true; return `${prefix}${REDACTED}`; })
    .replace(EMBEDDED_ASSIGNMENT, (_match, prefix: string) => { redacted = true; return `${prefix}${REDACTED}`; })
    .replace(KNOWN_TOKEN, () => { redacted = true; return REDACTED; })
    .replace(URL_PASSWORD, (_match, prefix: string, _password: string, suffix: string) => { redacted = true; return `${prefix}${REDACTED}${suffix}`; });
  const truncated = output.length > maxChars;
  if (truncated) output = `${output.slice(0, maxChars)}…`;
  return { value: output, redacted, truncated };
}

export function redactCredentialValue(value: unknown): RedactionResult {
  const state = { redacted: false, truncated: false };
  const seen = new WeakSet<object>();
  const walk = (candidate: unknown, key = "", depth = 0): unknown => {
    if (SENSITIVE_KEY.test(key)) {
      state.redacted = true;
      return REDACTED;
    }
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      return "[MAX_DEPTH]";
    }
    if (typeof candidate === "string") {
      const safe = redactCredentialText(candidate);
      state.redacted ||= safe.redacted;
      state.truncated ||= safe.truncated;
      return safe.value;
    }
    if (typeof candidate === "bigint") return candidate.toString();
    if (!candidate || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) {
      state.truncated = true;
      return "[CIRCULAR]";
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_COLLECTION_ENTRIES) state.truncated = true;
      return candidate.slice(0, MAX_COLLECTION_ENTRIES).map((entry) => walk(entry, "", depth + 1));
    }
    const record = candidate as Record<string, unknown>;
    const sanitizedRecord: Record<string, unknown> = {};
    let count = 0;
    for (const entryKey in record) {
      if (!Object.prototype.hasOwnProperty.call(record, entryKey)) continue;
      if (count >= MAX_COLLECTION_ENTRIES) { state.truncated = true; break; }
      count += 1;
      try { sanitizedRecord[entryKey] = walk(record[entryKey], entryKey, depth + 1); }
      catch { state.truncated = true; sanitizedRecord[entryKey] = "[UNREADABLE]"; }
    }
    return sanitizedRecord;
  };

  let sanitized = walk(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitized) ?? "null";
  } catch {
    return { value: { preview: "[UNSERIALIZABLE_PROVIDER_PAYLOAD]" }, redacted: state.redacted, truncated: true };
  }
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > MAX_PAYLOAD_BYTES) {
    sanitized = { preview: "[PAYLOAD_TOO_LARGE]", originalBytes: serializedBytes };
    state.truncated = true;
  }
  return { value: sanitized, redacted: state.redacted, truncated: state.truncated };
}

export function sanitizeDaemonActivityEvent(event: DaemonActivityEvent): DaemonActivityEvent {
  const payload = redactCredentialValue(event.payload);
  const provider = redactCredentialText(String(event.provider ?? ""), 160);
  const kind = redactCredentialText(String(event.kind ?? ""), 160);
  const method = redactCredentialText(String(event.method ?? ""), 500);
  const summary = redactCredentialText(String(event.summary ?? ""), 500);
  const durableRef = event.durable_payload_ref === null
    ? { value: null, redacted: false, truncated: false }
    : redactCredentialText(String(event.durable_payload_ref), 2_048);
  return {
    ...event,
    provider: provider.value,
    kind: kind.value,
    method: method.value,
    summary: summary.value,
    payload: payload.value,
    payload_truncated: event.payload_truncated || payload.truncated || provider.truncated || kind.truncated || method.truncated || summary.truncated || durableRef.truncated,
    payload_redacted: event.payload_redacted || payload.redacted || provider.redacted || kind.redacted || method.redacted || summary.redacted || durableRef.redacted,
    durable_payload_ref: durableRef.value,
  };
}
