import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopSupervisorManifestEntry, DesktopSupervisorRetirementEvent } from "../ipc-types.js";
import {
  desktopRetirementDurablyCompleted,
  SupervisorRetirementOperations,
} from "../main/supervisor-retirement-operations.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accepted, failed) => { resolve = accepted; reject = failed; });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_retirement_12345678", roomId: "room_1", displayName: "MapleMeadow",
    provider: "codex", model: null, charter: "test", desiredState: "stopped", observedState: "stopped",
    condition: "none", permissionProfileId: null, deliveryMode: "daemon_inbox", createdBy: "desktop",
    createdAt: "2026-08-15T00:00:00.000Z", workspacePath: "/tmp/work", workAttemptId: "attempt_1",
    agentSessionId: null, agentSessionBindingState: "historical", bindingUpdatedAt: null,
    executionGenerationId: "generation_1", providerContinuationId: "thread_1", providerPid: null,
    workplaceLiveness: { state: "stale", observedAt: "2026-08-15T00:00:01.000Z", detail: "Retired." },
    nativeLiveness: { state: "terminal", observedAt: "2026-08-15T00:00:01.000Z", detail: "Stopped." },
    restartCount: 0, lastTerminal: null, activity: [], lastTurnControlSequence: 0, turnControl: null,
    ...overrides,
  };
}

test("retirement submission returns before slow cleanup and emits completion afterward", async () => {
  const gate = deferred();
  const events: DesktopSupervisorRetirementEvent[] = [];
  let retireCalls = 0;
  const operations = new SupervisorRetirementOperations({
    retire: async () => { retireCalls += 1; await gate.promise; },
    emit: (event) => events.push(event),
    now: () => new Date("2026-08-15T00:00:02.000Z"),
  });

  const receipt = operations.start({ operationId: "operation_12345678", entryId: "agent_12345678", daemonGeneration: 7 });
  assert.deepEqual(receipt, {
    operationId: "operation_12345678", entryId: "agent_12345678", daemonGeneration: 7, status: "accepted",
  });
  assert.equal(retireCalls, 0, "cleanup starts in the background instead of holding submission open");
  assert.deepEqual(events, []);
  await nextTurn();
  assert.equal(retireCalls, 1);
  gate.resolve();
  await nextTurn();
  assert.deepEqual(events, [{
    operationId: "operation_12345678", entryId: "agent_12345678", daemonGeneration: 7,
    status: "completed", error: null, occurredAt: "2026-08-15T00:00:02.000Z",
  }]);
});

test("repeated submissions share cleanup but every accepted operation receives completion", async () => {
  const gate = deferred();
  const events: DesktopSupervisorRetirementEvent[] = [];
  let retireCalls = 0;
  const operations = new SupervisorRetirementOperations({
    retire: async () => { retireCalls += 1; await gate.promise; },
    emit: (event) => events.push(event),
  });
  operations.start({ operationId: "operation_first", entryId: "agent_12345678", daemonGeneration: 7 });
  operations.start({ operationId: "operation_second", entryId: "agent_12345678", daemonGeneration: 7 });
  await nextTurn();
  assert.equal(retireCalls, 1);
  gate.resolve();
  await nextTurn();
  assert.deepEqual(events.map((event) => [event.operationId, event.status]), [
    ["operation_first", "completed"], ["operation_second", "completed"],
  ]);
});

test("background retirement failure is reported by event rather than rejecting submission", async () => {
  const events: DesktopSupervisorRetirementEvent[] = [];
  const operations = new SupervisorRetirementOperations({
    retire: async () => { throw new Error("Credential revocation failed."); },
    emit: (event) => events.push(event),
  });
  assert.equal(operations.start({
    operationId: "operation_failure", entryId: "agent_12345678", daemonGeneration: 7,
  }).status, "accepted");
  await nextTurn();
  assert.equal(events[0]?.status, "failed");
  assert.equal(events[0]?.error, "Credential revocation failed.");
});

test("durable retirement fallback requires stopped lifecycle and attested daemon-inbox grant revocation", () => {
  assert.equal(desktopRetirementDurablyCompleted(entry(), true), true);
  assert.equal(desktopRetirementDurablyCompleted(entry(), false), false,
    "missing registry state is ambiguity, not proof of remote grant revocation");
  assert.equal(desktopRetirementDurablyCompleted(entry({ agentSessionId: "session_1", agentSessionBindingState: "active" }), true), false);
  assert.equal(desktopRetirementDurablyCompleted(entry({ observedState: "stopping" }), true), false);
  assert.equal(desktopRetirementDurablyCompleted(entry({ desiredState: "running" }), true), false);
  assert.equal(desktopRetirementDurablyCompleted(entry({ deliveryMode: "mcp_polling" }), false), true,
    "entries that never held a desktop host grant use daemon lifecycle proof alone");
});

test("retirement submission rejects malformed or cross-generation aliases", async () => {
  const gate = deferred();
  const operations = new SupervisorRetirementOperations({ retire: () => gate.promise, emit: () => undefined });
  assert.throws(() => operations.start({ operationId: "short", entryId: "agent_12345678", daemonGeneration: 7 }), /exact typed coordinates/);
  operations.start({ operationId: "operation_valid", entryId: "agent_12345678", daemonGeneration: 7 });
  assert.throws(() => operations.start({ operationId: "operation_newgen", entryId: "agent_12345678", daemonGeneration: 8 }), /another supervisor generation/);
  gate.resolve();
  await nextTurn();
});
