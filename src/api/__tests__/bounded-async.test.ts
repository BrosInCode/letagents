import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedWorkRejectedError,
  BoundedWorkTimeoutError,
  createBoundedExecutor,
} from "../bounded-async.js";

test("bounded executor caps both active and queued dependency work", async () => {
  const gates: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const run = createBoundedExecutor({
    label: "test work",
    maxConcurrent: 2,
    maxQueued: 1,
    timeoutMs: 5_000,
  });
  const work = () => run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => gates.push(resolve));
    active -= 1;
    return true;
  });

  const first = work();
  const second = work();
  const queued = work();
  await assert.rejects(work(), BoundedWorkRejectedError);
  assert.equal(active, 2);
  assert.equal(peak, 2);

  gates.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 2, "queued work starts only after an active slot settles");
  while (gates.length > 0) gates.shift()?.();
  await Promise.all([first, second, queued]);
  assert.equal(peak, 2);
});

test("deadlines cover queue wait while timed-out active work retains its slot", async () => {
  let releaseFirst!: () => void;
  let secondStarted = false;
  let replacementStarted = false;
  const run = createBoundedExecutor({
    label: "slow work",
    maxConcurrent: 1,
    maxQueued: 1,
    timeoutMs: 10,
  });
  const first = run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
  const second = run(async () => { secondStarted = true; });

  // Production timers are unref'ed so they do not keep a drained API process
  // alive. Keep this isolated test process alive long enough to observe it.
  const keepAlive = setTimeout(() => undefined, 100);
  await Promise.all([
    assert.rejects(first, BoundedWorkTimeoutError),
    assert.rejects(second, BoundedWorkTimeoutError),
  ]);
  clearTimeout(keepAlive);
  assert.equal(secondStarted, false);
  const replacement = run(async () => { replacementStarted = true; });
  assert.equal(replacementStarted, false, "the timed-out dependency still owns the active slot");
  releaseFirst();
  await replacement;
  assert.equal(replacementStarted, true);
});

test("a synchronous producer failure releases its executor slot", async () => {
  const run = createBoundedExecutor({
    label: "throwing work",
    maxConcurrent: 1,
    maxQueued: 0,
    timeoutMs: 1_000,
  });
  await assert.rejects(
    run(() => { throw new Error("synchronous failure"); }),
    /synchronous failure/,
  );
  assert.equal(await run(async () => 42), 42);
});
