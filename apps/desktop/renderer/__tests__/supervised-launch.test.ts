import assert from "node:assert/strict";
import test from "node:test";

import {
  supervisedLaunchProgress,
  supervisedLaunchProviderLabel,
} from "../src/domain/supervised-launch";
import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";

function entry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_1",
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
    workplaceLiveness: { state: "unknown", observedAt: null, detail: "Awaiting room registration." },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null },
    restartCount: 0,
    lastTerminal: null,
    activity: [],
    ...overrides,
  };
}

function stateOf(progress: ReturnType<typeof supervisedLaunchProgress>, id: string): string {
  return progress.phases.find((phase) => phase.id === id)!.state;
}

test("phase order is the five product phases", () => {
  const progress = supervisedLaunchProgress(entry());
  assert.deepEqual(
    progress.phases.map((phase) => phase.id),
    ["preparing_workspace", "starting_provider", "connecting_room", "registering_identity", "ready"],
  );
});

test("a just-created entry is preparing the workspace", () => {
  const progress = supervisedLaunchProgress(entry({ observedState: "starting", workspacePath: null }));
  assert.equal(progress.currentPhaseId, "preparing_workspace");
  assert.equal(stateOf(progress, "preparing_workspace"), "active");
  assert.equal(stateOf(progress, "starting_provider"), "pending");
  assert.equal(progress.ready, false);
  assert.equal(progress.failed, false);
  assert.equal(progress.joinHint, "The agent will join the room shortly.");
});

test("workspace provisioned advances to starting the provider", () => {
  const progress = supervisedLaunchProgress(entry({ workspacePath: "/tmp/wt", providerPid: null }));
  assert.equal(progress.currentPhaseId, "starting_provider");
  assert.equal(stateOf(progress, "preparing_workspace"), "done");
  assert.equal(stateOf(progress, "starting_provider"), "active");
});

test("provider child up but still starting is connecting to the room", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "starting",
  }));
  // observedState still "starting" => provider started, not yet connecting.
  assert.equal(progress.currentPhaseId, "connecting_room");
  assert.equal(stateOf(progress, "starting_provider"), "done");
  assert.equal(stateOf(progress, "connecting_room"), "active");
});

test("awaiting the exact bind (coordination_blocked) is registering identity, NOT a failure", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "coordination_blocked",
    agentSessionBindingState: "none",
  }));
  assert.equal(progress.failed, false, "coordination_blocked pre-bind must not read as failure");
  assert.equal(progress.currentPhaseId, "registering_identity");
  assert.equal(stateOf(progress, "connecting_room"), "done");
  assert.equal(stateOf(progress, "registering_identity"), "active");
  assert.equal(progress.joinHint, "The agent will join the room shortly.");
});

test("a bound, working, unblocked entry is ready and resolves the real name", () => {
  const progress = supervisedLaunchProgress(entry({
    displayName: "QuartzMeadow",
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "working",
    condition: "none",
    agentSessionId: "agent_session_422",
    agentSessionBindingState: "active",
  }));
  assert.equal(progress.ready, true);
  assert.equal(progress.failed, false);
  assert.equal(progress.currentPhaseId, "ready");
  assert.equal(progress.agentName, "QuartzMeadow");
  assert.equal(progress.joinHint, null);
  assert.ok(progress.phases.every((phase) => phase.state === "done"));
  assert.match(progress.headline, /QuartzMeadow/);
});

test("an idle bound entry is also ready", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "idle",
    agentSessionBindingState: "active",
  }));
  assert.equal(progress.ready, true);
});

test("a blocking auth condition fails the current phase with actionable detail", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "auth_blocked",
    lastError: "Codex CLI is not signed in.",
  }));
  assert.equal(progress.failed, true);
  assert.equal(progress.ready, false);
  assert.equal(stateOf(progress, progress.currentPhaseId), "failed");
  assert.equal(progress.failureDetail, "Codex CLI is not signed in.");
  assert.equal(progress.joinHint, null);
});

test("a blocking condition without lastError falls back to a condition message", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "budget_blocked",
    lastError: null,
  }));
  assert.equal(progress.failed, true);
  assert.match(progress.failureDetail ?? "", /budget|rate cap/i);
});

test("observedState failed is a failure even with condition none", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "failed",
    condition: "none",
    lastError: "provider crashed before MCP registration",
  }));
  assert.equal(progress.failed, true);
  assert.equal(stateOf(progress, progress.currentPhaseId), "failed");
});

test("a stopped launch is reported as stopped, not failed", () => {
  const progress = supervisedLaunchProgress(entry({
    desiredState: "stopped",
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "stopping",
  }));
  assert.equal(progress.stopped, true);
  assert.equal(progress.failed, false);
  assert.equal(progress.ready, false);
  assert.equal(progress.joinHint, null);
});

test("provider label is human-readable and provider-neutral", () => {
  assert.equal(supervisedLaunchProviderLabel("codex"), "Codex");
  assert.equal(supervisedLaunchProviderLabel("claude-code"), "Claude Code");
  assert.equal(supervisedLaunchProviderLabel("cursor"), "Cursor");
  assert.equal(supervisedLaunchProviderLabel("open-model"), "Open Model");
  assert.equal(supervisedLaunchProviderLabel("something-new"), "something-new");
  assert.equal(supervisedLaunchProgress(entry({ provider: "claude-code" })).providerLabel, "Claude Code");
});

test("the agent name is withheld until the launch is actually ready", () => {
  const progress = supervisedLaunchProgress(entry({
    displayName: "Codex supervised agent",
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "coordination_blocked",
  }));
  assert.equal(progress.agentName, null);
});
