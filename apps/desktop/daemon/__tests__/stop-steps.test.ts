import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SupervisorDaemon } from "../main.js";
import type { ProviderActionPort } from "../provider-action-port.js";
import { runEveryStopStep } from "../stop-steps.js";

test("every step of a stop runs, in order, whatever an earlier one reports, and the first failure is reported at the end", async () => {
  const first = new Error("first"), later = new Error("later");
  const cases: Array<{ second: () => unknown; fourth: () => unknown; reported: unknown }> = [
    { second: () => { throw first; }, fourth: async () => { throw later; }, reported: first },
    { second: async () => { throw first; }, fourth: () => { throw later; }, reported: first },
    // A step may fail with nothing at all; it is still a failure, and still the first.
    { second: () => { throw undefined; }, fourth: async () => { throw later; }, reported: undefined },
  ];
  for (const { second, fourth, reported } of cases) {
    const ran: number[] = [];
    const numbered = (steps: Array<() => unknown>) => steps.map((step, index) => () => { ran.push(index + 1); return step(); });
    await assert.rejects(runEveryStopStep(numbered([() => undefined, second, async () => undefined, fourth, () => undefined])),
      (error) => error === reported);
    assert.deepEqual(ran, [1, 2, 3, 4, 5]);
  }
  await runEveryStopStep([() => undefined, async () => undefined, () => null, () => "done"]);
  await runEveryStopStep([]);
});

test("the steps of a stop that fence together do so before the first wait, and a step that returns a promise is waited for", async () => {
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const stopping = runEveryStopStep([
    () => { order.push("fence 1"); },
    () => { order.push("fence 2"); },
    () => held.then(() => { order.push("drain"); }),
    () => { order.push("close"); },
  ]);
  // Both fences are up before the caller has the stop's promise: nothing could run between them.
  assert.deepEqual(order, ["fence 1", "fence 2"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["fence 1", "fence 2"], "the close waits for the drain");
  release();
  await stopping;
  assert.deepEqual(order, ["fence 1", "fence 2", "drain", "close"]);
});

type Step = "typedLifecycleEffects.close" | "boundedEffects.drainJournalReservations" | "providerReconciliation.disposeAll"
  | "providerExecution.drainConvergence" | "providerStreams.disposeAll" | "socket.stop" | "store.close" | "supervisedInbox.close";

/** A daemon on its own paths, with a provider and no agent: the provider is never asked to do anything. */
async function runningDaemon() {
  const root = await mkdtemp(join(tmpdir(), "letagents-daemon-stop-"));
  const paths = { lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"), manifestPath: join(root, "daemon-state.sqlite"),
    auditPath: join(root, "audit.jsonl"), attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root };
  const unasked = async (): Promise<never> => { throw new Error("No agent exists, so the provider is not asked."); };
  const provider: ProviderActionPort = { capabilities: unasked, spawn: unasked, attach: unasked, attachAction: unasked, resume: unasked, poke: unasked, stop: unasked, onExit: unasked };
  const start = async () => {
    const daemon = new SupervisorDaemon(paths, "darwin", provider, false, 15_000, undefined, {}, { poll: async () => ({ messages: [] }), publish: unasked });
    await daemon.start();
    return daemon;
  };
  const daemon = await start();
  const ran: Step[] = [];
  const steps = daemon as unknown as Record<string, Record<string, () => Promise<void>>>;
  /** Note when a step of the stop runs, and optionally fail it once, as a drain that reports a refused write does. */
  const watch = (step: Step, failure?: Error) => {
    const [owner, method] = step.split(".") as [string, string];
    const run = steps[owner]![method]!.bind(steps[owner]);
    let fail = failure !== undefined;
    steps[owner]![method] = async () => {
      ran.push(step);
      await run();
      if (fail) { fail = false; throw failure; }
    };
  };
  return {
    daemon, watch, ran,
    /** The servers still listening on the daemon's socket: one keeps the process alive. */
    listening: () => (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
      .filter((handle) => handle instanceof Server && handle.address() === paths.socketPath).length,
    answers: () => new Promise<boolean>((resolve) => {
      const socket = createConnection(paths.socketPath);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    }),
    /** A new daemon starts on the same paths, which it can only do once the lock is released. */
    succeed: async () => { await (await start()).stop(); },
    cleanup: async () => {
      await daemon.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const failing of ["typedLifecycleEffects.close", "boundedEffects.drainJournalReservations", "providerReconciliation.disposeAll", "providerExecution.drainConvergence"] as const) {
  test(`a daemon whose ${failing} fails while it stops still drains what is left, closes its socket and stores, and reports that failure`, async () => {
    const stopped = await runningDaemon();
    try {
      const failure = new Error(`${failing} failed.`);
      const drains: Step[] = ["typedLifecycleEffects.close", "boundedEffects.drainJournalReservations", "providerReconciliation.disposeAll",
        "providerExecution.drainConvergence", "providerStreams.disposeAll"];
      for (const step of drains) stopped.watch(step, step === failing ? failure : undefined);
      stopped.watch("socket.stop");
      assert.equal(stopped.listening(), 1);

      await assert.rejects(stopped.daemon.stop().then(() => assert.fail("the stop reports the failure")), (error) => error === failure);

      // The steps after the one that failed ran all the same, the provider streams' drain among them, before the socket closed.
      assert.deepEqual(stopped.ran, [...drains, "socket.stop"]);
      assert.equal(stopped.listening(), 0, "the daemon's socket server is closed");
      assert.equal(await stopped.answers(), false, "and nothing answers on its socket");
      // Its lock and stores were released: a successor starts on the same paths.
      await stopped.succeed();
    } finally {
      await stopped.cleanup();
    }
  });

  test(`a daemon whose ${failing} failed while it stopped can be stopped again, and that stop finishes cleanly`, async () => {
    const stopped = await runningDaemon();
    try {
      const failure = new Error(`${failing} failed.`);
      stopped.watch(failing, failure);
      await assert.rejects(stopped.daemon.stop().then(() => assert.fail("the stop reports the failure")), (error) => error === failure);
      // A caller that cleans up after a failed stop stops the daemon again: nothing is left to fail, or to close twice.
      await stopped.daemon.stop();
      assert.equal(stopped.listening(), 0);
      await stopped.succeed();
    } finally {
      await stopped.cleanup();
    }
  });
}

test("a store that fails to close while a daemon stops does not replace the drain's failure, and what closes after it still closes", async () => {
  const stopped = await runningDaemon();
  try {
    const drainFailure = new Error("providerStreams.disposeAll failed."), closeFailure = new Error("store.close failed.");
    stopped.watch("providerStreams.disposeAll", drainFailure);
    stopped.watch("store.close", closeFailure);
    stopped.watch("supervisedInbox.close");

    await assert.rejects(stopped.daemon.stop().then(() => assert.fail("the stop reports the failure")), (error) => error === drainFailure);

    assert.deepEqual(stopped.ran, ["providerStreams.disposeAll", "store.close", "supervisedInbox.close"]);
    assert.equal(stopped.listening(), 0);
    await stopped.succeed();
  } finally {
    await stopped.cleanup();
  }
});
