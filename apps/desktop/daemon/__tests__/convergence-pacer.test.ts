import assert from "node:assert/strict";
import test from "node:test";

import {
  ConvergencePacer,
  ConvergencePacerClosedError,
  INTERACTIVE_PRIORITY_WINDOW_MS,
  INTERACTIVE_RESERVED_AUTHORITY_SLOTS,
  PACED_SLOT_LEASE_MS,
  PACED_START_JITTER_MS,
  PROVIDER_LAUNCH_CONCURRENCY,
  SERVER_AUTHORITY_CONCURRENCY,
  type PacedLane,
} from "../convergence-pacer.js";

type FakeTimer = { callback: () => void; delay: number; cleared: boolean };

/** Authority slots background convergence may use; the rest wait for a user. */
const BACKGROUND_AUTHORITY = SERVER_AUTHORITY_CONCURRENCY - INTERACTIVE_RESERVED_AUTHORITY_SLOTS;

function fakeClock() {
  let now = 1_000_000;
  const timers: FakeTimer[] = [];
  return {
    timers,
    nowMs: () => now,
    advance: (ms: number) => { now += ms; },
    setTimeout: ((callback: () => void, delay: number) => {
      const timer: FakeTimer = { callback, delay, cleared: false };
      timers.push(timer);
      return { unref() {}, timer };
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: { timer?: FakeTimer } | undefined) => {
      if (handle?.timer) handle.timer.cleared = true;
    }) as unknown as typeof clearTimeout,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(pendingWork: ReadonlySet<string> = new Set(), random = () => 0) {
  const clock = fakeClock();
  const pacer = new ConvergencePacer({
    hasPendingWork: async (entryId) => pendingWork.has(entryId),
    nowMs: clock.nowMs,
    random,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  let active = 0;
  let maxActive = 0;
  const run = (lane: PacedLane, entryId: string) => pacer.run(lane, entryId, async () => {
    started.push(entryId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const gate = deferred();
    gates.set(entryId, gate);
    try {
      await gate.promise;
    } finally {
      active -= 1;
    }
    return entryId;
  });
  return {
    pacer, clock, started, run,
    finish: async (entryId: string) => { gates.get(entryId)!.resolve(); await settle(); },
    get active() { return active; },
    get maxActive() { return maxActive; },
  };
}

test("a handoff of 33 agents runs at most the named number of authority requests and launches at once", async () => {
  for (const [lane, limit] of [["authority", BACKGROUND_AUTHORITY], ["launch", PROVIDER_LAUNCH_CONCURRENCY]] as const) {
    const runtime = harness();
    const agents = Array.from({ length: 33 }, (_, index) => `agent-${index + 1}`);
    const results = agents.map((agent) => runtime.run(lane, agent));
    await settle();
    assert.equal(runtime.active, limit, lane);
    assert.deepEqual(runtime.pacer.snapshot(lane), { active: limit, queued: agents.slice(limit) }, lane);
    for (const agent of agents) {
      if (runtime.started.includes(agent)) await runtime.finish(agent);
      else {
        await settle();
        await runtime.finish(agent);
      }
      assert.ok(runtime.active <= limit, `${lane}: ${runtime.active} active`);
    }
    assert.deepEqual(await Promise.all(results), agents, lane);
    assert.equal(runtime.maxActive, limit, lane);
    assert.deepEqual(runtime.started, agents, `${lane}: equal-priority work keeps arrival order`);
    assert.deepEqual(runtime.pacer.snapshot(lane), { active: 0, queued: [] }, lane);
  }
  assert.equal(SERVER_AUTHORITY_CONCURRENCY, 4);
  assert.equal(INTERACTIVE_RESERVED_AUTHORITY_SLOTS, 1);
  assert.equal(PROVIDER_LAUNCH_CONCURRENCY, 3);
});

test("a user action takes the reserved authority slot while background convergence fills the rest", async () => {
  const runtime = harness();
  const background = Array.from({ length: 33 }, (_, index) => `agent-${index + 1}`);
  for (const agent of background) void runtime.run("authority", agent);
  await settle();
  assert.equal(runtime.active, BACKGROUND_AUTHORITY, "background work never takes the reserved slot");
  runtime.pacer.markInteractive("reconnect-1");
  void runtime.run("authority", "reconnect-1");
  await settle();
  assert.equal(runtime.started.at(-1), "reconnect-1", "the user starts at once, without waiting for a slot to free");
  assert.equal(runtime.active, SERVER_AUTHORITY_CONCURRENCY);
  runtime.pacer.markInteractive("restart-1");
  void runtime.run("authority", "restart-1");
  await settle();
  assert.equal(runtime.started.includes("restart-1"), false, "the cap still holds for everyone");
  await runtime.finish("agent-1");
  assert.equal(runtime.started.at(-1), "restart-1", "a freed slot goes to the waiting user first");
  await runtime.finish("reconnect-1");
  assert.equal(runtime.active, BACKGROUND_AUTHORITY, "a background agent takes only a background slot");
});

test("user actions go first, then agents with queued room work, then background convergence", async () => {
  const runtime = harness(new Set(["pending-1"]));
  const holders = [...Array.from({ length: BACKGROUND_AUTHORITY }, (_, index) => `holder-${index}`), "holder-user"];
  runtime.pacer.markInteractive("holder-user");
  for (const holder of holders) {
    void runtime.run("authority", holder);
    await settle();
  }
  assert.equal(runtime.active, SERVER_AUTHORITY_CONCURRENCY);
  for (const agent of ["background-1", "background-2", "pending-1", "background-3"]) {
    void runtime.run("authority", agent);
    await settle();
  }
  runtime.pacer.markInteractive("restart-1");
  void runtime.run("authority", "restart-1");
  await settle();
  // Reconnect pressed on an agent whose background rebind is already queued.
  runtime.pacer.markInteractive("background-3");
  assert.deepEqual(runtime.pacer.snapshot("authority").queued,
    ["background-3", "restart-1", "pending-1", "background-1", "background-2"]);

  for (const holder of holders) await runtime.finish(holder);
  assert.deepEqual(runtime.started.slice(holders.length), ["background-3", "restart-1", "pending-1"],
    "users first, then pending work; background-1 waits because only the reserved slot is free");

  runtime.clock.advance(INTERACTIVE_PRIORITY_WINDOW_MS + 1);
  void runtime.run("authority", "restart-1");
  await settle();
  void runtime.run("authority", "pending-1");
  await settle();
  assert.deepEqual(runtime.pacer.snapshot("authority").queued, ["pending-1", "background-1", "background-2", "restart-1"],
    "user priority lapses after its window; pending work still outranks background");
});

test("only work that had to queue pauses briefly before starting, and user actions never do", async () => {
  const runtime = harness(new Set(), () => 0.5);
  void runtime.run("launch", "fast-1");
  await settle();
  assert.equal(runtime.clock.timers.filter((timer) => timer.delay < PACED_START_JITTER_MS).length, 0,
    "an uncontended launch starts at once");
  for (let index = 2; index <= PROVIDER_LAUNCH_CONCURRENCY; index += 1) void runtime.run("launch", `fast-${index}`);
  await settle();
  void runtime.run("launch", "queued");
  runtime.pacer.markInteractive("user");
  void runtime.run("launch", "user");
  await settle();

  await runtime.finish("fast-1");
  assert.equal(runtime.started.at(-1), "user", "the user's launch starts without a pause");
  await runtime.finish("fast-2");
  assert.equal(runtime.started.includes("queued"), false, "queued background work waits out its pause");
  const pause = runtime.clock.timers.find((timer) => timer.delay === Math.floor(0.5 * PACED_START_JITTER_MS));
  assert.ok(pause, "the pause is drawn from the jitter window");
  pause.callback();
  await settle();
  assert.equal(runtime.started.at(-1), "queued");
});

test("a request that never settles hands its slot on after the lease", async () => {
  const runtime = harness();
  const wedged = Array.from({ length: BACKGROUND_AUTHORITY }, (_, index) => `wedged-${index}`);
  for (const agent of wedged) void runtime.run("authority", agent);
  await settle();
  void runtime.run("authority", "next");
  await settle();
  assert.equal(runtime.started.includes("next"), false);
  const lease = runtime.clock.timers.find((timer) => timer.delay === PACED_SLOT_LEASE_MS.authority && !timer.cleared)!;
  lease.callback();
  await settle();
  assert.equal(runtime.started.at(-1), "next");
  await runtime.finish("wedged-0");
  assert.equal(runtime.pacer.snapshot("authority").active, BACKGROUND_AUTHORITY,
    "a late settle after the lease does not release a second slot");
});

test("closing the pacer cancels queued work and refuses new work", async () => {
  const runtime = harness();
  const results = Array.from({ length: BACKGROUND_AUTHORITY + 2 },
    (_, index) => runtime.run("authority", `agent-${index}`).then(() => "done", (error: unknown) => error));
  await settle();
  assert.equal(runtime.started.length, BACKGROUND_AUTHORITY);
  runtime.pacer.close();
  await settle();
  assert.equal(runtime.started.length, BACKGROUND_AUTHORITY, "a retiring daemon never sends its queue");
  await assert.rejects(runtime.run("authority", "after-close"), ConvergencePacerClosedError);
  for (let index = 0; index < BACKGROUND_AUTHORITY; index += 1) await runtime.finish(`agent-${index}`);
  const settled = await Promise.all(results);
  assert.deepEqual(settled.slice(0, BACKGROUND_AUTHORITY), Array(BACKGROUND_AUTHORITY).fill("done"));
  for (const cancelled of settled.slice(BACKGROUND_AUTHORITY)) assert.ok(cancelled instanceof ConvergencePacerClosedError);
});

test("work that gives up while queued leaves the queue without taking a slot", async () => {
  const runtime = harness();
  for (let index = 0; index < BACKGROUND_AUTHORITY; index += 1) void runtime.run("authority", `holder-${index}`);
  await settle();
  const controller = new AbortController();
  const abandoned = runtime.pacer.acquire("authority", "abandoned", controller.signal);
  void runtime.run("authority", "next");
  await settle();
  assert.deepEqual(runtime.pacer.snapshot("authority").queued, ["abandoned", "next"]);
  controller.abort(new Error("bootstrap cancelled"));
  await assert.rejects(abandoned, /bootstrap cancelled/);
  assert.deepEqual(runtime.pacer.snapshot("authority").queued, ["next"]);
  await runtime.finish("holder-0");
  assert.equal(runtime.started.at(-1), "next", "the freed slot goes to the next waiter, not the abandoned one");
  await assert.rejects(runtime.pacer.acquire("authority", "late", controller.signal), /bootstrap cancelled/,
    "an already-aborted request never queues");
});
