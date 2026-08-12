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

test("a pid-less Cursor continuation is an established provider lane", () => {
  const progress = supervisedLaunchProgress(entry({
    provider: "cursor",
    workspacePath: "/tmp/wt",
    providerPid: null,
    providerContinuationId: "cursor-session-1",
    observedState: "idle",
  }));
  assert.equal(progress.currentPhaseId, "connecting_room");
  assert.equal(stateOf(progress, "starting_provider"), "done");
  assert.equal(stateOf(progress, "connecting_room"), "active");
});

test("native-working but unbound with no workplace evidence stays at Connecting, NOT a failure", () => {
  // P1: a provider that is "working" locally but has not reached the room (no
  // session id, workplace not reachable) must NOT be advanced to Registering.
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "working",
    condition: "none",
    agentSessionId: null,
    agentSessionBindingState: "none",
    workplaceLiveness: { state: "unknown", observedAt: null, detail: "Awaiting room registration." },
  }));
  assert.equal(progress.failed, false);
  assert.equal(progress.ready, false);
  assert.equal(progress.currentPhaseId, "connecting_room");
  assert.equal(stateOf(progress, "starting_provider"), "done");
  assert.equal(stateOf(progress, "connecting_room"), "active");
  assert.equal(progress.joinHint, "The agent will join the room shortly.");
});

test("real workplace/session evidence advances Connecting -> Registering (coordination_blocked pre-bind, not a failure)", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "coordination_blocked",
    agentSessionId: "agent_session_422",
    agentSessionBindingState: "none",
    workplaceLiveness: { state: "reachable", observedAt: "2026-07-17T00:00:02.000Z", detail: null },
  }));
  assert.equal(progress.failed, false, "coordination_blocked pre-bind must not read as failure");
  assert.equal(progress.currentPhaseId, "registering_identity");
  assert.equal(stateOf(progress, "connecting_room"), "done");
  assert.equal(stateOf(progress, "registering_identity"), "active");
  assert.equal(progress.joinHint, "The agent will join the room shortly.");
});

test("an unattached durable generation is an actionable recovery failure, not an endless join", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "coordination_blocked",
    lastError: "durable execution generation remains live without an attachable provider handle",
  }));

  assert.equal(progress.failed, true);
  assert.equal(progress.recoverableBlocked, true);
  assert.equal(progress.currentPhaseId, "connecting_room");
  assert.equal(stateOf(progress, "connecting_room"), "failed");
  assert.match(progress.failureDetail ?? "", /can't currently reconnect/i);
  assert.equal(progress.joinHint, null);
});

test("a pre-provider provisioning failure is retryable and never described as reconnecting", () => {
  const progress = supervisedLaunchProgress(entry({
    observedState: "failed",
    condition: "coordination_blocked",
    lastError: "convergence scheduler failure: revision was not found",
    workspacePath: null,
    workAttemptId: null,
    providerPid: null,
    providerContinuationId: null,
    executionGenerationId: null,
  }));

  assert.equal(progress.failed, true);
  assert.equal(progress.recoverableBlocked, false);
  assert.equal(progress.currentPhaseId, "preparing_workspace");
  assert.doesNotMatch(progress.headline, /reconnect/i);
  assert.doesNotMatch(progress.failureDetail ?? "", /reconnect/i);
  assert.match(progress.failureDetail ?? "", /prepare the private project area/i);
});

test("expected exact-bind coordination remains an in-progress registration", () => {
  const progress = supervisedLaunchProgress(entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "recovering",
    condition: "coordination_blocked",
    lastError: "resumed provider awaits exact worker wait evidence",
  }));

  assert.equal(progress.failed, false);
  assert.equal(progress.recoverableBlocked, false);
  assert.equal(progress.currentPhaseId, "connecting_room");
});

const readyEntry = (overrides = {}) => entry({
  displayName: "QuartzMeadow",
  workspacePath: "/tmp/wt",
  providerPid: 4242,
  observedState: "working",
  condition: "none",
  agentSessionId: "agent_session_422",
  agentSessionBindingState: "active",
  workplaceLiveness: { state: "reachable", observedAt: "2026-07-17T00:00:03.000Z", detail: null },
  ...overrides,
});

test("a bound, working, reachable, unblocked entry is ready and resolves the real name", () => {
  const progress = supervisedLaunchProgress(readyEntry());
  assert.equal(progress.ready, true);
  assert.equal(progress.failed, false);
  assert.equal(progress.currentPhaseId, "ready");
  assert.equal(progress.agentName, "QuartzMeadow");
  assert.equal(progress.joinHint, null);
  assert.ok(progress.phases.every((phase) => phase.state === "done"));
  assert.match(progress.headline, /QuartzMeadow/);
});

