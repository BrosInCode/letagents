import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopGitRoomInfo,
  DesktopManagedAgentSession,
  DesktopParticipantSummary,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types";
import {
  activeManagedAgentWorkIndicators,
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  agentAuthCommand,
  branchScopedGitRoomExpectedBranch,
  agentProviderNeedsDesktopRepo,
  canStopManagedAgentTurn,
  cursorMcpPolicyDescription,
  cursorMcpPolicyLabel,
  cursorMcpPolicyOptions,
  defaultCursorMcpPolicy,
  externalMcpProviderJoinPrompt,
  externalMcpProviderInstruction,
  hasDesktopManagedRuntime,
  hasSupervisedRuntime,
  humanFacingSupervisorActivitySummary,
  isAgentSetupConfirmationActive,
  isDeliverableManagedAgentSession,
  isExternalMcpProviderReady,
  isHumanVisibleSupervisorActivity,
  isVisibleManagedAgentSession,
  isBranchScopedGitRoomIdentifier,
  managedAgentRepoDetail,
  managedAgentRepoStatusForRoom,
  managedAgentRootPathForRoom,
  managedAgentRoomBranchMismatch,
  managedAgentPermissionProfileLabel,
  managedAgentPermissionProfileSelectionForProvider,
  managedAgentPermissionProfileStatusLabel,
  managedAgentPermissionProfileSummary,
  supervisedCursorPermissionProfilePresentation,
  managedAgentPermissionRequestTargetLabel,
  managedAgentDetailSelection,
  managedAgentProviderIdentityForTarget,
  managedAgentSessionMatchesSupervisorTarget,
  managedAgentSessionMatchesRoom,
  managedAgentSessionMatchesReasoning,
  managedAgentSessionMatchesTarget,
  managedAgentSessionDisplayName,
  managedAgentSessionStatusLabel,
  managedAgentStopResultNeedsAttention,
  managedAgentStopResultMessage,
  mergeDesktopManagedAgentParticipants,
  mergeDesktopSupervisorAgentParticipants,
  mergeDesktopManagedAgentPresence,
  mergeReachableAgentPresenceParticipants,
  exactSupervisorEntriesForManagedSessions,
  exactSupervisorEntriesForTarget,
  matchingManagedAgentWorktrees,
  matchingManagedAgentWorktreesForBranch,
  normalizeManagedAgentRoomIdentifier,
  pendingManagedAgentPermissionApprovals,
  preferredManagedAgentRepoRootPath,
  shouldShowCursorMcpPolicySelector,
  shouldShowDeliveryModeSelector,
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
    capabilities: ["external_mcp", "desktop_managed_runtime"],
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

function session(
  overrides: Partial<DesktopManagedAgentSession> = {},
): DesktopManagedAgentSession {
  return {
    id: "managed_1",
    providerId: "codex",
    runtime: "codex",
    roomIdentifier: "room_1",
    roomDisplayName: null,
    repoRootPath: "/tmp/repo",
    repoBranch: null,
    status: "running",
    deliveryMode: "mcp_polling",
    permissionProfileId: "full_access",
    permissionProfile: {
      id: "full_access",
      label: "Full access",
      description: "Trusted local access.",
      status: "available",
      risk: "high",
      detail: null,
      isDefault: true,
    },
    canStop: true,
    agentSessionId: "agent_1",
    actorLabel: "MapleRidge",
    agentKey: "codex",
    displayName: "MapleRidge",
    ownerLabel: "Local desktop",
    ideLabel: "Codex",
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:00:00.000Z",
    lastError: null,
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

test("hasDesktopManagedRuntime identifies providers the desktop can supervise directly", () => {
  assert.equal(hasDesktopManagedRuntime(provider()), true);
  assert.equal(hasDesktopManagedRuntime(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), true);
});

test("Cursor MCP policy selector metadata defaults to filtering LetAgents", () => {
  assert.equal(defaultCursorMcpPolicy, "filter_letagents");
  assert.deepEqual(
    cursorMcpPolicyOptions.map((option) => [option.id, option.label]),
    [
      ["filter_letagents", "Filter LetAgents"],
      ["normal", "Normal Cursor MCPs"],
      ["none", "No MCPs"],
    ],
  );
  assert.equal(cursorMcpPolicyDescription("filter_letagents"), "Use my MCPs except LetAgents.");
  assert.equal(cursorMcpPolicyDescription("normal"), "Use my normal Cursor MCP setup as-is.");
  assert.equal(cursorMcpPolicyLabel("normal"), "Normal Cursor MCPs");
  assert.equal(cursorMcpPolicyLabel(null), "Filter LetAgents");
});

test("Cursor MCP policy selector only shows for desktop-managed Cursor", () => {
  assert.equal(shouldShowCursorMcpPolicySelector(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
  })), true);
  assert.equal(shouldShowCursorMcpPolicySelector(provider()), false);
  assert.equal(shouldShowCursorMcpPolicySelector(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp"],
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
  })), false);
});

