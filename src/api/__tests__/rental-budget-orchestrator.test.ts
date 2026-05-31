/**
 * Tests for Budget Sentinel DB orchestration + internal routes (p2.8b).
 */

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  BUDGET_EXHAUSTED,
  BUDGET_RECONCILED,
  BUDGET_RESERVED,
} from "../rental/activity-event-types.js";
import type {
  BudgetOrchestratorDeps,
  BudgetReconcileInput,
  BudgetReserveInput,
  BudgetReserveResult,
  BudgetReconcileResult,
} from "../rental/budget-orchestrator.js";
import { BUDGET_SENTINEL_REASONS } from "../rental/budget-sentinel.js";
import type { RentalUsageMeterRow } from "../rental/usage-ingest.js";

const {
  BudgetOrchestratorError,
  reconcileBudget,
  reserveBudget,
} = await import("../rental/budget-orchestrator.js");
const { registerRentalInternalRoutes } = await import("../routes/rental/internal/index.js");

const REFERENCE_NOW = Date.parse("2026-05-11T10:00:00.000Z");

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "rsess_1",
    room_id: "rroom_1",
    status: "active",
    lrt_limit: 100_000,
    budget_stop_threshold: null,
    lrt_reserved: 0,
    lrt_used: 0,
    meter_confidence: "estimated",
    ...overrides,
  } as Awaited<ReturnType<BudgetOrchestratorDeps["loadSession"]>>;
}

function makeLatestMeter(overrides: Record<string, unknown> = {}) {
  return {
    created_at: new Date(REFERENCE_NOW - 1_000),
    confidence: "estimated",
    ...overrides,
  } as Awaited<ReturnType<BudgetOrchestratorDeps["loadLatestMeter"]>>;
}

function buildDeps(options: {
  session?: Awaited<ReturnType<BudgetOrchestratorDeps["loadSession"]>>;
  latest?: Awaited<ReturnType<BudgetOrchestratorDeps["loadLatestMeter"]>>;
} = {}) {
  let session = options.session === undefined ? makeSession() : options.session;
  const latest = options.latest === undefined ? makeLatestMeter() : options.latest;
  const updates: Array<{ lrtReserved: number; lrtUsed: number; status?: string }> = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const lockOrder: string[] = [];
  const deps: BudgetOrchestratorDeps = {
    loadSession: async () => session,
    loadLatestMeter: async () => latest,
    updateSessionBudget: async (_sessionId, patch) => {
      updates.push(patch);
      if (!session) throw new BudgetOrchestratorError("session not found", "session_not_found", 404);
      session = {
        ...session,
        status: patch.status ?? session.status,
        lrt_reserved: patch.lrtReserved,
        lrt_used: patch.lrtUsed,
        meter_confidence: patch.meterConfidence ?? session.meter_confidence,
      };
      return session;
    },
    emitActivity: async (input) => {
      events.push({ eventType: input.eventType, payload: input.payload });
      return {
        id: `rev_${events.length}`,
        session_id: input.sessionId,
        room_id: input.roomId,
        event_type: input.eventType,
        source: "system",
        verified: true,
        visibility: "rental_visible",
        payload: input.payload,
        created_at: new Date(REFERENCE_NOW),
      };
    },
    withSessionLock: async (sessionId, body) => {
      lockOrder.push(`lock:${sessionId}`);
      return body(deps);
    },
  };
  return { deps, events, lockOrder, updates, get session() { return session; } };
}

