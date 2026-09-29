import assert from "node:assert/strict";
import test from "node:test";

import { ProviderSchedulerFailureCoordinator } from "../provider-scheduler-failure-coordinator.js";

function harness() {
  const entry = { id: "agent-1", desired_state: "running", observed_state: "recovering", condition: "none",
    work_attempt_id: "attempt-1", provider_ref: { execution_generation_id: "generation-1" } };
  const scheduled: number[] = [];
  const messages: string[] = [];
  const coordinator = new ProviderSchedulerFailureCoordinator({
    nativeHeartbeatIntervalMs: 15_000, currentDaemonGeneration: () => 1, nowMs: () => 0,
    serializeEntry: async (_id, operation) => operation(),
    serializeManifest: async (operation) => operation(),
    manifest: {
      load: async () => ({ entries: [entry as never] }),
      updateEntry: async () => { throw new Error("a usage limit must not reset the continuation"); },
    },
    transitionOnce: async (_id, _state, _condition, message) => { messages.push(message); },
    audit: { append: async () => {} },
    scheduleRecovery: (_id, delayMs) => { scheduled.push(delayMs); },
  });
  return { coordinator, scheduled, messages };
}

const quotaError = () => Object.assign(new Error("Claude CLI did not complete its daemon-safe bootstrap turn (failed_response)."),
  { providerQuotaExhausted: true as const });

test("a provider usage limit keeps retrying with capped backoff until a launch succeeds", async () => {
  const { coordinator, scheduled, messages } = harness();
  for (let attempt = 0; attempt < 7; attempt += 1) await coordinator.record("agent-1", quotaError(), "test");
  assert.deepEqual(scheduled, [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000, 3_600_000]);
  assert.equal(messages.length, 7);
  assert.match(messages[0]!, /failed_response/);

  coordinator.clearSuccessfulRecovery("agent-1");
  await coordinator.record("agent-1", quotaError(), "test");
  assert.equal(scheduled.at(-1), 300_000, "a successful launch restarts the backoff");
});

test("an unclassified bootstrap failure still schedules no automatic retry", async () => {
  const { coordinator, scheduled } = harness();
  await coordinator.record("agent-1", new Error("Claude CLI did not complete its daemon-safe bootstrap turn (deadline)."), "test");
  assert.deepEqual(scheduled, []);
});
