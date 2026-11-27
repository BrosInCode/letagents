import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopAgentPresence, DesktopParticipantSummary, DesktopSupervisorManifestEntry } from "../../electron/ipc-types";
import { FRIENDLY_AGENT_NAMES } from "../../../../shared/agent-names.mjs";
import { freeAgentName, heldNameMatch, heldNameMessage, roomHeldNames } from "../src/domain/room-held-names";

const ROOM = "welcome-room";

function participant(overrides: Partial<DesktopParticipantSummary>): DesktopParticipantSummary {
  return {
    participantKey: `key:${overrides.displayName}`, kind: "agent", displayName: "Someone", actorLabel: null,
    agentKey: null, githubLogin: null, ownerLabel: null, ideLabel: null, hiddenAt: null, activityState: "active",
    lastSeenAt: "2026-11-27T10:00:00.000Z", lastRoomActivityAt: null, lastLiveHeartbeatAt: null, sourceFlags: [],
    ...overrides,
  };
}

function presence(overrides: Partial<DesktopAgentPresence>): DesktopAgentPresence {
  return {
    roomId: ROOM, actorLabel: "x", agentKey: null, agentInstanceId: null, agentSessionId: null, sessionKind: "worker",
    runtime: "codex", displayName: "Someone", ownerLabel: null, ideLabel: null, repoBranch: null, status: "idle",
    statusText: null, lastHeartbeatAt: "2026-11-27T10:00:00.000Z", freshness: "active", activityState: "active",
    sourceFlags: ["delivery"], livenessObservation: null as unknown as DesktopAgentPresence["livenessObservation"],
    ...overrides,
  } as DesktopAgentPresence;
}

function entry(overrides: Partial<DesktopSupervisorManifestEntry>): DesktopSupervisorManifestEntry {
  return { id: "entry-1", roomId: ROOM, displayName: "Atlas", desiredState: "stopped", observedState: "stopped", ...overrides } as DesktopSupervisorManifestEntry;
}

test("people hold their display name and login; agents with a known state hold theirs; hidden people and history-only agents hold nothing", () => {
  const held = roomHeldNames({
    roomIdentifier: ROOM,
    participants: [
      participant({ kind: "human", displayName: "Emmy May", githubLogin: "EmmyMay", activityState: null }),
      participant({ kind: "human", displayName: "Left", githubLogin: "left", hiddenAt: "2026-11-01T00:00:00.000Z" }),
      participant({ kind: "agent", displayName: "OldHelper", activityState: "offline" }),
      participant({ kind: "agent", displayName: "Historic", activityState: null }),
      participant({ kind: "agent", displayName: "Scout", activityState: "away" }),
    ],
    presence: [],
    entries: [],
  });
  assert.deepEqual(held, [
    { name: "Emmy May", holder: "person" },
    { name: "EmmyMay", holder: "person" },
    { name: "OldHelper", holder: "agent" },
    { name: "Scout", holder: "agent" },
  ]);
});

test("an agent saved on this computer holds its name even while stopped; other rooms do not count", () => {
  const held = roomHeldNames({
    roomIdentifier: ROOM,
    participants: [],
    presence: [
      presence({ displayName: "Nova" }),
      presence({ displayName: "Elsewhere", roomId: "other-room" }),
      presence({ displayName: "Offline", activityState: "offline" }),
    ],
    entries: [entry({ displayName: "Atlas" }), entry({ id: "entry-2", displayName: "Milo", roomId: "other-room" })],
  });
  assert.deepEqual(held.map((name) => name.name), ["Nova", "Atlas"]);
});

test("a name matches a held name the way @mentions match, in any spelling", () => {
  const held = [{ name: "Atlas", holder: "agent" as const }, { name: "EmmyMay", holder: "person" as const }];
  assert.equal(heldNameMatch("atlas", held)?.name, "Atlas");
  assert.equal(heldNameMatch("  ATLAS ", held)?.name, "Atlas");
  assert.equal(heldNameMatch("Emmy May", held)?.holder, "person");
  assert.equal(heldNameMatch("Atlas2", held), null);
  assert.equal(heldNameMatch("", held), null);
});

test("the warning names who holds the name", () => {
  assert.equal(heldNameMessage({ name: "Atlas", holder: "agent" }), "An agent named Atlas is already in this room. Choose another name.");
  assert.equal(heldNameMessage({ name: "EmmyMay", holder: "person" }), "EmmyMay is a person in this room. Choose another name.");
});

test("the default name is the first free friendly name, then a free codename", () => {
  assert.equal(freeAgentName([], "seed"), "Atlas");
  assert.equal(freeAgentName([{ name: "Atlas", holder: "agent" }], "seed"), "Scout");
  const allFriendly = FRIENDLY_AGENT_NAMES.map((name) => ({ name, holder: "agent" as const }));
  const replacement = freeAgentName(allFriendly, "seed");
  assert.equal(heldNameMatch(replacement, allFriendly), null);
  assert.match(replacement, /^[A-Z][a-z]+[A-Z][a-z]+$/, "a two-word codename");
  assert.equal(freeAgentName(allFriendly, "seed"), replacement, "the same seed gives the same name");
});
