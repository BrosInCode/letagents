import assert from "node:assert/strict";
import test from "node:test";

import { projectBackgroundCommands, projectLaunchProgress } from "../main/supervisor-daemon/entry-mapping.js";

const wire = {
  started_at: "2026-10-26T10:00:00.000Z",
  state: "failed",
  current: null,
  phases: [
    { phase: "prepare", started_at: "2026-10-26T10:00:00.000Z", ms: 300 },
    { phase: "slot_wait", started_at: "2026-10-26T10:00:00.300Z", ms: 2000 },
  ],
  ended_at: "2026-10-26T10:00:02.300Z",
  first_output_at: null,
  failure: { phase: "slot_wait", action: "sign_in" },
  slot_ahead: null,
};

test("daemon launch progress maps to the renderer shape", () => {
  assert.deepEqual(projectLaunchProgress(wire), {
    attempt: 1,
    startedAt: "2026-10-26T10:00:00.000Z",
    state: "failed",
    current: null,
    phases: [
      { phase: "prepare", startedAt: "2026-10-26T10:00:00.000Z", ms: 300 },
      { phase: "slot_wait", startedAt: "2026-10-26T10:00:00.300Z", ms: 2000 },
    ],
    endedAt: "2026-10-26T10:00:02.300Z",
    firstOutputAt: null,
    failure: { phase: "slot_wait", action: "sign_in" },
    slotAhead: null,
  });
  assert.equal(projectLaunchProgress({ ...wire, state: "running", current: "slot_wait", failure: null, slot_ahead: 3 })!.slotAhead, 3);
  const verifying = { ...wire, state: "running", current: "runtime_verify", failure: null,
    phases: [wire.phases[0], { phase: "runtime_verify", started_at: "2026-10-26T10:00:00.300Z", ms: null }] };
  assert.equal(projectLaunchProgress(verifying)!.current, "runtime_verify");
  assert.deepEqual(projectLaunchProgress(verifying)!.phases.map((phase) => phase.phase), ["prepare", "runtime_verify"]);
  assert.equal(projectLaunchProgress({ ...wire, attempt: 2 })!.attempt, 2);
});

test("malformed launch progress is shown as none, never partly", () => {
  for (const bad of [
    null,
    "running",
    { ...wire, state: "starting" },
    { ...wire, attempt: 0 },
    { ...wire, current: "warming_up" },
    { ...wire, started_at: "yesterday" },
    { ...wire, phases: [{ phase: "prepare", started_at: wire.started_at, ms: -1 }] },
    { ...wire, phases: [{ phase: "unknown", started_at: wire.started_at, ms: 1 }] },
    { ...wire, phases: "prepare" },
    { ...wire, failure: { phase: "prepare", action: "reboot" } },
    { ...wire, failure: { phase: "prepare", action: "retry", reason: "secret" }, ended_at: 5 },
  ]) assert.equal(projectLaunchProgress(bad), null, JSON.stringify(bad));
});

test("an agent's running background commands map to the renderer's shape, and a malformed one is left out", () => {
  assert.deepEqual(projectBackgroundCommands([
    { task_id: "task-1", tool_use_id: "toolu_1", command: "npm run dev", started_at: "2026-11-08T22:00:00.000Z" },
    { task_id: "task-2", tool_use_id: null, command: "npm run watch", started_at: "not a time" },
    { task_id: "", command: "x" },
    { task_id: "task-3" },
    null,
  ]), [
    { taskId: "task-1", toolUseId: "toolu_1", command: "npm run dev", startedAt: "2026-11-08T22:00:00.000Z" },
    { taskId: "task-2", toolUseId: null, command: "npm run watch", startedAt: null },
  ]);
  assert.deepEqual(projectBackgroundCommands(undefined), []);
});
