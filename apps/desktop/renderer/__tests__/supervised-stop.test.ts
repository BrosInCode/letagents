import assert from "node:assert/strict";
import test from "node:test";

import {
  supervisedLifecycleStatusLabel,
  supervisedStopAgentButtonLabel,
  supervisedStopAgentDisabled,
  supervisedStopAgentInFlight,
} from "../src/domain/supervised-stop";
import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";

type Fields = Pick<DesktopSupervisorManifestEntry, "desiredState" | "observedState">;

function fields(overrides: Partial<Fields> = {}): Fields {
  return { desiredState: "running", observedState: "working", ...overrides };
}

test("lifecycle label reports working/idle only while actually running", () => {
  assert.equal(supervisedLifecycleStatusLabel(fields({ desiredState: "running", observedState: "working" })), "Working");
  assert.equal(supervisedLifecycleStatusLabel(fields({ desiredState: "running", observedState: "idle" })), "Idle");
});

test("a stopped desired state never lingers as working/idle", () => {
  // desired stopped but not yet converged -> Stopping…
  assert.equal(
    supervisedLifecycleStatusLabel(fields({ desiredState: "stopped", observedState: "working" })),
    "Stopping…",
  );
  // converged -> Stopped
  assert.equal(
    supervisedLifecycleStatusLabel(fields({ desiredState: "stopped", observedState: "stopped" })),
    "Stopped",
  );
  assert.equal(
    supervisedLifecycleStatusLabel(fields({ desiredState: "stopped", observedState: "absent" })),
    "Stopped",
  );
});

test("paused desired state is honest too", () => {
  assert.equal(supervisedLifecycleStatusLabel(fields({ desiredState: "paused", observedState: "working" })), "Pausing…");
  assert.equal(supervisedLifecycleStatusLabel(fields({ desiredState: "paused", observedState: "paused" })), "Paused");
});

test("stop is disabled (idempotent) once the entry is already stopped", () => {
  assert.equal(supervisedStopAgentDisabled({ desiredState: "stopped" }), true);
  assert.equal(supervisedStopAgentDisabled({ desiredState: "running" }), false);
  assert.equal(supervisedStopAgentDisabled({ desiredState: "paused" }), false);
});

test("in-flight is true only while a stop is converging", () => {
  assert.equal(supervisedStopAgentInFlight(fields({ desiredState: "stopped", observedState: "stopping" })), true);
  assert.equal(supervisedStopAgentInFlight(fields({ desiredState: "stopped", observedState: "stopped" })), false);
  assert.equal(supervisedStopAgentInFlight(fields({ desiredState: "running", observedState: "working" })), false);
});

test("button label walks Stop agent -> Confirm stop -> Stopping… -> Stopped", () => {
  const running = fields({ desiredState: "running", observedState: "working" });
  assert.equal(supervisedStopAgentButtonLabel(running, { confirming: false, pendingStop: false }), "Stop agent");
  assert.equal(supervisedStopAgentButtonLabel(running, { confirming: true, pendingStop: false }), "Confirm stop");
  assert.equal(supervisedStopAgentButtonLabel(running, { confirming: true, pendingStop: true }), "Stopping…");
  assert.equal(
    supervisedStopAgentButtonLabel(fields({ desiredState: "stopped", observedState: "stopping" }), { confirming: false, pendingStop: false }),
    "Stopping…",
  );
  assert.equal(
    supervisedStopAgentButtonLabel(fields({ desiredState: "stopped", observedState: "stopped" }), { confirming: false, pendingStop: false }),
    "Stopped",
  );
});

test("an unresolved/unbound launch is still stoppable (label reflects running, not blocked)", () => {
  // A launch gone wrong: never bound, still desired running.
  const unresolved = fields({ desiredState: "running", observedState: "recovering" });
  assert.equal(supervisedStopAgentDisabled({ desiredState: "running" }), false);
  assert.equal(supervisedStopAgentButtonLabel(unresolved, { confirming: false, pendingStop: false }), "Stop agent");
});
