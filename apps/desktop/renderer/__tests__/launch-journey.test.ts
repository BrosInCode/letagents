import assert from "node:assert/strict";
import test from "node:test";

import { foldLaunchJourney, type LaunchJourneyView } from "../src/domain/launch-journey";
import type {
  DesktopLaunchEvent,
  DesktopLaunchEventType,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";

let sequenceCounter = 0;
function evt(type: DesktopLaunchEventType, overrides: Partial<DesktopLaunchEvent> = {}): DesktopLaunchEvent {
  return {
    launchId: "launch-1",
    entryId: "supervised_launch-1",
    roomIdentifier: "focus_37",
    provider: "codex",
    sequence: (sequenceCounter += 1),
    type,
    at: "2026-07-17T00:00:00.000Z",
    detail: null,
    recovery: null,
    durable: false,
    ...overrides,
  };
}

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_launch-1",
    roomId: "focus_37",
    displayName: "Codex supervised agent",
    provider: "codex",
    model: null,
    charter: "Work from the board.",
    desiredState: "running",
    observedState: "starting",
    condition: "none",
    lastError: null,
    permissionProfileId: null,
    createdBy: "desktop",
    createdAt: "2026-07-17T00:00:00.000Z",
    workspacePath: null,
    workAttemptId: null,
    agentSessionId: null,
    agentSessionBindingState: "none",
    bindingUpdatedAt: null,
    executionGenerationId: null,
    providerContinuationId: null,
    providerPid: null,
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    ...overrides,
  };
}

function stateOf(view: LaunchJourneyView, id: string): string {
  return view.phases.find((phase) => phase.id === id)!.state;
}

function activeCount(view: LaunchJourneyView): number {
  return view.phases.filter((phase) => phase.state === "active").length;
}

test("the journey is seven ordered product phases", () => {
  const view = foldLaunchJourney({ requested: true, provider: "codex" });
  assert.deepEqual(
    view.phases.map((phase) => phase.id),
    [
      "connecting_supervisor",
      "saving_agent",
      "preparing_workspace",
      "starting_provider",
      "connecting_room",
      "registering_identity",
      "ready",
    ],
  );
});

test("clicking Start (requested only) is connecting to the supervisor", () => {
  const view = foldLaunchJourney({ requested: true, provider: "codex", roomLabel: "Room Agents Rewrite" });
  assert.equal(view.currentPhaseId, "connecting_supervisor");
  assert.equal(stateOf(view, "connecting_supervisor"), "active");
  assert.equal(view.status, "in_progress");
  assert.equal(view.ready, false);
  assert.equal(view.failed, false);
  assert.equal(view.joinHint, "You can close this window. We'll keep setting up the agent.");
  assert.equal(activeCount(view), 1);
});

test("supervisor.connected advances to saving your agent", () => {
  const view = foldLaunchJourney({ events: [evt("launch.requested"), evt("supervisor.connected")], provider: "codex" });
  assert.equal(stateOf(view, "connecting_supervisor"), "done");
  assert.equal(stateOf(view, "saving_agent"), "active");
  assert.equal(activeCount(view), 1);
});

test("agent.saved advances past the pre-durable window", () => {
  const view = foldLaunchJourney({ events: [evt("supervisor.connected"), evt("agent.saved")], provider: "codex" });
  assert.equal(stateOf(view, "connecting_supervisor"), "done");
  assert.equal(stateOf(view, "saving_agent"), "done");
  assert.equal(stateOf(view, "preparing_workspace"), "active");
});

test("once the durable entry exists the pre-durable steps are complete and the manifest drives the rest", () => {
  const view = foldLaunchJourney({
    events: [evt("supervisor.connected"), evt("agent.saved"), evt("launch.activated", { durable: true })],
    entry: entry({ workspacePath: "/tmp/wt", providerPid: null }),
    provider: "codex",
  });
  assert.equal(stateOf(view, "connecting_supervisor"), "done");
  assert.equal(stateOf(view, "saving_agent"), "done");
  assert.equal(stateOf(view, "preparing_workspace"), "done");
  assert.equal(stateOf(view, "starting_provider"), "active");
  assert.equal(activeCount(view), 1);
});

