import assert from "node:assert/strict";
import test from "node:test";

import { DaemonAuthority } from "../daemon-authority.js";
import { DaemonFenceLostError } from "../singleton.js";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("owns a compatibility manifest generation getter and setter", () => {
  const authority = new DaemonAuthority({
    assertCurrent: async () => undefined,
    isHandoffScheduled: () => false,
    notifyStateChanged: () => undefined,
  }, 4);

  assert.equal(authority.generation, 4);
  authority.generation = 9;
  assert.equal(authority.generation, 9);
});

test("serializes manifest mutations and releases the queue after operation rejection", async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const events: string[] = [];
  let assertions = 0;
  const authority = new DaemonAuthority({
    assertCurrent: async () => { assertions += 1; },
    isHandoffScheduled: () => false,
    notifyStateChanged: () => undefined,
  });

  const first = authority.serializeManifestMutation(async () => {
    events.push("first:entered");
    firstEntered.resolve();
    await releaseFirst.promise;
    events.push("first:rejected");
    throw new Error("first mutation failed");
  });
  await firstEntered.promise;
  const second = authority.serializeManifestMutation(async () => {
    events.push("second:entered");
    return "second result";
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:entered"]);
  releaseFirst.resolve();
  await assert.rejects(first, /first mutation failed/);
  assert.equal(await second, "second result");
  assert.deepEqual(events, ["first:entered", "first:rejected", "second:entered"]);
  assert.equal(assertions, 2);
});

test("releases the mutation queue when authority assertion rejects", async () => {
  let assertion = 0;
  let operations = 0;
  const authority = new DaemonAuthority({
    assertCurrent: async () => {
      assertion += 1;
      if (assertion === 1) throw new Error("singleton lost");
    },
    isHandoffScheduled: () => false,
    notifyStateChanged: () => undefined,
  });

  const rejected = authority.serializeManifestMutation(async () => { operations += 1; });
  const successor = authority.serializeManifestMutation(async () => { operations += 1; return 7; });

  await assert.rejects(rejected, /singleton lost/);
  assert.equal(await successor, 7);
  assert.equal(operations, 1);
});

test("ordinary commit fencing rejects handoff before authority assertion and releases its queue", async () => {
  let handoff = true;
  let assertions = 0;
  let commits = 0;
  let notifications = 0;
  const authority = new DaemonAuthority({
    assertCurrent: async () => { assertions += 1; },
    isHandoffScheduled: () => handoff,
    notifyStateChanged: () => { notifications += 1; },
  });

  const rejected = authority.fenceDaemonCommit(async () => { commits += 1; });
  await assert.rejects(rejected, (error) => error instanceof DaemonFenceLostError
    && error.message === "Supervisor handoff fenced a stale daemon-owned commit.");
  assert.equal(assertions, 0);
  assert.equal(commits, 0);
  assert.equal(notifications, 0);

  handoff = false;
  await authority.fenceDaemonCommit(async () => { commits += 1; });
  assert.equal(assertions, 1);
  assert.equal(commits, 1);
  assert.equal(notifications, 1);
});

test("ordinary commit fencing rechecks handoff after asynchronous authority assertion", async () => {
  const assertionEntered = deferred();
  const releaseAssertion = deferred();
  let handoff = false;
  let committed = false;
  let notified = false;
  const authority = new DaemonAuthority({
    assertCurrent: async () => {
      assertionEntered.resolve();
      await releaseAssertion.promise;
    },
    isHandoffScheduled: () => handoff,
    notifyStateChanged: () => { notified = true; },
  });

  const operation = authority.fenceDaemonCommit(async () => { committed = true; });
  await assertionEntered.promise;
  handoff = true;
  releaseAssertion.resolve();

  await assert.rejects(operation, DaemonFenceLostError);
  assert.equal(committed, false);
  assert.equal(notified, false);
});

test("admitted transition commits during handoff and asserts authority on both sides", async () => {
  const events: string[] = [];
  const authority = new DaemonAuthority({
    assertCurrent: async () => { events.push("assert"); },
    isHandoffScheduled: () => true,
    notifyStateChanged: () => { events.push("notify"); },
  });

  await authority.fenceAdmittedTransitionCommit(async () => { events.push("commit"); });

  assert.deepEqual(events, ["assert", "commit", "assert", "notify"]);
});

test("commit queue releases when an admitted post-commit assertion rejects", async () => {
  let assertion = 0;
  const events: string[] = [];
  const authority = new DaemonAuthority({
    assertCurrent: async () => {
      assertion += 1;
      events.push(`assert:${assertion}`);
      if (assertion === 2) throw new Error("authority changed after commit");
    },
    isHandoffScheduled: () => false,
    notifyStateChanged: () => { events.push("notify"); },
  });

  const admitted = authority.fenceAdmittedTransitionCommit(async () => { events.push("admitted:commit"); });
  const ordinary = authority.fenceDaemonCommit(async () => { events.push("ordinary:commit"); });

  await assert.rejects(admitted, /authority changed after commit/);
  await ordinary;
  assert.deepEqual(events, [
    "assert:1",
    "admitted:commit",
    "assert:2",
    "assert:3",
    "ordinary:commit",
    "notify",
  ]);
});

test("manifest mutation and commit serialization remain independent lanes", async () => {
  const mutationEntered = deferred();
  const releaseMutation = deferred();
  const events: string[] = [];
  const authority = new DaemonAuthority({
    assertCurrent: async () => undefined,
    isHandoffScheduled: () => false,
    notifyStateChanged: () => undefined,
  });

  const mutation = authority.serializeManifestMutation(async () => {
    events.push("mutation:entered");
    mutationEntered.resolve();
    await releaseMutation.promise;
    events.push("mutation:done");
  });
  await mutationEntered.promise;
  await authority.serializeManifestCommit(async () => { events.push("commit"); });

  assert.deepEqual(events, ["mutation:entered", "commit"]);
  releaseMutation.resolve();
  await mutation;
});
