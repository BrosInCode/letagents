import assert from "node:assert/strict";
import test from "node:test";

import type { StalledRoomCandidate } from "../db/coordination/room-stall.js";
import {
  buildRoomStallNudgeText,
  createRoomStallSweeper,
  evaluateRoomStall,
  ROOM_STALL_AFTER_MS,
  type RoomStallSweeperDeps,
} from "../rooms/room-stall-sweep.js";

const NOW = Date.parse("2026-07-14T00:00:00.000Z");

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function candidate(overrides: Partial<StalledRoomCandidate> = {}): StalledRoomCandidate {
  return {
    room_id: overrides.room_id ?? "focus_34",
    last_closed_at: overrides.last_closed_at ?? isoMinutesAgo(45),
    stall_nudged_at: overrides.stall_nudged_at ?? null,
    manager_mode: overrides.manager_mode ?? "manager_optional",
  };
}

test("evaluateRoomStall verdicts", () => {
  const base = { manager_reachable: false, live_worker_count: 2, now: NOW };

  assert.deepEqual(
    evaluateRoomStall({ candidate: candidate(), ...base }),
    { stalled: true, epoch: isoMinutesAgo(45) }
  );
  assert.equal(
    evaluateRoomStall({ candidate: candidate(), ...base, manager_reachable: true }).stalled,
    false,
    "a reachable manager owns next-task creation"
  );
  assert.equal(
    evaluateRoomStall({ candidate: candidate(), ...base, live_worker_count: 0 }).stalled,
    false,
    "no live workers means no audience to nudge"
  );
  assert.equal(
    evaluateRoomStall({ candidate: candidate({ last_closed_at: isoMinutesAgo(10) }), ...base }).stalled,
    false,
    "inside the stall threshold"
  );
  assert.equal(
    evaluateRoomStall({
      candidate: candidate({ stall_nudged_at: isoMinutesAgo(20) }),
      ...base,
    }).stalled,
    false,
    "already nudged for this drain epoch"
  );
  assert.equal(
    evaluateRoomStall({
      candidate: candidate({ stall_nudged_at: isoMinutesAgo(120), last_closed_at: isoMinutesAgo(45) }),
      ...base,
    }).stalled,
    true,
    "a newer drain epoch re-arms a previously nudged room"
  );
  assert.ok(ROOM_STALL_AFTER_MS > 0);
});

test("nudge text names live workers and falls back gracefully", () => {
  const named = buildRoomStallNudgeText({
    stalled_for_ms: 45 * 60_000,
    live_worker_labels: [
      "RiverGrove | EmmyMay's agent | Claude Code",
      "RiverRidge | EmmyMay's agent | Codex",
      "Third | X | Y",
    ],
    manager_mode: "manager_optional",
  });
  assert.ok(named.includes("empty for 45m"));
  assert.ok(named.includes("RiverGrove and RiverRidge"));
  assert.ok(!named.includes("Third"));
  assert.ok(named.includes("auto-approve when no manager responds"));

  const anonymous = buildRoomStallNudgeText({
    stalled_for_ms: 31 * 60_000,
    live_worker_labels: [],
    manager_mode: "manager_optional",
  });
  assert.ok(anonymous.includes("any available agent"));

  // intent_required rooms must not be promised auto-approval.
  const humanGated = buildRoomStallNudgeText({
    stalled_for_ms: 31 * 60_000,
    live_worker_labels: [],
    manager_mode: "intent_required",
  });
  assert.ok(!humanGated.includes("auto-approve"));
  assert.ok(humanGated.includes("room admin will need to decide"));
});

interface FakeDepsOptions {
  candidates: StalledRoomCandidate[];
  reachableManagerRooms?: Set<string>;
  liveWorkers?: string[];
  announceResult?: boolean;
  failForRoom?: string;
}

function buildFakeDeps(options: FakeDepsOptions) {
  const nudges: Array<{ roomId: string; epoch: string; text: string; clientMessageId: string }> = [];
  const deps: RoomStallSweeperDeps = {
    listStalledRooms: async () => options.candidates,
    hasReachableManager: async (roomId) => {
      if (options.failForRoom === roomId) {
        throw new Error("manager lookup failed");
      }
      return options.reachableManagerRooms?.has(roomId) ?? false;
    },
    listLiveWorkerLabels: async () => options.liveWorkers ?? ["RiverGrove | EmmyMay's agent | Claude Code"],
    announceStall: async (input) => {
      nudges.push({
        roomId: input.room_id,
        epoch: input.epoch,
        text: input.text,
        clientMessageId: input.client_message_id,
      });
      return options.announceResult ?? true;
    },
    now: () => NOW,
  };
  return { deps, nudges };
}

test("sweepOnce nudges a stalled room with an epoch-stable client message id", async () => {
  const fake = buildFakeDeps({ candidates: [candidate()] });
  const summary = await createRoomStallSweeper(fake.deps).sweepOnce();

  assert.equal(summary.nudged, 1);
  assert.equal(fake.nudges.length, 1);
  assert.equal(fake.nudges[0]?.clientMessageId, `room_stall:focus_34:${isoMinutesAgo(45)}`);
  assert.ok(fake.nudges[0]!.text.includes("RiverGrove"));
});

test("sweepOnce settles the fence and threshold before any per-room lookups", async () => {
  let lookups = 0;
  const fake = buildFakeDeps({ candidates: [candidate({ stall_nudged_at: isoMinutesAgo(20) })] });
  const deps: RoomStallSweeperDeps = {
    ...fake.deps,
    hasReachableManager: async (roomId) => {
      lookups += 1;
      return fake.deps.hasReachableManager(roomId);
    },
  };
  const summary = await createRoomStallSweeper(deps).sweepOnce();

  assert.equal(summary.nudged, 0);
  assert.equal(lookups, 0, "an already-nudged epoch must skip the manager lookup entirely");
});

test("sweepOnce leaves managed, staffed-by-nobody, and lost-fence rooms alone", async () => {
  const managed = buildFakeDeps({
    candidates: [candidate()],
    reachableManagerRooms: new Set(["focus_34"]),
  });
  assert.equal((await createRoomStallSweeper(managed.deps).sweepOnce()).nudged, 0);
  assert.deepEqual(managed.nudges, []);

  const unstaffed = buildFakeDeps({ candidates: [candidate()], liveWorkers: [] });
  assert.equal((await createRoomStallSweeper(unstaffed.deps).sweepOnce()).nudged, 0);

  const lostFence = buildFakeDeps({ candidates: [candidate()], announceResult: false });
  assert.equal((await createRoomStallSweeper(lostFence.deps).sweepOnce()).nudged, 0);
});

test("sweepOnce isolates per-room failures", async () => {
  const fake = buildFakeDeps({
    candidates: [candidate({ room_id: "focus_broken" }), candidate()],
    failForRoom: "focus_broken",
  });
  const summary = await createRoomStallSweeper(fake.deps).sweepOnce();

  assert.equal(summary.rooms_with_errors, 1);
  assert.equal(summary.nudged, 1);
});
