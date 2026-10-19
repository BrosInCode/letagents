import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentInspectorSelection } from "../src/components/desktop/content/desktop-chat-message/types";
import {
  projectAgentInspectorParticipant,
  projectAgentInspectorStatus,
} from "../src/domain/agent-inspector-participant";

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

test("a true external participant is factual and read-only", () => {
  const projected = projectAgentInspectorParticipant(selection());
  assert.deepEqual(projected, {
    kind: "external",
    title: "GardenSignal",
    eyebrow: "Room participant",
    heading: "Externally managed agent",
    detail: "This participant is visible in this room, but its runtime and permissions are managed elsewhere.",
  });
});

test("resolving and unavailable supervisor identity never produce a participant control surface", () => {
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "resolving" }), null);
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "unavailable", unavailableReason: "ambiguous" }), null);
  assert.equal(projectAgentInspectorParticipant({ ...selection(), kind: "unavailable", unavailableReason: "load_error" }), null);
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

test("the responsive host has an exact 920px nonmodal boundary and compact accessibility treatment", async () => {
  const host = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/components/desktop/content/agent-inspector/agent-inspector.css", import.meta.url), "utf8");
  assert.match(host, /width < compactBreakpoint/);
  assert.match(host, /const compactBreakpoint = 920/);
  assert.match(host, /setShellContentInert\(open && isCompact\)/);
  assert.match(host, /<Teleport to="body">[\s\S]*aria-live="polite" aria-atomic="true"/);
  assert.match(host, /projectAgentInspectorParticipant\(props\.selection\)/);
  assert.match(host, /latestReasoningSessionForExactIdentity/);
  assert.match(host, /ManagedAgentChangeSummaryCard|reasoning: participantReasoning\.value/);
  assert.doesNotMatch(await readFile(new URL("../src/components/desktop/content/DesktopRoomShell.vue", import.meta.url), "utf8"), /:managed-sessions=/);
  assert.match(css, /@media \(min-width: 560px\) and \(max-width: 919px\)/);
  assert.match(css, /width: min\(640px, 88vw\)/);
  assert.match(css, /width: 100vw/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /ease-in(?:[;,)\s])/);
  assert.doesNotMatch(css, /scale\(0\)/);
});

test("the participant surface links to published progress and offers no local stop, retry or permission controls", async () => {
  const surface = await readFile(new URL("../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue", import.meta.url), "utf8");
  assert.match(surface, /emit\('open-reasoning', reasoning\.id\)/);
  assert.match(surface, /const emit = defineEmits<\{\s*close: \[\];\s*"open-reasoning": \[sessionId: string\];\s*"reveal-live-request": \[messageId: string\];\s*\}>\(\)/);
  assert.doesNotMatch(surface, /desktopIpc|ManagedAgentChangeSummaryCard|getManagedAgentChangeSummary|session-updated/);
});

test('shared Overview uses exact room/session presence and never display-name matching', async () => {
  const { sharedAgentInspectorPresentation } = await import('../src/domain/agent-inspector-presentation');
  const presence = { roomId: 'room_a', agentKey: 'owner/garden-signal', agentSessionId: 'session_garden', sessionKind: 'worker', status: 'working', statusText: 'Reviewing changes.', freshness: 'active', activityState: 'active', ideLabel: 'Codex', ownerLabel: 'Owner' } as import('../../electron/ipc-types').DesktopAgentPresence;
  const current = sharedAgentInspectorPresentation(selection(), [presence], 'room_a', 'owner');
  assert.equal(current.owner, true);
  assert.equal(current.ownerLabel, 'Your agent');
  assert.equal(current.signal.state, 'responding');
  assert.equal(current.signal.moving, true);
  assert.equal(current.signal.detail, 'Reviewing changes.');
  assert.equal('actions' in current, false);
  assert.equal(sharedAgentInspectorPresentation(selection(), [presence], 'room_b').signal.state, 'unshared');
  assert.equal(sharedAgentInspectorPresentation(selection({ agentKey: 'other/agent' }), [presence], 'room_a').signal.state, 'unshared');
  assert.equal(sharedAgentInspectorPresentation(selection({ agentSessionId: 'other_session' }), [presence], 'room_a').signal.state, 'unshared');
  assert.equal(sharedAgentInspectorPresentation(selection(), [presence, { ...presence }], 'room_a').signal.state, 'unshared');
  assert.equal(sharedAgentInspectorPresentation(selection({ agentKey: null, agentSessionId: null }), [presence], 'room_a', 'EmmyMay').owner, false);
  const member = sharedAgentInspectorPresentation(selection(), [presence], 'room_a', 'member');
  assert.equal(member.owner, false);
  assert.equal(member.ownerLabel, 'Owner’s agent');
  for (const [patch, expected] of [
    [{ activityState: 'offline', freshness: 'stale' }, 'disconnected'],
    [{ activityState: 'away', freshness: 'active', status: 'idle' }, 'online'],
    [{ sessionKind: 'controller', status: 'working' }, 'responding'],
    [{ freshness: 'stale' }, 'stale'],
    [{ status: 'blocked' }, 'needs_attention'],
    [{ status: 'idle' }, 'online'],
  ] as const) {
    assert.equal(sharedAgentInspectorPresentation(selection(), [{ ...presence, ...patch }], 'room_a').signal.state, expected);
  }
  const stale = sharedAgentInspectorPresentation(selection(), [presence], 'room_a', 'owner', false);
  assert.equal(stale.signal.state, 'stale');
  assert.equal(stale.signal.moving, false);
});
