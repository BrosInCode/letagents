import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types.ts";
import {
  isGenericAgentProviderLabel,
  resolveMessageProviderLabel,
} from "../src/domain/agent-provider.ts";

function message(overrides: Partial<DesktopRoomMessage["agentIdentity"]> = {}): DesktopRoomMessage {
  return {
    id: "msg_provider",
    sender: "GardenSignal | EmmyMay's agent | Supervisor worker",
    text: "Hi EmmyMay!",
    attachments: [],
    agentPromptKind: null,
    source: "agent",
    timestamp: "2026-07-22T19:29:00.000Z",
    actorLabel: "GardenSignal | EmmyMay's agent | Supervisor worker",
    agentIdentity: {
      name: "GardenSignal",
      displayName: "GardenSignal",
      ownerLabel: "EmmyMay",
      ownerAttribution: "EmmyMay's agent",
      ideLabel: "Supervisor worker",
      actorLabel: "GardenSignal | EmmyMay's agent | Supervisor worker",
      agentKey: "EmmyMay/desktop-codex-garden-signal",
      agentSessionId: "agent_session_496",
      ...overrides,
    },
    threadRootId: "msg_provider",
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

const participant = {
  participantKey: "agent:GardenSignal",
  kind: "agent",
  displayName: "GardenSignal",
  actorLabel: "GardenSignal | EmmyMay's agent | Supervisor worker",
  agentKey: "EmmyMay/desktop-codex-garden-signal",
  githubLogin: null,
  ownerLabel: "EmmyMay",
  ideLabel: "Codex",
  hiddenAt: null,
  activityState: "active",
  lastSeenAt: "2026-07-22T19:29:00.000Z",
  lastRoomActivityAt: null,
  lastLiveHeartbeatAt: null,
  sourceFlags: ["presence"],
} satisfies DesktopParticipantSummary;

test("generic supervised message metadata resolves through current room identity", () => {
  assert.equal(resolveMessageProviderLabel(message(), [participant], []), "Codex");
  assert.equal(isGenericAgentProviderLabel("Supervisor worker"), true);
});

test("the exact live session wins when a historical message lacks its agent key", () => {
  const presence = {
    actorLabel: "GardenSignal",
    agentKey: "EmmyMay/desktop-codex-garden-signal",
    agentSessionId: "agent_session_496",
    displayName: "GardenSignal",
    ownerLabel: "EmmyMay",
    ideLabel: "Codex",
    runtime: "codex",
  } as DesktopAgentPresence;
  assert.equal(resolveMessageProviderLabel(message({ agentKey: null }), [], [presence]), "Codex");
});

test("an explicit provider remains authoritative", () => {
  assert.equal(resolveMessageProviderLabel(message({ ideLabel: "Claude Code" }), [participant], []), "Claude Code");
});

test("the room supervisor manifest resolves partial historical identities", () => {
  const entry = {
    roomId: "Focus: Room Agents Rewrite",
    displayName: "GardenSignal",
    agentKey: null,
    agentSessionId: null,
    provider: "codex",
  } as DesktopSupervisorManifestEntry;
  const partialMessage = message({
    agentKey: null,
    agentSessionId: null,
    actorLabel: null,
  });
  partialMessage.actorLabel = null;
  partialMessage.sender = "GardenSignal | EmmyMay's agent | Supervisor worker";

  assert.equal(resolveMessageProviderLabel(partialMessage, [], [], [entry]), "Codex");
});

test("a room-scoped exact display fallback fails closed when providers disagree", () => {
  const entries = [
    { displayName: "GardenSignal", provider: "codex", agentKey: null, agentSessionId: null },
    { displayName: "GardenSignal", provider: "claude", agentKey: null, agentSessionId: null },
  ] as DesktopSupervisorManifestEntry[];

  assert.equal(resolveMessageProviderLabel(message({ agentKey: null, agentSessionId: null }), [], [], entries), "Supervisor worker");
});
