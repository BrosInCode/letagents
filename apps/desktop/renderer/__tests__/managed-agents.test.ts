import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type {
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopGitRoomInfo,
  DesktopManagedAgentPermissionProfile,
  DesktopParticipantSummary,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";
import { supervisedPermissionProfilesForProvider } from "../../daemon/supervised-permission-profiles";
import { STATE_WATCH_RECEIPT_TIMELINE_PHASES } from "../../daemon/state-watch-projection";
import {
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  agentAuthCommand,
  branchScopedGitRoomExpectedBranch,
  agentProviderNeedsDesktopRepo,
  externalMcpProviderJoinPrompt,
  externalMcpProviderInstruction,
  hasSupervisedRuntime,
  humanFacingSupervisorActivitySummary,
  isAgentSetupConfirmationActive,
  isExternalMcpProviderReady,
  isHumanVisibleSupervisorActivity,
  isBranchScopedGitRoomIdentifier,
  managedAgentRepoStatusForRoom,
  managedAgentRootPathForRoom,
  managedAgentRoomBranchMismatch,
  managedAgentRoomBranchMismatchLabel,
  managedAgentPermissionProfileSelectionForProvider,
  managedAgentPermissionProfileStatusLabel,
  managedAgentPermissionProfileSummary,
  supervisedCursorPermissionProfilePresentation,
  supervisedPermissionProfileLimits,
  supervisedPermissionProfilePresentation,
  supervisedProviderLaunchPolicy,
  autoReviewNotice,
  mergeDesktopSupervisorAgentParticipants,
  mergeReachableAgentPresenceParticipants,
  matchingManagedAgentWorktrees,
  matchingManagedAgentWorktreesForBranch,
  normalizeManagedAgentRoomIdentifier,
  preferredManagedAgentRepoRootPath,
  shouldShowManagedModelSelector,
  supervisedAgentWorkIndicators,
  visibleDesktopAgentProviders,
} from "../src/domain/managed-agents";
import {
  isSupervisedRuntimeSettled,
  refreshSupervisedRuntimeEntry,
  stopSupervisedProviderLane,
  supervisedRecoveryDetail,
  supervisedRuntimeCardLabel,
} from "../src/domain/supervised-recovery";
import { isMentionableRoomParticipant, roomMentionCandidates } from "../src/domain/participants";

function provider(
  overrides: Partial<DesktopAgentProvider> = {},
): DesktopAgentProvider {
  return {
    id: "codex",
    name: "Codex",
    description: "Codex",
    capabilities: ["external_mcp", "supervised_runtime"],
    runtimeCommand: "codex",
    mcpTargetId: "codex",
    permissionProfiles: [{
      id: "full_access",
      label: "Full access",
      description: "Trusted local access.",
      status: "available",
      risk: "high",
      detail: null,
      isDefault: true,
    }],
    defaultPermissionProfileId: "full_access",
    ...overrides,
  };
}

function preflight(
  overrides: Partial<DesktopAgentProviderPreflight> = {},
): DesktopAgentProviderPreflight {
  return {
    providerId: "codex",
    status: "ready",
    canStart: true,
    message: "Ready",
    detail: null,
    nextAction: null,
    version: "codex 1.0.0",
    mcpStatus: "installed",
    ...overrides,
  };
}

function supervisorEntry(
  overrides: Partial<DesktopSupervisorManifestEntry> = {},
): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_1",
    roomId: "room_1",
    displayName: "Codex supervised agent",
    provider: "codex",
    model: null,
    charter: "Work from the board.",
    desiredState: "running",
    observedState: "recovering",
    condition: "coordination_blocked",
    lastError: "startup failed before MCP registration",
    permissionProfileId: "full_access",
    createdBy: "desktop",
    createdAt: "2026-07-15T12:00:00.000Z",
    workspacePath: "/tmp/repo",
    workAttemptId: "attempt_1",
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

function branchGitRoom(branch = "feature/codex-work"): DesktopGitRoomInfo {
  return {
    provider: "git",
    host: "local",
    repository: {
      id: null,
      fullName: "repo",
      owner: "",
      name: "repo",
    },
    ref: {
      type: "branch",
      name: branch,
      defaultBranch: "main",
      baseRef: null,
      headRef: null,
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  };
}

function participant(
  overrides: Partial<DesktopParticipantSummary> = {},
): DesktopParticipantSummary {
  return {
    participantKey: "agent:existing",
    kind: "agent",
    displayName: "MapleRidge",
    actorLabel: "MapleRidge",
    agentKey: "desktop/codex/maple",
    githubLogin: null,
    ownerLabel: "Local desktop",
    ideLabel: "Codex",
    hiddenAt: null,
    activityState: "away",
    lastSeenAt: "2026-06-14T12:00:00.000Z",
    lastRoomActivityAt: "2026-06-14T12:00:00.000Z",
    lastLiveHeartbeatAt: null,
    sourceFlags: ["messages"],
    ...overrides,
  };
}

function presence(
  overrides: Partial<DesktopAgentPresence> = {},
): DesktopAgentPresence {
  return {
    roomId: "room_1",
    actorLabel: "MapleRidge",
    agentKey: "desktop/codex/maple",
    agentInstanceId: null,
    agentSessionId: "agent_1",
    sessionKind: "worker",
    runtime: "codex",
    displayName: "MapleRidge",
    ownerLabel: "Local desktop",
    ideLabel: "Codex",
    repoBranch: null,
    status: "idle",
    statusText: null,
    lastHeartbeatAt: "2026-06-14T11:59:00.000Z",
    freshness: "stale",
    activityState: "offline",
    sourceFlags: ["presence"],
    livenessObservation: null,
    ...overrides,
  };
}

test("managed model selector only shows for supervised providers", () => {
  assert.equal(shouldShowManagedModelSelector(provider()), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "supervised_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp", "supervised_runtime"],
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
  })), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    id: "open-model",
    name: "Open Model",
    capabilities: ["supervised_runtime"],
    runtimeCommand: "codex",
    mcpTargetId: "open-model",
  })), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    capabilities: ["external_mcp"],
  })), false);
});

test("durable supervision is advertised only by providers with validated native evidence", () => {
  assert.equal(hasSupervisedRuntime(provider({
    capabilities: ["external_mcp", "supervised_runtime"],
  })), true);
  assert.equal(hasSupervisedRuntime(provider({
    id: "open-model",
    name: "Open Model",
    capabilities: ["reasoning_stream"],
    runtimeCommand: "codex",
    mcpTargetId: "open-model",
  })), false);
  assert.equal(hasSupervisedRuntime(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp"],
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
  })), false);
});

test("supervised recovery keeps an honest fallback and surfaces the latest durable notice", async () => {
  const lookup = await refreshSupervisedRuntimeEntry({
    async listAgents() {
      throw new Error("daemon unavailable");
    },
  }, "room_1", "supervised_request_alpha");
  assert.equal(lookup.entry, null);
  assert.match(lookup.error || "", /Could not refresh the supervised runtime/);
  assert.equal(supervisedRecoveryDetail(supervisorEntry({
    lastError: null,
    activity: [{
      observedAt: "2026-07-15T12:00:00.000Z",
      sequence: 9,
      provider: "codex",
      kind: "reconcile",
      method: "restart_fresh",
      summary: "provider restart failed before MCP registration",
      status: "blocked",
      payload: null,
      payloadTruncated: false,
      payloadRedacted: false,
      durablePayloadRef: null,
    }],
  })), "provider restart failed before MCP registration");
});