test("managed model selector only shows for desktop-managed providers", () => {
  assert.equal(shouldShowManagedModelSelector(provider()), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
  })), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    id: "open-model",
    name: "Open Model",
    capabilities: ["desktop_managed_runtime"],
    runtimeCommand: "codex",
    mcpTargetId: "open-model",
  })), true);
  assert.equal(shouldShowManagedModelSelector(provider({
    capabilities: ["external_mcp"],
  })), false);
});

test("durable supervision is advertised only by providers with validated native evidence", () => {
  assert.equal(hasSupervisedRuntime(provider({
    capabilities: ["external_mcp", "desktop_managed_runtime", "supervised_runtime"],
  })), true);
  assert.equal(hasSupervisedRuntime(provider({
    id: "open-model",
    name: "Open Model",
    capabilities: ["desktop_managed_runtime", "reasoning_stream"],
    runtimeCommand: "codex",
    mcpTargetId: "open-model",
  })), false);
  assert.equal(hasSupervisedRuntime(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
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

test("Inspector activity uses exact supervisor ids when same-provider agents share a label", () => {
  const first = supervisorEntry({ id: "supervised_first", displayName: "Codex supervised agent" });
  const second = supervisorEntry({ id: "supervised_second", displayName: "Codex supervised agent" });
  assert.deepEqual(
    exactSupervisorEntriesForManagedSessions([first, second], [{ supervisorEntryId: "supervised_second" }]).map((entry) => entry.id),
    ["supervised_second"],
  );
  assert.equal(exactSupervisorEntriesForManagedSessions([first, second], [{ supervisorEntryId: null }]), null);
});

test("a rebound room session resolves one exact supervisor entry without a local managed session", () => {
  const first = supervisorEntry({
    id: "supervised_first",
    displayName: "Codex supervised agent",
    agentSessionId: "agent_session_402",
  });
  const rebound = supervisorEntry({
    id: "supervised_second",
    displayName: "Codex supervised agent",
    agentSessionId: "agent_session_403",
  });
  assert.deepEqual(
    exactSupervisorEntriesForTarget([first, rebound], [], "agent_session_403").map((entry) => entry.id),
    ["supervised_second"],
  );
  assert.deepEqual(
    exactSupervisorEntriesForTarget([first, rebound], [], "agent_session_missing"),
    [],
    "a specific room worker never widens to a same-label peer",
  );
  assert.deepEqual(
    exactSupervisorEntriesForTarget([
      { ...rebound, agentSessionId: null },
      first,
    ], [], "agent_session_403", ["supervised_second"]).map((entry) => entry.id),
    ["supervised_second"],
    "a previously exact entry remains controllable when restart temporarily clears its worker binding",
  );
});

test("exact supervisor worker bindings join Activity workers to their managed Claude and Codex controls", () => {
  const codexEntry = supervisorEntry({
    id: "supervised_codex",
    displayName: "Shared agent",
    provider: "codex",
    agentSessionId: "agent_session_codex",
    agentSessionBindingState: "active",
  });
  const claudeEntry = supervisorEntry({
    id: "supervised_claude",
    displayName: "Shared agent",
    provider: "claude-code",
    agentSessionId: "agent_session_claude",
    agentSessionBindingState: "active",
  });
  const codexSession = session({
    id: "managed_codex",
    providerId: "codex",
    agentSessionId: "local_agent_session_codex",
    displayName: "Shared agent",
    supervisorEntryId: "supervised_codex",
  });
  const claudeSession = session({
    id: "managed_claude",
    providerId: "claude-code",
    agentSessionId: "local_agent_session_claude",
    displayName: "Shared agent",
    supervisorEntryId: "supervised_claude",
  });

  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      claudeSession,
      [codexEntry, claudeEntry],
      "agent_session_claude",
    ),
    true,
    "a freshly registered Claude worker reaches the managed session that owns its exact supervisor entry",
  );
  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      codexSession,
      [codexEntry, claudeEntry],
      "agent_session_codex",
    ),
    true,
    "Codex uses the same provider-neutral durable binding path",
  );
  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      codexSession,
      [codexEntry, claudeEntry],
      "agent_session_claude",
    ),
    false,
    "same-label peers never inherit another worker's controls",
  );
  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      claudeSession,
      [codexEntry, claudeEntry],
      "external_session",
    ),
    false,
    "unbound external workers keep the external-agent Inspector",
  );
});

