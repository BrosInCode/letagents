import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  JOB_QUEUE_ERROR_RETRY_MS,
  JOB_QUEUE_FALLBACK_MS,
  startJobQueueLoop,
  wakeJobQueue,
  type JobQueuePass,
} from "../server/job-queue-wakes.js";

/** Let pending promise callbacks run; setImmediate is not mocked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(results: Array<JobQueuePass | Error> = []) {
  const runs: number[] = [];
  let now = 0;
  const loop = startJobQueueLoop({
    queue: "jev_routing",
    label: "test",
    logError: () => {},
    async run() {
      runs.push(now);
      const next = results.shift() ?? {};
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return {
    runs,
    loop,
    async advance(ms: number) {
      now += ms;
      mock.timers.tick(ms);
      await settle();
    },
  };
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
test.afterEach(() => mock.timers.reset());

test("an idle queue runs once at start and then only at the fallback", async () => {
  const h = harness();
  await h.advance(0);
  assert.deepEqual(h.runs, [0], "one pass at start");
  await h.advance(JOB_QUEUE_FALLBACK_MS - 1);
  assert.deepEqual(h.runs, [0], "no claim between start and the fallback");
  await h.advance(1);
  assert.deepEqual(h.runs, [0, JOB_QUEUE_FALLBACK_MS]);
  await h.loop.stop();
});

test("a wake after commit runs a pass at once", async () => {
  const h = harness();
  await h.advance(0);
  await h.advance(1_000);
  wakeJobQueue("jev_routing");
  wakeJobQueue("desktop_push"); // another queue's wake is not this loop's
  await h.advance(0);
  assert.deepEqual(h.runs, [0, 1_000]);
  await h.loop.stop();
});

test("a retry due later wakes the loop at its due time, not before", async () => {
  const h = harness([{ nextDueInMs: 1_500.2 }]);
  await h.advance(0);
  await h.advance(1_500);
  assert.deepEqual(h.runs, [0]);
  await h.advance(1);
  assert.deepEqual(h.runs, [0, 1_501]);
  await h.loop.stop();
});

test("a due time beyond the fallback is capped by the fallback", async () => {
  const h = harness([{ nextDueInMs: 10 * JOB_QUEUE_FALLBACK_MS }]);
  await h.advance(0);
  await h.advance(JOB_QUEUE_FALLBACK_MS);
  assert.deepEqual(h.runs, [0, JOB_QUEUE_FALLBACK_MS]);
  await h.loop.stop();
});

test("a full batch runs again at once; a wake during a pass runs one more pass after it", async () => {
  let release: (() => void) | undefined;
  const runs: string[] = [];
  let calls = 0;
  const loop = startJobQueueLoop({
    queue: "wake_delivery",
    label: "test",
    async run() {
      calls += 1;
      runs.push(`run${calls}`);
      if (calls === 1) return { again: true };
      if (calls === 2) await new Promise<void>((resolve) => { release = resolve; });
      return {};
    },
  });
  mock.timers.tick(0);
  await settle();
  mock.timers.tick(0);
  await settle();
  assert.deepEqual(runs, ["run1", "run2"], "a full batch claims again with no wait");
  wakeJobQueue("wake_delivery");
  wakeJobQueue("wake_delivery");
  release!();
  await settle();
  mock.timers.tick(0);
  await settle();
  assert.deepEqual(runs, ["run1", "run2", "run3"], "wakes during a pass collapse into one more pass");
  mock.timers.tick(JOB_QUEUE_FALLBACK_MS - 1);
  await settle();
  assert.equal(runs.length, 3);
  await loop.stop();
});

test("a failed pass retries after the error delay; a stopped loop never runs again", async () => {
  const h = harness([new Error("database down")]);
  await h.advance(0);
  await h.advance(JOB_QUEUE_ERROR_RETRY_MS);
  assert.deepEqual(h.runs, [0, JOB_QUEUE_ERROR_RETRY_MS]);
  await h.loop.stop();
  wakeJobQueue("jev_routing");
  await h.advance(10 * JOB_QUEUE_FALLBACK_MS);
  assert.equal(h.runs.length, 2);
});