test("the chat work indicator reads the same turn start from a state-watch receipt timeline", () => {
  const timeline = [
    { sequence: 1, phase: "received" as const, observedAt: "2026-07-15T18:00:00.000Z", detail: null },
    { sequence: 2, phase: "turn_started" as const, observedAt: "2026-07-15T18:00:00.200Z", detail: null },
    { sequence: 3, phase: "retry_scheduled" as const, observedAt: "2026-07-15T18:00:00.300Z", detail: null },
    { sequence: 4, phase: "turn_started" as const, observedAt: "2026-07-15T18:00:00.500Z", detail: null },
    { sequence: 5, phase: "turn_finished" as const, observedAt: "2026-07-15T18:00:00.900Z", detail: null },
  ];
  const working = supervisorEntry({
    id: "supervised_working", agentKey: "codex:dawn-harbor", agentSessionId: "agent_session_403",
    agentSessionBindingState: "active", observedState: "working", condition: "none",
    roomAgentState: {
      connection: { state: "connected", observedAt: "2026-07-15T18:00:00.000Z", detail: null },
      ingress: { state: "observing", observedAt: "2026-07-15T18:00:00.000Z", detail: null },
      inbox: { state: "queued", pendingCount: 1, blockedByMessageId: null, detail: null },
      turn: { state: "responding", inboxItemId: "inbox_1", sourceMessageId: "message_source", providerTurnId: "turn_1", detail: null },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [{ inboxItemId: "inbox_1", sourceMessageId: "message_source", state: "awaiting_result", attemptCount: 2,
      providerTurnId: "turn_1", blockedByMessageId: null, error: null, updatedAt: "2026-07-15T18:00:00.900Z", timeline }],
    nativeLiveness: { state: "active", observedAt: "2026-07-15T18:00:01.000Z", detail: "tool running" },
  });
  const trimmed = { ...working, deliveryReceipts: working.deliveryReceipts!.map((receipt) => ({
    ...receipt, timeline: receipt.timeline.filter((event) => STATE_WATCH_RECEIPT_TIMELINE_PHASES.has(event.phase)) })) };
  const people = [presence({ agentSessionId: "agent_session_403", actorLabel: "DawnHarbor", displayName: "DawnHarbor" })];
  const full = supervisedAgentWorkIndicators([working], people, "room_1");
  assert.equal(full[0]?.startedAt, "2026-07-15T18:00:00.500Z");
  assert.deepEqual(supervisedAgentWorkIndicators([trimmed], people, "room_1"), full);
});

test("supervisor native activity drives the chat work indicator for the bound room identity", () => {
  const working = supervisorEntry({
    id: "supervised_working",
    agentKey: "codex:dawn-harbor",
    agentSessionId: "agent_session_403",
    agentSessionBindingState: "active",
    observedState: "working",
    condition: "none",
    roomAgentState: {
      connection: { state: "connected", observedAt: "2026-07-15T18:00:00.000Z", detail: null },
      ingress: { state: "observing", observedAt: "2026-07-15T18:00:00.000Z", detail: null },
      inbox: { state: "queued", pendingCount: 1, blockedByMessageId: null, detail: null },
      turn: {
        state: "responding",
        inboxItemId: "inbox_1",
        sourceMessageId: "message_source",
        providerTurnId: "turn_1",
        detail: null,
      },
      task: { state: "none", taskId: null, title: null },
    },
    deliveryReceipts: [{
      inboxItemId: "inbox_1",
      sourceMessageId: "message_source",
      state: "awaiting_result",
      attemptCount: 1,
      providerTurnId: "turn_1",
      blockedByMessageId: null,
      error: null,
      updatedAt: "2026-07-15T18:00:00.500Z",
      timeline: [{ sequence: 1, phase: "turn_started", observedAt: "2026-07-15T18:00:00.500Z", detail: null }],
    }],
    nativeLiveness: { state: "active", observedAt: "2026-07-15T18:00:01.000Z", detail: "tool running" },
    activity: [{
      observedAt: "2026-07-15T18:00:01.000Z",
      sequence: 7,
      provider: "codex",
      kind: "tool_lifecycle",
      method: "item/toolCall/started",
      summary: "Inspecting the workspace",
      status: "working",
      payload: null,
      payloadTruncated: false,
      payloadRedacted: true,
      durablePayloadRef: null,
    }],
  });
  assert.deepEqual(
    supervisedAgentWorkIndicators([
      working,
      {
        ...working,
        id: "supervised_disconnected",
        agentSessionId: "agent_session_404",
        nativeLiveness: { state: "stale", observedAt: working.nativeLiveness.observedAt, detail: null },
        roomAgentState: {
          ...working.roomAgentState!,
          connection: { state: "disconnected", observedAt: "2026-07-15T18:00:02.000Z", detail: "Provider exited" },
        },
      },
    ], [presence({ agentSessionId: "agent_session_403", actorLabel: "DawnHarbor", displayName: "DawnHarbor" })], "room_1"),
    [{
      id: "supervised_working",
      displayName: "DawnHarbor",
      summary: "Using a tool",
      startedAt: "2026-07-15T18:00:00.500Z",
      agentSessionId: "agent_session_403",
      agentKey: "codex:dawn-harbor",
      sourceMessageId: "message_source",
    }],
  );
  assert.deepEqual(
    supervisedAgentWorkIndicators([
      { ...working, agentSessionBindingState: "historical" },
    ], [presence({ agentSessionId: "agent_session_403", actorLabel: "DawnHarbor", displayName: "DawnHarbor" })], "room_1"),
    [],
    "a historical control identity never claims that an unbound worker is typing or working",
  );
  assert.deepEqual(
    supervisedAgentWorkIndicators([{
      ...working,
      observedState: "idle",
      nativeLiveness: { state: "idle", observedAt: "2026-07-15T18:00:02.000Z", detail: "claude-code · assistant" },
      activity: [...working.activity, {
        ...working.activity[0]!,
        observedAt: "2026-07-15T18:00:02.000Z",
        sequence: 8,
        summary: "claude-code · assistant",
        status: "idle",
      }],
    }], [presence({ agentSessionId: "agent_session_403", actorLabel: "DawnHarbor", displayName: "DawnHarbor" })], "room_1"),
    [{
      id: "supervised_working",
      displayName: "DawnHarbor",
      summary: "Using a tool",
      startedAt: "2026-07-15T18:00:00.500Z",
      agentSessionId: "agent_session_403",
      agentKey: "codex:dawn-harbor",
      sourceMessageId: "message_source",
    }],
    "an internal item completing cannot hide an active room turn",
  );
  const settledReceipt = { ...working.deliveryReceipts![0]!, state: "acknowledged_no_reply" as const };
  assert.deepEqual(supervisedAgentWorkIndicators([
    { ...working, deliveryReceipts: [settledReceipt] },
  ], [], "room_1"), [], "a settled exact turn cannot still claim to be writing while its active projection catches up");
  for (const mismatch of [
    { inboxItemId: "previous_inbox" },
    { providerTurnId: "previous_turn" },
    { sourceMessageId: "previous_message" },
  ]) {
    assert.equal(supervisedAgentWorkIndicators([
      { ...working, deliveryReceipts: [{ ...settledReceipt, ...mismatch }] },
    ], [], "room_1").length, 1, "a completed different turn cannot hide current work");
  }
  assert.deepEqual(
    supervisedAgentWorkIndicators([{
      ...working,
      observedState: "idle",
      nativeLiveness: { state: "idle", observedAt: "2026-07-15T18:00:03.000Z", detail: "codex · turn/completed" },
      roomAgentState: {
        ...working.roomAgentState!,
        inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
        turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      },
    }], [presence({ agentSessionId: "agent_session_403", actorLabel: "DawnHarbor", displayName: "DawnHarbor" })], "room_1"),
    [],
    "the durable room turn completing removes the indicator",
  );
});

test("provider activity becomes product language instead of a protocol trace", () => {
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "item_lifecycle", method: "item/started" }), true);
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "item_lifecycle", method: "item/completed" }), true);
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "item_lifecycle", method: "thread/read" }), false);
  assert.equal(isHumanVisibleSupervisorActivity({ kind: "tool_lifecycle", method: "item/toolCall/started" }), true);
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "text_delta", method: "item/agentMessage/delta", summary: "codex · item/agentMessage/delta" }), "Writing a response");
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "item_lifecycle", method: "item/reasoning/summaryTextDelta", summary: "codex · item/reasoning/summaryTextDelta" }), "Thinking through the request");
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "tool_lifecycle", method: "item/mcpToolCall/progress", summary: "codex · item/mcpToolCall/progress" }), "Using a tool");
  // Codex's own review asks nobody, so it must not read as a request waiting on the host.
  for (const method of ["item/autoApprovalReview/started", "item/autoApprovalReview/completed", "guardianWarning"]) {
    assert.equal(humanFacingSupervisorActivitySummary({ kind: "approval", method, summary: `codex · ${method}` }), "Checking an action");
  }
  assert.equal(humanFacingSupervisorActivitySummary({ kind: "approval", method: "item/permissions/requestApproval", summary: "codex" }), "Waiting for approval");
});

