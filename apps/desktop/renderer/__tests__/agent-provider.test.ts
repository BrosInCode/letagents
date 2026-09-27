import assert from "node:assert/strict";
import test from "node:test";
import { computed, reactive } from "vue";

import type {
  DesktopAgentPresence,
  DesktopParticipantSummary,
  DesktopRoomMessage,
  DesktopSupervisorManifestEntry,
} from "../../electron/ipc-types.ts";
import {
  isGenericAgentProviderLabel,
  createMessageProviderLabelResolver,
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

test("a human message never inherits an agent provider from a matching display name", () => {
  const human = message({ ideLabel: null, agentKey: null, agentSessionId: null });
  human.source = "browser";
  human.sender = "GardenSignal";
  human.actorLabel = "GardenSignal";
  human.agentIdentity = null;
  assert.equal(resolveMessageProviderLabel(human, [participant], []), null);
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

test("indexed identities preserve explicit, session, key and actor precedence including ambiguous fallthrough", () => {
  const candidates = [
    { ...participant, agentSessionId: "agent_session_496", agentKey: "other/key", ideLabel: "Claude Code" },
    { ...participant, agentSessionId: "different_session", ideLabel: "Codex" },
  ];
  let resolve = createMessageProviderLabelResolver(candidates);
  assert.equal(resolve(message()), "Claude Code");
  assert.equal(resolve(message({ ideLabel: "Cursor" })), "Cursor");
  assert.equal(resolve(message({ agentSessionId: null })), "Codex");
  candidates.push({ ...participant, agentSessionId: "agent_session_496", agentKey: "third/key", ideLabel: "Cursor" });
  resolve = createMessageProviderLabelResolver(candidates);
  assert.equal(resolve(message()), "Codex", "ambiguous session falls through to the exact agent key");
  resolve = createMessageProviderLabelResolver([
    { ...participant, actorLabel: "actor", displayName: "unrelated", ideLabel: "Cursor" },
  ]);
  assert.equal(resolve(message({ agentSessionId: null, agentKey: null, actorLabel: " ACTOR " })), "Cursor");
  const human = { ...message(), source: "browser" as const };
  assert.equal(resolve(human), null);
});

test("indexed display fallback preserves owner normalization, absent owners and generic-only owner matches", () => {
  const partial = message({ agentSessionId: null, agentKey: null, actorLabel: "unmatched", ownerLabel: " EmmyMay’s agent " });
  const other = { ...participant, actorLabel: "other", ownerLabel: "Someone", ideLabel: "Claude Code" };
  const own = { ...participant, actorLabel: "own", ideLabel: "Codex" };
  assert.equal(createMessageProviderLabelResolver([other, own])(partial), "Codex");
  assert.equal(createMessageProviderLabelResolver([other])(partial), "Claude Code", "missing owner falls back to the display name");
  assert.equal(createMessageProviderLabelResolver([other, { ...own, ideLabel: "worker" }])(partial), "Supervisor worker", "existing generic-only owner must not borrow another owner's provider");
  assert.equal(createMessageProviderLabelResolver([other, own])(message({
    agentSessionId: null, agentKey: null, actorLabel: "unmatched", ownerLabel: "", ownerAttribution: "",
  })), "Codex", "sender owner attribution remains available");
});

test("component-local provider indexes observe in-place roster mutations and replacement", () => {
  const state = reactive({ entries: [{
    displayName: "GardenSignal", agentSessionId: "agent_session_496", agentKey: "EmmyMay/key", provider: "codex",
  }] as DesktopSupervisorManifestEntry[] });
  let builds = 0;
  const resolver = computed(() => {
    builds++;
    return createMessageProviderLabelResolver([], [], state.entries);
  });
  assert.equal(resolver.value(message()), "Codex");
  assert.equal(resolver.value(message()), "Codex");
  assert.equal(builds, 1);
  state.entries[0].provider = "claude";
  assert.equal(resolver.value(message()), "Claude Code");
  state.entries[0].displayName = "Different";
  state.entries[0].agentSessionId = "different";
  state.entries[0].agentKey = "Someone/different";
  assert.equal(resolver.value(message()), "Supervisor worker");
  state.entries = [{ displayName: "GardenSignal", provider: "cursor", agentKey: null, agentSessionId: null } as DesktopSupervisorManifestEntry];
  assert.equal(resolver.value(message()), "Cursor");
  assert.equal(builds, 4);
});

test("resolving a loaded history reads provider rosters once instead of once per message", () => {
  let reads = 0;
  const entries = Array.from({ length: 100 }, (_, index) => ({
    displayName: `Agent ${index}`, agentKey: `owner/key_${index}`, provider: "codex",
    get agentSessionId() { reads++; return `session_${index}`; },
  })) as DesktopSupervisorManifestEntry[];
  const resolve = createMessageProviderLabelResolver([], [], entries);
  assert.equal(reads, 100);
  for (let index = 0; index < 750; index++) {
    assert.equal(resolve(message({ agentSessionId: `session_${index % 100}` })), "Codex");
  }
  assert.equal(reads, 100);
});
