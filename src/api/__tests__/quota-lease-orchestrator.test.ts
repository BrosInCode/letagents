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