test("a successful first supervised Start has an immediate non-recovery runtime label", () => {
  assert.equal(supervisedRuntimeCardLabel(supervisorEntry({
    observedState: "absent",
    condition: "none",
  })), "Supervised runtime is starting");
  assert.equal(supervisedRuntimeCardLabel(supervisorEntry({
    observedState: "failed",
    condition: "none",
  })), "Supervised runtime needs recovery");
});

test("a first supervised Start refreshes its exact durable entry to blocked or healthy without another create", async () => {
  const starting = supervisorEntry({
    id: "first_start",
    observedState: "absent",
    condition: "none",
  });
  const blocked = {
    ...starting,
    observedState: "paused" as const,
    condition: "coordination_blocked" as const,
    lastError: "provider launch failed before MCP registration",
  };
  const healthy = {
    ...starting,
    observedState: "idle" as const,
    condition: "none" as const,
    lastError: null,
  };
  let createCalls = 0;
  const snapshots = [[blocked], [healthy]];
  const client = {
    async createAgent() {
      createCalls += 1;
      return starting;
    },
    async listAgents() {
      return snapshots.shift() || [healthy];
    },
  };

  const created = await client.createAgent();
  assert.equal(createCalls, 1);
  assert.equal(supervisedRuntimeCardLabel(created), "Supervised runtime is starting");

  const afterBlocked = await refreshSupervisedRuntimeEntry(client, "room_1", created.id);
  assert.equal(afterBlocked.entry?.id, created.id);
  assert.equal(afterBlocked.entry?.condition, "coordination_blocked");
  assert.equal(supervisedRuntimeCardLabel(afterBlocked.entry!), "Supervised runtime needs recovery");
  assert.equal(isSupervisedRuntimeSettled(afterBlocked.entry!), true);

  const afterHealthy = await refreshSupervisedRuntimeEntry(client, "room_1", created.id);
  assert.equal(afterHealthy.entry?.id, created.id);
  assert.equal(afterHealthy.entry?.observedState, "idle");
  assert.equal(supervisedRuntimeCardLabel(afterHealthy.entry!), "Supervised runtime is ready");
  assert.equal(isSupervisedRuntimeSettled(afterHealthy.entry!), true);
  assert.equal(createCalls, 1, "refreshing a returned entry must never issue a second create");
});

test("preferredManagedAgentRepoRootPath defaults local agents to the main checkout", () => {
  assert.equal(preferredManagedAgentRepoRootPath({
    rootPath: "/repo-feature-worktree",
    mainRootPath: "/repo-main-checkout",
    defaultBranch: "main",
    worktrees: [],
  }), "/repo-main-checkout");
  assert.equal(preferredManagedAgentRepoRootPath({
    rootPath: "/repo-feature-worktree",
    mainRootPath: null,
    defaultBranch: "main",
    worktrees: [],
  }), "/repo-feature-worktree");
  assert.equal(preferredManagedAgentRepoRootPath({
    rootPath: " ",
    mainRootPath: " ",
    defaultBranch: "main",
    worktrees: [],
  }), null);
});

test("preferredManagedAgentRepoRootPath picks matching worktrees for branch-scoped rooms", () => {
  const repoStatus = {
    rootPath: "/repo-main-checkout",
    mainRootPath: "/repo-main-checkout",
    defaultBranch: "main",
    worktrees: [
      {
        path: "/repo-main-checkout",
        branch: "main",
        head: "1111111",
        isCurrent: true,
        isMain: true,
      },
      {
        path: "/repo-feature-worktree",
        branch: "feature/codex-work",
        head: "2222222",
        isCurrent: false,
        isMain: false,
      },
    ],
  };

  assert.equal(
    branchScopedGitRoomExpectedBranch(branchGitRoom("feature/codex-work"), repoStatus),
    "feature/codex-work",
  );
  assert.equal(
    preferredManagedAgentRepoRootPath(repoStatus, branchGitRoom("feature/codex-work")),
    "/repo-feature-worktree",
  );
  assert.deepEqual(
    matchingManagedAgentWorktrees(repoStatus, branchGitRoom("feature/codex-work")).map((worktree) => worktree.path),
    ["/repo-feature-worktree"],
  );
  assert.deepEqual(
    matchingManagedAgentWorktreesForBranch(repoStatus, "feature/codex-work").map((worktree) => worktree.path),
    ["/repo-feature-worktree"],
  );
  assert.equal(
    preferredManagedAgentRepoRootPath(repoStatus, branchGitRoom("feature/missing")),
    "/repo-main-checkout",
  );
  assert.equal(
    branchScopedGitRoomExpectedBranch(branchGitRoom("main"), repoStatus),
    null,
  );
  assert.equal(
    preferredManagedAgentRepoRootPath(null, branchGitRoom("feature/codex-work")),
    null,
  );
});

