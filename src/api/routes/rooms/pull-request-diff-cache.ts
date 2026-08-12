// Small TTL + byte-budgeted cache for authorized PR diffs. Extracted so eviction
// and byte accounting are unit-testable with an injectable clock and limits.

export interface PullRequestDiffCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
}

interface Entry {
  diff: string;
  bytes: number;
  expiresAt: number;
}

const DEFAULTS = {
  ttlMs: 5 * 60 * 1000,
  maxEntries: 200,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 5 * 1024 * 1024,
};

export class PullRequestDiffCache {
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntryBytes: number;

  constructor(options: PullRequestDiffCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULTS.maxTotalBytes;
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULTS.maxEntryBytes;
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() > entry.expiresAt) {
      this.remove(key, entry);
      return null;
    }
    return entry.diff;
  }

  set(key: string, diff: string): void {
    const bytes = Buffer.byteLength(diff, "utf8");
    if (bytes > this.maxEntryBytes) return; // too large to retain; caller still serves it
    // Overwrite-safe: drop any existing entry's bytes first.
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    // Evict expired, then oldest, until within entry and byte budgets.
    const now = this.now();
    for (const [k, entry] of this.entries) {
      if (now > entry.expiresAt) this.remove(k, entry);
    }
    while (this.entries.size >= this.maxEntries || this.total + bytes > this.maxTotalBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = this.entries.get(oldest);
      if (evicted) this.remove(oldest, evicted);
    }
    this.entries.set(key, { diff, bytes, expiresAt: now + this.ttlMs });
    this.total += bytes;
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.total -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.total;
  }
}
