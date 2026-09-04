import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DesktopManagedAgentSession } from "../../electron/ipc-types";
import type { AgentInspectorSelection } from "../src/components/desktop/content/desktop-chat-message/types";
import {
  agentInspectorManagedSessionIdentity,
  isCurrentAgentInspectorParticipantSessionUpdate,
  projectAgentInspectorParticipant,
  projectAgentInspectorStatus,
} from "../src/domain/agent-inspector-participant";
import { agentInspectorRequestResetKey } from "../src/domain/agent-inspector-identity";

function selection(overrides: Partial<AgentInspectorSelection> = {}): AgentInspectorSelection {
  return {
    kind: "external",
    actorLabel: "GardenSignal",
    displayName: "GardenSignal",
    ownerAttribution: "EmmyMay's agent",
    ideLabel: "Codex",
    sender: "GardenSignal",
    agentKey: "owner/garden-signal",
    agentSessionId: "session_garden",
    ...overrides,
  } as AgentInspectorSelection;
}

function session(overrides: Partial<DesktopManagedAgentSession> = {}): DesktopManagedAgentSession {
  return {
    id: "managed_garden",
    providerId: "codex",
    runtime: "codex",
    roomIdentifier: "room_a",
    roomDisplayName: null,
    repoRootPath: "/tmp/repo",
    repoBranch: null,
    status: "running",
    deliveryMode: "desktop_events",
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
    agentSessionId: "session_garden",
    actorLabel: "GardenSignal",
    agentKey: "owner/garden-signal",
    displayName: "GardenSignal",
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    reasoningSessionId: null,
    activeWork: { kind: "message", eventId: "message_1", startedAt: "2026-07-23T07:00:00.000Z", summary: "Reviewing the room request" },
    pendingPermissionRequests: [],
    startedAt: "2026-07-23T07:00:00.000Z",
    updatedAt: "2026-07-23T07:00:00.000Z",
    lastError: null,
    supervisorEntryId: null,
    ...overrides,
  };
}

test("only one exact durable local session gains inspector controls", () => {
  const projected = projectAgentInspectorParticipant(selection(), [session()], "room_a");
  assert.equal(projected?.kind, "local_managed");
  assert.equal(projected?.kind === "local_managed" ? projected.canStopTurn : false, true);
  assert.equal(projected?.kind === "local_managed" ? projected.detail : null, "Reviewing the room request");
});

test("a true external participant is factual and read-only", () => {
  const projected = projectAgentInspectorParticipant(selection(), [], "room_a");
  assert.deepEqual(projected, {
    kind: "external",
    title: "GardenSignal",
    eyebrow: "Room participant",
    heading: "Externally managed agent",
    detail: "This participant is visible in this room, but its runtime and permissions are managed elsewhere.",
  });
});

test("duplicate and disagreeing identities render explicit unavailable state", () => {
  const duplicate = projectAgentInspectorParticipant(
    selection(),
    [session({ id: "one" }), session({ id: "two" })],
    "room_a",
  );
  assert.equal(duplicate?.kind, "unavailable");
  assert.match(duplicate?.detail || "", /Conflicting exact local sessions/);
  const disagreement = projectAgentInspectorParticipant(selection(), [
    session({ id: "session-owner", agentKey: "owner/one" }),
    session({ id: "key-owner", agentSessionId: "session_other" }),
  ], "room_a");
  assert.equal(disagreement?.kind, "unavailable");
});

test("resolving and unavailable supervisor identity never produce a participant control surface", () => {
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "resolving" }, [session()], "room_a"), null);
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "unavailable", unavailableReason: "ambiguous" }, [session()], "room_a"), null);
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "unavailable", unavailableReason: "load_error" }, [session()], "room_a"), null);
});

test("agent status copy distinguishes a background-service failure from agent availability", () => {
  assert.deepEqual(projectAgentInspectorStatus({
    ...selection(),
    kind: "unavailable",
    unavailableReason: "load_error",
  }), {
    title: "GardenSignal",
    eyebrow: "Agent",
    heading: "Couldn’t load agent details",
    detail: "LetAgents couldn’t reach its background agent service. The agent’s room history is still available, and you can try again.",
    canRetry: true,
  });
  assert.deepEqual(projectAgentInspectorStatus({
    ...selection(),
    kind: "unavailable",
    unavailableReason: "missing",
  }), {
    title: "GardenSignal",
    eyebrow: "Agent",
    heading: "Agent no longer available",
    detail: "This agent is no longer managed by this desktop. Its room messages remain available in history.",
    canRetry: false,
  });
});