test("supervisor target joins survive room re-registration and temporary restart unbinding", () => {
  const managed = session({
    providerId: "claude-code",
    agentSessionId: "local_agent_session_claude",
    supervisorEntryId: "supervised_claude",
  });
  const rebound = supervisorEntry({
    id: "supervised_claude",
    provider: "claude-code",
    agentSessionId: "agent_session_re_registered",
    agentSessionBindingState: "active",
  });
  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      managed,
      [rebound],
      "agent_session_re_registered",
    ),
    true,
  );

  const restarting = {
    ...rebound,
    agentSessionId: null,
    agentSessionBindingState: "historical" as const,
  };
  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      managed,
      [restarting],
      "agent_session_re_registered",
      ["supervised_claude"],
    ),
    true,
    "the previously exact entry stays joined while a restart briefly clears the daemon projection",
  );
});

test("ambiguous duplicate worker bindings fail closed instead of widening controls", () => {
  const first = supervisorEntry({ id: "supervised_first", agentSessionId: "agent_session_shared" });
  const second = supervisorEntry({ id: "supervised_second", agentSessionId: "agent_session_shared" });
  assert.equal(
    managedAgentSessionMatchesSupervisorTarget(
      session({ supervisorEntryId: "supervised_first" }),
      [first, second],
      "agent_session_shared",
    ),
    false,
  );
});

test("Agent Inspector selection exposes exact bound controls and keeps unsafe targets external", () => {
  const boundEntry = supervisorEntry({
    id: "supervised_claude",
    displayName: "Claude Code supervised agent",
    provider: "claude-code",
    agentSessionId: "agent_session_441",
    agentSessionBindingState: "historical",
  });
  const boundSession = session({
    id: "managed_claude",
    providerId: "claude-code",
    agentSessionId: null,
    canStop: false,
    supervisorEntryId: "supervised_claude",
  });
  const target = {
    agentSessionId: "agent_session_441",
    agentKey: "EmmyMay/summitcrisp",
    actorLabel: "SummitCrisp | EmmyMay's agent | Agent",
    displayName: "SummitCrisp",
    ideLabel: "Agent",
    ownerAttribution: "EmmyMay's agent",
    sender: "SummitCrisp | EmmyMay's agent | Agent",
  };

  const bound = managedAgentDetailSelection(
    [boundSession],
    [boundEntry],
    target,
    null,
  );
  assert.deepEqual(bound.managedSessions.map((candidate) => candidate.id), ["managed_claude"]);
  assert.deepEqual(bound.supervisorEntries.map((entry) => entry.id), ["supervised_claude"]);
  assert.equal(bound.providerIdentity?.label, "Claude Code");
  assert.equal(bound.showExternalFallback, false);

  const external = managedAgentDetailSelection(
    [boundSession],
    [boundEntry],
    { ...target, agentSessionId: "external_session" },
    null,
  );
  assert.deepEqual(external.managedSessions, []);
  assert.deepEqual(external.supervisorEntries, []);
  assert.equal(external.providerIdentity, null);
  assert.equal(external.showExternalFallback, true);

  const ambiguous = managedAgentDetailSelection(
    [boundSession],
    [boundEntry, { ...boundEntry, id: "supervised_peer" }],
    target,
    null,
  );
  assert.deepEqual(ambiguous.managedSessions, []);
  assert.deepEqual(ambiguous.supervisorEntries, []);
  assert.equal(ambiguous.providerIdentity, null);
  assert.equal(ambiguous.showExternalFallback, true, "ambiguous durable entries fail closed without controls");
});

test("provider identity presentation follows exact active and historical supervisor bindings", () => {
  const codex = supervisorEntry({
    id: "supervised_codex",
    provider: "codex",
    model: "gpt-5.3-codex",
    agentSessionId: "agent_session_codex",
    agentSessionBindingState: "active",
  });
  const claude = supervisorEntry({
    id: "supervised_claude",
    provider: "claude-code",
    model: null,
    agentSessionId: "agent_session_claude",
    agentSessionBindingState: "historical",
  });

  assert.deepEqual(
    managedAgentProviderIdentityForTarget([codex, claude], [], "agent_session_codex"),
    {
      supervisorEntryId: "supervised_codex",
      providerId: "codex",
      label: "Codex",
      model: "gpt-5.3-codex",
      accessibleLabel: "Codex · gpt-5.3-codex",
      bindingState: "active",
    },
  );
  assert.equal(
    managedAgentProviderIdentityForTarget([codex, claude], [], "agent_session_claude")?.accessibleLabel,
    "Claude Code",
  );
});

