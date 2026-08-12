import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createGracefulShutdownController } from "../server/graceful-shutdown.js";

test("graceful shutdown is single-flight, ordered, and restart-leak free", async () => {
  const signals = new EventEmitter();
  const calls: string[] = [];
  let releaseIntake!: () => void;
  const intake = new Promise<void>((resolve) => { releaseIntake = resolve; });
  let exited: number | null = null;
  const controller = createGracefulShutdownController({
    stopIntake: () => { calls.push("intake:start"); return intake.then(() => { calls.push("intake:done"); }); },
    stopWorkers: async () => { calls.push("workers"); },
    stopBridge: async () => { calls.push("bridge"); },
    closeBroker: () => { calls.push("broker"); },
    drainConnections: async () => { calls.push("connections"); },
    closeDatabase: async () => { calls.push("database"); },
    exit: (code) => { exited = code; },
  }, signals);

  controller.install();
  controller.install();
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  assert.equal(signals.listenerCount("SIGINT"), 1);
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["intake:start", "workers", "bridge", "broker"]);
  assert.equal(exited, null, "the process stays alive while intake is draining");

  releaseIntake();
  await controller.shutdown();
  assert.deepEqual(calls, [
    "intake:start", "workers", "bridge", "broker", "intake:done", "connections", "database",
  ]);
  assert.equal(exited, 0);

  controller.dispose();
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  const restarted = createGracefulShutdownController({
    stopIntake: async () => {},
    stopWorkers: async () => {},
    stopBridge: async () => {},
    closeBroker: () => {},
    closeDatabase: async () => {},
  }, signals);
  restarted.install();
  assert.equal(signals.listenerCount("SIGTERM"), 1, "restart owns exactly one handler");
  restarted.dispose();
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("graceful shutdown has a hard deadline and forces sockets closed", async () => {
  let forced = 0;
  const never = new Promise<void>(() => {});
  const controller = createGracefulShutdownController({
    stopIntake: () => never,
    stopWorkers: async () => {},
    stopBridge: async () => {},
    closeBroker: () => {},
    closeDatabase: async () => {},
    forceClose: () => { forced += 1; },
    timeoutMs: 10,
  }, new EventEmitter());
  await assert.rejects(controller.shutdown(), /exceeded 10ms/);
  assert.equal(forced, 1);
});