test("participant session updates are fenced by room, request, selection, and exact session", () => {
  const currentSelection = selection();
  const currentSession = session();
  const inspectorRequestVersion = 7;
  const update = {
    roomIdentifier: "room_a",
    inspectorRequestVersion,
    selectionKey: agentInspectorRequestResetKey(currentSelection, inspectorRequestVersion),
    expectedSessionIdentity: agentInspectorManagedSessionIdentity(currentSession),
    session: currentSession,
  };
  const current = {
    roomIdentifier: "room_a",
    inspectorRequestVersion,
    selection: currentSelection,
    sessions: [currentSession],
  };
  assert.equal(isCurrentAgentInspectorParticipantSessionUpdate(update, current), true);
  assert.equal(isCurrentAgentInspectorParticipantSessionUpdate(update, {
    ...current,
    roomIdentifier: "room_b",
    sessions: [session({ roomIdentifier: "room_b" })],
  }), false);
  assert.equal(isCurrentAgentInspectorParticipantSessionUpdate(update, {
    ...current,
    inspectorRequestVersion: inspectorRequestVersion + 1,
  }), false);
  assert.equal(isCurrentAgentInspectorParticipantSessionUpdate(update, {
    ...current,
    selection: selection({ agentSessionId: "session_other" }),
  }), false);
  assert.equal(isCurrentAgentInspectorParticipantSessionUpdate(update, {
    ...current,
    sessions: [session({ roomIdentifier: "room_b" })],
  }), false);
});

test("room scoping prevents a shared agent key from granting another room controls", () => {
  const projected = projectAgentInspectorParticipant(
    selection({ agentSessionId: null }),
    [session({ roomIdentifier: "room_b", agentSessionId: null })],
    "room_a",
  );
  assert.equal(projected?.kind, "external");
});

test("the responsive host has an exact 920px nonmodal boundary and compact accessibility treatment", async () => {
  const host = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/components/desktop/content/agent-inspector/agent-inspector.css", import.meta.url), "utf8");
  assert.match(host, /width < compactBreakpoint/);
  assert.match(host, /const compactBreakpoint = 920/);
  assert.match(host, /setShellContentInert\(open && isCompact\)/);
  assert.match(host, /<Teleport to="body">[\s\S]*aria-live="polite" aria-atomic="true"/);
  assert.match(host, /projectAgentInspectorParticipant\(props\.selection, props\.managedSessions, props\.roomIdentifier\)/);
  assert.match(host, /latestReasoningSessionForExactIdentity/);
  assert.match(host, /ManagedAgentChangeSummaryCard|reasoning: participantReasoning\.value/);
  assert.match(await readFile(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url), "utf8"), /:managed-sessions="roomManagedAgentSessions"/);
  assert.match(css, /@media \(min-width: 560px\) and \(max-width: 919px\)/);
  assert.match(css, /width: min\(640px, 88vw\)/);
  assert.match(css, /width: 100vw/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /ease-in(?:[;,)\s])/);
  assert.doesNotMatch(css, /scale\(0\)/);
});

test("participant actions invalidate on room, request, identity, and unmount before applying results", async () => {
  const surface = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue", import.meta.url), "utf8");
  assert.match(surface, /const actionFenceKey = computed\(\(\) => JSON\.stringify\(\[/);
  assert.match(surface, /props\.roomIdentifier,[\s\S]*props\.requestVersion,[\s\S]*props\.selectionKey/);
  assert.match(surface, /onBeforeUnmount\(\(\) => \{[\s\S]*mounted = false;[\s\S]*lifecycleVersion \+= 1/);
  assert.match(surface, /if \(!fenceIsCurrent\(fence\)\) return false;[\s\S]*await desktopIpc\.workers\.stopManagedAgent/);
  assert.match(surface, /await desktopIpc\.workers\.stopManagedAgent[\s\S]*if \(!fenceIsCurrent\(fence\)\) return false/);
  assert.match(surface, /emitSessionUpdate/);
  assert.doesNotMatch(surface, /managedSessionsContext\.upsert/);
});

test("worker stop accepts only the same stable session and room before closing the inspector", async () => {
  const surface = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue", import.meta.url), "utf8");
  assert.match(surface, /function workerStopResultMatchesFence\([\s\S]*session\.id === fence\.sessionId[\s\S]*managedAgentSessionMatchesRoom\(session, fence\.roomIdentifier\)/);
  assert.match(surface, /if \(stopMode === "worker"\) \{[\s\S]*workerStopResultMatchesFence\(result, fence\)[\s\S]*emit\("close"\);[\s\S]*return true;/);
  assert.match(surface, /if \(stopMode === "worker"\)[\s\S]*\}[\s\S]*if \(!emitSessionUpdate\(result, fence\)\)/);
});

test("participant parity keeps exact local changes and published progress without false success", async () => {
  const surface = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue", import.meta.url), "utf8");
  assert.match(surface, /ManagedAgentChangeSummaryCard/);
  assert.match(surface, /getManagedAgentChangeSummary/);
  assert.match(surface, /Published progress/);
  assert.match(surface, /emit\('open-reasoning', reasoning\.id\)/);
  assert.match(surface, /if \(!result\) throw new Error\(stopMode === "turn" \? "No active turn was stopped\."/);
  assert.match(surface, /if \(!result\) throw new Error\("The failed message could not be retried\."/);
  assert.match(surface, /if \(!result\) throw new Error\("The local agent session is no longer available\."/);
});