test("managedAgentRepoStatusForRoom requires verified repo identity for branch rooms", () => {
  const repoStatus = {
    rootPath: "/repo-main-checkout",
  };
  const branchRoomIdentifier = "git-room:local:1234567890abcdef:branch:ZmVhdHVyZS9jb2RleC13b3Jr";

  assert.equal(isBranchScopedGitRoomIdentifier(branchRoomIdentifier), true);
  assert.equal(
    managedAgentRepoStatusForRoom(repoStatus, {
      identifier: branchRoomIdentifier,
      gitRoom: null,
    }, true),
    null,
  );
  assert.equal(
    managedAgentRepoStatusForRoom(repoStatus, {
      identifier: "ad-hoc-room",
      gitRoom: null,
    }, false),
    repoStatus,
  );
  assert.equal(
    managedAgentRepoStatusForRoom(repoStatus, {
      identifier: "github.com/BrosInCode/letagents",
      gitRoom: branchGitRoom("feature/codex-work"),
    }, false),
    null,
  );
  assert.equal(
    managedAgentRepoStatusForRoom(repoStatus, {
      identifier: "github.com/BrosInCode/letagents",
      gitRoom: branchGitRoom("feature/codex-work"),
    }, true),
    repoStatus,
  );
});

test("managedAgentRootPathForRoom never falls back to HOME", () => {
  // Regression (task_60): a repo-backed focus room whose durable root was lost
  // (an account/app-agent reopen wiped it) must resolve to null so Add Agent
  // requires an explicit repo — never HOME. HOME is not a Git repo and the daemon
  // convergence blocks on `git -C <home> remote get-url origin`.
  assert.equal(
    managedAgentRootPathForRoom({
      room: { gitRoom: branchGitRoom("feature/codex-work") },
      repoStatus: null,
      gitRoomMatchesActiveRepo: false,
      durableProjectRootPath: null,
    }),
    null,
  );
  // A durable project root still keeps a focus room attached when the live probe
  // is absent.
  assert.equal(
    managedAgentRootPathForRoom({
      room: { gitRoom: null },
      repoStatus: null,
      gitRoomMatchesActiveRepo: false,
      durableProjectRootPath: "/Users/emmy/Projects/letagents",
    }),
    "/Users/emmy/Projects/letagents",
  );
  // A room with no project context at all is genuinely repo-less: it resolves to
  // null so the daemon provisions a private, empty scratch workspace — the agent
  // is NEVER pointed at HOME (which is not a Git repo and would leak the whole
  // home directory into the agent's reach).
  assert.equal(
    managedAgentRootPathForRoom({
      room: { gitRoom: null },
      repoStatus: null,
      gitRoomMatchesActiveRepo: false,
      durableProjectRootPath: null,
    }),
    null,
  );
});

test("isExternalMcpProviderReady distinguishes bridge-only providers from desktop-supervised providers", () => {
  assert.equal(isExternalMcpProviderReady(provider(), preflight()), false);
  assert.equal(isExternalMcpProviderReady(provider({
    id: "antigravity",
    name: "Antigravity",
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "antigravity",
  }), preflight({
    providerId: "antigravity",
    canStart: false,
  })), true);
  assert.equal(isExternalMcpProviderReady(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "cursor",
  }), preflight({
    providerId: "cursor",
    status: "bridge_required",
    mcpStatus: "not_installed",
  })), false);
});

test("visibleDesktopAgentProviders excludes Antigravity from Add Agent choices", () => {
  const providers = visibleDesktopAgentProviders([
    provider({
      id: "claude-code",
      name: "Claude Code",
      mcpTargetId: "claude-code",
    }),
    provider({
      id: "antigravity",
      name: "Antigravity",
      capabilities: ["external_mcp"],
      runtimeCommand: null,
      mcpTargetId: "antigravity",
    }),
    provider({
      id: "codex",
      name: "Codex",
      mcpTargetId: "codex",
    }),
  ]);

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["claude-code", "codex"],
  );
});