describe("budget orchestration service", () => {
  it("reserveBudget authorizes, bumps lrtReserved, and emits budget.reserved", async () => {
    const harness = buildDeps({
      session: makeSession({ lrt_used: 5_000, lrt_reserved: 1_000 }),
    });

    const result = await reserveBudget(
      "rsess_1",
      { stepCostLrt: 2_000, nowMs: REFERENCE_NOW },
      harness.deps,
    );

    assert.equal(result.decision.allowed, true);
    assert.equal(result.reservedDelta, 2_000);
    assert.equal(result.session.lrtReserved, 3_000);
    assert.deepEqual(harness.lockOrder, ["lock:rsess_1"]);
    assert.equal(harness.events[0]!.eventType, BUDGET_RESERVED);
  });

  it("reserveBudget moves active sessions to budget_exhausted on ceiling_exceeded", async () => {
    const harness = buildDeps({
      session: makeSession({ lrt_used: 86_000, lrt_reserved: 1_000 }),
    });

    const result = await reserveBudget(
      "rsess_1",
      { stepCostLrt: 1, nowMs: REFERENCE_NOW },
      harness.deps,
    );

    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.reason, BUDGET_SENTINEL_REASONS.CEILING_EXCEEDED);
    assert.equal(result.session.status, "budget_exhausted");
    assert.equal(result.exhaustedEvent?.event_type, BUDGET_EXHAUSTED);
    assert.equal(harness.session?.status, "budget_exhausted");
  });

  it("reserveBudget stale-conservative denials do not mutate budget state", async () => {
    const harness = buildDeps({
      session: makeSession({ lrt_used: 40_000, lrt_reserved: 0 }),
      latest: makeLatestMeter({ created_at: new Date(REFERENCE_NOW - 60_000) }),
    });

    const result = await reserveBudget(
      "rsess_1",
      { stepCostLrt: 5_000, nowMs: REFERENCE_NOW },
      harness.deps,
    );

    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.reason, BUDGET_SENTINEL_REASONS.METER_STALE_CONSERVATIVE);
    assert.equal(harness.updates.length, 0);
    assert.equal(harness.events.length, 0);
  });

  it("reconcileBudget releases reservations, records usage, and emits exhaustion once", async () => {
    const harness = buildDeps({
      session: makeSession({ lrt_used: 50_000, lrt_reserved: 40_000 }),
    });

    const result = await reconcileBudget(
      "rsess_1",
      { actualCostLrt: 1_000, reservedCostLrt: 500 },
      harness.deps,
    );

    assert.equal(result.usedDelta, 1_000);
    assert.equal(result.reservedDelta, 500);
    assert.equal(result.session.lrtUsed, 51_000);
    assert.equal(result.session.lrtReserved, 39_500);
    assert.equal(result.becameExhausted, true);
    assert.equal(result.session.status, "budget_exhausted");
    assert.deepEqual(harness.events.map((e) => e.eventType), [
      BUDGET_RECONCILED,
      BUDGET_EXHAUSTED,
    ]);
  });
});

