import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyLaneCoordinator,
  type LegacyLaneProcessIdentity,
  type ReserveLegacyLaneInput,
} from "../legacy-lane-coordinator.js";
import type { DaemonManifest, DaemonManifestEntry, LegacyLaneOwner } from "../types.js";

const fixedNow = "2026-08-26T15:00:00.000Z";

test("reserve validates the public request shape before entering mutation authority", async () => {
  const harness = coordinator();
  const base = reserveInput("reservation", "room", "codex");

  await assert.rejects(() => harness.subject.reserve({ ...base, reservation_id: " " }), /reservation_id is required/);
  await assert.rejects(() => harness.subject.reserve({ ...base, room_id: "" }), /room_id is required/);
  await assert.rejects(() => harness.subject.reserve({ ...base, provider: "" }), /provider is required/);
  await assert.rejects(() => harness.subject.reserve({ ...base, owner_pid: 0 }), /owner_pid is required/);
  await assert.rejects(() => harness.subject.reserve({ ...base, owner_process_identity: " " }), /owner_process_identity is required/);
  assert.equal(harness.serializeCalls, 0);
});

test("reserve commits one generation-fenced owner and exact retries are idempotent", async () => {
  const harness = coordinator({ generation: 7 });
  const input = reserveInput("reservation", "room", "codex");

  assert.deepEqual(await harness.subject.reserve(input), owner({
    reservation_id: "reservation",
    room_id: "room",
    provider: "codex",
  }));
  assert.deepEqual(harness.writeGenerations, [7]);
  assert.equal(harness.acceptedGeneration, 8);

  const duplicate = await harness.subject.reserve(input);
  assert.equal(duplicate.reservation_id, "reservation");
  assert.deepEqual(harness.writeGenerations, [7], "an exact lost-response retry must not rewrite the manifest");

  await assert.rejects(
    () => harness.subject.reserve({ ...input, room_id: "different" }),
    /already bound to another lane/,
  );
  await assert.rejects(
    () => harness.subject.reserve({ ...input, owner_pid: 99 }),
    /belongs to another Electron process/,
  );
});

test("reserve rejects supervised and live legacy lane owners", async () => {
  const supervised = coordinator({
    entries: [entry("supervised", "room", "codex", "running", "working")],
  });
  await assert.rejects(
    () => supervised.subject.reserve(reserveInput("legacy", "room", "codex")),
    /already owned by supervised entry 'supervised'/,
  );
  assert.equal(supervised.writes, 0);

  const legacy = coordinator({ owners: [owner({ reservation_id: "existing" })] });
  await assert.rejects(
    () => legacy.subject.reserve(reserveInput("new", "room", "codex")),
    /already owned by legacy reservation 'existing'/,
  );
  assert.equal(legacy.writes, 0);

  const stoppedSupervised = coordinator({
    entries: [entry("stopped", "room", "codex", "stopped", "stopped")],
  });
  assert.equal((await stoppedSupervised.subject.reserve(reserveInput("allowed", "room", "codex"))).reservation_id, "allowed");
});

test("reserve prunes dead reservations while retaining active owners", async () => {
  const harness = coordinator({
    owners: [
      owner({ reservation_id: "dead", owner_pid: 44, owner_process_identity: "dead-birth" }),
      owner({ reservation_id: "active", room_id: "other", owner_pid: 45, owner_process_identity: "dead-birth", state: "active", session_id: "session" }),
    ],
    processIdentity: identities(new Map([[44, "different-birth"], [45, "different-birth"], [71, "birth-71"]])),
  });

  await harness.subject.reserve(reserveInput("replacement", "room", "codex"));
  assert.deepEqual(harness.manifest.legacy_lane_owners?.map((candidate) => candidate.reservation_id), ["active", "replacement"]);
});