test("agentProviderNeedsDesktopRepo only requires a repo for desktop-supervised providers", () => {
  assert.equal(agentProviderNeedsDesktopRepo(provider()), true);
  assert.equal(agentProviderNeedsDesktopRepo(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "supervised_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), true);
  assert.equal(agentProviderNeedsDesktopRepo(provider({
    capabilities: ["external_mcp"],
  })), false);
});

test("agentAuthCommand exposes provider sign-in commands for managed runtimes", () => {
  assert.equal(agentAuthCommand(provider()), "codex login --device-auth");
  assert.equal(agentAuthCommand(provider({
    runtimeCommand: "/usr/local/bin/codex",
  })), "/usr/local/bin/codex login --device-auth");
  assert.equal(agentAuthCommand(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "supervised_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), "claude auth login");
});

test("externalMcpProviderInstruction does not imply the desktop starts bridge-only agents", () => {
  const externalProvider = provider({
      id: "antigravity",
      name: "Antigravity",
      capabilities: ["external_mcp"],
      runtimeCommand: null,
      mcpTargetId: "antigravity",
  });
  assert.equal(
    externalMcpProviderInstruction(externalProvider),
    "Open Antigravity, then ask it to join this room through the installed LetAgents connection.",
  );
  const repoPrompt = externalMcpProviderJoinPrompt(externalProvider, "github.com/BrosInCode/letagents");
  assert.match(repoPrompt, /Call join_room with \{"name":"github\.com\/BrosInCode\/letagents","session_mode":"current"\}\./);
  assert.match(repoPrompt, /Examples: MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor/);
  assert.match(repoPrompt, /Call set_agent_name with \{"name":"<your agent name>"\} before posting status or registering/);
  assert.match(repoPrompt, /Call register_agent_session with \{"session_kind":"worker","runtime":"antigravity","display_name":"<your agent name>"\}/);
  assert.match(repoPrompt, /Do not continue into the room loop until register_agent_session succeeds/);
  assert.match(repoPrompt, /Call post_status with \{"agent_session_id":"<returned agent_session_id>","status":"available in the room"\}/);
  assert.match(repoPrompt, /Call read_messages once, then call get_board once/);
  assert.match(repoPrompt, /Do not claim unassigned tasks on your own/);
  assert.doesNotMatch(repoPrompt, /claim it with claim_task/);
  assert.match(repoPrompt, /wait_for_messages with \{"agent_session_id":"<returned agent_session_id>","after_message_id":"<latest seen message id>","timeout":30000\} in a loop/);
  assert.match(repoPrompt, /send_message or send_thread_message with the same agent_session_id/);

  const repoAwarePrompt = externalMcpProviderJoinPrompt(
    externalProvider,
    "github.com/BrosInCode/letagents",
    "/tmp/repo",
  );
  assert.match(
    repoAwarePrompt,
    /Call register_agent_session with \{"session_kind":"worker","runtime":"antigravity","display_name":"<your agent name>","cwd":"\/tmp\/repo"\}/,
  );
  assert.match(repoPrompt, /empty wait result just means continue waiting/);
  assert.match(repoPrompt, /Do not call yourself Antigravity, Antigravity 1, Antigravity 2, or use any numbered provider label/);

  assert.match(
    externalMcpProviderJoinPrompt(externalProvider, "ABCD-1234"),
    /Call join_code with \{"code":"ABCD-1234","session_mode":"current"\}\./,
  );
  assert.match(
    externalMcpProviderJoinPrompt(externalProvider, " abcd-1234 "),
    /Call join_code with \{"code":"ABCD-1234","session_mode":"current"\}\./,
  );
  assert.match(
    externalMcpProviderJoinPrompt(externalProvider, 'github.com/BrosInCode/letagents "staging"'),
    /Call join_room with \{"name":"github\.com\/BrosInCode\/letagents \\"staging\\"","session_mode":"current"\}\./,
  );
});

test("agent setup confirmation is scoped to the selected provider and action", () => {
  const confirmation = {
    providerId: "codex",
    action: "install_runtime" as const,
  };

  assert.equal(isAgentSetupConfirmationActive(confirmation, "codex", "install_runtime"), true);
  assert.equal(isAgentSetupConfirmationActive(confirmation, "codex", "install_mcp_bridge"), false);
  assert.equal(isAgentSetupConfirmationActive(confirmation, "antigravity", "install_runtime"), false);
  assert.equal(isAgentSetupConfirmationActive(null, "codex", "install_runtime"), false);
});

test("agent setup action labels and confirmation copy are provider-aware", () => {
  const openModel = provider({
    id: "open-model",
    name: "Open Model",
    capabilities: ["supervised_runtime", "installable_runtime"],
    runtimeCommand: "opencode",
    mcpTargetId: null,
  });
  assert.equal(
    agentSetupActionButtonLabel("install_runtime", openModel, false, false),
    "Install Open Model",
  );
  assert.equal(
    agentSetupActionButtonLabel("install_runtime", openModel, true, false),
    "Confirm install Open Model",
  );
  assert.equal(
    agentSetupActionButtonLabel("install_mcp_bridge", provider(), true, false),
    "Confirm connection install",
  );
  assert.equal(
    agentSetupActionButtonLabel("install_runtime", openModel, true, true),
    "Installing...",
  );
  assert.equal(
    agentSetupConfirmationMessage("install_runtime", openModel),
    "LetAgents will install its managed Open Model execution engine on this machine after confirmation. External provider CLIs remain user-managed.",
  );
  assert.equal(
    agentSetupConfirmationMessage("install_mcp_bridge", provider({
      id: "antigravity",
      name: "Antigravity",
      capabilities: ["external_mcp"],
      runtimeCommand: null,
      mcpTargetId: "antigravity",
    })),
    "LetAgents will update Antigravity's agent app configuration to add the LetAgents connection after confirmation.",
  );
});

test("managedAgentRoomBranchMismatch only flags branch-scoped room conflicts", () => {
  const defaultBranchGitRoom = branchGitRoom("main");
  defaultBranchGitRoom.ref.type = "default_branch";

  assert.deepEqual(
    managedAgentRoomBranchMismatch(
      { repoBranch: "main" },
      branchGitRoom("feature/codex-work"),
    ),
    { expectedBranch: "feature/codex-work", actualBranch: "main" },
  );
  assert.equal(
    managedAgentRoomBranchMismatchLabel(
      { repoBranch: "main" },
      branchGitRoom("feature/codex-work"),
    ),
    "Expected feature/codex-work; agent is on main",
  );
  assert.equal(
    managedAgentRoomBranchMismatch(
      { repoBranch: "feature/codex-work" },
      branchGitRoom("feature/codex-work"),
    ),
    null,
  );
  assert.equal(
    managedAgentRoomBranchMismatch(
      { repoBranch: "feature/codex-work" },
      defaultBranchGitRoom,
    ),
    null,
  );
  assert.equal(
    managedAgentRoomBranchMismatch(
      { repoBranch: "feature/codex-work" },
      branchGitRoom("main"),
    ),
    null,
  );
});

test("managed permission profile helpers present available and gated modes", () => {
  assert.equal(managedAgentPermissionProfileStatusLabel("available"), "Available");
  assert.equal(managedAgentPermissionProfileStatusLabel("gated"), "Not available yet");
  assert.equal(managedAgentPermissionProfileSummary({
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Waiting on sandbox tests.",
    status: "gated",
    risk: "medium",
    detail: "Needs config isolation.",
    isDefault: false,
  }), "Not available yet: Needs config isolation.");
});

test("supervised Cursor permission copy distinguishes Full access from Workspace writes", () => {
  const base = {
    id: "full_access" as const,
    label: "Full access",
    description: "Broad access.",
    status: "available" as const,
    risk: "high" as const,
    detail: "Broad access detail.",
    isDefault: false,
  };
  const fullAccess = supervisedCursorPermissionProfilePresentation(base);
  assert.equal(fullAccess.label, "Full access");
  assert.match(fullAccess.detail ?? "", /apply directly/i);
  assert.match(fullAccess.detail ?? "", /outside the project and use the network/i);

  const writable = supervisedCursorPermissionProfilePresentation({
    ...base,
    id: "sandboxed_write",
    label: "Sandboxed writes",
    risk: "medium",
  });
  assert.equal(writable.label, "Workspace writes");
  assert.match(writable.description, /separate copy of your project/i);
});

test("every access level a supervised agent can use states what it does not allow", () => {
  for (const providerId of ["codex", "claude-code", "open-model", "cursor"] as const) {
    for (const profile of supervisedPermissionProfilesForProvider(providerId)) {
      const presented = supervisedPermissionProfilePresentation(providerId, profile as DesktopManagedAgentPermissionProfile);
      const limits = supervisedPermissionProfileLimits(providerId, presented);
      if (profile.status === "available") {
        assert.ok(limits, `${providerId} ${profile.id} needs a limits line`);
      } else {
        // The card already says the level is unavailable.
        assert.equal(limits, null, `${providerId} ${profile.id}`);
      }
    }
  }
});

test("Cursor Full access permits network and host files while restricted profiles remain isolated", () => {
  for (const profile of supervisedPermissionProfilesForProvider("cursor")) {
    if (profile.status !== "available") continue;
    if (profile.id === "full_access") {
      assert.match(supervisedPermissionProfileLimits("cursor", profile) ?? "", /can reach the network and files outside the project/);
      continue;
    }
    assert.match(
      supervisedPermissionProfileLimits("cursor", profile as DesktopManagedAgentPermissionProfile) ?? "",
      /No network access: can't push or open PRs\./,
      profile.id,
    );
  }
  assert.equal(supervisedPermissionProfileLimits("codex", {
    id: "sandboxed_write", status: "gated",
  }), null);
});

test("supervised Codex presents ask-before-write without changing the legacy catalog", () => {
  const legacy = {
    id: "ask_before_write" as const,
    label: "Ask before writes",
    description: "Not wired.",
    status: "gated" as const,
    risk: "medium" as const,
    detail: "Requires an approval bridge.",
    isDefault: false,
  };
  const supervised = supervisedPermissionProfilePresentation("codex", legacy);
  assert.equal(legacy.status, "gated");
  assert.equal(supervised.status, "available");
  assert.match(supervised.detail ?? "", /read-only file access and no network access/);
});

test("supervised Codex presents Read-only as usable, in the daemon's own words, without changing the legacy catalog", () => {
  const legacy = {
    id: "read_only" as const,
    label: "Read-only",
    description: "Read-only access is unavailable for Codex here.",
    status: "gated" as const,
    risk: "low" as const,
    detail: "Choose another available access level.",
    isDefault: false,
  };
  const supervised = supervisedPermissionProfilePresentation("codex", legacy);
  assert.equal(legacy.status, "gated");
  assert.equal(supervised.status, "available");
  assert.equal(supervised.isDefault, false);
  // Add Agent and the agent's settings describe the level with the same words.
  const daemon = supervisedPermissionProfilesForProvider("codex").find((profile) => profile.id === "read_only")!;
  assert.equal(supervised.description, daemon.description);
  assert.equal(supervised.detail, daemon.detail);
  assert.equal(supervised.risk, daemon.risk);
  assert.equal(supervised.risk, "medium");
  assert.equal(supervised.description, "Can read files on this Mac, also outside your project, and read and post in the room.");
  assert.equal(supervised.detail, "Cannot change files. Its commands cannot use the network, and web search is off. Its commands cannot read your Codex sign-in file. It asks for no approval: a command that needs more is refused. Your saved Codex command rules do not apply to it. It cannot change the task board, join rooms or submit reviews.");
  // Its card says what it withholds, and that it asks for no approval.
  assert.equal(supervisedPermissionProfileLimits("codex", supervised),
    "Can't change files. Its commands can't use the network, and web search is off. Can't change the task board, join rooms or submit reviews. It asks for no approval.");
  // With the owner's own setup the line promises nothing that setup can undo.
  assert.equal(supervisedPermissionProfileLimits("codex", supervised, true),
    "Codex's own commands change no files and have no network access, web search is off, and it asks for no approval. Your own MCP tools, hooks and plugins are not held to this.");
  assert.equal(supervisedPermissionProfileLimits("codex", legacy), null, "a level that cannot be used has no limits line");
  // Open Model has no Read-only, and Codex's restricted editing stays unavailable.
  assert.equal(supervisedPermissionProfilePresentation("open-model", legacy).status, "gated");
  assert.equal(supervisedPermissionProfilePresentation("codex", { ...legacy, id: "sandboxed_write" }).status, "gated");
  assert.equal(supervisedProviderLaunchPolicy("codex", "read_only"), undefined, "the daemon, not the renderer, supplies Codex's native policy");
});

test("supervised Open Model presents its native approval bridge without changing the legacy catalog", () => {
  const legacy = {
    id: "ask_before_write" as const,
    label: "Ask before writes",
    description: "Not wired.",
    status: "gated" as const,
    risk: "medium" as const,
    detail: "Requires an approval bridge.",
    isDefault: false,
  };
  const supervised = supervisedPermissionProfilePresentation("open-model", legacy);
  assert.equal(legacy.status, "gated");
  assert.equal(supervised.status, "available");
  assert.match(supervised.detail ?? "", /Commands and file changes need approval/);
});

test("managed permission profile selection is scoped by provider", () => {
  const cursorProvider = provider({
    id: "cursor",
    name: "Cursor",
    defaultPermissionProfileId: "read_only",
    permissionProfiles: [
      {
        id: "read_only",
        label: "Read-only",
        description: "Inspect only.",
        status: "available",
        risk: "low",
        detail: null,
        isDefault: true,
      },
      {
        id: "sandboxed_write",
        label: "Sandboxed writes",
        description: "Repo-scoped coding access.",
        status: "available",
        risk: "medium",
        detail: null,
        isDefault: false,
      },
      {
        id: "full_access",
        label: "Full access",
        description: "Trusted local access.",
        status: "available",
        risk: "high",
        detail: null,
        isDefault: false,
      },
    ],
  });

  assert.equal(
    managedAgentPermissionProfileSelectionForProvider(cursorProvider, { codex: "full_access" }),
    "read_only",
  );
  assert.equal(
    managedAgentPermissionProfileSelectionForProvider(cursorProvider, { cursor: "full_access" }),
    "full_access",
  );
  assert.equal(
    managedAgentPermissionProfileSelectionForProvider(cursorProvider, {}, "sandboxed_write"),
    "sandboxed_write",
  );
  assert.equal(
    managedAgentPermissionProfileSelectionForProvider(
      cursorProvider,
      { cursor: "read_only" },
      "sandboxed_write",
    ),
    "read_only",
  );
});

test("managed agent room identifiers normalize like backend room filtering", () => {
  assert.equal(normalizeManagedAgentRoomIdentifier(" ABCD-1234 "), "abcd-1234");
  assert.equal(normalizeManagedAgentRoomIdentifier(" github.com/BrosInCode/letagents "), "github.com/brosincode/letagents");
});

test("live daemon-inbox agents become friendly mentionable room participants", () => {
  const participants = mergeDesktopSupervisorAgentParticipants([], [supervisorEntry({
    id: "supervised_6697e364-62d0-4027-b02d-ee71a8fbf579",
    roomId: "room_1",
    displayName: "GardenWinter · 6697e364-62d0-4027-b02d-ee71a8fbf579",
    agentKey: "EmmyMay/desktop-codex-4d8fe3",
    desiredState: "running",
    observedState: "working",
    condition: "none",
    bindingUpdatedAt: "2026-07-21T11:27:00.000Z",
    roomAgentState: {
      connection: { state: "connected", detail: null },
      inbox: { state: "idle", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
  })], "room_1");

  assert.equal(participants.length, 1);
  assert.equal(participants[0]?.displayName, "GardenWinter");
  assert.equal(participants[0]?.agentKey, "EmmyMay/desktop-codex-4d8fe3");
  assert.equal(participants[0]?.ownerLabel, "EmmyMay");
  assert.equal(participants[0]?.activityState, "active");
  assert.deepEqual(participants[0]?.sourceFlags, ["delivery", "presence"]);
  assert.equal(isMentionableRoomParticipant(participants[0]!), true);
  const mention = roomMentionCandidates(participants, "garden")[0];
  assert.equal(mention?.label, "EmmyMay's agent");
  assert.equal(mention?.insertText, "GardenWinter");
});

test("supervisor reachability preserves server-owned attribution while replacing a generic provider label", () => {
  const participants = mergeDesktopSupervisorAgentParticipants([
    participant({
      participantKey: "agent:EmmyMay/desktop-codex-4d8fe3",
      kind: "agent",
      displayName: "GardenWinter",
      actorLabel: "GardenWinter | Emmy May's agent | Supervisor Worker",
      agentKey: "EmmyMay/desktop-codex-4d8fe3",
      githubLogin: null,
      ownerLabel: "Emmy May",
      ideLabel: "Supervisor Worker",
      activityState: "away",
      sourceFlags: ["messages"],
    }),
  ], [supervisorEntry({
    id: "supervised_6697e364-62d0-4027-b02d-ee71a8fbf579",
    roomId: "room_1",
    displayName: "GardenWinter",
    agentKey: "EmmyMay/desktop-codex-4d8fe3",
    desiredState: "running",
    observedState: "working",
    condition: "none",
    roomAgentState: {
      connection: { state: "connected", detail: null },
      inbox: { state: "idle", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
  })], "room_1");

  assert.equal(participants.length, 1);
  assert.equal(participants[0]?.participantKey, "desktop-supervisor-agent:supervised_6697e364-62d0-4027-b02d-ee71a8fbf579");
  assert.equal(participants[0]?.ownerLabel, "Emmy May");
  assert.equal(participants[0]?.actorLabel, "GardenWinter | Emmy May's agent | Supervisor Worker");
  assert.equal(participants[0]?.ideLabel, "Codex");
  assert.equal(participants[0]?.activityState, "active");
  assert.deepEqual(participants[0]?.sourceFlags, ["messages", "delivery", "presence"]);
});

test("presence restores message-history identity before supervisor rows are projected", () => {
  const shell = readFileSync(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url), "utf8");
  assert.match(shell, /const roomParticipants = computed\(\(\) =>\s*mergeDesktopSupervisorAgentParticipants\(\s*(?:\/\/[^\n]*\n\s*)*mergeReachableAgentPresenceParticipants\(props\.participants,/);
  const history = [participant({
    participantKey: "agent:dawnhaven | emmymay's agent | codex",
    displayName: "DawnHaven",
    actorLabel: "DawnHaven | EmmyMay's agent | Codex",
    agentKey: null,
    ownerLabel: "EmmyMay",
  })];
  const live = [presence({
    displayName: "DawnHaven",
    actorLabel: history[0].actorLabel,
    agentKey: "EmmyMay/desktop-codex-dawn",
    ownerLabel: "EmmyMay",
    freshness: "active",
    activityState: "active",
    sourceFlags: ["delivery", "presence"],
  })];
  const entries = [supervisorEntry({
    displayName: "DawnHaven",
    agentKey: live[0].agentKey,
    roomAgentState: {
      connection: { state: "connected", detail: null },
      inbox: { state: "idle", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
  })];
  const participants = mergeDesktopSupervisorAgentParticipants(
    mergeReachableAgentPresenceParticipants(history, live, "room_1"),
    entries,
    "room_1",
  );

  assert.equal(participants.length, 1);
  assert.equal(participants[0].agentKey, live[0].agentKey);
  assert.equal(participants[0].participantKey, "desktop-supervisor-agent:supervised_1");
  assert.equal(participants[0].ownerLabel, "EmmyMay");
  assert.deepEqual(participants[0].sourceFlags, ["messages", "delivery", "presence"]);
  assert.equal(roomMentionCandidates(participants, "dawn")[0]?.insertText, "DawnHaven");

  const differentAgent = mergeDesktopSupervisorAgentParticipants(participants, [
    { ...entries[0], id: "supervised_other", agentKey: "OtherOwner/desktop-codex-dawn" },
  ], "room_1");
  assert.equal(differentAgent.length, 2);
  assert.deepEqual(roomMentionCandidates(differentAgent, "dawn").map((item) => item.insertText), [
    "agent:EmmyMay/desktop-codex-dawn",
    "agent:OtherOwner/desktop-codex-dawn",
  ]);

  const owners = ["Alice", "Bob"];
  const ownerHistory = owners.map((owner) => ({
    ...history[0],
    participantKey: `agent:dawnhaven:${owner}`,
    actorLabel: `DawnHaven | ${owner}'s agent | Codex`,
    ownerLabel: owner,
    activityState: "offline" as const,
  }));
  const ownerPresence = ownerHistory.map((item) => ({
    ...live[0], actorLabel: item.actorLabel, ownerLabel: item.ownerLabel,
    agentKey: `${item.ownerLabel}/dawn`,
  })).reverse();
  const ownerEntries = owners.map((owner) => ({
    ...entries[0], id: `supervised_${owner}`, agentKey: `${owner}/dawn`,
  }));
  const ownerParticipants = mergeDesktopSupervisorAgentParticipants(
    mergeReachableAgentPresenceParticipants(ownerHistory, ownerPresence, "room_1"), ownerEntries, "room_1",
  );
  assert.deepEqual(ownerParticipants.map((item) => [item.ownerLabel, item.agentKey]), [
    ["Alice", "Alice/dawn"], ["Bob", "Bob/dawn"],
  ]);
  assert.deepEqual(roomMentionCandidates(ownerParticipants, "dawn").map((item) => item.insertText), [
    "agent:Alice/dawn", "agent:Bob/dawn",
  ]);
});

test("presence matches canonical identity before ambiguous actor labels", () => {
  const participants = ["Alice", "Bob"].map((owner) => participant({
    participantKey: `agent:${owner}`, displayName: "DawnHaven", actorLabel: "DawnHaven",
    agentKey: `${owner}/dawn`, ownerLabel: owner, activityState: "offline",
  }));
  const result = mergeReachableAgentPresenceParticipants(participants, [presence({
    actorLabel: "DawnHaven", displayName: "DawnHaven", agentKey: "Bob/dawn", ownerLabel: "Bob",
    freshness: "active", activityState: "active", status: "working", sourceFlags: ["delivery", "presence"],
  })], "room_1");
  assert.equal(result.length, 2);
  assert.equal(result[0].activityState, "offline");
  assert.equal(result[1].activityState, "active");
  assert.equal(result[1].agentKey, "Bob/dawn");
});

test("Open Model supervisor participants use the product provider label", () => {
  const participants = mergeDesktopSupervisorAgentParticipants([], [supervisorEntry({
    id: "supervised_open_model",
    provider: "open-model",
    displayName: "QuartzCove",
    agentKey: "EmmyMay/desktop-open-model-4d8fe3",
    roomAgentState: {
      connection: { state: "connected", detail: null },
      inbox: { state: "idle", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "idle", inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
      task: { state: "none", taskId: null, title: null },
    },
  })], "room_1");

  assert.equal(participants[0]?.displayName, "QuartzCove");
  assert.equal(participants[0]?.ideLabel, "Open Model");
});

test("supervisor mention projection excludes disconnected, stopped, and other-room agents", () => {
  const connectedState = {
    connection: { state: "connected" as const, detail: null },
    inbox: { state: "idle" as const, pendingCount: 0, blockedByMessageId: null, detail: null },
    turn: { state: "idle" as const, inboxItemId: null, sourceMessageId: null, providerTurnId: null, detail: null },
    task: { state: "none" as const, taskId: null, title: null },
  };
  const participants = mergeDesktopSupervisorAgentParticipants([], [
    supervisorEntry({ agentKey: "owner/live", roomAgentState: connectedState }),
    supervisorEntry({ id: "supervised_stopped", agentKey: "owner/stopped", desiredState: "stopped", observedState: "stopped", roomAgentState: connectedState }),
    supervisorEntry({ id: "supervised_other", agentKey: "owner/other", roomId: "room_2", roomAgentState: connectedState }),
    supervisorEntry({
      id: "supervised_disconnected",
      agentKey: "owner/disconnected",
      roomAgentState: { ...connectedState, connection: { state: "disconnected", detail: null } },
    }),
  ], "room_1");

  assert.deepEqual(participants.map((participant) => participant.agentKey), ["owner/live"]);
});

test("reachable worker presence becomes mentionable when room participants lag", () => {
  const participants = mergeReachableAgentPresenceParticipants([
    participant({
      participantKey: "human:emmy",
      kind: "human",
      displayName: "EmmyMay",
      actorLabel: "EmmyMay",
      agentKey: null,
      githubLogin: "EmmyMay",
      ownerLabel: null,
      ideLabel: null,
      activityState: "active",
    }),
  ], [
    presence({
      actorLabel: "LumenVale",
      displayName: "LumenVale",
      agentKey: "cursor/lumenvale",
      agentSessionId: "agent_lumenvale",
      runtime: "cursor",
      ideLabel: "Cursor",
      status: "working",
      freshness: "active",
      activityState: "active",
      sourceFlags: ["delivery", "presence"],
      lastHeartbeatAt: "2026-06-14T12:03:00.000Z",
    }),
  ], "ROOM_1");

  assert.deepEqual(participants.map((entry) => entry.displayName), ["EmmyMay", "LumenVale"]);
  assert.equal(participants[1].kind, "agent");
  assert.equal(participants[1].activityState, "active");
  assert.deepEqual(participants[1].sourceFlags, ["delivery", "presence"]);
  assert.equal(isMentionableRoomParticipant(participants[1]), true);
});

test("reachable worker presence updates an existing hidden agent participant", () => {
  const participants = mergeReachableAgentPresenceParticipants([
    participant({
      hiddenAt: "2026-06-14T12:00:00.000Z",
      activityState: "offline",
    }),
  ], [
    presence({
      freshness: "active",
      activityState: "away",
      sourceFlags: ["delivery", "presence"],
    }),
  ], "room_1");

  assert.equal(participants.length, 1);
  assert.equal(participants[0].hiddenAt, null);
  assert.equal(participants[0].activityState, "away");
  assert.equal(isMentionableRoomParticipant(participants[0]), true);
});

test("stale or non-delivery presence does not become mentionable", () => {
  assert.deepEqual(mergeReachableAgentPresenceParticipants([], [
    presence({
      freshness: "stale",
      activityState: "offline",
      sourceFlags: ["presence"],
    }),
  ], "room_1"), []);
  assert.deepEqual(mergeReachableAgentPresenceParticipants([], [
    presence({
      freshness: "active",
      activityState: "active",
      sourceFlags: ["presence"],
    }),
  ], "room_1"), []);
});

test("supervised Claude exposes one-time native approval without enabling its legacy profile", () => {
  const legacy = { id: "ask_before_write", label: "Ask before writes", description: "Unavailable", status: "gated", risk: "medium", detail: "Unavailable", isDefault: false } as const;
  const supervised = supervisedPermissionProfilePresentation("claude-code", legacy);
  assert.equal(supervised.status, "available");
  assert.match(supervised.description, /Claude.*change files/);
  assert.match(supervised.detail!, /only read the project, its history, or its pull requests run without asking\. Each approval allows one action.*Other Claude settings do not apply/);
  assert.equal(legacy.status, "gated");
});

test("supervised Claude, Codex, and Open Model expose Auto, and Cursor leaves it as it found it", () => {
  const legacy = { id: "auto_review", label: "Auto", description: "Unavailable", status: "gated", risk: "medium", detail: "Unavailable", isDefault: false } as const;
  const claude = supervisedPermissionProfilePresentation("claude-code", legacy);
  assert.equal(claude.status, "available");
  assert.match(claude.detail!, /Anything a room message asks for counts as approved, including commands that reach outside your project/);
  const codex = supervisedPermissionProfilePresentation("codex", legacy);
  assert.equal(codex.status, "available");
  assert.match(codex.detail!, /only in its working folder and temporary folders, with no network access, until Codex approves more/);
  assert.match(codex.detail!, /Anything a room message asks for counts as approved/);
  const openModel = supervisedPermissionProfilePresentation("open-model", legacy);
  assert.equal(openModel.status, "available");
  assert.match(openModel.detail!, /Reading and checking commands are sent to LetAgents and to Jev.*pushing to the agent's own LetAgents branch run without asking.*Reading project files and looking things up on the web are not reviewed\..*cannot open files outside the project\./);
  assert.equal(supervisedPermissionProfilePresentation("cursor", legacy).status, "gated");
  assert.match(autoReviewNotice("Open Model", "open-model"), /sends each command to LetAgents and Jev.*run the project's own scripts/);
  assert.doesNotMatch(autoReviewNotice("Open Model", "open-model"), /room message/);
  assert.equal(autoReviewNotice("Codex", "codex"), autoReviewNotice("Codex"));
  assert.equal(legacy.status, "gated");
  assert.deepEqual(supervisedProviderLaunchPolicy("claude-code", "auto_review"), { permissionMode: "auto" });
  assert.match(autoReviewNotice("Codex"), /^Codex decides which actions are safe instead of asking you\..*trust everyone who can post\.$/);
  assert.equal(supervisedProviderLaunchPolicy("codex", "auto_review"), undefined);
});

test("repo-less Cursor setup offers read-only and reserves write profiles for a connected project", () => {
  for (const id of ["read_only", "sandboxed_write", "full_access"] as const) {
    const profile = { id, label: id, description: "", detail: "", status: "available" as const, risk: "medium" as const, isDefault: false };
    const scratch = supervisedPermissionProfilePresentation("cursor", profile, { hasProject: false });
    assert.equal(scratch.status, id === "read_only" ? "available" : "unsupported");
    if (id !== "read_only") assert.equal(scratch.detail, "Connect a project to use workspace writes.");
    assert.equal(supervisedPermissionProfilePresentation("cursor", profile, { hasProject: true }).status, "available");
    assert.equal(supervisedPermissionProfilePresentation("claude-code", profile, { hasProject: false }).status, "available");
  }
});


test("room work indicator reflects current compaction but cannot invent a room turn", () => {
  const base = supervisorEntry({ provider: "claude-code", desiredState: "running", observedState: "working", condition: "none",
    agentSessionBindingState: "active", providerProgress: { state: "compacting", startedAt: "2026-09-24T00:00:00Z" },
    roomAgentState: { connection: { state: "connected", observedAt: null, detail: null },
      ingress: { state: "observing", observedAt: null, detail: null },
      inbox: { state: "empty", pendingCount: 0, blockedByMessageId: null, detail: null },
      turn: { state: "responding", inboxItemId: "inbox", sourceMessageId: "msg", providerTurnId: "turn", detail: null },
      task: { state: "none", taskId: null, title: null } } });
  assert.equal(supervisedAgentWorkIndicators([base], [], "room_1")[0]?.summary, "Compacting conversation");
  assert.notEqual(supervisedAgentWorkIndicators([base], [], "room_1", "stale")[0]?.summary, "Compacting conversation");
  assert.notEqual(supervisedAgentWorkIndicators([{ ...base, providerProgress: null }], [], "room_1")[0]?.summary, "Compacting conversation");
  assert.deepEqual(supervisedAgentWorkIndicators([{ ...base, roomAgentState: { ...base.roomAgentState!, turn: { ...base.roomAgentState!.turn, state: "idle" } } }], [], "room_1"), []);
});
