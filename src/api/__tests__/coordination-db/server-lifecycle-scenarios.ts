import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { stopChildProcess, waitForServer } from "./server.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  onKill: (signal: NodeJS.Signals) => void = () => {};

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.onKill(signal);
    return this.exitCode === null && this.signalCode === null;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

for (const terminal of ["numeric", "signal"] as const) {
  test(`process teardown accepts an already observed ${terminal} exit`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new FakeChild();
    child.exit(terminal === "numeric" ? 0 : null, terminal === "signal" ? "SIGTERM" : null);
    let completed = false;
    const stopping = stopChildProcess(child.asChild()).then(() => { completed = true; });
    await flushPromises();
    assert.equal(completed, true, "an observed exit requires no further event");
    assert.deepEqual(child.signals, []);
    await stopping;
  });

  test(`process teardown observes ${terminal} exit during TERM without a second signal`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new FakeChild();
    child.onKill = () => queueMicrotask(() => child.exit(
      terminal === "numeric" ? 0 : null,
      terminal === "signal" ? "SIGTERM" : null,
    ));
    let completed = false;
    const stopping = stopChildProcess(child.asChild()).then(() => { completed = true; });
    await flushPromises();
    assert.equal(completed, true, "TERM exit must finish teardown before grace expiry");
    assert.deepEqual(child.signals, ["SIGTERM"]);
    await stopping;
  });
}

test("process teardown arms exit observation before signalling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new FakeChild();
  child.onKill = () => child.exit(null, "SIGTERM");
  let completed = false;
  const stopping = stopChildProcess(child.asChild()).then(() => { completed = true; });
  await flushPromises();
  assert.equal(completed, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await stopping;
});

test("process teardown escalates after grace and still requires observed KILL exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new FakeChild();
  let completed = false;
  const stopping = stopChildProcess(child.asChild()).then(() => { completed = true; });
  await flushPromises();
  assert.equal(completed, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  t.mock.timers.tick(5000);
  await flushPromises();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(completed, false, "a successful signal request is not an exit witness");
  child.exit(null, "SIGKILL");
  await stopping;
  assert.equal(completed, true);
  assert.equal(child.listenerCount("exit"), 0, "one observation owns both TERM and KILL");
});


test("failed server readiness retires its child before publishing the startup failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  const child = new FakeChild();
  let failure: Error | null = null;
  const ready = waitForServer(12345, child.asChild(), () => "fixture stderr").catch((error: Error) => { failure = error; });
  for (let attempt = 0; attempt < 61; attempt += 1) {
    await flushPromises();
    t.mock.timers.tick(250);
  }
  await flushPromises();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(failure, null, "startup failure must not abandon an unretired child");
  child.exit(null, "SIGTERM");
  await ready;
  assert.match((failure as Error | null)?.message ?? "", /did not become ready: fixture stderr/);
  assert.equal(child.listenerCount("exit"), 0);
});

test("a signal-exited server cannot become ready from a healthy port response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const health = t.mock.method(globalThis, "fetch", async () => new Response("ok"));
  const child = new FakeChild();
  child.exit(null, "SIGTERM");
  await assert.rejects(waitForServer(12345, child.asChild(), () => "fixture stderr"), /exited early: fixture stderr/);
  assert.equal(health.mock.callCount(), 0);
  assert.deepEqual(child.signals, []);
});