test("process liveness uses the stable birth identity and fails closed on unknown evidence", () => {
  let probeError: NodeJS.ErrnoException | null = null;
  let probeCalls = 0;
  const processIdentity: LegacyLaneProcessIdentity = {
    readBirthIdentity(pid) {
      if (pid === 1) return "Wed Jul 16  02:22:00 2026";
      if (pid === 2) return "Wed Jul 16 09:00:00 2026";
      throw new Error("ps unavailable");
    },
    probe() {
      probeCalls += 1;
      if (probeError) throw probeError;
    },
    sameBirthIdentity(actual, expected) {
      return actual.replace(/\s+/g, " ") === expected.replace(/\s+/g, " ");
    },
  };
  const harness = coordinator({ processIdentity });

  assert.equal(harness.subject.isProcessOwnerLive(1, "Wed Jul 16 02:22:00 2026"), true);
  assert.equal(harness.subject.isProcessOwnerLive(2, "Wed Jul 16 02:22:00 2026"), false);
  assert.equal(probeCalls, 0, "a proven birth mismatch must not fall back to pid-only evidence");
  assert.equal(harness.subject.isProcessOwnerLive(3, "unknown"), true);

  probeError = Object.assign(new Error("not permitted"), { code: "EPERM" });
  assert.equal(harness.subject.isProcessOwnerLive(3, "unknown"), true);
  probeError = Object.assign(new Error("gone"), { code: "ESRCH" });
  assert.equal(harness.subject.isProcessOwnerLive(3, "unknown"), false);
});

test("activate prunes dead duplicates, binds the exact reservation, and fences another session", async () => {
  const harness = coordinator({
    generation: 12,
    owners: [
      owner({ reservation_id: "target" }),
      owner({ reservation_id: "dead", room_id: "other", owner_pid: 88, owner_process_identity: "dead" }),
    ],
    processIdentity: identities(new Map([[71, "birth-71"], [88, "different"]])),
  });

  const activated = await harness.subject.activate("target", "session");
  assert.equal(activated.state, "active");
  assert.equal(activated.session_id, "session");
  assert.deepEqual(harness.writeGenerations, [12]);
  assert.deepEqual(harness.manifest.legacy_lane_owners?.map((candidate) => candidate.reservation_id), ["target"]);

  await assert.rejects(
    () => harness.subject.activate("target", "other-session"),
    /already active for another session/,
  );
  assert.deepEqual(harness.writeGenerations, [12]);

  const sameSession = await harness.subject.activate("target", "session");
  assert.equal(sameSession.session_id, "session");
  assert.deepEqual(harness.writeGenerations, [12, 13], "same-session activation preserves the existing rewrite behavior");
  await assert.rejects(() => harness.subject.activate("", "session"), /reservation and session ids are required/);
});

test("release preserves OR matching, input trimming, no-op responses, and generation CAS", async () => {
  const harness = coordinator({
    generation: 3,
    owners: [
      owner({ reservation_id: "by-reservation" }),
      owner({ reservation_id: "by-session", room_id: "two", session_id: "session", state: "active" }),
      owner({ reservation_id: "by-lane", room_id: "three", provider: "cursor" }),
    ],
  });

  assert.deepEqual(await harness.subject.release({
    reservation_id: " by-reservation ", session_id: null, room_id: null, provider: null,
  }), { released: true });
  assert.deepEqual(await harness.subject.release({
    reservation_id: null, session_id: " session ", room_id: null, provider: null,
  }), { released: true });
  assert.deepEqual(await harness.subject.release({
    reservation_id: null, session_id: null, room_id: " three ", provider: " cursor ",
  }), { released: true });
  assert.deepEqual(harness.writeGenerations, [3, 4, 5]);

  assert.deepEqual(await harness.subject.release({
    reservation_id: "missing", session_id: null, room_id: null, provider: null,
  }), { released: false });
  assert.deepEqual(harness.writeGenerations, [3, 4, 5]);
  await assert.rejects(
    () => harness.subject.release({ reservation_id: null, session_id: null, room_id: "three", provider: null }),
    /complete room\/provider lane is required/,
  );
});

test("orphan recovery commits only when a dead reserved owner is removed", async () => {
  const harness = coordinator({
    generation: 21,
    owners: [
      owner({ reservation_id: "live", owner_pid: 71, owner_process_identity: "birth-71" }),
      owner({ reservation_id: "dead", room_id: "two", owner_pid: 72, owner_process_identity: "birth-72" }),
      owner({ reservation_id: "active", room_id: "three", owner_pid: 73, owner_process_identity: "birth-73", state: "active", session_id: "session" }),
    ],
    processIdentity: identities(new Map([[71, "birth-71"], [72, "recycled"], [73, "recycled"]])),
  });

  await harness.subject.recoverOrphanedReservations();
  assert.deepEqual(harness.writeGenerations, [21]);
  assert.deepEqual(harness.manifest.legacy_lane_owners?.map((candidate) => candidate.reservation_id), ["live", "active"]);

  await harness.subject.recoverOrphanedReservations();
  assert.deepEqual(harness.writeGenerations, [21], "a fully live owner set must not bump the manifest generation");
});

