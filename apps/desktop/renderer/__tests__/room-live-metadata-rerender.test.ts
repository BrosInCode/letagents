import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computed, effectScope, nextTick, ref, watch } from "vue";

import type { DesktopRoomLiveMetadata, DesktopRoomSnapshot } from "../../electron/ipc-types";
import { applyRoomLiveMetadata } from "../src/domain/desktop-room-snapshots";

const ROOM = "room_measure";
const TICKS = 20;

/**
 * Measurement: an EQUAL live-metadata payload (a fresh deep copy each tick, as
 * IPC delivers it) must not make consumers of the snapshot recompute or
 * re-render. The consumers below mirror what room views do: one computed per
 * section plus one watcher standing in for a component render.
 */
describe("equal live metadata ticks do not re-render snapshot consumers", () => {
  it("keeps computed and render counts at their initial values", async () => {
    const selectedSnapshot = ref<DesktopRoomSnapshot | null>(baseSnapshot());
    const counts = { participants: 0, presence: 0, activity: 0, focus: 0, board: 0, states: 0, render: 0 };
    const scope = effectScope();
    scope.run(() => {
      const participants = computed(() => { counts.participants += 1; return selectedSnapshot.value?.participants.map((p) => p.participantKey) ?? []; });
      const presence = computed(() => { counts.presence += 1; return selectedSnapshot.value?.presence.length ?? 0; });
      const activity = computed(() => { counts.activity += 1; return selectedSnapshot.value?.recentActivity.length ?? 0; });
      const focus = computed(() => { counts.focus += 1; return selectedSnapshot.value?.focusRooms.length ?? 0; });
      const board = computed(() => { counts.board += 1; return selectedSnapshot.value?.boardSettings.managerMode; });
      const states = computed(() => { counts.states += 1; return selectedSnapshot.value?.sourceStates.presence.status; });
      // A component render reads the section arrays by identity, like a child prop.
      watch(
        () => [
          selectedSnapshot.value?.participants, selectedSnapshot.value?.presence,
          selectedSnapshot.value?.recentActivity, selectedSnapshot.value?.focusRooms,
          selectedSnapshot.value?.boardSettings, selectedSnapshot.value?.sourceStates,
        ],
        () => { counts.render += 1; },
        { flush: "sync" },
      );
      // Computeds are lazy: keep them subscribed, as a mounted view would.
      watch([participants, presence, activity, focus, board, states], () => undefined, { flush: "sync" });
    });
    // Touch every computed once so the initial evaluation is counted.
    await nextTick();
    const initial = { ...counts };
    for (let tick = 0; tick < TICKS; tick += 1) {
      // Same call shape as useDesktopRoomLiveSync's periodic tick.
      selectedSnapshot.value = applyRoomLiveMetadata(selectedSnapshot.value, structuredClone(metadata()));
      await nextTick();
    }
    const delta = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v - initial[k as keyof typeof counts]]));
    console.log(`MEASURE equal ticks=${TICKS} extra evaluations:`, JSON.stringify(delta));
    assert.deepEqual(delta, { participants: 0, presence: 0, activity: 0, focus: 0, board: 0, states: 0, render: 0 });
    scope.stop();
  });
});

function ready() { return { status: "ready" as const, error: null }; }

function metadata(): DesktopRoomLiveMetadata {
  return {
    roomIdentifier: ROOM,
    focusRooms: Array.from({ length: 5 }, (_, i) => ({ identifier: `focus_${i}`, displayName: `Focus ${i}` })) as unknown as DesktopRoomLiveMetadata["focusRooms"],
    participants: Array.from({ length: 40 }, (_, i) => ({ participantKey: `p${i}`, displayName: `Person ${i}`, nested: { roles: ["a", "b"] } })) as unknown as DesktopRoomLiveMetadata["participants"],
    participantHiddenCount: 0,
    presence: Array.from({ length: 40 }, (_, i) => ({ participantKey: `p${i}`, status: "online", lastSeenAt: "2026-10-19T00:00:00.000Z" })) as unknown as DesktopRoomLiveMetadata["presence"],
    recentActivity: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, text: `did ${i}` })) as unknown as DesktopRoomLiveMetadata["recentActivity"],
    boardSettings: { managerMode: "manager_optional", activeManager: null, pendingIntentCount: 0 },
    sourceStates: {
      focusRooms: ready(), participants: ready(), presence: ready(), activityHistory: ready(), boardSettings: ready(),
    },
  };
}

function baseSnapshot(): DesktopRoomSnapshot {
  const m = structuredClone(metadata());
  return {
    roomIdentifier: ROOM,
    room: { identifier: ROOM, code: "", name: ROOM, displayName: ROOM },
    focusRooms: m.focusRooms, tasks: [], participants: m.participants, participantHiddenCount: 0,
    presence: m.presence, reasoningSessions: [], recentActivity: m.recentActivity, roomArtifacts: [],
    messages: [], githubEvents: null, boardSettings: m.boardSettings,
    sourceStates: { ...m.sourceStates, tasks: ready(), reasoning: ready(), roomArtifacts: ready(), messages: ready(), githubEvents: ready() },
  } as unknown as DesktopRoomSnapshot;
}
