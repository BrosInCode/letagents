import assert from "node:assert/strict";
import test from "node:test";

import { ProviderSchedulerFailureCoordinator } from "../provider-scheduler-failure-coordinator.js";

function harness(clock = { now: 0 }) {
  const entry = { id: "agent-1", desired_state: "running", observed_state: "recovering", condition: "none",
    work_attempt_id: "attempt-1", provider_ref: { execution_generation_id: "generation-1" } };
  const scheduled: number[] = [];
  const messages: string[] = [];
  const reports: Array<{ entryId: string; resetsAtMs: number | null; occurrence: string }> = [];
  const coordinator = new ProviderSchedulerFailureCoordinator({
    reportUsageLimit: (input) => { reports.push(input); },
    nativeHeartbeatIntervalMs: 15_000, currentDaemonGeneration: () => 1, nowMs: () => clock.now,
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
  return { coordinator, scheduled, messages, reports };
}

const quotaError = (resetsAtMs?: number) => Object.assign(
  new Error("Claude CLI did not complete its daemon-safe bootstrap turn (failed_response)."),
  { providerQuotaExhausted: true as const, ...(resetsAtMs === undefined ? {} : { providerQuotaResetsAtMs: resetsAtMs }) });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("a provider usage limit is checked once soon, then every six hours until a launch succeeds", async () => {
  const { coordinator, scheduled, messages } = harness();
  for (let attempt = 0; attempt < 7; attempt += 1) await coordinator.record("agent-1", quotaError(), "test");
  assert.deepEqual(scheduled, [5 * MINUTE, 6 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR],
    "an hourly relaunch of every limited agent is the defect");
  assert.equal(messages.length, 7);
  assert.match(messages[0]!, /failed_response/);

  coordinator.clearSuccessfulRecovery("agent-1");
  await coordinator.record("agent-1", quotaError(), "test");
  assert.equal(scheduled.at(-1), 5 * MINUTE, "a successful launch restarts the schedule");
});

test("a usage limit with a reset clearly ahead waits for that reset, never beyond six hours", async () => {
  const clock = { now: 1_000_000_000 };
  const { coordinator, scheduled } = harness(clock);
  const record = (resetsInMs: number) => coordinator.record("agent-1", quotaError(clock.now + resetsInMs), "test");
  await record(2 * HOUR);
  await record(3 * 24 * HOUR);
  await record(5 * MINUTE + 1);
  assert.deepEqual(scheduled, [2 * HOUR + 30_000, 6 * HOUR, 5 * MINUTE + 1 + 30_000],
    "just after the named reset; a far reset is rechecked every six hours");
});

for (const [name, resetsInMs] of [
  ["already past", -10 * MINUTE],
  ["a minute away", MINUTE],
  ["exactly at the early check", 5 * MINUTE],
] as const) {
  test(`a reset that is ${name} gets one early check, then six hours, however often it is named`, async () => {
    const clock = { now: 1_000_000_000 };
    const { coordinator, scheduled } = harness(clock);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await coordinator.record("agent-1", quotaError(clock.now + resetsInMs), "test");
    }
    assert.deepEqual(scheduled, [5 * MINUTE, 6 * HOUR, 6 * HOUR, 6 * HOUR],
      "a stale reset must not relaunch every limited agent every five minutes");
  });
}

test("a stale reset after a reset that was waited for still gets its one early check", async () => {
  const clock = { now: 1_000_000_000 };
  const { coordinator, scheduled } = harness(clock);
  await coordinator.record("agent-1", quotaError(clock.now + 2 * HOUR), "test");
  await coordinator.record("agent-1", quotaError(clock.now - MINUTE), "test");
  await coordinator.record("agent-1", quotaError(clock.now - MINUTE), "test");
  assert.deepEqual(scheduled, [2 * HOUR + 30_000, 5 * MINUTE, 6 * HOUR]);
  coordinator.clearSuccessfulRecovery("agent-1");
  await coordinator.record("agent-1", quotaError(clock.now - MINUTE), "test");
  assert.equal(scheduled.at(-1), 5 * MINUTE, "a successful launch restarts the early check");
});

test("a named reset ignores how many launches already failed", async () => {
  const clock = { now: 0 };
  const { coordinator, scheduled } = harness(clock);
  await coordinator.record("agent-1", quotaError(), "test");
  await coordinator.record("agent-1", quotaError(), "test");
  await coordinator.record("agent-1", quotaError(clock.now + 90 * MINUTE), "test");
  assert.equal(scheduled.at(-1), 90 * MINUTE + 30_000);
});

test("the reset time is read from the cause chain the scheduler receives", async () => {
  const { coordinator, scheduled } = harness();
  const wrapped = new Error("launch failed", { cause: quotaError(2 * HOUR) });
  await coordinator.record("agent-1", wrapped, "test");
  assert.deepEqual(scheduled, [2 * HOUR + 30_000]);
});

test("an unclassified bootstrap failure still schedules no automatic retry", async () => {
  const { coordinator, scheduled } = harness();
  await coordinator.record("agent-1", new Error("Claude CLI did not complete its daemon-safe bootstrap turn (deadline)."), "test");
  assert.deepEqual(scheduled, []);
});

test("a launch refused at the usage limit tells the room, once for each reset the provider names", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00.000Z") };
  const { coordinator, reports } = harness(clock);
  const reset = clock.now + 2 * HOUR;
  await coordinator.record("agent-1", quotaError(reset), "test");
  await coordinator.record("agent-1", quotaError(reset), "test");
  await coordinator.record("agent-1", quotaError(), "test");
  assert.deepEqual(reports, [
    { entryId: "agent-1", resetsAtMs: reset, occurrence: String(reset) },
    { entryId: "agent-1", resetsAtMs: reset, occurrence: String(reset) },
    { entryId: "agent-1", resetsAtMs: null, occurrence: `unknown:${Math.floor(clock.now / (24 * HOUR))}` },
  ], "the occurrence repeats for the same reset, so the room posts it once");
  await coordinator.record("agent-1", new Error("some other launch failure"), "test");
  assert.equal(reports.length, 3, "only a usage limit is reported");
});
