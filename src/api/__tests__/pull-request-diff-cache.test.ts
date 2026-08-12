import assert from "node:assert/strict";
import test from "node:test";

import { PullRequestDiffCache } from "../routes/rooms/pull-request-diff-cache.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("evicts entries after the TTL", () => {
  const c = clock();
  const cache = new PullRequestDiffCache({ now: c.now, ttlMs: 1000 });
  cache.set("k", "diff");
  assert.equal(cache.get("k"), "diff");
  c.advance(1001);
  assert.equal(cache.get("k"), null, "expired entry evicted on read");
  assert.equal(cache.size, 0);
  assert.equal(cache.byteSize, 0);
});

test("evicts oldest entries to stay within the total byte budget", () => {
  const cache = new PullRequestDiffCache({ maxTotalBytes: 10, maxEntryBytes: 10, ttlMs: 60_000 });
  cache.set("a", "12345"); // 5 bytes
  cache.set("b", "12345"); // 5 bytes -> total 10
  assert.equal(cache.size, 2);
  cache.set("c", "123"); // 3 bytes -> would exceed 10, evict oldest ("a")
  assert.equal(cache.get("a"), null, "oldest evicted");
  assert.ok(cache.byteSize <= 10, "within byte budget");
});

test("overwriting a key does not double-count bytes", () => {
  const cache = new PullRequestDiffCache({ ttlMs: 60_000 });
  cache.set("k", "xxxxxx"); // 6 bytes
  cache.set("k", "yy"); // 2 bytes
  assert.equal(cache.size, 1, "still one entry");
  assert.equal(cache.byteSize, 2, "byte count reflects only the current value");
  assert.equal(cache.get("k"), "yy");
});

test("skips entries larger than the per-entry cap (still returns null, not cached)", () => {
  const cache = new PullRequestDiffCache({ maxEntryBytes: 4, ttlMs: 60_000 });
  cache.set("k", "toolong");
  assert.equal(cache.size, 0);
  assert.equal(cache.get("k"), null);
});

test("evicts oldest when exceeding the max entry count", () => {
  const cache = new PullRequestDiffCache({ maxEntries: 2, maxTotalBytes: 1_000_000, ttlMs: 60_000 });
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3"); // exceeds 2 entries -> evict "a"
  assert.equal(cache.get("a"), null);
  assert.equal(cache.size, 2);
});