test("a bound, reachable, unblocked entry resolves to ready with the real name", () => {
  const view = foldLaunchJourney({
    entry: entry({
      displayName: "SilverCanyon",
      observedState: "working",
      condition: "none",
      workspacePath: "/tmp/wt",
      providerPid: 4242,
      agentSessionId: "agent_session_9",
      agentSessionBindingState: "active",
      workplaceLiveness: { state: "reachable", observedAt: "2026-07-17T00:01:00.000Z", detail: null },
    }),
  });
  assert.equal(view.ready, true);
  assert.equal(view.status, "ready");
  assert.equal(view.agentName, "SilverCanyon");
  assert.match(view.headline, /SilverCanyon/);
  assert.ok(view.phases.every((phase) => phase.state === "done"));
  assert.equal(view.joinHint, null);
});

test("a pre-durable connection failure blocks on connecting to the supervisor with a recovery action", () => {
  const view = foldLaunchJourney({
    events: [
      evt("launch.requested"),
      evt("launch.blocked", { detail: "LetAgents could not reach background agent management.", recovery: "reconnect" }),
    ],
    provider: "codex",
  });
  assert.equal(view.status, "blocked");
  assert.equal(view.failed, true);
  assert.equal(stateOf(view, "connecting_supervisor"), "failed");
  assert.equal(view.recovery, "reconnect");
  assert.match(view.failureDetail ?? "", /background agent management/);
});

test("a failure after connecting attributes to saving your agent", () => {
  const view = foldLaunchJourney({
    events: [
      evt("supervisor.connected"),
      evt("launch.failed", { detail: "The launch could not be completed. You can try again.", recovery: "retry" }),
    ],
    provider: "codex",
  });
  assert.equal(view.status, "failed");
  assert.equal(stateOf(view, "saving_agent"), "failed");
  assert.equal(view.recovery, "retry");
});

test("a user cancel is a cancelled journey, not a failure", () => {
  const view = foldLaunchJourney({
    events: [evt("supervisor.connected"), evt("agent.saved"), evt("launch.cancelled", { durable: true, detail: "You stopped this launch." })],
    provider: "codex",
  });
  assert.equal(view.status, "cancelled");
  assert.equal(view.stopped, true);
  assert.equal(view.failed, false);
  // Cancelled shows no failed step marker.
  assert.equal(view.phases.filter((phase) => phase.state === "failed").length, 0);
});

test("a manifest auth block surfaces a sign-in recovery", () => {
  const view = foldLaunchJourney({
    entry: entry({ observedState: "recovering", condition: "auth_blocked", workspacePath: "/tmp/wt", providerPid: 10 }),
  });
  assert.equal(view.failed, true);
  assert.equal(view.status, "failed");
  assert.equal(view.recovery, "sign_in");
});

test("folding is idempotent under duplicate and out-of-order delivery", () => {
  const ordered = foldLaunchJourney({
    events: [
      evt("launch.requested", { sequence: 1 }),
      evt("supervisor.connected", { sequence: 2 }),
      evt("agent.saved", { sequence: 3 }),
    ],
    provider: "codex",
  });
  const shuffledWithDuplicates = foldLaunchJourney({
    events: [
      evt("agent.saved", { sequence: 3 }),
      evt("launch.requested", { sequence: 1 }),
      evt("agent.saved", { sequence: 3 }),
      evt("supervisor.connected", { sequence: 2 }),
    ],
    provider: "codex",
  });
  assert.deepEqual(
    shuffledWithDuplicates.phases.map((phase) => phase.state),
    ordered.phases.map((phase) => phase.state),
  );
});

test("copy is provider-neutral", () => {
  const codex = foldLaunchJourney({ requested: true, provider: "codex" });
  const claude = foldLaunchJourney({ requested: true, provider: "claude-code" });
  assert.equal(codex.providerLabel, "Codex");
  assert.equal(claude.providerLabel, "Claude Code");
  assert.match(codex.phases.find((phase) => phase.id === "starting_provider")!.label, /Codex/);
  assert.match(claude.phases.find((phase) => phase.id === "starting_provider")!.label, /Claude Code/);
});

