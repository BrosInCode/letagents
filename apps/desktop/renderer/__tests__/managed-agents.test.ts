import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopAgentProvider,
  DesktopAgentProviderPreflight,
  DesktopManagedAgentSession,
} from "../../electron/ipc-types";
import {
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  agentAuthCommand,
  agentProviderNeedsDesktopRepo,
  externalMcpProviderJoinPrompt,
  externalMcpProviderInstruction,
  hasDesktopManagedRuntime,
  isAgentSetupConfirmationActive,
  isExternalMcpProviderReady,
  isVisibleManagedAgentSession,
  managedAgentSessionMatchesRoom,
  managedAgentSessionMatchesTarget,
  managedAgentSessionDisplayName,
  managedAgentSessionStatusLabel,
  managedAgentStopResultNeedsAttention,
  managedAgentStopResultMessage,
  normalizeManagedAgentRoomIdentifier,
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
    status: "running",
    deliveryMode: "mcp_polling",
    canStop: true,
    agentSessionId: "agent_1",
    actorLabel: "MapleRidge",
    agentKey: "codex",
    displayName: "MapleRidge",
    ownerLabel: "Local desktop",
    ideLabel: "Codex",
    reasoningSessionId: null,
    startedAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

test("hasDesktopManagedRuntime identifies providers the desktop can supervise directly", () => {
  assert.equal(hasDesktopManagedRuntime(provider()), true);
  assert.equal(hasDesktopManagedRuntime(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "claude-code",
  })), false);
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
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "claude-code",
  })), false);
});

test("agentAuthCommand exposes Codex sign-in command only for Codex", () => {
  assert.equal(agentAuthCommand(provider()), "codex login --device-auth");
  assert.equal(agentAuthCommand(provider({
    runtimeCommand: "/usr/local/bin/codex",
  })), "/usr/local/bin/codex login --device-auth");
  assert.equal(agentAuthCommand(provider({
    id: "claude-code",
    name: "Claude Code",
    capabilities: ["external_mcp"],
    runtimeCommand: null,
    mcpTargetId: "claude-code",
  })), null);
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
    "Open Antigravity, then ask it to join this room through the installed MCP bridge.",
  );
  const repoPrompt = externalMcpProviderJoinPrompt(externalProvider, "github.com/BrosInCode/letagents");
  assert.match(repoPrompt, /Call join_room with \{"name":"github\.com\/BrosInCode\/letagents","session_mode":"current"\}\./);
  assert.match(repoPrompt, /Examples: MapleRidge, CedarVista, DawnWinter, GardenFern, SilverHarbor/);
  assert.match(repoPrompt, /Call set_agent_name with \{"name":"<your codename>"\} before posting status or registering/);
  assert.match(repoPrompt, /Call register_agent_session with \{"session_kind":"worker","runtime":"antigravity","display_name":"<your codename>"\}/);
  assert.match(repoPrompt, /Do not continue into the room loop until register_agent_session succeeds/);
  assert.match(repoPrompt, /Call post_status with \{"agent_session_id":"<returned agent_session_id>","status":"available in the room"\}/);
  assert.match(repoPrompt, /Call read_messages once, then call get_board once/);
  assert.match(repoPrompt, /claim it with claim_task using the returned agent_session_id/);
  assert.match(repoPrompt, /wait_for_messages with \{"agent_session_id":"<returned agent_session_id>","after_message_id":"<latest seen message id>","timeout":30000\} in a loop/);
  assert.match(repoPrompt, /send_message or send_thread_message with the same agent_session_id/);
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
    "Confirm bridge install",
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
    "LetAgents will update Antigravity's MCP configuration to add the LetAgents bridge after confirmation.",
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
