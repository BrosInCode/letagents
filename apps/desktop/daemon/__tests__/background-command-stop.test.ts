import assert from "node:assert/strict";
import test from "node:test";

import { stopBackgroundCommand, type BackgroundCommandStopPorts } from "../background-command-stop.js";
import type { ProviderActionHandle } from "../provider-action-port.js";

const handle = { workAttemptId: "attempt-1" } as ProviderActionHandle;

function ports(overrides: Partial<BackgroundCommandStopPorts> = {}): BackgroundCommandStopPorts & { stopped: string[] } {
  const stopped: string[] = [];
  return {
    stopped,
    currentDaemonGeneration: () => 7,
    liveHandle: () => handle,
    isRunning: (_entryId, taskId) => taskId === "task-1",
    stop: async (_handle, taskId) => { stopped.push(taskId); return "stopping"; },
    ...overrides,
  };
}

test("the owner's Stop reaches the agent's provider only for a command that runs now, in the current generation", async () => {
  const live = ports();
  assert.deepEqual(await stopBackgroundCommand({ entryId: "agent", daemonGeneration: 7, taskId: "task-1" }, live), { outcome: "stopping" });
  assert.deepEqual(live.stopped, ["task-1"]);

  const stale = ports();
  assert.equal((await stopBackgroundCommand({ entryId: "agent", daemonGeneration: 6, taskId: "task-1" }, stale)).outcome, "invalid");
  assert.deepEqual(stale.stopped, [], "a stale generation changes nothing");

  const unknown = ports();
  assert.deepEqual(await stopBackgroundCommand({ entryId: "agent", daemonGeneration: 7, taskId: "sub-agent" }, unknown), { outcome: "not_running" });
  assert.deepEqual(unknown.stopped, [], "only a command the feed shows as running");

  assert.deepEqual(await stopBackgroundCommand({ entryId: "agent", daemonGeneration: 7, taskId: "task-1" }, ports({ liveHandle: () => undefined })), { outcome: "not_running" });
  assert.deepEqual(await stopBackgroundCommand({ entryId: "agent", daemonGeneration: 7, taskId: "task-1" }, ports({ stop: undefined })), { outcome: "not_running" });
  assert.deepEqual(await stopBackgroundCommand({ entryId: "agent", daemonGeneration: 7, taskId: "task-1" },
    ports({ stop: async () => { throw new Error("gone"); } })), { outcome: "failed" });
});