describe("budget internal routes", () => {
  let app: import("express").Express;
  let server: http.Server;
  let baseUrl: string;
  let reserveCalls: Array<{ sessionId: string; input: BudgetReserveInput }>;
  let reconcileCalls: Array<{ sessionId: string; input: BudgetReconcileInput }>;
  let reserveImpl: (sessionId: string, input: BudgetReserveInput) => Promise<BudgetReserveResult>;
  let reconcileImpl: (sessionId: string, input: BudgetReconcileInput) => Promise<BudgetReconcileResult>;
  let accessReturn: "renter" | "provider" | null;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    reserveCalls = [];
    reconcileCalls = [];
    accessReturn = "renter";
    reserveImpl = async (sessionId, input) => {
      reserveCalls.push({ sessionId, input });
      return {
        decision: {
          allowed: true,
          reason: BUDGET_SENTINEL_REASONS.AUTHORIZED,
          effectiveCeiling: 87_000,
          reservedAfter: input.stepCostLrt,
          remaining: 87_000,
          meterStale: false,
          staleSinceMs: null,
        },
        reservedDelta: input.stepCostLrt,
        session: {
          sessionId,
          status: "active",
          lrtLimit: 100_000,
          lrtReserved: input.stepCostLrt,
          lrtUsed: 0,
          effectiveCeiling: 87_000,
          meterConfidence: "estimated",
          lastMeterAt: null,
        },
        event: null,
        exhaustedEvent: null,
      };
    };
    reconcileImpl = async (sessionId, input) => {
      reconcileCalls.push({ sessionId, input });
      return {
        reservedDelta: input.reservedCostLrt,
        usedDelta: input.actualCostLrt,
        becameExhausted: false,
        session: {
          sessionId,
          status: "active",
          lrtLimit: 100_000,
          lrtReserved: 0,
          lrtUsed: input.actualCostLrt,
          effectiveCeiling: 87_000,
          meterConfidence: "estimated",
          lastMeterAt: null,
        },
        event: null,
        exhaustedEvent: null,
      };
    };

    const express = (await import("express")).default;
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Record<string, unknown>).sessionAccount = { account_id: "acct_1" };
      next();
    });
    registerRentalInternalRoutes(app, {
      ingestUsage: async () => ({ id: "rusg_1" }) as RentalUsageMeterRow,
      reserveBudget: (sessionId, input) => reserveImpl(sessionId, input),
      reconcileBudget: (sessionId, input) => reconcileImpl(sessionId, input),
      resolveSessionAccess: async () => accessReturn,
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as import("net").AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    delete process.env.LETAGENTS_RENT_ENABLED;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : "{}",
    });
  }

  it("POST /budget/reserve validates and dispatches to reserveBudget", async () => {
    const res = await post("/api/rental/sessions/rsess_1/budget/reserve", { stepCostLrt: 123 });
    assert.equal(res.status, 201);
    assert.equal(reserveCalls.length, 1);
    assert.equal(reserveCalls[0]!.sessionId, "rsess_1");
    assert.equal(reserveCalls[0]!.input.stepCostLrt, 123);
  });

  it("POST /budget/reserve returns 409 for denied decisions", async () => {
    const baseReserve = reserveImpl;
    reserveImpl = async (sessionId, input) => ({
      ...(await baseReserve(sessionId, input)),
      decision: {
        allowed: false,
        reason: BUDGET_SENTINEL_REASONS.CEILING_EXCEEDED,
        effectiveCeiling: 87_000,
        reservedAfter: 87_000,
        remaining: 0,
        meterStale: false,
        staleSinceMs: null,
      },
      reservedDelta: 0,
    });
    const res = await post("/api/rental/sessions/rsess_1/budget/reserve", { stepCostLrt: 1 });
    assert.equal(res.status, 409);
  });

  it("POST /budget/reconcile validates and dispatches to reconcileBudget", async () => {
    const res = await post("/api/rental/sessions/rsess_1/budget/reconcile", {
      actualCostLrt: 75,
      reservedCostLrt: 100,
    });
    assert.equal(res.status, 200);
    assert.equal(reconcileCalls.length, 1);
    assert.deepEqual(reconcileCalls[0]!.input, { actualCostLrt: 75, reservedCostLrt: 100 });
  });

  it("budget routes reject invalid numeric input and unauthorized sessions", async () => {
    let res = await post("/api/rental/sessions/rsess_1/budget/reserve", { stepCostLrt: -1 });
    assert.equal(res.status, 400);

    accessReturn = null;
    res = await post("/api/rental/sessions/rsess_1/budget/reconcile", {
      actualCostLrt: 1,
      reservedCostLrt: 1,
    });
    assert.equal(res.status, 404);
  });

  it("budget routes map orchestrator errors to their status/code", async () => {
    reserveImpl = async () => {
      throw new BudgetOrchestratorError("session not found", "session_not_found", 404);
    };
    const res = await post("/api/rental/sessions/rsess_missing/budget/reserve", { stepCostLrt: 1 });
    assert.equal(res.status, 404);
    const json = (await res.json()) as { code: string };
    assert.equal(json.code, "session_not_found");
  });
});
