// A model of a slow, busy CI runner, for the daemon under the edge tests.
// Node loads it before the daemon (`node --import stall.mjs dist-daemon/main.js`).
//
// The edge tests pass on a developer machine and then fail on a CI runner on
// timing: a state that the test reads a moment before the daemon reaches it.
// This file makes the daemon slow in the two ways a busy runner does:
//
//   - The event loop stops for STALL_MS, again and again, after a random wait
//     of STALL_EVERY_MS to STALL_EVERY_MS + STALL_JITTER_MS.
//   - Each SQLite write first waits SLOW_SQLITE_MS, as a commit does on a
//     disk whose fsync is slow. The daemon's SQLite is synchronous, so a slow
//     commit stops the whole process.
//   - SLOW_AFTER_MS and SLOW_FOR_MS limit the slow disk to a period: it starts
//     that long after the process starts and lasts that long. The default is
//     from the start, for ever.
//
// It is a test tool. Nothing in the product loads it.

import { DatabaseSync, StatementSync } from "node:sqlite";

const setting = (name, fallback) => {
  if (process.env[name] === undefined || process.env[name] === "") return fallback;
  const value = Number(process.env[name]);
  return value >= 0 ? value : fallback;
};
const STALL_MS = setting("STALL_MS", 400);
const STALL_EVERY_MS = setting("STALL_EVERY_MS", 500);
const STALL_JITTER_MS = setting("STALL_JITTER_MS", 1000);
const SLOW_SQLITE_MS = setting("SLOW_SQLITE_MS", 3);
const SLOW_AFTER_MS = setting("SLOW_AFTER_MS", 0);
const SLOW_FOR_MS = setting("SLOW_FOR_MS", Infinity);

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
  const startedAt = Date.now();
  const slowNow = () => {
    const sinceStart = Date.now() - startedAt;
    return sinceStart >= SLOW_AFTER_MS && sinceStart < SLOW_AFTER_MS + SLOW_FOR_MS;
  };
  const slow = (prototype, method) => {
    const original = prototype[method];
    prototype[method] = function slowed(...args) {
      if (slowNow()) block(SLOW_SQLITE_MS);
      return original.apply(this, args);
    };
  };
  // `exec` runs statements with no result, `run` runs a prepared write.
  slow(DatabaseSync.prototype, "exec");
  slow(StatementSync.prototype, "run");
}
