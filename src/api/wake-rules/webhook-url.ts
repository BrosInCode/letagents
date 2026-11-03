/**
 * Outbound wake webhooks call a URL that an agent chose. Before LetAgents
 * saves or calls one it must be https, and every address its host resolves
 * to must be a public unicast address: loopback, link-local, private (RFC
 * 1918, CGNAT, ULA), multicast, unspecified and reserved ranges are refused,
 * for IPv4 and IPv6 alike, including IPv4 written inside IPv6. The request
 * then connects to the address that was checked (it is pinned through the
 * socket's `lookup`), so a DNS change between the check and the connect
 * cannot send it anywhere else. No redirect is followed.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export class WakeWebhookUrlError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "WakeWebhookUrlError";
  }
}

/** The host could not be resolved now. At registration it is refused; at delivery it is retried. */
export class WakeWebhookResolveError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "WakeWebhookResolveError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a host name resolves to, as `dns.lookup(host, { all: true })` returns them. */
export type WakeWebhookLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const systemLookup: WakeWebhookLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

let loopbackHttpForTests = false;

/**
 * Tests only: lets a stub on `http://127.0.0.1` (or `[::1]`) receive
 * deliveries over plain http. No environment variable or setting turns this
 * on; only a test calls it. Private addresses stay refused.
 */
export function allowLoopbackHttpWakeWebhooksForTests(enabled: boolean): void {
  loopbackHttpForTests = enabled;
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
  // Teredo hides its IPv4 address; documentation and discard ranges are not hosts.
  if (prefixMatches(groups, [0x2001, 0], 32)) return "reserved";
  if (prefixMatches(groups, [0x2001, 0xdb8], 32)) return "reserved";
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
  return loopbackHttpForTests && (address === "127.0.0.1" || address === "::1");
}

/** Parse and check the URL itself. The fragment is dropped: it never leaves the client. */
export function parseWakeWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WakeWebhookUrlError("webhook.url is not a valid URL.");
  }
  // Under the test switch plain http is accepted; the address check below still admits only loopback for it.
  const allowHttp = loopbackHttpForTests && url.protocol === "http:";
  if (url.protocol !== "https:" && !allowHttp) throw new WakeWebhookUrlError("webhook.url must use https.");
  if (url.username || url.password) throw new WakeWebhookUrlError("webhook.url must not carry a user name or password.");
  const host = bareHost(url).toLowerCase();
  if (!host) throw new WakeWebhookUrlError("webhook.url needs a host.");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new WakeWebhookUrlError("webhook.url must reach a public address, not this server.");
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
  lookup: WakeWebhookLookup = systemLookup,
): Promise<ResolvedAddress> {
  const host = bareHost(url);
  const literal = isIP(host);
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new WakeWebhookResolveError(`webhook.url host ${host} could not be resolved.`);
    }
  }
  if (addresses.length === 0) throw new WakeWebhookResolveError(`webhook.url host ${host} could not be resolved.`);
  for (const entry of addresses) {
    if (loopbackAllowedForTests(entry.address) && url.protocol === "http:") continue;
    const refused = refusedWebhookAddress(entry.address);
    if (refused) {
      throw new WakeWebhookUrlError(`webhook.url must reach a public address; ${host} resolves to a ${refused} address.`);
    }
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

export type WakeWebhookOutcome = "delivered" | "retry" | "dead";

export interface WakeWebhookSendResult {
  outcome: WakeWebhookOutcome;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  error: string | null;
}

/** 2xx delivers. Network errors and 5xx are retried; 4xx and redirects are final. */
export function classifyWakeWebhookStatus(status: number): WakeWebhookOutcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status === 0 || status >= 500) return "retry";
  return "dead";
}

function describeStatus(status: number): string | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) return `HTTP ${status}: redirects are not followed`;
  return `HTTP ${status}`;
}

/**
 * POST one signed body. The response body is never read; only the status
 * counts. Resolves; never throws.
 */
export async function postWakeWebhook(input: {
  url: string;
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs?: number;
  lookup?: WakeWebhookLookup;
}): Promise<WakeWebhookSendResult> {
  const bytes = Buffer.byteLength(input.body, "utf8");
  if (bytes > WAKE_WEBHOOK_MAX_BODY_BYTES) {
    return { outcome: "dead", status: 0, error: `Request body is ${bytes} bytes; the limit is ${WAKE_WEBHOOK_MAX_BODY_BYTES}.` };
  }
  let url: URL;
  let pinned: ResolvedAddress;
  try {
    url = parseWakeWebhookUrl(input.url);
    pinned = await resolveWakeWebhookAddress(url, input.lookup);
  } catch (error) {
    if (error instanceof WakeWebhookResolveError) return { outcome: "retry", status: 0, error: error.message };
    return { outcome: "dead", status: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const host = bareHost(url);
  const transport = url.protocol === "https:" ? https : http;
  const timeoutMs = input.timeoutMs ?? WAKE_WEBHOOK_TIMEOUT_MS;
  return new Promise<WakeWebhookSendResult>((resolve) => {
    let settled = false;
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
      headers: { ...input.headers, Host: url.host, "Content-Length": String(bytes) },
    }, (response) => {
      const status = response.statusCode ?? 0;
      // Only the status matters; drop the body unread.
      response.destroy();
      finish({ outcome: classifyWakeWebhookStatus(status), status, error: describeStatus(status) });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`No response within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    timer.unref?.();
    request.on("error", (error) => {
      finish({ outcome: "retry", status: 0, error: error.message.slice(0, 300) || "Network error." });
    });
    request.end(input.body);
  });
}