test("launch success projects a legacy entry-owned suffix out of its label", () => {
  const requestId = "6697e364-62d0-4027-b02d-ee71a8fbf579";
  const progress = supervisedLaunchProgress(readyEntry({
    id: `supervised_${requestId}`,
    displayName: `QuartzMeadow · ${requestId}`,
  }));

  assert.equal(progress.agentName, "QuartzMeadow");
  assert.equal(progress.headline, "QuartzMeadow is ready");
});

test("an idle bound reachable entry is also ready", () => {
  assert.equal(supervisedLaunchProgress(readyEntry({ observedState: "idle" })).ready, true);
});

test("a bound and reachable Cursor lane remains ready while idle without a process", () => {
  const progress = supervisedLaunchProgress(readyEntry({
    provider: "cursor",
    providerPid: null,
    providerContinuationId: "cursor-session-1",
    observedState: "idle",
  }));
  assert.equal(progress.ready, true);
  assert.equal(progress.currentPhaseId, "ready");
});

test("a bound entry whose workplace is not yet reachable stays Registering (Ready must never show)", () => {
  const progress = supervisedLaunchProgress(readyEntry({
    workplaceLiveness: { state: "unknown", observedAt: null, detail: "Awaiting room registration." },
  }));
  assert.equal(progress.ready, false);
  // Bound but unreachable: Registering ACTIVE, Ready PENDING — not a done/Ready state.
  assert.equal(progress.currentPhaseId, "registering_identity");
  assert.equal(stateOf(progress, "connecting_room"), "done");
  assert.equal(stateOf(progress, "registering_identity"), "active");
  assert.equal(stateOf(progress, "ready"), "pending");
});

test("P1: a working+unbound entry advances to ready in the SAME derivation once it binds and its workplace is reachable", () => {
  const unbound = entry({
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "working",
    agentSessionId: null,
    agentSessionBindingState: "none",
    workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
  });
  assert.equal(supervisedLaunchProgress(unbound).currentPhaseId, "connecting_room");
  assert.equal(supervisedLaunchProgress(unbound).ready, false);

  const bound = entry({
    ...unbound,
    agentSessionId: "agent_session_500",
    agentSessionBindingState: "active",
    workplaceLiveness: { state: "reachable", observedAt: "2026-07-17T00:00:04.000Z", detail: null },
  });
  assert.equal(supervisedLaunchProgress(bound).ready, true);
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

test("stop intent stays nonterminal until the daemon observes the provider stopped", () => {
  const progress = supervisedLaunchProgress(entry({
    desiredState: "stopped",
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    observedState: "stopping",
  }));
  assert.equal(progress.stopping, true);
  assert.equal(progress.stopFailed, false);
  assert.equal(progress.stopped, false);
  assert.equal(progress.failed, false);
  assert.equal(progress.ready, false);
  assert.equal(progress.joinHint, null);

  const stopped = supervisedLaunchProgress(entry({
    desiredState: "stopped",
    observedState: "stopped",
  }));
  assert.equal(stopped.stopping, false);
  assert.equal(stopped.stopFailed, false);
  assert.equal(stopped.stopped, true);
});

test("a failed stop is actionable instead of remaining in Cancelling", () => {
  const progress = supervisedLaunchProgress(entry({
    desiredState: "stopped",
    observedState: "failed",
    workspacePath: "/tmp/wt",
    providerPid: 4242,
    lastError: "provider did not exit",
  }));

  assert.equal(progress.stopping, false);
  assert.equal(progress.stopFailed, true);
  assert.equal(progress.failed, true);
  assert.match(progress.headline, /Couldn't stop the Codex agent/);
  assert.equal(progress.failureDetail, "provider did not exit");
  assert.equal(stateOf(progress, progress.currentPhaseId), "failed");
});

test("an actionable condition after stop intent is a failed stop", () => {
  const progress = supervisedLaunchProgress(entry({
    desiredState: "stopped",
    observedState: "recovering",
    condition: "security_blocked",
    lastError: "policy prevented termination",
  }));

  assert.equal(progress.stopping, false);
  assert.equal(progress.stopFailed, true);
  assert.equal(progress.failed, true);
  assert.equal(progress.failureDetail, "policy prevented termination");
});

test("stop intent suppresses stale ready but surfaces an actionable stop condition", () => {
  const formerlyReady = supervisedLaunchProgress(readyEntry({
    desiredState: "stopped",
    observedState: "working",
  }));
  assert.equal(formerlyReady.stopping, true);
  assert.equal(formerlyReady.ready, false);
  assert.equal(formerlyReady.failed, false);

  const formerlyBlocked = supervisedLaunchProgress(entry({
    desiredState: "stopped",
    observedState: "stopping",
    condition: "coordination_blocked",
    lastError: "durable execution generation remains live without an attachable provider handle",
  }));
  assert.equal(formerlyBlocked.stopping, false);
  assert.equal(formerlyBlocked.stopFailed, true);
  assert.equal(formerlyBlocked.recoverableBlocked, false);
  assert.equal(formerlyBlocked.failed, true);
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
