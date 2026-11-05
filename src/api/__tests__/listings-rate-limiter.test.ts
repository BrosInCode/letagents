import assert from "node:assert/strict";
import test from "node:test";

import { buildInMemoryListingsRateLimiter } from "../routes/rental/renter/rate-limiter.js";

// The in-memory limiter behind renter listings, OAuth registration and
// confirm_wake_email: one bucket per key, and a bounded map.

test("a key gets `capacity` calls per window, then starts over; other keys have their own budget", () => {
  let clock = 1_000;
  const allow = buildInMemoryListingsRateLimiter({ capacity: 2, windowMs: 100, now: () => clock });
  assert.equal(allow.size, 0);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false, "the third call in the window is refused");
  assert.equal(allow("b"), true, "another key is not held back");
  assert.equal(allow.size, 2);
  clock += 99;
  assert.equal(allow("a"), false, "still inside the window");
  clock += 1;
  assert.equal(allow("a"), true, "a passed window starts over");
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
});

test("a new key arriving at the entry cap sweeps the buckets whose window has passed; live buckets keep their counts", () => {
  let clock = 0;
  const allow = buildInMemoryListingsRateLimiter({ capacity: 2, windowMs: 100, maxEntries: 3, now: () => clock });
  for (const key of ["a", "b", "c"]) assert.equal(allow(key), true);
  assert.equal(allow("c"), true, "c is at its cap");
  assert.equal(allow.size, 3);

  // Nothing has expired yet: the fourth key is kept, and the map holds the live keys.
  assert.equal(allow("d"), true);
  assert.equal(allow.size, 4);
  clock = 50;
  assert.equal(allow("c"), false, "a live bucket is never touched by the cap");

  // Every bucket started at 0 and is now past its window. A seen key resets in place.
  clock = 100;
  assert.equal(allow("c"), true);
  assert.equal(allow.size, 4, "a reset is not a sweep");

  // A key never seen, at the cap: the three buckets from 0 go; c (window from 100) stays with its count.
  clock = 120;
  assert.equal(allow("e"), true);
  assert.equal(allow.size, 2, "c and e");
  assert.equal(allow("c"), true, "c had one call in its live window and gets its second");
  assert.equal(allow("c"), false, "the kept bucket's count was not lost");

  // A swept key answers exactly as an expired bucket would have: fresh.
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
  assert.equal(allow.size, 3);
});

test("by default the sweep starts at 10,000 buckets, so one-off keys do not grow a long-lived process without bound", () => {
  let clock = 0;
  const allow = buildInMemoryListingsRateLimiter({ now: () => clock });
  for (let i = 0; i < 10_000; i += 1) allow(`token:${i}`);
  assert.equal(allow.size, 10_000);
  clock = 60_000;
  assert.equal(allow("token:new"), true);
  assert.equal(allow.size, 1, "the expired ten thousand are gone; the new key is held");
});