test("the room name appears in the joining step", () => {
  const view = foldLaunchJourney({ requested: true, provider: "codex", roomLabel: "Room Agents Rewrite" });
  assert.match(view.phases.find((phase) => phase.id === "connecting_room")!.label, /Room Agents Rewrite/);
});

test("a retry after failure clears the prior terminal and progresses (finding 1)", () => {
  const view = foldLaunchJourney({
    events: [
      evt("launch.requested", { sequence: 1 }),
      evt("supervisor.connected", { sequence: 2 }),
      evt("launch.failed", { sequence: 3, detail: "boom", recovery: "retry" }),
      // Retry reuses the same launch id and opens a fresh attempt:
      evt("launch.requested", { sequence: 4 }),
      evt("supervisor.connected", { sequence: 5 }),
    ],
    provider: "codex",
  });
  assert.equal(view.status, "in_progress");
  assert.equal(view.failed, false);
  assert.equal(stateOf(view, "saving_agent"), "active");
  assert.equal(view.phases.filter((phase) => phase.state === "failed").length, 0);
});

test("stopping a ready (bound) agent reads as stopped, not launch cancelled (finding 3)", () => {
  const view = foldLaunchJourney({
    entry: entry({
      displayName: "SilverCanyon",
      desiredState: "stopped",
      observedState: "absent",
      agentSessionId: "agent_session_9",
      agentSessionBindingState: "historical",
      workspacePath: "/tmp/wt",
      providerPid: null,
    }),
  });
  assert.equal(view.stopped, true);
  assert.doesNotMatch(view.headline, /cancelled/i);
  assert.match(view.headline, /stopped/i);
});

test("cancelling a not-yet-bound launch still reads as launch cancelled (finding 3)", () => {
  const view = foldLaunchJourney({
    entry: entry({ desiredState: "stopped", observedState: "absent", agentSessionBindingState: "none" }),
  });
  assert.equal(view.stopped, true);
  assert.match(view.headline, /cancelled/i);
});

test("a terminal cancelled/stopped outcome leaves zero active steps and marks the boundary Cancelled (finding 4)", () => {
  const cancelled = foldLaunchJourney({
    events: [evt("launch.requested", { sequence: 1 }), evt("launch.cancelled", { sequence: 2 })],
    provider: "codex",
  });
  assert.equal(cancelled.phases.filter((phase) => phase.state === "active").length, 0);
  // The step that was in flight reads Cancelled, not the misleading "Waiting".
  assert.equal(stateOf(cancelled, "connecting_supervisor"), "cancelled");
  assert.equal(cancelled.phases.some((phase) => phase.state === "cancelled"), true);

  const stopped = foldLaunchJourney({
    entry: entry({ desiredState: "stopped", observedState: "absent", agentSessionBindingState: "none" }),
  });
  assert.equal(stopped.phases.filter((phase) => phase.state === "active").length, 0);
  assert.equal(stopped.phases.some((phase) => phase.state === "cancelled"), true);
});

test("a connected-then-cancelled launch keeps the connected step done (finding 4)", () => {
  const view = foldLaunchJourney({
    events: [
      evt("launch.requested", { sequence: 1 }),
      evt("supervisor.connected", { sequence: 2 }),
      evt("launch.cancelled", { sequence: 3 }),
    ],
    provider: "codex",
  });
  assert.equal(stateOf(view, "connecting_supervisor"), "done");
  assert.equal(stateOf(view, "saving_agent"), "cancelled");
  assert.equal(view.phases.filter((phase) => phase.state === "active").length, 0);
});

test("at most one step is in progress while launching", () => {
  const entries = [
    foldLaunchJourney({ requested: true, provider: "codex" }),
    foldLaunchJourney({ events: [evt("supervisor.connected")], provider: "codex" }),
    foldLaunchJourney({ entry: entry({ workspacePath: "/tmp/wt", providerPid: 7 }) }),
  ];
  for (const view of entries) {
    assert.ok(activeCount(view) <= 1, `expected <=1 active phase, got ${activeCount(view)}`);
  }
});