test("serialized concurrent reservations consume successive manifest generations", async () => {
  const harness = coordinator({ generation: 30 });

  await Promise.all([
    harness.subject.reserve(reserveInput("one", "one", "codex")),
    harness.subject.reserve(reserveInput("two", "two", "codex")),
  ]);

  assert.deepEqual(harness.writeGenerations, [30, 31]);
  assert.equal(harness.manifest.generation, 32);
  assert.deepEqual(harness.manifest.legacy_lane_owners?.map((candidate) => candidate.reservation_id), ["one", "two"]);
});

type CoordinatorOptions = {
  generation?: number;
  entries?: DaemonManifestEntry[];
  owners?: LegacyLaneOwner[];
  processIdentity?: LegacyLaneProcessIdentity;
};

function coordinator(options: CoordinatorOptions = {}) {
  let mutation = Promise.resolve();
  const harness = {
    manifest: {
      generation: options.generation ?? 0,
      entries: options.entries ?? [],
      ...(options.owners?.length ? { legacy_lane_owners: options.owners } : {}),
    } as DaemonManifest,
    acceptedGeneration: options.generation ?? 0,
    writeGenerations: [] as number[],
    writes: 0,
    serializeCalls: 0,
    assertCurrentCalls: 0,
    subject: null as unknown as LegacyLaneCoordinator,
  };
  harness.subject = new LegacyLaneCoordinator({
    storage: {
      load: async () => harness.manifest,
    },
    commit: {
      currentGeneration: () => harness.acceptedGeneration,
      write: async (expectedGeneration, entries, owners) => {
        harness.writes += 1;
        harness.writeGenerations.push(expectedGeneration);
        assert.equal(expectedGeneration, harness.manifest.generation, "write must compare-and-set the loaded generation");
        harness.manifest = {
          generation: expectedGeneration + 1,
          entries,
          ...(owners.length ? { legacy_lane_owners: owners } : {}),
        };
        return { generation: harness.manifest.generation };
      },
      acceptGeneration: (generation) => {
        harness.acceptedGeneration = generation;
      },
    },
    authority: {
      serialize: async <T>(operation: () => Promise<T>): Promise<T> => {
        harness.serializeCalls += 1;
        const previous = mutation;
        let release!: () => void;
        mutation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          harness.assertCurrentCalls += 1;
          return await operation();
        } finally {
          release();
        }
      },
      assertCurrent: async () => {
        harness.assertCurrentCalls += 1;
      },
    },
    processIdentity: options.processIdentity ?? identities(new Map([[71, "birth-71"]])),
    isSupervisedLaneOwner: (candidate) => !(
      candidate.desired_state === "stopped" && candidate.observed_state === "stopped"
    ),
    now: () => fixedNow,
  });
  return harness;
}

function identities(values: Map<number, string>): LegacyLaneProcessIdentity {
  return {
    readBirthIdentity(pid) {
      return values.get(pid) ?? `birth-${pid}`;
    },
    probe() {},
    sameBirthIdentity(actual, expected) {
      return actual === expected;
    },
  };
}

function reserveInput(reservationId: string, roomId: string, provider: string): ReserveLegacyLaneInput {
  return {
    reservation_id: reservationId,
    room_id: roomId,
    provider,
    owner_pid: 71,
    owner_process_identity: "birth-71",
  };
}

function owner(overrides: Partial<LegacyLaneOwner> = {}): LegacyLaneOwner {
  return {
    reservation_id: "existing",
    room_id: "room",
    provider: "codex",
    owner_pid: 71,
    owner_process_identity: "birth-71",
    state: "reserved",
    session_id: null,
    created_at: fixedNow,
    updated_at: fixedNow,
    ...overrides,
  };
}

function entry(
  id: string,
  roomId: string,
  provider: string,
  desiredState: DaemonManifestEntry["desired_state"],
  observedState: DaemonManifestEntry["observed_state"],
): DaemonManifestEntry {
  return {
    id,
    room_id: roomId,
    display_name: id,
    provider,
    model: null,
    charter: "test",
    desired_state: desiredState,
    observed_state: observedState,
    condition: "none",
    permission_profile_id: null,
    created_by: "test",
    created_at: fixedNow,
  };
}
