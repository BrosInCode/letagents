import assert from "node:assert/strict";
import test from "node:test";

import {
  DeliveryCutoverCoordinator,
  DeliveryCutoverObservationDetached,
  type DeliveryCutoverRetryTimer,
} from "../delivery-cutover-coordinator.js";

test("start coalesces one in-flight request per entry and admits a successor after settlement", async () => {
  const firstGate = deferred<void>();
  let drives = 0;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async () => {
      drives += 1;
      if (drives === 1) await firstGate.promise;
    },
  });

  const first = coordinator.start("agent");
  const duplicate = coordinator.start("agent");
  assert.equal(duplicate, first);
  assert.equal(drives, 1);

  firstGate.resolve();
  await first;
  await coordinator.start("agent");
  assert.equal(drives, 2);
});

test("different entries have independent requests and a rejection does not strand a slot", async () => {
  const calls = new Map<string, number>();
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async (entryId) => {
      const call = (calls.get(entryId) ?? 0) + 1;
      calls.set(entryId, call);
      if (entryId === "left" && call === 1) throw new Error("drive failed");
    },
  });

  await Promise.all([
    assert.rejects(coordinator.start("left"), /drive failed/),
    coordinator.start("right"),
  ]);
  await coordinator.start("left");
  assert.deepEqual([...calls], [["left", 2], ["right", 1]]);
});

test("fenceAndDrain aborts observations and absorbs admitted request failures", async () => {
  let coordinator!: DeliveryCutoverCoordinator;
  const signals: AbortSignal[] = [];
  coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async (_entryId, signal) => {
      signals.push(signal);
      await coordinator.observe(signal, new Promise<void>(() => undefined));
    },
  });

  const left = coordinator.start("left");
  const right = coordinator.start("right");
  await coordinator.fenceAndDrain();

  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => signal.aborted), true);
  await assert.rejects(left, DeliveryCutoverObservationDetached);
  await assert.rejects(right, DeliveryCutoverObservationDetached);
});

test("fenceAndDrain waits for a driver that is still settling after abort", async () => {
  const gate = deferred<void>();
  let signal: AbortSignal | null = null;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async (_entryId, detachSignal) => {
      signal = detachSignal;
      await gate.promise;
    },
  });
  const operation = coordinator.start("agent");
  let drained = false;
  const drain = coordinator.fenceAndDrain().then(() => { drained = true; });

  await Promise.resolve();
  assert.equal(signal?.aborted, true);
  assert.equal(drained, false);
  gate.resolve();
  await operation;
  await drain;
  assert.equal(drained, true);
});

test("assertObservation detaches on either abort or daemon handoff", () => {
  let handoff = false;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => handoff,
    drive: async () => undefined,
  });
  const controller = new AbortController();

  assert.doesNotThrow(() => coordinator.assertObservation(controller.signal));
  handoff = true;
  assert.throws(() => coordinator.assertObservation(controller.signal), DeliveryCutoverObservationDetached);
  handoff = false;
  controller.abort();
  assert.throws(() => coordinator.assertObservation(controller.signal), DeliveryCutoverObservationDetached);
});

test("observe rejects a detached fulfillment but preserves an underlying rejection", async () => {
  let handoff = false;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => handoff,
    drive: async () => undefined,
  });
  const controller = new AbortController();
  const fulfilledGate = deferred<string>();
  const fulfillment = coordinator.observe(controller.signal, fulfilledGate.promise);
  handoff = true;
  fulfilledGate.resolve("terminal");
  await assert.rejects(fulfillment, DeliveryCutoverObservationDetached);

  handoff = false;
  const rejectedGate = deferred<string>();
  const rejection = coordinator.observe(controller.signal, rejectedGate.promise);
  handoff = true;
  rejectedGate.reject(new Error("provider inspection failed"));
  await assert.rejects(rejection, /provider inspection failed/);
});

test("observe detaches immediately on abort without waiting for the provider operation", async () => {
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async () => undefined,
  });
  const controller = new AbortController();
  const never = new Promise<void>(() => undefined);
  const observation = coordinator.observe(controller.signal, never);

  controller.abort();
  await assert.rejects(observation, DeliveryCutoverObservationDetached);
});

test("scheduleRetry preserves delay, unreferences its timer, and swallows drive rejection", async () => {
  let scheduled: { callback: () => void; delayMs: number; unrefCalls: number } | null = null;
  let driveCalls = 0;
  const coordinator = new DeliveryCutoverCoordinator({
    isHandoffScheduled: () => false,
    drive: async () => {
      driveCalls += 1;
      throw new Error("retry failed");
    },
    setRetryTimeout: (callback, delayMs): DeliveryCutoverRetryTimer => {
      const record = { callback, delayMs, unrefCalls: 0 };
      scheduled = record;
      return { unref: () => { record.unrefCalls += 1; } };
    },
  });

  coordinator.scheduleRetry("agent", 1_000);
  assert.ok(scheduled);
  assert.equal(scheduled.delayMs, 1_000);
  assert.equal(scheduled.unrefCalls, 1);
  scheduled.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(driveCalls, 1);
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
