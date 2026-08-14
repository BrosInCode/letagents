import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopQuitCoordinator,
  type DesktopQuitCoordinatorOptions,
} from "../main/desktop-quit.js";
import type { DesktopSupervisorQuitAgent } from "../main/supervisor-daemon.js";

const activeAgent: DesktopSupervisorQuitAgent = {
  id: "agent_1",
  displayName: "Oak",
  desiredState: "running",
  observedState: "working",
};

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(overrides: Partial<DesktopQuitCoordinatorOptions> = {}) {
  const events: string[] = [];
  let prevented = 0;
  const coordinator = new DesktopQuitCoordinator({
    prepareDaemonIfIdle: async () => ({ outcome: "no_daemon" }),
    stopAgentsAndPrepareDaemon: async () => ({ outcome: "shutting_down" }),
    chooseForActiveAgents: async () => "cancel",
    chooseAfterFailure: async () => "cancel",
    cleanup: async () => { events.push("cleanup"); },
    quit: () => { events.push("quit"); },
    bypassForUpdate: () => false,
    ...overrides,
  });
  const handle = () => coordinator.handleBeforeQuit({
    preventDefault: () => { prevented += 1; },
  });
  return { coordinator, events, handle, prevented: () => prevented };
}

test("ordinary quit retires an idle daemon before cleanup and Electron exit", async () => {
  const events: string[] = [];
  const app = harness({
    prepareDaemonIfIdle: async () => { events.push("daemon"); return { outcome: "shutting_down" }; },
    cleanup: async () => { events.push("cleanup"); },
    quit: () => { events.push("quit"); },
  });
  app.handle();
  await flush();
  assert.equal(app.prevented(), 1);
  assert.deepEqual(events, ["daemon", "cleanup", "quit"]);
});

test("active-agent quit can keep supervised work running", async () => {
  let stopCalls = 0;
  const app = harness({
    prepareDaemonIfIdle: async () => ({ outcome: "active", activeAgents: [activeAgent] }),
    chooseForActiveAgents: async (agents) => {
      assert.deepEqual(agents, [activeAgent]);
      return "keep_running";
    },
    stopAgentsAndPrepareDaemon: async () => { stopCalls += 1; return { outcome: "shutting_down" }; },
  });
  app.handle();
  await flush();
  assert.equal(stopCalls, 0);
  assert.deepEqual(app.events, ["cleanup", "quit"]);
});

test("active-agent quit can stop exact agents before daemon retirement", async () => {
  const order: string[] = [];
  const app = harness({
    prepareDaemonIfIdle: async () => ({ outcome: "active", activeAgents: [activeAgent] }),
    chooseForActiveAgents: async () => "stop_and_quit",
    stopAgentsAndPrepareDaemon: async (agents) => {
      assert.deepEqual(agents, [activeAgent]);
      order.push("stop");
      return { outcome: "shutting_down" };
    },
    cleanup: async () => { order.push("cleanup"); },
    quit: () => { order.push("quit"); },
  });
  app.handle();
  await flush();
  assert.deepEqual(order, ["stop", "cleanup", "quit"]);
});

test("cancelling the active-agent prompt leaves the app and cleanup running", async () => {
  const app = harness({
    prepareDaemonIfIdle: async () => ({ outcome: "active", activeAgents: [activeAgent] }),
    chooseForActiveAgents: async () => "cancel",
  });
  app.handle();
  await flush();
  assert.deepEqual(app.events, []);
  app.handle();
  await flush();
  assert.equal(app.prevented(), 2, "a later quit remains eligible after cancellation");
});

test("duplicate before-quit events coalesce while the daemon decision is pending", async () => {
  let release!: () => void;
  let preparations = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = harness({
    prepareDaemonIfIdle: async () => { preparations += 1; await gate; return { outcome: "no_daemon" }; },
  });
  app.handle();
  app.handle();
  assert.equal(preparations, 1);
  assert.equal(app.prevented(), 2);
  release();
  await flush();
  assert.deepEqual(app.events, ["cleanup", "quit"]);
});

test("a failed daemon decision requires an explicit quit-anyway choice", async () => {
  const app = harness({
    prepareDaemonIfIdle: async () => { throw new Error("socket remained owned"); },
    chooseAfterFailure: async (error) => {
      assert.match(error.message, /socket remained owned/);
      return "quit_anyway";
    },
  });
  app.handle();
  await flush();
  assert.deepEqual(app.events, ["cleanup", "quit"]);
});

test("native updater quit bypasses the prompt without delaying Electron", async () => {
  const app = harness({ bypassForUpdate: () => true });
  app.handle();
  await flush();
  assert.equal(app.prevented(), 0);
  assert.deepEqual(app.events, ["cleanup"]);
});