test("provider identity fails closed for unbound, external, and ambiguous same-label peers", () => {
  const codex = supervisorEntry({
    id: "supervised_codex",
    displayName: "Shared agent",
    provider: "codex",
    agentSessionId: null,
  });
  const claude = supervisorEntry({
    id: "supervised_claude",
    displayName: "Shared agent",
    provider: "claude-code",
    agentSessionId: null,
  });

  assert.equal(managedAgentProviderIdentityForTarget([codex, claude], [], null), null);
  assert.equal(managedAgentProviderIdentityForTarget([], [], "external_session"), null);
  assert.equal(
    managedAgentProviderIdentityForTarget([codex, claude], [{ supervisorEntryId: "supervised_codex" }], null)?.label,
    "Codex",
  );
});

test("provider identity remains exact while a relaunch temporarily clears its room binding", () => {
  const relaunched = supervisorEntry({
    id: "supervised_relaunch",
    provider: "claude-code",
    model: "claude-opus-4-1",
    agentSessionId: null,
    agentSessionBindingState: "historical",
    executionGenerationId: "generation_2",
  });

  assert.equal(
    managedAgentProviderIdentityForTarget(
      [relaunched],
      [],
      "agent_session_previous",
      ["supervised_relaunch"],
    )?.accessibleLabel,
    "Claude Code · claude-opus-4-1",
  );
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
      timeline: [{ phase: "turn_started", observedAt: "2026-07-15T18:00:00.500Z", detail: null }],
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

test("delivery mode selector only shows for managed Codex", () => {
  assert.equal(shouldShowDeliveryModeSelector(provider()), true);
  assert.equal(shouldShowDeliveryModeSelector(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), false);
  assert.equal(shouldShowDeliveryModeSelector(provider({
    id: "cursor",
    name: "Cursor",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "cursor-agent",
    mcpTargetId: "cursor",
  })), false);
  assert.equal(shouldShowDeliveryModeSelector(provider({
    id: "open-model",
    name: "Open Model",
    capabilities: ["desktop_managed_runtime"],
    runtimeCommand: "codex",
    mcpTargetId: "open-model",
  })), false);
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

test("isVisibleManagedAgentSession keeps idle and attention-needed workers visible", () => {
  assert.equal(isVisibleManagedAgentSession(session({
    deliveryMode: "desktop_events",
    status: "completed",
    canStop: true,
  })), true);
  assert.equal(isVisibleManagedAgentSession(session({
    deliveryMode: "mcp_polling",
    status: "completed",
    canStop: false,
  })), false);
  assert.equal(isVisibleManagedAgentSession(session({
    status: "failed",
    canStop: true,
  })), false);
  assert.equal(isVisibleManagedAgentSession(session({
    status: "unknown",
    canStop: true,
  })), true);
  assert.equal(isVisibleManagedAgentSession(session({
    status: "blocked",
    canStop: true,
  })), true);
});

test("isDeliverableManagedAgentSession requires a registered room worker", () => {
  assert.equal(isDeliverableManagedAgentSession(session({
    status: "running",
    agentSessionId: "agent_1",
  })), true);
  assert.equal(isDeliverableManagedAgentSession(session({
    status: "running",
    agentSessionId: null,
  })), false);
  assert.equal(isDeliverableManagedAgentSession(session({
    status: "starting",
    agentSessionId: "agent_1",
  })), false);
  assert.equal(isDeliverableManagedAgentSession(session({
    status: "unknown",
    agentSessionId: "agent_1",
  })), true);
  assert.equal(isDeliverableManagedAgentSession(session({
    status: "blocked",
    agentSessionId: "agent_1",
  })), false);
  assert.equal(isDeliverableManagedAgentSession(session({
    deliveryMode: "desktop_events",
    status: "completed",
    agentSessionId: "agent_1",
    canStop: true,
  })), true);
});

test("pendingManagedAgentPermissionApprovals derives composer approval items", () => {
  const approvals = pendingManagedAgentPermissionApprovals([
    session({
      id: "managed_late",
      displayName: "NorthForge",
      ideLabel: "Claude Code",
      pendingPermissionRequests: [{
        id: "perm_late",
        providerId: "claude-code",
        sessionId: "managed_late",
        toolName: "Edit",
        toolUseId: "tool_1",
        title: "Use Edit",
        description: null,
        inputSummary: "/tmp/repo/apps/desktop/electron/main/agents/providers.ts",
        decisionReason: null,
        roomMessageId: null,
        requestedAt: "2026-07-01T12:00:02.000Z",
      }],
    }),
    session({
      id: "managed_early",
      displayName: "CedarVista",
      ideLabel: "Claude Code",
      pendingPermissionRequests: [{
        id: "perm_early",
        providerId: "claude-code",
        sessionId: "managed_early",
        toolName: "Bash",
        toolUseId: "tool_2",
        title: "Run command",
        description: "npm test",
        inputSummary: null,
        decisionReason: null,
        roomMessageId: null,
        requestedAt: "2026-07-01T12:00:01.000Z",
      }],
    }),
    session({
      id: "managed_other_room",
      roomIdentifier: "room_2",
      pendingPermissionRequests: [{
        id: "perm_other",
        providerId: "claude-code",
        sessionId: "managed_other_room",
        toolName: "Edit",
        toolUseId: null,
        title: "Use Edit",
        description: null,
        inputSummary: "/tmp/repo/README.md",
        decisionReason: null,
        roomMessageId: null,
        requestedAt: "2026-07-01T12:00:00.000Z",
      }],
    }),
  ], "room_1");

  assert.deepEqual(approvals.map((approval) => approval.id), ["perm_early", "perm_late"]);
  assert.equal(approvals[0]?.displayName, "CedarVista");
  assert.equal(approvals[0]?.targetLabel, "npm test");
  assert.equal(approvals[1]?.targetLabel, "apps/desktop/electron/main/agents/providers.ts");
});

test("managedAgentPermissionRequestTargetLabel keeps external targets intact", () => {
  assert.equal(managedAgentPermissionRequestTargetLabel({
    inputSummary: "/var/tmp/outside.txt",
    description: null,
  }, session()), "/var/tmp/outside.txt");
  assert.equal(managedAgentPermissionRequestTargetLabel({
    inputSummary: "/tmp/repo",
    description: null,
  }, session()), ".");
});

test("activeManagedAgentWorkIndicators only exposes running room work", () => {
  const indicators = activeManagedAgentWorkIndicators([
    session({
      id: "running_local",
      displayName: "LumenRiver",
      status: "running",
      activeWork: {
        kind: "message",
        eventId: "msg_1",
        startedAt: "2026-06-14T12:10:00.000Z",
        summary: "Checking the attachment path.",
      },
    }),
    session({
      id: "waiting_local",
      displayName: "CedarVista",
      status: "completed",
      deliveryMode: "desktop_events",
      activeWork: null,
    }),
    session({
      id: "other_room",
      roomIdentifier: "room_2",
      displayName: "MapleRidge",
      status: "running",
      activeWork: {
        kind: "message",
        eventId: "msg_2",
        startedAt: "2026-06-14T12:11:00.000Z",
        summary: "Working elsewhere.",
      },
    }),
  ], "room_1");

  assert.deepEqual(indicators, [{
    id: "running_local:msg_1",
    displayName: "LumenRiver",
    summary: "Checking the attachment path.",
    startedAt: "2026-06-14T12:10:00.000Z",
    agentSessionId: "agent_1",
    agentKey: "codex",
  }]);
});

test("canStopManagedAgentTurn only enables turn stops for active startup or running turns", () => {
  assert.equal(canStopManagedAgentTurn(session({
    status: "running",
    canStop: true,
  })), true);
  assert.equal(canStopManagedAgentTurn(session({
    status: "starting",
    canStop: true,
  })), true);
  assert.equal(canStopManagedAgentTurn(session({
    deliveryMode: "desktop_events",
    status: "completed",
    canStop: true,
  })), false);
  assert.equal(canStopManagedAgentTurn(session({
    status: "running",
    canStop: false,
  })), false);
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
    capabilities: ["external_mcp", "desktop_managed_runtime"],
    runtimeCommand: "claude",
    mcpTargetId: "claude-code",
  })), true);
});

