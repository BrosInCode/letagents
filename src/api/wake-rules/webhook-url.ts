/**
 * Outbound wake webhooks call a URL that an agent chose. Before LetAgents
 * saves or calls one it must be https on port 443, it must not name this
 * server, and every address its host resolves to must be a public unicast
 * address: loopback, link-local, private (RFC 1918, CGNAT, ULA), multicast,
 * unspecified and reserved ranges are refused, for IPv4 and IPv6 alike,
 * including IPv4 written inside IPv6. The request then connects to the
 * address that was checked (it is pinned through the socket's `lookup`), so a
 * DNS change between the check and the connect cannot send it anywhere else.
 * No redirect is followed.
 *
 * Errors are classes (`WakeDeliveryErrorClass`), never transport text: what
 * is stored or shown cannot reveal how a host resolved.
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { HostResolveError, resolveWithinDeadline, type HostResolver } from "./dns-resolve.js";
import { letAgentsPublicHostnames } from "./public-url.js";

/** What went wrong with a delivery, as stored on the rule and shown to its owner. */
export type WakeDeliveryErrorClass =
  | "url_not_allowed"
  | "address_not_allowed"
  | "dns_timeout"
  | "dns_failed"
  | "connect_failed"
  | "tls_failed"
  | "timeout"
  | "http_redirect"
  | "http_4xx"
  | "http_throttled"
  | "http_5xx"
  | "body_too_large"
  | "access_denied"
  | "credential_revoked"
  | "target_unreadable"
  | "not_configured"
  | "smtp_rejected"
  | "smtp_deferred"
  | "smtp_operator";

/** The one answer to a refused URL, whatever the reason. */
export const WAKE_WEBHOOK_URL_REFUSED = "The URL is not allowed. Use a public https URL on port 443.";

export class WakeWebhookUrlError extends Error {
  readonly status = 400;
  /** Kept for tests and logs on this server; never shown to the caller. */
  constructor(readonly reason: string, readonly errorClass: WakeDeliveryErrorClass = "url_not_allowed") {
    super(WAKE_WEBHOOK_URL_REFUSED);
    this.name = "WakeWebhookUrlError";
  }
}

/** The host could not be resolved now. At registration it is refused; at delivery it is retried. */
export class WakeWebhookResolveError extends Error {
  readonly status = 400;
  constructor(readonly errorClass: "dns_timeout" | "dns_failed") {
    super(WAKE_WEBHOOK_URL_REFUSED);
    this.name = "WakeWebhookResolveError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a host name resolves to. Tests pass a stub; the server uses c-ares (`dns-resolve.ts`). */
export type WakeWebhookLookup = HostResolver;

let loopbackForTests: { ca?: string } | null = null;

/**
 * Tests only: lets a stub on `127.0.0.1` or `[::1]` receive deliveries, over
 * plain http or over https with a certificate signed by `ca`, on any port. No
 * environment variable or setting turns this on; only a test calls it.
 * Private addresses stay refused.
 */
export function allowLoopbackWakeWebhooksForTests(options: { ca?: string } | false): void {
  loopbackForTests = options === false ? null : { ...options };
}

type AddressClass = "loopback" | "private" | "link-local" | "multicast" | "unspecified" | "reserved";

const IPV4_REFUSED: ReadonlyArray<readonly [string, number, AddressClass]> = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "private"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "reserved"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "reserved"],
  ["198.51.100.0", 24, "reserved"],
  ["203.0.113.0", 24, "reserved"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value >>> 0;
}

const IPV4_RANGES = IPV4_REFUSED.map(([base, prefix, kind]) => ({
  base: parseIPv4(base)!,
  mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0,
  kind,
}));

function classifyIPv4(value: number): AddressClass | null {
  for (const range of IPV4_RANGES) {
    if (((value & range.mask) >>> 0) === range.base) return range.kind;
  }
  return null;
}

/** Eight 16-bit groups, or null when the text is not one IPv6 address. Zone ids are refused. */
function parseIPv6(input: string): number[] | null {
  let text = input.toLowerCase();
  if (!text || text.includes("%")) return null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half ? half.split(":") : []);
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const all = [...head, ...rest];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const zeros = 8 - all.length;
  return [...head, ...Array.from({ length: halves.length === 2 ? zeros : 0 }, () => "0"), ...rest]
    .map((group) => Number.parseInt(group, 16));
}

