process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_LEASE_CREATED,
  SESSION_TEARDOWN_COMPLETED,
} from "../rental/activity-event-types.js";
import {
  createLease,
  type QuotaLane,
  type QuotaLease,
  type QuotaLeaseSnapshot,
} from "../rental/quota-lease.js";
import type { QuotaLeaseOrchestratorDeps } from "../rental/quota-lease-orchestrator.js";

const {
  acquireQuotaLeaseForSession,
  buildQuotaLeaseInput,
  releaseQuotaLeaseForSession,
} = await import("../rental/sessions.js");

const NOW = "2026-05-11T12:00:00.000Z";

function makeLane(overrides: Partial<QuotaLane> = {}): QuotaLane {
  return {
    provider: "codex",
    model: "gpt-5",
    quotaLaneId: "lane-primary",
    providerAccountId: "acct_provider",
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<QuotaLeaseSnapshot> = {},
): QuotaLeaseSnapshot {
  return {
    nativeUnit: "tokens",
    nativeRemaining: 10_000,
    nativeResetAt: null,
    confidence: "local_exact",
    observedAt: NOW,
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsess_1",
    room_id: "room_1",
    ...overrides,
  };
}

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    provider_account_id: "acct_provider",
    ide_kind: "codex",
    model_label: "gpt-5",
    quota_lane_id: "lane-primary",
    native_quota_unit: "tokens",
    last_native_quota_snapshot: null,
    last_quota_reset_at: null,
    meter_confidence: "local_exact",
    ...overrides,
  };
}

function makeDeps(input: {
  activeLeases?: QuotaLease[];
  sessionLease?: QuotaLease | null;
  nowIso?: string;
} = {}): QuotaLeaseOrchestratorDeps & {
  persisted: { sessionId: string; lease: QuotaLease }[];
  emitted: { eventType: string; roomId: string; payload: Record<string, unknown> }[];
} {
  const persisted: { sessionId: string; lease: QuotaLease }[] = [];
  const emitted: { eventType: string; roomId: string; payload: Record<string, unknown> }[] = [];
  return {
    persisted,
    emitted,
    async loadActiveLeasesForLane() {
      return input.activeLeases ?? [];
    },
    async loadSessionLease() {
      return input.sessionLease ?? null;
    },
    async persistSessionLease(sessionId, lease) {
      persisted.push({ sessionId, lease });
    },
    async emitLeaseEvent(call) {
      emitted.push({
        eventType: call.eventType,
        roomId: call.roomId,
        payload: call.payload,
      });
    },
    now() {
      return input.nowIso ?? NOW;
    },
  };
}

describe("quota lease lifecycle helpers", () => {
  it("builds a provider quota lane and native snapshot from the listing", () => {
    const input = buildQuotaLeaseInput(
      makeSession({ room_id: null }) as never,
      makeListing({
        last_native_quota_snapshot: {
          provider: "codex",
          model: "gpt-5",
          sourceId: "local",
          nativeUnit: "credits",
          nativeRemaining: 42,
          nativeTotal: 100,
          nativeResetAt: "2026-05-12T00:00:00.000Z",
          confidence: "official_exact",
          observedAt: "2026-05-11T11:55:00.000Z",
          raw: {},
        },
      }) as never,
      NOW,
    );

    assert.deepEqual(input.lane, makeLane());
    assert.equal(input.roomId, null);
    assert.deepEqual(input.snapshot, {
      nativeUnit: "credits",
      nativeRemaining: 42,
      nativeResetAt: "2026-05-12T00:00:00.000Z",
      confidence: "official_exact",
      observedAt: "2026-05-11T11:55:00.000Z",
    });
  });

  it("acquires and emits when the provider lane is available", async () => {
    const deps = makeDeps();
    const lease = await acquireQuotaLeaseForSession(
      makeSession() as never,
      makeListing() as never,
      deps,
    );

    assert.equal(lease.sessionId, "rsess_1");
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.emitted[0]?.eventType, SESSION_LEASE_CREATED);
  });

  it("returns a clear conflict when another session already holds the lane", async () => {
    const otherLease = createLease({
      sessionId: "rsess_other",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: "2026-05-11T11:00:00.000Z",
    });
    const deps = makeDeps({ activeLeases: [otherLease] });

    await assert.rejects(
      () => acquireQuotaLeaseForSession(
        makeSession({ id: "rsess_new" }) as never,
        makeListing() as never,
        deps,
      ),
      /quota_lease_lane_locked held_by=rsess_other/,
    );
    assert.equal(deps.persisted.length, 0);
    assert.equal(deps.emitted.length, 0);
  });

  it("allows same-session acquisition idempotently without another event", async () => {
    const existing = createLease({
      sessionId: "rsess_1",
      lane: makeLane(),
      snapshot: makeSnapshot({ nativeRemaining: 7_000 }),
      nowIso: "2026-05-11T11:00:00.000Z",
    });
    const deps = makeDeps({ activeLeases: [existing] });

    const lease = await acquireQuotaLeaseForSession(
      makeSession() as never,
      makeListing() as never,
      deps,
    );

    assert.equal(lease.sessionId, "rsess_1");
    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.emitted.length, 0);
  });

  it("releases the session lease with a terminal teardown reason", async () => {
    const existing = createLease({
      sessionId: "rsess_1",
      lane: makeLane(),
      snapshot: makeSnapshot(),
      nowIso: "2026-05-11T11:00:00.000Z",
    });
    const deps = makeDeps({
      sessionLease: existing,
      nowIso: "2026-05-11T12:30:00.000Z",
    });

    await releaseQuotaLeaseForSession(
      makeSession() as never,
      "completed",
      deps,
    );

    assert.equal(deps.persisted.length, 1);
    assert.equal(deps.persisted[0]!.lease.releaseReason, "completed");
    assert.equal(deps.emitted[0]?.eventType, SESSION_TEARDOWN_COMPLETED);
  });
});
