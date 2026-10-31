import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type { DesktopAgentPresence } from "../../electron/ipc-types";
import { useAgentPresenceChips } from "../src/composables/useAgentPresenceChips";
import {
  advancePresenceTracker,
  createPresenceTracker,
  mergePresenceChips,
  PRESENCE_CHIP_LIMIT,
  PRESENCE_CHIP_SETTLE_MS,
  PRESENCE_CHIP_VISIBLE_MS,
  PRESENCE_DISCONNECT_CONFIRM_MS,
  reachableAgents,
  type PresenceChip,
} from "../src/domain/presence-chips";

function presence(name: string, overrides: Partial<DesktopAgentPresence> = {}): DesktopAgentPresence {
  return {
    roomId: "room_1",
    actorLabel: `${name} | EmmyMay's agent | Claude Code`,
    agentKey: `EmmyMay/${name.toLowerCase()}`,
    agentInstanceId: null,
    agentSessionId: `session_${name}`,
    sessionKind: "worker",
    runtime: "claude-code",
    displayName: name,
    ownerLabel: "EmmyMay",
    ideLabel: "Claude Code",
    repoBranch: null,
    status: "idle",
    statusText: null,
    lastHeartbeatAt: new Date().toISOString(),
    freshness: "active",
    activityState: "away",
    sourceFlags: ["delivery"],
    livenessObservation: null,
    ...overrides,
  } as DesktopAgentPresence;
}

test("only reachable workers count as connected, keyed by the room name", () => {
  const agents = reachableAgents([
    presence("MossDawn"),
    presence("MossDawn", { agentSessionId: "session_new", agentKey: null }),
    presence("Stale", { freshness: "stale" }),
    presence("Controller", { sessionKind: "controller" }),
    presence("NoChannel", { sourceFlags: ["messages"] }),
  ]);
  assert.deepEqual([...agents.keys()], ["mossdawn"]);
  assert.equal(agents.get("mossdawn")?.displayName, "MossDawn");
});

test("a reconnect under a new session, or a source without the agent key, is the same agent", () => {
  const tracker = createPresenceTracker(reachableAgents([presence("MossDawn")]));
  const after = reachableAgents([presence("MossDawn", { agentSessionId: "session_new", agentKey: null })]);
  assert.deepEqual(advancePresenceTracker(tracker, after, 0), []);
});

test("a connect is reported at once; a disconnect only after the agent stays away", () => {
  const names = (changes: ReturnType<typeof advancePresenceTracker>) =>
    changes.map((change) => `${change.agent.displayName}:${change.kind}`);
  const tracker = createPresenceTracker(reachableAgents([presence("MossDawn"), presence("NobleMoon")]));

  // One refresh without MossDawn (a failed fetch, a busy agent) says nothing.
  const without = reachableAgents([presence("NobleMoon"), presence("TimberBadger")]);
  assert.deepEqual(names(advancePresenceTracker(tracker, without, 1_000)), ["TimberBadger:connected"]);
  assert.deepEqual(names(advancePresenceTracker(tracker, without, 1_000 + PRESENCE_DISCONNECT_CONFIRM_MS - 1)), []);
  assert.deepEqual(
    names(advancePresenceTracker(tracker, without, 1_000 + PRESENCE_DISCONNECT_CONFIRM_MS)),
    ["MossDawn:disconnected"],
  );

  // A whole roster vanishing for one refresh and coming back shows no chips.
  const all = reachableAgents([presence("NobleMoon"), presence("TimberBadger")]);
  assert.deepEqual(names(advancePresenceTracker(tracker, new Map(), 60_000)), []);
  assert.deepEqual(names(advancePresenceTracker(tracker, all, 75_000)), []);
  assert.deepEqual(names(advancePresenceTracker(tracker, all, 200_000)), []);
});

test("an agent has one chip and the row is capped", () => {
  const chip = (key: string, kind: PresenceChip["kind"], id: string): PresenceChip =>
    ({ id, key, kind, displayName: key, ideLabel: null, agentKey: null });
  const flapped = mergePresenceChips([chip("a", "disconnected", "1")], [chip("a", "connected", "2")]);
  assert.deepEqual(flapped.map((entry) => entry.id), ["2"]);
  const many = mergePresenceChips([], ["a", "b", "c", "d", "e"].map((key, index) => chip(key, "connected", String(index))));
  assert.equal(many.length, PRESENCE_CHIP_LIMIT);
  assert.equal(many.at(-1)?.key, "e");
});

test("chips appear for changes after the room settles and dismiss themselves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const list = ref<DesktopAgentPresence[]>([presence("MossDawn")]);
  const room = ref<string | null>("room_1");
  const ready = ref(false);
  const scope = effectScope();
  const { chips } = scope.run(() => useAgentPresenceChips({
    presence: () => list.value,
    scope: () => room.value,
    ready: () => ready.value,
  }))!;

  // The roster a room opens with announces nobody, even if it arrives in pieces.
  ready.value = true;
  await nextTick();
  list.value = [presence("MossDawn"), presence("NobleMoon")];
  await nextTick();
  assert.deepEqual(chips.value, []);

  t.mock.timers.tick(PRESENCE_CHIP_SETTLE_MS + 1);
  list.value = [presence("MossDawn"), presence("NobleMoon"), presence("TimberBadger")];
  await nextTick();
  assert.deepEqual(chips.value.map((chip) => `${chip.displayName}:${chip.kind}`), ["TimberBadger:connected"]);
  t.mock.timers.tick(PRESENCE_CHIP_VISIBLE_MS + 1);
  assert.deepEqual(chips.value, [], "a chip dismisses itself");

  // MossDawn goes missing: nothing yet, then a chip once it has stayed away.
  list.value = [presence("NobleMoon"), presence("TimberBadger")];
  await nextTick();
  assert.deepEqual(chips.value, []);
  // Confirmed by time alone: no further refresh has to arrive.
  t.mock.timers.tick(PRESENCE_DISCONNECT_CONFIRM_MS);
  assert.deepEqual(chips.value.map((chip) => `${chip.displayName}:${chip.kind}`), ["MossDawn:disconnected"]);
  t.mock.timers.tick(PRESENCE_CHIP_VISIBLE_MS + 1);
  assert.deepEqual(chips.value, []);

  // Switching rooms starts over: the new room's roster is a baseline again.
  room.value = "room_2";
  list.value = [presence("Elsewhere")];
  await nextTick();
  assert.deepEqual(chips.value, []);
  scope.stop();
});
