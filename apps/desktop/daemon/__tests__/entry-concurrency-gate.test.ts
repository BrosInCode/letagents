import assert from "node:assert/strict";
import test from "node:test";

import { EntryConcurrencyGate } from "../entry-concurrency-gate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("serializes one entry, permits sibling entries, and releases the lane after failure", async () => {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const order: string[] = [];

  const first = gate.run("agent-a", async () => {
    order.push("a:first:entered");
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push("a:first:released");
    throw new Error("expected failure");
  });
  await firstEntered.promise;

  const second = gate.run("agent-a", async () => {
    order.push("a:second");
    return "second";
  });
  const sibling = gate.run("agent-b", async () => {
    order.push("b:first");
    return "sibling";
  });

  assert.equal(await sibling, "sibling");
  assert.deepEqual(order, ["a:first:entered", "b:first"]);
  releaseFirst.resolve();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "second");
  assert.deepEqual(order, ["a:first:entered", "b:first", "a:first:released", "a:second"]);

  assert.equal(await gate.run("agent-a", async () => "after"), "after");
});

test("control epochs bump synchronously before delayed entry work can resume", async () => {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
  const delayed = deferred();
  const observed: number[] = [];

  const operation = (async () => {
    const captured = gate.currentControlEpoch("agent-a");
    await delayed.promise;
    observed.push(captured, gate.currentControlEpoch("agent-a"));
  })();

  assert.equal(gate.currentControlEpoch("agent-a"), 0);
  assert.equal(gate.bumpControlEpoch("agent-a"), 1);
  assert.equal(gate.currentControlEpoch("agent-a"), 1);
  delayed.resolve();
  await operation;
  assert.deepEqual(observed, [0, 1]);
});

test("lifecycle and turn control exclude each other with stable errors", () => {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });

  const releaseLifecycle = gate.beginLifecycle("agent-a");
  assert.equal(gate.isLifecycleActive("agent-a"), true);
  assert.throws(
    () => gate.beginLifecycle("agent-a"),
    /This supervised entry already has an in-flight lifecycle or turn-control action\./,
  );
  assert.throws(
    () => gate.beginTurnControl("agent-a"),
    /Turn control is unavailable while a lifecycle action is in flight for this supervised entry\./,
  );
  releaseLifecycle();
  assert.equal(gate.isLifecycleActive("agent-a"), false);

  const releaseTurn = gate.beginTurnControl("agent-a");
  assert.throws(
    () => gate.beginTurnControl("agent-a"),
    /A turn-control action is already in flight for this exact supervised entry\./,
  );
  assert.throws(
    () => gate.beginLifecycle("agent-a"),
    /This supervised entry already has an in-flight lifecycle or turn-control action\./,
  );
  releaseTurn();

  const nextLifecycle = gate.beginLifecycle("agent-a");
  nextLifecycle();
});

test("lifecycle wakes a queued room move without treating it as active work", async () => {
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => false });
  const blockerEntered = deferred();
  const releaseBlocker = deferred();
  let roomMoveRuns = 0;

  const blocker = gate.run("agent-a", async () => {
    blockerEntered.resolve();
    await releaseBlocker.promise;
  });
  await blockerEntered.promise;

  const roomMove = gate.runRoomMove("agent-a", "excluded", async () => {
    roomMoveRuns += 1;
    return "completed";
  });
  await flushMicrotasks();

  const releaseLifecycle = gate.beginLifecycle("agent-a");
  assert.equal(await roomMove, "excluded");
  await gate.waitForActiveRoomMove("agent-a");
  assert.equal(roomMoveRuns, 0);

  releaseBlocker.resolve();
  await blocker;
  await flushMicrotasks();
  assert.equal(roomMoveRuns, 0);
  releaseLifecycle();
});

test("handoff wake releases an active room-move caller but drain waits for its critical section", async () => {
  let handoffScheduled = false;
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => handoffScheduled });
  const roomMoveEntered = deferred();
  const releaseRoomMove = deferred();
  let operationCompleted = false;

  const roomMove = gate.runRoomMove("agent-a", "excluded", async () => {
    roomMoveEntered.resolve();
    await releaseRoomMove.promise;
    operationCompleted = true;
    return "completed";
  });
  await roomMoveEntered.promise;

  handoffScheduled = true;
  let drained = false;
  const drain = gate.fenceAndDrainRoomMoves().then(() => { drained = true; });
  assert.equal(await roomMove, "excluded");
  await flushMicrotasks();
  assert.equal(drained, false);
  assert.equal(operationCompleted, false);

  releaseRoomMove.resolve();
  await drain;
  assert.equal(operationCompleted, true);
  assert.equal(drained, true);
});

test("handoff drain ignores room moves queued behind unrelated entry work", async () => {
  let handoffScheduled = false;
  const gate = new EntryConcurrencyGate({ isHandoffScheduled: () => handoffScheduled });
  const blockerEntered = deferred();
  const releaseBlocker = deferred();
  let roomMoveRuns = 0;

  const blocker = gate.run("agent-a", async () => {
    blockerEntered.resolve();
    await releaseBlocker.promise;
  });
  await blockerEntered.promise;
  const roomMove = gate.runRoomMove("agent-a", "excluded", async () => {
    roomMoveRuns += 1;
    return "completed";
  });

  handoffScheduled = true;
  await gate.fenceAndDrainRoomMoves();
  assert.equal(await roomMove, "excluded");
  assert.equal(roomMoveRuns, 0);

  releaseBlocker.resolve();
  await blocker;
  await flushMicrotasks();
  assert.equal(roomMoveRuns, 0);
});
