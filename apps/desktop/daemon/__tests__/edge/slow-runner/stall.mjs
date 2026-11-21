// A model of a slow, busy CI runner, for the daemon under the edge tests.
// Node loads it before the daemon (`node --import stall.mjs dist-daemon/main.js`).
//
// The edge tests pass on a developer machine and then fail on a CI runner on
// timing: a state that the test reads a moment before the daemon reaches it.
// This file makes the daemon slow in the two ways a busy runner does:
//
//   - The event loop stops for STALL_MS, again and again, after a random wait
//     of STALL_EVERY_MS to STALL_EVERY_MS + STALL_JITTER_MS.
//   - Each SQLite write takes SLOW_SQLITE_MS longer.
//
// It is a test tool. Nothing in the product loads it.

import { DatabaseSync, StatementSync } from "node:sqlite";

const setting = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const STALL_MS = setting("STALL_MS", 400);
const STALL_EVERY_MS = setting("STALL_EVERY_MS", 500);
const STALL_JITTER_MS = setting("STALL_JITTER_MS", 1000);
const SLOW_SQLITE_MS = setting("SLOW_SQLITE_MS", 3);

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Stop this thread, and with it the event loop, for `ms`. */
const block = (ms) => { if (ms > 0) Atomics.wait(sleeper, 0, 0, ms); };

function stallAgain() {
  const timer = setTimeout(() => {
    block(STALL_MS);
    stallAgain();
  }, STALL_EVERY_MS + Math.random() * STALL_JITTER_MS);
  // The stalls must not keep a daemon alive that has nothing else to do.
  timer.unref();
}
if (STALL_MS > 0) stallAgain();

if (SLOW_SQLITE_MS > 0) {
  const slow = (prototype, method) => {
    const original = prototype[method];
    prototype[method] = function slowed(...args) {
      const result = original.apply(this, args);
      block(SLOW_SQLITE_MS);
      return result;
    };
  };
  // `exec` runs statements with no result, `run` runs a prepared write.
  slow(DatabaseSync.prototype, "exec");
  slow(StatementSync.prototype, "run");
}
