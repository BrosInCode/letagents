import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopSupervisorCreateInput } from "../ipc-types/agents.js";
import { assertDesktopSupervisorLaunchTarget } from "../main/supervisor-launch-target.js";

function launchInput(overrides: Partial<DesktopSupervisorCreateInput> = {}): DesktopSupervisorCreateInput {
  return {
    creationRequestId: "request_b",
    activeRoomIdentifier: "focus_b",
    projectRoomIdentifier: "focus_b",
    projectRootPath: "/tmp/repo-b",
    roomIdentifier: "focus_b",
    displayName: "Codex supervised agent",
    providerId: "codex",
    charter: "Work in B.",
    repoRootPath: "/tmp/repo-b",
    ...overrides,
  };
}

test("accepts an exact visible-room launch even when another room owns the same provider lane", () => {
  // Lane ownership is room scoped downstream. An existing focus_a/codex lane
  // must not rewrite or reject the independently targeted focus_b request.
  assert.doesNotThrow(() => assertDesktopSupervisorLaunchTarget(launchInput()));
});

test("fails closed when navigation leaves the modal on the prior room", () => {
  assert.throws(
    () => assertDesktopSupervisorLaunchTarget(launchInput({ activeRoomIdentifier: "focus_b", projectRoomIdentifier: "focus_a", roomIdentifier: "focus_a" })),
    /visible room changed/i,
  );
});

test("fails closed when the requested room disagrees with active and project context", () => {
  assert.throws(
    () => assertDesktopSupervisorLaunchTarget(launchInput({ roomIdentifier: "focus_a" })),
    /visible room changed/i,
  );
});

test("fails closed when app restart or modal restore omits active-room evidence", () => {
  assert.throws(
    () => assertDesktopSupervisorLaunchTarget(launchInput({ activeRoomIdentifier: null })),
    /requires an exact visible room/i,
  );
});

test("fails closed before IPC effects when project roots disagree", () => {
  assert.throws(
    () => assertDesktopSupervisorLaunchTarget(launchInput({ projectRootPath: "/tmp/repo-a" })),
    /project changed/i,
  );
});
