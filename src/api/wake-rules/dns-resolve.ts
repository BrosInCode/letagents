/**
 * Host name resolution for wake deliveries. `dns.lookup` runs getaddrinfo on
 * the libuv thread pool with no deadline, so a slow resolver could block file
 * and crypto work for the whole process. This uses c-ares (`resolve4` and
 * `resolve6`), which needs no thread pool, with a timeout per query, a
 * deadline per lookup, and a bound on lookups in flight.
 */
import { Resolver } from "node:dns/promises";

export type HostResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const DNS_QUERY_TIMEOUT_MS = 2_000;
export const DNS_DEADLINE_MS = 3_000;
export const MAX_CONCURRENT_LOOKUPS = 16;

export type HostResolveFailure = "timeout" | "not_found" | "failed";

export class HostResolveError extends Error {
  constructor(readonly reason: HostResolveFailure) {
    super(`DNS ${reason}`);
    this.name = "HostResolveError";
  }
}

const MISSING = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN"]);

/** A records and AAAA records, each family on its own; one family may be missing. */
export const resolveHostAddresses: HostResolver = async (hostname) => {
  const resolver = new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 1 });
  try {
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const found = answers.flatMap((answer, index) =>
      answer.status === "fulfilled" ? answer.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })) : []);
    if (found.length > 0) return found;
    const codes = answers.map((answer) => answer.status === "rejected" ? String((answer.reason as { code?: unknown })?.code ?? "") : "");
    if (codes.some((code) => code === "ETIMEOUT")) throw new HostResolveError("timeout");
    if (codes.every((code) => !code || MISSING.has(code))) throw new HostResolveError("not_found");
    throw new HostResolveError("failed");
  } finally {
    resolver.cancel();
  }
};

let active = 0;
const waiting: Array<{ granted: boolean; grant(): void }> = [];

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next.granted = true;
    next.grant();
  }
}

/**
 * Resolve `hostname` within the deadline, waiting for a free slot when
 * `MAX_CONCURRENT_LOOKUPS` are already in flight. The wait counts toward the
 * deadline. Rejects with `HostResolveError`.
 */
export async function resolveWithinDeadline(
  hostname: string,
  resolver: HostResolver = resolveHostAddresses,
  deadlineMs = DNS_DEADLINE_MS,
): Promise<ReadonlyArray<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    // Not unref'd: a lookup in progress is work, and the timer lasts seconds at most.
    timer = setTimeout(() => reject(new HostResolveError("timeout")), deadlineMs);
  });
  const slot = { granted: false, grant: () => undefined as void };
  const ready = new Promise<void>((resolve) => {
    if (active < MAX_CONCURRENT_LOOKUPS) {
      active += 1;
      slot.granted = true;
      resolve();
    } else {
      slot.grant = resolve;
      waiting.push(slot);
    }
  });
  try {
    await Promise.race([ready, expired]);
    return await Promise.race([resolver(hostname), expired]);
  } catch (error) {
    throw error instanceof HostResolveError ? error : new HostResolveError("failed");
  } finally {
    clearTimeout(timer);
    if (slot.granted) release();
    else {
      const index = waiting.indexOf(slot);
      if (index >= 0) waiting.splice(index, 1);
    }
  }
}

/** Lookups in flight and waiting, for tests. */
export function dnsLookupLoadForTests(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}