function prefixMatches(groups: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let index = 0; bits > 0; index += 1, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if (((groups[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

function embeddedIPv4(high: number, low: number): number {
  return ((high << 16) | low) >>> 0;
}

function classifyIPv6(groups: readonly number[]): AddressClass | null {
  const zeroThrough = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return "unspecified";
  if (zeroThrough(7) && groups[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 rules decide.
  if (zeroThrough(5) && groups[5] === 0xffff) return classifyIPv4(embeddedIPv4(groups[6]!, groups[7]!));
  // IPv4-compatible (::a.b.c.d) is deprecated and never routed.
  if (zeroThrough(6)) return "reserved";
  // NAT64 well-known prefix reaches the embedded IPv4 address.
  if (prefixMatches(groups, [0x64, 0xff9b, 0, 0, 0, 0], 96)) return classifyIPv4(embeddedIPv4(groups[6]!, groups[7]!));
  if (prefixMatches(groups, [0x64, 0xff9b, 0x1], 48)) return "private";
  // 6to4 carries an IPv4 address in bits 16 to 48.
  if (prefixMatches(groups, [0x2002], 16)) return classifyIPv4(embeddedIPv4(groups[1]!, groups[2]!));
  if (prefixMatches(groups, [0xfc00], 7)) return "private";
  if (prefixMatches(groups, [0xfe80], 10)) return "link-local";
  if (prefixMatches(groups, [0xfec0], 10)) return "private";
  if (prefixMatches(groups, [0xff00], 8)) return "multicast";
  // Teredo hides its IPv4 address; documentation, benchmarking, ORCHID and
  // discard ranges are not hosts.
  if (prefixMatches(groups, [0x2001, 0], 32)) return "reserved";
  if (prefixMatches(groups, [0x2001, 0x2, 0], 48)) return "reserved";
  if (prefixMatches(groups, [0x2001, 0x10], 28)) return "reserved";
  if (prefixMatches(groups, [0x2001, 0x20], 28)) return "reserved";
  if (prefixMatches(groups, [0x2001, 0xdb8], 32)) return "reserved";
  if (prefixMatches(groups, [0x3fff, 0], 20)) return "reserved";
  if (prefixMatches(groups, [0x100, 0, 0, 0], 64)) return "reserved";
  // Everything else outside global unicast (2000::/3) is not a public host.
  if (!prefixMatches(groups, [0x2000], 3)) return "reserved";
  return null;
}

/**
 * Why an address may not receive a webhook ("loopback", "private", ...), or
 * null when it is a public unicast address. Text that is not an IP address is
 * refused as "reserved".
 */
export function refusedWebhookAddress(address: string): AddressClass | null {
  const family = isIP(address);
  if (family === 4) return classifyIPv4(parseIPv4(address)!);
  if (family === 6) {
    const groups = parseIPv6(address);
    return groups ? classifyIPv6(groups) : "reserved";
  }
  return "reserved";
}

function bareHost(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

function loopbackAllowedForTests(address: string): boolean {
  return loopbackForTests !== null && (address === "127.0.0.1" || address === "::1");
}

/**
 * The target as a rule identifies it: scheme, host and path. Two URLs that
 * differ only in their query string (or fragment) are one target.
 */
export function wakeWebhookTargetKey(url: URL): string {
  return `${url.protocol}//${bareHost(url).toLowerCase()}:${url.port || "443"}${url.pathname}`;
}

export function wakeWebhookHost(url: URL): string {
  return bareHost(url).toLowerCase();
}

/** Parse and check the URL itself. The fragment is dropped: it never leaves the client. */
export function parseWakeWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WakeWebhookUrlError("not a URL");
  }
  // Under the test switch plain http and any port are accepted; the address
  // check below still admits only loopback for them.
  const testing = loopbackForTests !== null;
  if (url.protocol !== "https:" && !(testing && url.protocol === "http:")) throw new WakeWebhookUrlError("not https");
  if (url.port && url.port !== "443" && !testing) throw new WakeWebhookUrlError("not port 443");
  if (url.username || url.password) throw new WakeWebhookUrlError("credentials in the URL");
  const host = bareHost(url).toLowerCase();
  if (!host) throw new WakeWebhookUrlError("no host");
  if (host === "localhost" || host.endsWith(".localhost")) throw new WakeWebhookUrlError("localhost");
  // This server's own host, and any name under it.
  for (const own of letAgentsPublicHostnames()) {
    if (host === own || host.endsWith(`.${own}`)) throw new WakeWebhookUrlError("this server");
  }
  url.hash = "";
  return url;
}

/**
 * Resolve the URL's host and return the one address to connect to. Every
 * address the name resolves to must be public: a name that also points at a
 * private address is refused, not filtered.
 */
export async function resolveWakeWebhookAddress(
  url: URL,
  lookup?: WakeWebhookLookup,
  deadlineMs?: number,
): Promise<ResolvedAddress> {
  const host = bareHost(url);
  const literal = isIP(host);
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    try {
      addresses = await resolveWithinDeadline(host, lookup, deadlineMs);
    } catch (error) {
      throw new WakeWebhookResolveError(error instanceof HostResolveError && error.reason === "timeout" ? "dns_timeout" : "dns_failed");
    }
  }
  if (addresses.length === 0) throw new WakeWebhookResolveError("dns_failed");
  for (const entry of addresses) {
    if (loopbackAllowedForTests(entry.address)) continue;
    const refused = refusedWebhookAddress(entry.address);
    if (refused) throw new WakeWebhookUrlError(`resolves to a ${refused} address`, "address_not_allowed");
  }
  const first = addresses[0]!;
  return { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

/** Check a URL before it is saved: parse it, resolve it, refuse what is not public. */
export async function assertWakeWebhookUrl(raw: string, lookup?: WakeWebhookLookup): Promise<URL> {
  const url = parseWakeWebhookUrl(raw);
  await resolveWakeWebhookAddress(url, lookup);
  return url;
}

export const WAKE_WEBHOOK_TIMEOUT_MS = 10_000;
export const WAKE_WEBHOOK_MAX_BODY_BYTES = 4096;
/** The longest a 408 or 429 answer may hold a delivery back. */
export const WAKE_WEBHOOK_MAX_HOLD_MS = 5 * 60_000;

export type WakeWebhookOutcome = "delivered" | "retry" | "dead";

export interface WakeWebhookSendResult {
  outcome: WakeWebhookOutcome;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  error: WakeDeliveryErrorClass | null;
  /**
   * 408, 425 or 429: the receiver asked for time. The retry waits for its
   * Retry-After (at most 5 minutes) and does not count toward pausing the rule.
   */
  throttled?: boolean;
  /** Set from Retry-After on a throttling status and on 503 (which counts as usual). */
  retryAfterMs?: number;
  /** The start of the response body, only when the caller asked to read it (a verification challenge). */
  body?: string;
}

/** The statuses that mean "not now": the retry waits for Retry-After and never counts toward a pause. */
export function isThrottlingStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429;
}

/**
 * 2xx delivers. Network errors, 5xx, 408, 425 and 429 are retried; other 4xx
 * (410 Gone and 413 Payload Too Large included) and redirects are final.
 */
export function classifyWakeWebhookStatus(status: number): WakeWebhookOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 0 || status >= 500 || isThrottlingStatus(status)) return "retry";
  return "dead";
}

function statusErrorClass(status: number): WakeDeliveryErrorClass | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return "http_redirect";
  if (isThrottlingStatus(status)) return "http_throttled";
  if (status >= 500) return "http_5xx";
  return "http_4xx";
}

/** Retry-After as seconds or an HTTP date, bounded to [1 s, 5 min]; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | string[] | undefined, nowMs = Date.now()): number | undefined {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!text) return undefined;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - nowMs;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 1000), WAKE_WEBHOOK_MAX_HOLD_MS);
}

function transportErrorClass(error: NodeJS.ErrnoException, timedOut: boolean): WakeDeliveryErrorClass {
  if (timedOut) return "timeout";
  const code = String(error.code ?? "");
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return "tls_failed";
  return "connect_failed";
}

/**
 * POST one signed body. The response body is dropped unread (only the status
 * counts) unless `readBodyBytes` asks for its first bytes, as a verification
 * challenge does. Resolves; never throws.
 */
export async function postWakeWebhook(input: {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs?: number;
  lookup?: WakeWebhookLookup;
  /** The largest body this call may send; a wake webhook's 4 KB unless the caller's contract allows more. */
  maxBodyBytes?: number;
  /** Read at most this many bytes of the response body into `body`. */
  readBodyBytes?: number;
}): Promise<WakeWebhookSendResult> {
  const bytes = Buffer.byteLength(input.body, "utf8");
  if (bytes > (input.maxBodyBytes ?? WAKE_WEBHOOK_MAX_BODY_BYTES)) return { outcome: "dead", status: 0, error: "body_too_large" };
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? WAKE_WEBHOOK_TIMEOUT_MS;
  let url: URL;
  let pinned: ResolvedAddress;
  try {
    url = parseWakeWebhookUrl(input.url);
    // DNS gets part of the 10 s, never all of it.
    pinned = await resolveWakeWebhookAddress(url, input.lookup, Math.min(3_000, Math.max(100, timeoutMs / 3)));
  } catch (error) {
    if (error instanceof WakeWebhookResolveError) return { outcome: "retry", status: 0, error: error.errorClass };
    return { outcome: "dead", status: 0, error: error instanceof WakeWebhookUrlError ? error.errorClass : "url_not_allowed" };
  }
  const host = bareHost(url);
  const transport = url.protocol === "https:" ? https : http;
  const remainingMs = Math.max(100, timeoutMs - (Date.now() - startedAt));
  const ca = loopbackForTests?.ca;
  return new Promise<WakeWebhookSendResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: WakeWebhookSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // The socket connects only to the address checked above, whatever DNS says now.
    const pinnedLookup = (_hostname: string, options: unknown, callback?: unknown) => {
      const done = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (all) done(null, [{ address: pinned.address, family: pinned.family }]);
      else done(null, pinned.address, pinned.family);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      agent: false,
      lookup: pinnedLookup as never,
      ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
      ...(url.protocol === "https:" && ca ? { ca } : {}),
      headers: { ...input.headers, Host: url.host, "Content-Length": String(bytes) },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const throttled = isThrottlingStatus(status);
      const retryAfterMs = throttled || status === 503 ? parseRetryAfter(response.headers["retry-after"]) : undefined;
      const result: WakeWebhookSendResult = {
        outcome: classifyWakeWebhookStatus(status),
        status,
        error: statusErrorClass(status),
        ...(throttled ? { throttled: true } : {}),
        ...(retryAfterMs ? { retryAfterMs } : {}),
      };
      const readBytes = input.readBodyBytes;
      if (!readBytes || result.outcome !== "delivered") {
        // Only the status matters; drop the body unread.
        response.destroy();
        finish(result);
        return;
      }
      // A verification answer: keep its first bytes, then stop reading.
      const chunks: Buffer[] = [];
      let collected = 0;
      response.on("data", (chunk: Buffer) => {
        if (collected >= readBytes) return;
        const slice = chunk.subarray(0, readBytes - collected);
        chunks.push(slice);
        collected += slice.length;
        if (collected >= readBytes) response.destroy();
      });
      const done = () => finish({ ...result, body: Buffer.concat(chunks).toString("utf8") });
      response.on("end", done);
      response.on("close", done);
      response.on("error", done);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error("timeout"));
    }, remainingMs);
    timer.unref?.();
    request.on("error", (error) => {
      finish({ outcome: "retry", status: 0, error: transportErrorClass(error, timedOut) });
    });
    request.end(input.body);
  });
}