test("agentAuthCommand exposes provider sign-in commands for managed runtimes", () => {
  assert.equal(agentAuthCommand(provider()), "codex login --device-auth");
  assert.equal(agentAuthCommand(provider({
    runtimeCommand: "/usr/local/bin/codex",
  })), "/usr/local/bin/codex login --device-auth");
  assert.equal(agentAuthCommand(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp", "desktop_managed_runtime"],
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
  assert.match(repoPrompt, /claim it with claim_task using the returned agent_session_id/);
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
    capabilities: ["desktop_managed_runtime", "installable_runtime"],
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

test("managedAgentSessionStatusLabel presents idle desktop-event turns as waiting", () => {
  assert.equal(managedAgentSessionStatusLabel(session({
    deliveryMode: "desktop_events",
    status: "completed",
  })), "Waiting for events");
  assert.equal(managedAgentSessionStatusLabel(session({
    deliveryMode: "mcp_polling",
    status: "completed",
  })), "Completed");
  assert.equal(managedAgentSessionStatusLabel(session({
    status: "starting",
  })), "Starting");
});

test("managedAgentRepoDetail includes branch when available", () => {
  assert.equal(
    managedAgentRepoDetail(session({ repoBranch: "codex/git-rooms" })),
    "codex/git-rooms - /tmp/repo",
  );
  assert.equal(managedAgentRepoDetail(session({ repoBranch: null })), "/tmp/repo");
});

test("managedAgentRoomBranchMismatch only flags branch-scoped room conflicts", () => {
  const defaultBranchGitRoom = branchGitRoom("main");
  defaultBranchGitRoom.ref.type = "default_branch";

  assert.deepEqual(
    managedAgentRoomBranchMismatch(
      session({ repoBranch: "main" }),
      branchGitRoom("feature/codex-work"),
    ),
    { expectedBranch: "feature/codex-work", actualBranch: "main" },
  );
  assert.equal(
    managedAgentRepoDetail(
      session({ repoBranch: "main" }),
      branchGitRoom("feature/codex-work"),
    ),
    "main - /tmp/repo - Expected feature/codex-work; agent is on main",
  );
  assert.equal(
    managedAgentRoomBranchMismatch(
      session({ repoBranch: "feature/codex-work" }),
      branchGitRoom("feature/codex-work"),
    ),
    null,
  );
  assert.equal(
    managedAgentRoomBranchMismatch(
      session({ repoBranch: "feature/codex-work" }),
      defaultBranchGitRoom,
    ),
    null,
  );
  assert.equal(
    managedAgentRoomBranchMismatch(
      session({ repoBranch: "feature/codex-work" }),
      branchGitRoom("main"),
    ),
    null,
  );
});

test("managedAgentStopResultMessage does not hide failed stop interrupts", () => {
  assert.equal(managedAgentStopResultMessage(session({
    status: "running",
    lastError: null,
  })), "Codex turn stopped.");
  assert.equal(managedAgentStopResultMessage(session({
    status: "unknown",
    lastError: null,
  })), "Codex turn state is unknown; refresh the agent to inspect it.");
  assert.equal(managedAgentStopResultMessage(session({
    status: "unknown",
    lastError: "Could not interrupt Codex turn.",
  })), "Could not interrupt Codex turn.");
  assert.equal(managedAgentStopResultMessage(session({
    status: "interrupted",
    lastError: null,
  })), "Codex worker stopped.");
  assert.equal(managedAgentStopResultNeedsAttention(session({
    status: "running",
    lastError: null,
  })), false);
  assert.equal(managedAgentStopResultNeedsAttention(session({
    status: "unknown",
    lastError: null,
  })), true);
  assert.equal(managedAgentStopResultNeedsAttention(session({
    status: "running",
    lastError: "Could not interrupt Codex turn.",
  })), true);
});

test("managedAgentSessionDisplayName prefers the worker codename", () => {
  assert.equal(managedAgentSessionDisplayName(session({
    displayName: "MapleRidge",
    actorLabel: "Codex fallback",
  })), "MapleRidge");
  assert.equal(managedAgentSessionDisplayName(session({
    displayName: null,
    actorLabel: "CedarVista",
  })), "CedarVista");
  assert.equal(managedAgentSessionDisplayName(session({
    displayName: null,
    actorLabel: null,
    runtime: "codex",
  })), "Local agent");
  assert.equal(managedAgentSessionDisplayName(session({
    displayName: null,
    actorLabel: null,
    runtime: "codex:LOCAL_CODEX_ROOM_test",
  })), "Local agent");
});

test("managed supervised sessions project legacy identity suffixes out of product labels", () => {
  const requestId = "6697e364-62d0-4027-b02d-ee71a8fbf579";

  assert.equal(managedAgentSessionDisplayName(session({
    displayName: `GardenWinter · ${requestId}`,
    supervisorEntryId: `supervised_${requestId}`,
  })), "GardenWinter");
  assert.equal(managedAgentSessionDisplayName(session({
    displayName: "GardenWinter · 000001",
    supervisorEntryId: `supervised_${requestId}`,
  })), "GardenWinter · 000001");
});

test("managed permission profile helpers present available and gated modes", () => {
  const running = session();
  assert.equal(managedAgentPermissionProfileLabel(running), "Full access");
  assert.equal(managedAgentPermissionProfileStatusLabel("available"), "Available");
  assert.equal(managedAgentPermissionProfileStatusLabel("gated"), "Gated");
  assert.equal(managedAgentPermissionProfileSummary({
    id: "sandboxed_write",
    label: "Sandboxed writes",
    description: "Waiting on sandbox tests.",
    status: "gated",
    risk: "medium",
    detail: "Needs config isolation.",
    isDefault: false,
  }), "Gated: Needs config isolation.");
});

test("supervised Cursor permission copy describes workspace scope instead of machine-wide access", () => {
  const base = {
    id: "full_access" as const,
    label: "Full access",
    description: "Broad access.",
    status: "available" as const,
    risk: "high" as const,
    detail: "Broad access detail.",
    isDefault: false,
  };
  const compatibility = supervisedCursorPermissionProfilePresentation(base);
  assert.equal(compatibility.label, "Workspace writes (compatibility)");
  assert.match(compatibility.detail ?? "", /private turn workspace/i);
  assert.match(compatibility.detail ?? "", /does not change Git history/i);

  const writable = supervisedCursorPermissionProfilePresentation({
    ...base,
    id: "sandboxed_write",
    label: "Sandboxed writes",
    risk: "medium",
  });
  assert.equal(writable.label, "Workspace writes");
  assert.match(writable.description, /private turn workspace/i);
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

test("managed agent room matching follows backend room filtering semantics", () => {
  assert.equal(normalizeManagedAgentRoomIdentifier(" ABCD-1234 "), "abcd-1234");
  assert.equal(normalizeManagedAgentRoomIdentifier(" github.com/BrosInCode/letagents "), "github.com/brosincode/letagents");
  assert.equal(managedAgentSessionMatchesRoom(session({
    roomIdentifier: "ABCD-1234",
  }), " abcd-1234 "), true);
  assert.equal(managedAgentSessionMatchesRoom(session({
    roomIdentifier: "github.com/BrosInCode/letagents",
  }), "github.com/brosincode/letagents"), true);
  assert.equal(managedAgentSessionMatchesRoom(session({
    roomIdentifier: "github.com/BrosInCode/letagents",
  }), "github.com/BrosInCode/other"), false);
});

test("managedAgentSessionMatchesTarget uses stable identity before display names", () => {
  assert.equal(managedAgentSessionMatchesTarget(session({
    agentSessionId: "session_maple",
    actorLabel: "MapleRidge",
    agentKey: "codex/maple-ridge",
    displayName: "MapleRidge",
  }), {
    agentSessionId: "session_maple",
    actorLabel: "Renamed",
    agentKey: null,
    displayName: "Renamed",
  }), true);

  assert.equal(managedAgentSessionMatchesTarget(session({
    agentSessionId: null,
    actorLabel: "OldName",
    agentKey: "codex/maple-ridge",
    displayName: "OldName",
  }), {
    agentSessionId: null,
    actorLabel: "Renamed",
    agentKey: "codex/maple-ridge",
    displayName: "Renamed",
  }), true);

  assert.equal(managedAgentSessionMatchesTarget(session({
    agentSessionId: null,
    actorLabel: "MapleRidge",
    agentKey: "codex",
    displayName: "MapleRidge",
  }), {
    agentSessionId: null,
    actorLabel: "CedarVista",
    agentKey: "codex",
    displayName: "CedarVista",
  }), false);

  assert.equal(managedAgentSessionMatchesTarget(session({
    agentSessionId: null,
    actorLabel: null,
    agentKey: null,
    displayName: "MapleRidge",
  }), {
    displayName: "MapleRidge",
  }), false);

  assert.equal(managedAgentSessionMatchesTarget(session({
    agentSessionId: null,
    actorLabel: null,
    agentKey: null,
    displayName: "MapleRidge",
    ideLabel: "Codex",
  }), {
    displayName: "MapleRidge",
    ideLabel: "Codex",
  }), true);

  assert.equal(managedAgentSessionMatchesTarget(session({
    agentSessionId: null,
    actorLabel: null,
    agentKey: null,
    displayName: "MapleRidge",
    ideLabel: "Codex",
  }), {
    displayName: "MapleRidge",
    ideLabel: "Antigravity",
  }), false);
});

test("managedAgentSessionMatchesReasoning links modal reasoning streams back to local sessions", () => {
  assert.equal(managedAgentSessionMatchesReasoning(session({
    agentSessionId: "agent_1",
    reasoningSessionId: "reasoning_1",
  }), {
    id: "reasoning_1",
    agentSessionId: null,
  }), true);

  assert.equal(managedAgentSessionMatchesReasoning(session({
    agentSessionId: "agent_1",
    reasoningSessionId: null,
  }), {
    id: "reasoning_other",
    agentSessionId: "agent_1",
  }), true);

  assert.equal(managedAgentSessionMatchesReasoning(session({
    agentSessionId: "agent_1",
    reasoningSessionId: "reasoning_1",
  }), {
    id: "reasoning_other",
    agentSessionId: "agent_other",
  }), false);
});

test("managed desktop agents become mentionable room participants", () => {
  const participants = mergeDesktopManagedAgentParticipants([], [
    session({
      deliveryMode: "desktop_events",
      displayName: "SummitGrove",
      actorLabel: "SummitGrove",
      agentSessionId: "agent_summit",
      roomIdentifier: "github.com/BrosInCode/letagents",
      repoBranch: "codex/git-rooms",
      updatedAt: "2026-06-15T09:30:00.000Z",
    }),
  ], "github.com/brosincode/letagents");

  assert.equal(participants.length, 1);
  assert.equal(participants[0].kind, "agent");
  assert.equal(participants[0].displayName, "SummitGrove");
  assert.equal(participants[0].activityState, "active");
  assert.deepEqual(participants[0].sourceFlags, ["delivery", "presence"]);
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

test("managed desktop agents become reachable activity presence", () => {
  const presenceEntries = mergeDesktopManagedAgentPresence([], [
    session({
      deliveryMode: "desktop_events",
      displayName: "SummitGrove",
      actorLabel: "SummitGrove",
      agentSessionId: "agent_summit",
      roomIdentifier: "github.com/BrosInCode/letagents",
      repoBranch: "codex/git-rooms",
      updatedAt: "2026-06-15T09:30:00.000Z",
    }),
  ], "github.com/brosincode/letagents");

  assert.equal(presenceEntries.length, 1);
  assert.equal(presenceEntries[0].actorLabel, "SummitGrove");
  assert.equal(presenceEntries[0].sessionKind, "worker");
  assert.equal(presenceEntries[0].freshness, "active");
  assert.equal(presenceEntries[0].activityState, "active");
  assert.equal(presenceEntries[0].livenessObservation?.source, "desktop_managed_agent");
  assert.equal(presenceEntries[0].livenessObservation?.detail, "codex/git-rooms - /tmp/repo");
  assert.deepEqual(presenceEntries[0].sourceFlags, ["delivery", "presence"]);
});

test("managed desktop agent merges with existing room identities instead of duplicating them", () => {
  const managedSession = session({
    displayName: "MapleRidge",
    actorLabel: "MapleRidge",
    agentSessionId: "agent_1",
    agentKey: "desktop/codex/maple",
    updatedAt: "2026-06-15T09:30:00.000Z",
  });

  const participants = mergeDesktopManagedAgentParticipants([
    participant(),
  ], [managedSession], "room_1");
  assert.equal(participants.length, 1);
  assert.equal(participants[0].sourceFlags.includes("messages"), true);

  const presenceEntries = mergeDesktopManagedAgentPresence([
    presence(),
  ], [managedSession], "room_1");
  assert.equal(presenceEntries.length, 1);
  assert.equal(presenceEntries[0].freshness, "active");
  assert.equal(presenceEntries[0].activityState, "active");
  assert.equal(presenceEntries[0].sourceFlags.includes("delivery"), true);
  assert.equal(presenceEntries[0].livenessObservation?.source, "desktop_managed_agent");
});

test("unregistered agents stay hidden while unknown agents remain visible but unreachable", () => {
  const unregistered = session({
    status: "starting",
    agentSessionId: null,
    displayName: "CloudForge",
    actorLabel: "CloudForge",
  });
  const unknown = session({
    status: "unknown",
    agentSessionId: "agent_cloudforge",
    displayName: "CloudForge",
    actorLabel: "CloudForge",
  });

  assert.deepEqual(mergeDesktopManagedAgentParticipants([], [unregistered], "room_1"), []);
  assert.deepEqual(mergeDesktopManagedAgentPresence([], [unregistered], "room_1"), []);
  const unknownParticipants = mergeDesktopManagedAgentParticipants([], [unknown], "room_1");
  const unknownPresence = mergeDesktopManagedAgentPresence([], [unknown], "room_1");
  assert.equal(unknownParticipants.length, 1);
  assert.equal(unknownPresence.length, 1);
  assert.equal(unknownPresence[0]?.freshness, "stale");
  assert.equal(unknownPresence[0]?.activityState, "offline");
});
