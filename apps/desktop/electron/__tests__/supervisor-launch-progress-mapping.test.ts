import assert from "node:assert/strict";
import test from "node:test";

import { projectLaunchProgress } from "../main/supervisor-daemon/entry-mapping.js";

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
});

test("malformed launch progress is shown as none, never partly", () => {
  for (const bad of [
    null,
    "running",
    { ...wire, state: "starting" },
    { ...wire, current: "warming_up" },
    { ...wire, started_at: "yesterday" },
    { ...wire, phases: [{ phase: "prepare", started_at: wire.started_at, ms: -1 }] },
    { ...wire, phases: [{ phase: "unknown", started_at: wire.started_at, ms: 1 }] },
    { ...wire, phases: "prepare" },
    { ...wire, failure: { phase: "prepare", action: "reboot" } },
    { ...wire, failure: { phase: "prepare", action: "retry", reason: "secret" }, ended_at: 5 },
  ]) assert.equal(projectLaunchProgress(bad), null, JSON.stringify(bad));
});
