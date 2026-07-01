import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopAgentPresence,
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopManagedAgentSession,
  DesktopParticipantSummary,
} from "../../electron/ipc-types";
import {
  activeManagedAgentWorkIndicators,
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  agentAuthCommand,
  agentProviderNeedsDesktopRepo,
  canStopManagedAgentTurn,
  cursorMcpPolicyDescription,
  cursorMcpPolicyLabel,
  cursorMcpPolicyOptions,
  defaultCursorMcpPolicy,
  externalMcpProviderJoinPrompt,
  externalMcpProviderInstruction,
  hasDesktopManagedRuntime,
  isAgentSetupConfirmationActive,
  isDeliverableManagedAgentSession,
  isExternalMcpProviderReady,
  isVisibleManagedAgentSession,
  managedAgentRepoDetail,
  managedAgentPermissionProfileLabel,
  managedAgentPermissionProfileSelectionForProvider,
  managedAgentPermissionProfileStatusLabel,
  managedAgentPermissionProfileSummary,
  managedAgentSessionMatchesRoom,
  managedAgentSessionMatchesTarget,
  managedAgentSessionDisplayName,
  managedAgentSessionStatusLabel,
  managedAgentStopResultNeedsAttention,
  managedAgentStopResultMessage,
  mergeDesktopManagedAgentParticipants,
  mergeDesktopManagedAgentPresence,
  normalizeManagedAgentRoomIdentifier,
  preferredManagedAgentRepoRootPath,
  shouldShowCursorMcpPolicySelector,
} from "../src/domain/managed-agents";

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

test("preferredManagedAgentRepoRootPath defaults local agents to the main checkout", () => {
  assert.equal(preferredManagedAgentRepoRootPath({
    rootPath: "/repo-feature-worktree",
    mainRootPath: "/repo-main-checkout",
  }), "/repo-main-checkout");
  assert.equal(preferredManagedAgentRepoRootPath({
    rootPath: "/repo-feature-worktree",
    mainRootPath: null,
  }), "/repo-feature-worktree");
  assert.equal(preferredManagedAgentRepoRootPath({
    rootPath: " ",
    mainRootPath: " ",
  }), null);
});

test("isVisibleManagedAgentSession keeps idle desktop-event workers visible", () => {
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
  })), false);
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
  })), false);
  assert.equal(isDeliverableManagedAgentSession(session({
    deliveryMode: "desktop_events",
    status: "completed",
    agentSessionId: "agent_1",
    canStop: true,
  })), true);
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
  assert.equal(
    agentSetupActionButtonLabel("install_runtime", provider(), false, false),
    "Install Codex",
  );
  assert.equal(
    agentSetupActionButtonLabel("install_runtime", provider(), true, false),
    "Confirm install Codex",
  );
  assert.equal(
    agentSetupActionButtonLabel("install_mcp_bridge", provider(), true, false),
    "Confirm connection install",
  );
  assert.equal(
    agentSetupActionButtonLabel("install_runtime", provider(), true, true),
    "Installing...",
  );
  assert.equal(
    agentSetupConfirmationMessage("install_runtime", provider()),
    "LetAgents will install the official Codex CLI runtime on this machine after confirmation.",
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

test("unregistered or unknown managed desktop agents do not become mentionable or reachable", () => {
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
  assert.deepEqual(mergeDesktopManagedAgentParticipants([], [unknown], "room_1"), []);
  assert.deepEqual(mergeDesktopManagedAgentPresence([], [unknown], "room_1"), []);
});
