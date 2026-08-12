/**
 * Tests for the Quota Lease orchestrator (p2.9b).
 *
 * Covers:
 *   acquireLease:
 *     - happy path → ok / available + lease persisted + lease_created emitted
 *     - lane_locked when another session holds the lane → ok=false, conflictingSessionId
 *     - same_session re-entry → ok=true, lease refreshed, NO duplicate event
 *     - released leases are ignored when scanning
 *     - invalid_lane → ok=false
 *
 *   releaseSessionLease:
 *     - no current lease → released=false, no emit
 *     - already-released lease → released=false, no emit
 *     - active lease → released=true, persisted, teardown event emitted
 *
 * Pure orchestration over the DI interface. No DB.
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  SESSION_LEASE_CREATED,
  SESSION_TEARDOWN_COMPLETED,
} from "../rental/activity-event-types.js";
import {
  QUOTA_LEASE_REASONS,
  createLease,
  type QuotaLane,
  type QuotaLease,
  type QuotaLeaseSnapshot,
} from "../rental/quota-lease.js";
import {
  acquireLease,
  releaseSessionLease,
  type QuotaLeaseOrchestratorDeps,
} from "../rental/quota-lease-orchestrator.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NOW = "2026-05-11T10:00:00.000Z";

function makeLane(
  overrides: Partial<QuotaLane> = {},
): QuotaLane {
  return {
    provider: "antigravity",
    model: "gemini-2.5-pro",
    quotaLaneId: "lane-a",
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<QuotaLeaseSnapshot> = {},
): QuotaLeaseSnapshot {
  return {
    nativeUnit: "tokens",
    nativeRemaining: 80_000,
    nativeResetAt: null,
    confidence: "local_exact",
    observedAt: NOW,
    ...overrides,
  };
}

interface PersistCall {
  sessionId: string;
  lease: QuotaLease;
}
interface EmitCall {
  sessionId: string;
  roomId: string;
  eventType:
    | typeof SESSION_LEASE_CREATED
    | typeof SESSION_TEARDOWN_COMPLETED;
  payload: Record<string, unknown>;
}

function makeDeps(input: {
  activeLeases?: QuotaLease[];
  sessionLease?: QuotaLease | null;
  nowIso?: string;
} = {}): QuotaLeaseOrchestratorDeps & {
  persisted: PersistCall[];
  emitted: EmitCall[];
} {
  const persisted: PersistCall[] = [];
  const emitted: EmitCall[] = [];
  return {
    persisted,
    emitted,
    async loadActiveLeasesForLane() {
      return input.activeLeases ?? [];
    },
    async loadSessionLease() {
      return input.sessionLease === undefined ? null : input.sessionLease;
    },
    async persistSessionLease(sessionId, lease) {
      persisted.push({ sessionId, lease });
    },
    async emitLeaseEvent(call) {
      emitted.push({
        sessionId: call.sessionId,
        roomId: call.roomId,
        eventType: call.eventType,
        payload: call.payload,
      });
    },
    now() {
      return input.nowIso ?? NOW;
    },
  };
}

// ---------------------------------------------------------------------------
// acquireLease
// ---------------------------------------------------------------------------

describe("acquireLease — happy path", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps({});
  });

  it("creates a lease and emits session.lease_created when the lane is available", async () => {
    const result = await acquireLease(
      {
        sessionId: "rsess_1",
        roomId: "room_1",
        lane: makeLane(),
        snapshot: makeSnapshot(),
      },
      deps,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reason, QUOTA_LEASE_REASONS.AVAILABLE);
    assert.equal(result.lease.sessionId, "rsess_1");
    assert.equal(result.lease.lockedAt, NOW);
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.persisted[0]!.lease.lockedAt, NOW);
    assert.equal(deps.emitted.length, 1);
    assert.equal(deps.emitted[0]!.eventType, SESSION_LEASE_CREATED);
    assert.deepEqual(
      (deps.emitted[0]!.payload as { lane: Record<string, unknown> }).lane,
      {
        provider: "antigravity",
        model: "gemini-2.5-pro",
        quota_lane_id: "lane-a",
      },
    );
  });

  it("persists without emitting when the session has no room yet", async () => {
    const result = await acquireLease(
      {
        sessionId: "rsess_pre_room",
        roomId: null,
        lane: makeLane(),
        snapshot: makeSnapshot(),
      },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.emitted.length, 0);
  });
});

describe("acquireLease — lane lock", () => {
  it("runs lease reads and writes through the locked dependency", async () => {
    const baseDeps = makeDeps({});
    const order: string[] = [];
    const lockedDeps: QuotaLeaseOrchestratorDeps = {
      ...baseDeps,
      async loadActiveLeasesForLane(lane) {
        order.push("locked:loadActiveLeasesForLane");
        return baseDeps.loadActiveLeasesForLane(lane);
      },
      async persistSessionLease(sessionId, lease) {
        order.push("locked:persistSessionLease");
        await baseDeps.persistSessionLease(sessionId, lease);
      },
      async emitLeaseEvent(input) {
        order.push("locked:emitLeaseEvent");
        await baseDeps.emitLeaseEvent(input);
      },
    };
    const deps: QuotaLeaseOrchestratorDeps = {
      ...baseDeps,
      async withLaneLock(_lane, body) {
        order.push("lock");
        return body(lockedDeps);
      },
    };

    const result = await acquireLease(
      {
        sessionId: "rsess_1",
        roomId: "room_1",
        lane: makeLane(),
        snapshot: makeSnapshot(),
      },
      deps,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(order, [
      "lock",
      "locked:loadActiveLeasesForLane",
      "locked:persistSessionLease",
      "locked:emitLeaseEvent",
    ]);
    assert.equal(baseDeps.persisted.length, 1);
    assert.equal(baseDeps.emitted.length, 1);
  });
});

describe("acquireLease — lane_locked", () => {
  it("rejects when another session holds an active lease on the same lane", async () => {
    const otherLease = createLease({
      sessionId: "rsess_other",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: "2026-05-11T09:00:00.000Z",
    });
    const deps = makeDeps({ activeLeases: [otherLease] });
    const result = await acquireLease(
      {
        sessionId: "rsess_new",
        roomId: "room_new",
        lane: makeLane(),
        snapshot: makeSnapshot(),
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, QUOTA_LEASE_REASONS.LANE_LOCKED);
    assert.equal(result.conflictingSessionId, "rsess_other");
    assert.equal(deps.persisted.length, 0);
    assert.equal(deps.emitted.length, 0);
  });
});

describe("acquireLease — same_session re-entry", () => {
  it("refreshes (persists) the lease but does NOT re-emit lease_created", async () => {
    const existing = createLease({
      sessionId: "rsess_1",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: "2026-05-11T09:00:00.000Z",
    });
    const deps = makeDeps({ activeLeases: [existing] });
    const result = await acquireLease(
      {
        sessionId: "rsess_1",
        roomId: "room_1",
        lane: makeLane(),
        snapshot: makeSnapshot({ nativeRemaining: 60_000 }),
      },
      deps,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reason, QUOTA_LEASE_REASONS.SAME_SESSION);
    assert.equal(deps.persisted.length, 1, "persist runs on re-entry");
    assert.equal(deps.persisted[0]!.lease.snapshot.nativeRemaining, 60_000);
    assert.equal(deps.emitted.length, 0, "no duplicate lease_created emission");
  });
});

describe("acquireLease — released leases are ignored", () => {
  it("treats released leases as not blocking new acquisitions", async () => {
    const released = createLease({
      sessionId: "rsess_old",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: "2026-05-11T08:00:00.000Z",
    });
    const releasedLease: QuotaLease = {
      ...released,
      releasedAt: "2026-05-11T08:30:00.000Z",
      releaseReason: "completed",
    };
    const deps = makeDeps({ activeLeases: [releasedLease] });
    const result = await acquireLease(
      {
        sessionId: "rsess_new",
        roomId: "room_1",
        lane: makeLane(),
        snapshot: makeSnapshot(),
      },
      deps,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reason, QUOTA_LEASE_REASONS.AVAILABLE);
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.emitted.length, 1);
  });
});

describe("acquireLease — invalid_lane", () => {
  it("rejects when the lane.provider is blank", async () => {
    const deps = makeDeps({});
    const result = await acquireLease(
      {
        sessionId: "rsess_1",
        roomId: "room_1",
        lane: makeLane({ provider: "" }),
        snapshot: makeSnapshot(),
      },
      deps,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, QUOTA_LEASE_REASONS.INVALID_LANE);
    assert.equal(deps.persisted.length, 0);
    assert.equal(deps.emitted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// releaseSessionLease
// ---------------------------------------------------------------------------

describe("releaseSessionLease — no current lease", () => {
  it("returns released=false and skips persist + emit", async () => {
    const deps = makeDeps({ sessionLease: null });
    const result = await releaseSessionLease(
      { sessionId: "rsess_1", roomId: "room_1", reason: "completed" },
      deps,
    );
    assert.equal(result.released, false);
    assert.equal(result.lease, null);
    assert.equal(deps.persisted.length, 0);
    assert.equal(deps.emitted.length, 0);
  });
});

describe("releaseSessionLease — already-released lease", () => {
  it("is idempotent: re-release returns released=false, no event", async () => {
    const original = createLease({
      sessionId: "rsess_1",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: NOW,
    });
    const released: QuotaLease = {
      ...original,
      releasedAt: "2026-05-11T11:00:00.000Z",
      releaseReason: "completed",
    };
    const deps = makeDeps({ sessionLease: released });
    const result = await releaseSessionLease(
      { sessionId: "rsess_1", roomId: "room_1", reason: "cancelled" },
      deps,
    );
    assert.equal(result.released, false);
    assert.equal(result.lease?.releaseReason, "completed");
    assert.equal(deps.persisted.length, 0);
    assert.equal(deps.emitted.length, 0);
  });
});

describe("releaseSessionLease — active lease", () => {
  it("releases, persists, and emits teardown_completed", async () => {
    const original = createLease({
      sessionId: "rsess_1",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: NOW,
    });
    const deps = makeDeps({
      sessionLease: original,
      nowIso: "2026-05-11T11:00:00.000Z",
    });
    const result = await releaseSessionLease(
      { sessionId: "rsess_1", roomId: "room_1", reason: "completed" },
      deps,
    );
    assert.equal(result.released, true);
    assert.equal(result.lease!.releasedAt, "2026-05-11T11:00:00.000Z");
    assert.equal(result.lease!.releaseReason, "completed");
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.emitted.length, 1);
    assert.equal(deps.emitted[0]!.eventType, SESSION_TEARDOWN_COMPLETED);
    const payload = deps.emitted[0]!.payload as { reason: string };
    assert.equal(payload.reason, "completed");
  });

  it("persists release without emitting when the session has no room yet", async () => {
    const original = createLease({
      sessionId: "rsess_1",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: NOW,
    });
    const deps = makeDeps({
      sessionLease: original,
      nowIso: "2026-05-11T11:00:00.000Z",
    });
    const result = await releaseSessionLease(
      { sessionId: "rsess_1", roomId: null, reason: "cancelled" },
      deps,
    );
    assert.equal(result.released, true);
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.persisted[0]!.lease.releaseReason, "cancelled");
    assert.equal(deps.emitted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// acquireLease — lane capacity above 1
// ---------------------------------------------------------------------------

describe("acquireLease — laneCapacity above 1", () => {
  const lane = () => makeLane({ provider: "claude_code", model: "sonnet-5", quotaLaneId: null });

  function heldLease(sessionId: string): QuotaLease {
    return createLease({
      sessionId,
      lane: lane(),
      snapshot: makeSnapshot(),
      nowIso: NOW,
    });
  }

  it("admits a second session when capacity allows it", async () => {
    const deps = makeDeps({ activeLeases: [heldLease("rsess_a")] });
    const result = await acquireLease(
      {
        sessionId: "rsess_b",
        roomId: "room_1",
        lane: lane(),
        snapshot: makeSnapshot(),
        laneCapacity: 2,
      },
      deps,
    );
    assert.equal(result.ok, true);
    assert.equal(result.reason, QUOTA_LEASE_REASONS.AVAILABLE);
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.emitted.length, 1);
  });

  it("locks the lane once capacity is reached", async () => {
    const deps = makeDeps({
      activeLeases: [heldLease("rsess_a"), heldLease("rsess_b")],
    });
    const result = await acquireLease(
      {
        sessionId: "rsess_c",
        roomId: "room_1",
        lane: lane(),
        snapshot: makeSnapshot(),
        laneCapacity: 2,
      },
      deps,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, QUOTA_LEASE_REASONS.LANE_LOCKED);
    assert.equal(result.conflictingSessionId, "rsess_a");
    assert.equal(deps.persisted.length, 0);
    assert.equal(deps.emitted.length, 0);
  });

  it("serializes racing acquires through withLaneLock so capacity holds", async () => {
    // Two sessions genuinely race for the last capacity slot: both
    // acquireLease calls are launched unawaited, and a queuing fake
    // lock (the pg advisory lock stand-in) admits one body at a time.
    // Under the lock the loser observes the winner's persisted lease
    // and gets lane_locked; without serialization both would read one
    // active lease and both would be admitted.
    const store: QuotaLease[] = [heldLease("rsess_a")];
    let queue: Promise<unknown> = Promise.resolve();
    let bodiesInFlight = 0;
    let maxBodiesInFlight = 0;

    const deps: QuotaLeaseOrchestratorDeps = {
      async loadActiveLeasesForLane() {
        // Yield so an unserialized implementation would interleave here.
        await new Promise((resolve) => setImmediate(resolve));
        return [...store];
      },
      async loadSessionLease() {
        return null;
      },
      async persistSessionLease(_sessionId, lease) {
        await new Promise((resolve) => setImmediate(resolve));
        store.push(lease);
      },
      async emitLeaseEvent() {},
      now: () => NOW,
      async withLaneLock(_lane, body) {
        const run = queue.then(async () => {
          bodiesInFlight += 1;
          maxBodiesInFlight = Math.max(maxBodiesInFlight, bodiesInFlight);
          try {
            return await body(this as QuotaLeaseOrchestratorDeps);
          } finally {
            bodiesInFlight -= 1;
          }
        });
        queue = run.catch(() => undefined);
        return run as Promise<never>;
      },
    };

    const input = (sessionId: string) => ({
      sessionId,
      roomId: null,
      lane: lane(),
      snapshot: makeSnapshot(),
      laneCapacity: 2,
    });

    // Launch both BEFORE awaiting either — a genuine race for one slot.
    const firstPromise = acquireLease(input("rsess_b"), deps);
    const secondPromise = acquireLease(input("rsess_c"), deps);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.deepEqual(
      [first.ok, second.ok].sort(),
      [false, true],
      "exactly one racer wins the last slot",
    );
    const loser = first.ok ? second : first;
    assert.equal(loser.reason, QUOTA_LEASE_REASONS.LANE_LOCKED);
    assert.equal(store.filter((l) => !l.releasedAt).length, 2);
    assert.equal(maxBodiesInFlight, 1, "lock bodies must not overlap");
  });
});
