/**
 * Budget Sentinel orchestration (p2.8b).
 *
 * Wraps the pure Budget Sentinel decision functions with the DB updates
 * and activity events needed by the internal reserve/reconcile routes.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  rental_activity_events,
  rental_sessions,
  rental_usage_meters,
} from "../db/schema.js";
import { emitActivityEvent, type ActivityEvent } from "./activity-emitter.js";
import {
  BUDGET_EXHAUSTED,
  BUDGET_RECONCILED,
  BUDGET_RESERVED,
} from "./activity-event-types.js";
import {
  applyReconciliation,
  applyReservation,
  authorize,
  BUDGET_SENTINEL_REASONS,
  effectiveLrtCeiling,
  type AuthorizeDecision,
  type BudgetSentinelOptions,
  type BudgetSentinelState,
} from "./budget-sentinel.js";
import type { QuotaConfidence } from "../../shared/rental/meter-types.js";

type BudgetSessionRow = Pick<
  typeof rental_sessions.$inferSelect,
  | "id"
  | "room_id"
  | "status"
  | "lrt_limit"
  | "budget_stop_threshold"
  | "lrt_reserved"
  | "lrt_used"
  | "meter_confidence"
>;

type LatestMeterRow = Pick<
  typeof rental_usage_meters.$inferSelect,
  "created_at" | "confidence"
>;

export interface BudgetReserveInput {
  idempotencyKey: string;
  stepCostLrt: number;
  options?: BudgetSentinelOptions;
  nowMs?: number;
}

export interface BudgetReconcileInput {
  idempotencyKey: string;
  actualCostLrt: number;
  reservedCostLrt: number;
}

export interface BudgetSessionSummary {
  sessionId: string;
  status: string;
  lrtLimit: number | null;
  lrtReserved: number;
  lrtUsed: number;
  effectiveCeiling: number;
  meterConfidence: QuotaConfidence | null;
  lastMeterAt: string | null;
}

export interface BudgetReserveResult {
  decision: AuthorizeDecision;
  reservedDelta: number;
  session: BudgetSessionSummary;
  event: ActivityEvent | null;
  exhaustedEvent: ActivityEvent | null;
}

export interface BudgetReconcileResult {
  reservedDelta: number;
  usedDelta: number;
  becameExhausted: boolean;
  session: BudgetSessionSummary;
  event: ActivityEvent | null;
  exhaustedEvent: ActivityEvent | null;
}

export class BudgetOrchestratorError extends Error {
  constructor(
    message: string,
    readonly code:
      | "session_not_found"
      | "invalid_input"
      | "idempotency_conflict"
      | "room_not_assigned",
    readonly status: number,
  ) {
    super(message);
    this.name = "BudgetOrchestratorError";
  }
}

export interface BudgetOrchestratorDeps {
  loadSession(sessionId: string): Promise<BudgetSessionRow | null>;
  loadLatestMeter(sessionId: string): Promise<LatestMeterRow | null>;
  loadBudgetEventByIdempotency(
    sessionId: string,
    eventType: typeof BUDGET_RESERVED | typeof BUDGET_RECONCILED,
    idempotencyKey: string,
  ): Promise<ActivityEvent | null>;
  updateSessionBudget(
    sessionId: string,
    patch: {
      lrtReserved: number;
      lrtUsed: number;
      status?: BudgetSessionRow["status"];
      meterConfidence?: QuotaConfidence | null;
    },
  ): Promise<BudgetSessionRow>;
  emitActivity(input: {
    sessionId: string;
    roomId: string;
    eventType: typeof BUDGET_RESERVED | typeof BUDGET_RECONCILED | typeof BUDGET_EXHAUSTED;
    payload: Record<string, unknown>;
  }): Promise<ActivityEvent>;
  withSessionLock<T>(
    sessionId: string,
    body: (locked: BudgetOrchestratorDeps) => Promise<T>,
  ): Promise<T>;
}

type BudgetExecutor = typeof db;

function buildBudgetDeps(
  executor: BudgetExecutor,
): Omit<BudgetOrchestratorDeps, "withSessionLock"> {
  return {
    async loadSession(sessionId) {
      const [row] = await executor
        .select({
          id: rental_sessions.id,
          room_id: rental_sessions.room_id,
          status: rental_sessions.status,
          lrt_limit: rental_sessions.lrt_limit,
          budget_stop_threshold: rental_sessions.budget_stop_threshold,
          lrt_reserved: rental_sessions.lrt_reserved,
          lrt_used: rental_sessions.lrt_used,
          meter_confidence: rental_sessions.meter_confidence,
        })
        .from(rental_sessions)
        .where(eq(rental_sessions.id, sessionId));
      return row ?? null;
    },
    async loadLatestMeter(sessionId) {
      const [row] = await executor
        .select({
          created_at: rental_usage_meters.created_at,
          confidence: rental_usage_meters.confidence,
        })
        .from(rental_usage_meters)
        .where(eq(rental_usage_meters.session_id, sessionId))
        .orderBy(desc(rental_usage_meters.created_at))
        .limit(1);
      return row ?? null;
    },
    async loadBudgetEventByIdempotency(sessionId, eventType, idempotencyKey) {
      const [row] = await executor
        .select()
        .from(rental_activity_events)
        .where(
          and(
            eq(rental_activity_events.session_id, sessionId),
            eq(rental_activity_events.event_type, eventType),
            sql`${rental_activity_events.payload}->>'idempotency_key' = ${idempotencyKey}`,
          ),
        )
        .orderBy(desc(rental_activity_events.created_at))
        .limit(1);
      return row ?? null;
    },
    async updateSessionBudget(sessionId, patch) {
      const update: Partial<typeof rental_sessions.$inferInsert> = {
        lrt_reserved: patch.lrtReserved,
        lrt_used: patch.lrtUsed,
        updated_at: new Date(),
      };
      if (patch.status) update.status = patch.status;
      if (patch.meterConfidence) update.meter_confidence = patch.meterConfidence;
      const [row] = await executor
        .update(rental_sessions)
        .set(update)
        .where(eq(rental_sessions.id, sessionId))
        .returning();
      if (!row) {
        throw new BudgetOrchestratorError("session not found", "session_not_found", 404);
      }
      return row;
    },
    async emitActivity(input) {
      return emitActivityEvent({
        sessionId: input.sessionId,
        roomId: input.roomId,
        eventType: input.eventType,
        source: "system",
        payload: input.payload,
      });
    },
  };
}

export const defaultBudgetOrchestratorDeps: BudgetOrchestratorDeps = {
  ...buildBudgetDeps(db),
  async withSessionLock(sessionId, body) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`);
      const txDeps: BudgetOrchestratorDeps = {
        ...buildBudgetDeps(tx as unknown as BudgetExecutor),
        withSessionLock: defaultBudgetOrchestratorDeps.withSessionLock,
      };
      return body(txDeps);
    });
  },
};

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new BudgetOrchestratorError(`${name} must be a finite non-negative number`, "invalid_input", 400);
  }
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function confidenceValue(value: unknown): QuotaConfidence | null {
  if (
    value === "official_exact"
    || value === "local_exact"
    || value === "derived"
    || value === "calibrated"
    || value === "estimated"
    || value === "weak_estimate"
    || value === "unknown"
  ) {
    return value;
  }
  return null;
}

function dateIso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function toSentinelState(
  session: BudgetSessionRow,
  latestMeter: LatestMeterRow | null,
): BudgetSentinelState {
  return {
    sessionId: session.id,
    status: session.status,
    lrtLimit: session.lrt_limit,
    budgetStopThreshold: numericValue(session.budget_stop_threshold),
    lrtReserved: session.lrt_reserved,
    lrtUsed: session.lrt_used,
    meterConfidence:
      confidenceValue(latestMeter?.confidence)
      ?? confidenceValue(session.meter_confidence)
      ?? "unknown",
    lastMeterAt: dateIso(latestMeter?.created_at),
  };
}

function summarize(
  session: BudgetSessionRow,
  latestMeter: LatestMeterRow | null,
): BudgetSessionSummary {
  const state = toSentinelState(session, latestMeter);
  return {
    sessionId: session.id,
    status: session.status,
    lrtLimit: state.lrtLimit,
    lrtReserved: session.lrt_reserved,
    lrtUsed: session.lrt_used,
    effectiveCeiling: effectiveLrtCeiling(state),
    meterConfidence: state.meterConfidence,
    lastMeterAt: state.lastMeterAt,
  };
}

function reservePayload(
  idempotencyKey: string,
  requestedStepCostLrt: number,
  decision: AuthorizeDecision,
  reservedDelta: number,
  session: BudgetSessionSummary,
): Record<string, unknown> {
  return {
    idempotency_key: idempotencyKey,
    requested_step_cost_lrt: requestedStepCostLrt,
    step_cost_lrt: reservedDelta,
    reserved_delta: reservedDelta,
    decision,
    lrt_reserved: session.lrtReserved,
    lrt_used: session.lrtUsed,
    effective_ceiling: session.effectiveCeiling,
  };
}

function exhaustedPayload(
  reason: string,
  session: BudgetSessionSummary,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    reason,
    lrt_reserved: session.lrtReserved,
    lrt_used: session.lrtUsed,
    effective_ceiling: session.effectiveCeiling,
    ...extra,
  };
}

function requireIdempotencyKey(input: unknown): string {
  if (typeof input !== "string") {
    throw new BudgetOrchestratorError("idempotencyKey is required", "invalid_input", 400);
  }
  const key = input.trim();
  if (!key) {
    throw new BudgetOrchestratorError("idempotencyKey is required", "invalid_input", 400);
  }
  return key;
}

function objectPayload(event: ActivityEvent): Record<string, unknown> {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function numberPayload(payload: Record<string, unknown>, field: string): number | null {
  const value = payload[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertSameIdempotentNumber(
  payload: Record<string, unknown>,
  field: string,
  expected: number,
): void {
  if (numberPayload(payload, field) !== expected) {
    throw new BudgetOrchestratorError(
      "idempotency key already used with a different budget request",
      "idempotency_conflict",
      409,
    );
  }
}

function decisionPayload(payload: Record<string, unknown>): AuthorizeDecision {
  const value = payload.decision;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as AuthorizeDecision;
  }
  throw new BudgetOrchestratorError(
    "stored budget reservation event is missing its decision",
    "invalid_input",
    409,
  );
}

function requireBudgetActivityRoom(session: BudgetSessionRow): void {
  if (!session.room_id) {
    throw new BudgetOrchestratorError(
      "session room is required for idempotent budget operations",
      "room_not_assigned",
      409,
    );
  }
}

export async function reserveBudget(
  sessionId: string,
  input: BudgetReserveInput,
  deps: BudgetOrchestratorDeps = defaultBudgetOrchestratorDeps,
): Promise<BudgetReserveResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  finiteNonNegative(input.stepCostLrt, "stepCostLrt");

  return deps.withSessionLock(sessionId, async (locked) => {
    const session = await locked.loadSession(sessionId);
    if (!session) {
      throw new BudgetOrchestratorError("session not found", "session_not_found", 404);
    }
    requireBudgetActivityRoom(session);
    const latestMeter = await locked.loadLatestMeter(sessionId);

    const existing = await locked.loadBudgetEventByIdempotency(
      sessionId,
      BUDGET_RESERVED,
      idempotencyKey,
    );
    if (existing) {
      const payload = objectPayload(existing);
      assertSameIdempotentNumber(payload, "requested_step_cost_lrt", input.stepCostLrt);
      return {
        decision: decisionPayload(payload),
        reservedDelta:
          numberPayload(payload, "reserved_delta")
          ?? numberPayload(payload, "step_cost_lrt")
          ?? 0,
        session: summarize(session, latestMeter),
        event: existing,
        exhaustedEvent: null,
      };
    }

    const state = toSentinelState(session, latestMeter);
    const decision = authorize(input.stepCostLrt, state, input.options, input.nowMs ?? Date.now());

    if (!decision.allowed) {
      if (
        decision.reason === BUDGET_SENTINEL_REASONS.CEILING_EXCEEDED
        && session.status !== "budget_exhausted"
      ) {
        const exhaustedState = {
          ...state,
          status: "budget_exhausted",
        };
        const updated = await locked.updateSessionBudget(sessionId, {
          lrtReserved: state.lrtReserved,
          lrtUsed: state.lrtUsed,
          status: "budget_exhausted",
          meterConfidence: state.meterConfidence,
        });
        const summary = {
          ...summarize(updated, latestMeter),
          effectiveCeiling: effectiveLrtCeiling(exhaustedState),
        };
        const exhaustedEvent = updated.room_id
          ? await locked.emitActivity({
              sessionId,
              roomId: updated.room_id,
              eventType: BUDGET_EXHAUSTED,
              payload: exhaustedPayload("ceiling_exceeded", summary, { decision }),
            })
          : null;
        return {
          decision,
          reservedDelta: 0,
          session: summary,
          event: null,
          exhaustedEvent,
        };
      }

      return {
        decision,
        reservedDelta: 0,
        session: summarize(session, latestMeter),
        event: null,
        exhaustedEvent: null,
      };
    }

    const reservation = applyReservation(input.stepCostLrt, state);
    const updated = await locked.updateSessionBudget(sessionId, {
      lrtReserved: reservation.state.lrtReserved,
      lrtUsed: reservation.state.lrtUsed,
      meterConfidence: state.meterConfidence,
    });
    const summary = summarize(updated, latestMeter);
    const event = updated.room_id
      ? await locked.emitActivity({
          sessionId,
          roomId: updated.room_id,
          eventType: BUDGET_RESERVED,
          payload: reservePayload(
            idempotencyKey,
            input.stepCostLrt,
            decision,
            reservation.reservedDelta,
            summary,
          ),
        })
      : null;

    return {
      decision,
      reservedDelta: reservation.reservedDelta,
      session: summary,
      event,
      exhaustedEvent: null,
    };
  });
}

export async function reconcileBudget(
  sessionId: string,
  input: BudgetReconcileInput,
  deps: BudgetOrchestratorDeps = defaultBudgetOrchestratorDeps,
): Promise<BudgetReconcileResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  finiteNonNegative(input.actualCostLrt, "actualCostLrt");
  finiteNonNegative(input.reservedCostLrt, "reservedCostLrt");

  return deps.withSessionLock(sessionId, async (locked) => {
    const session = await locked.loadSession(sessionId);
    if (!session) {
      throw new BudgetOrchestratorError("session not found", "session_not_found", 404);
    }
    requireBudgetActivityRoom(session);
    const latestMeter = await locked.loadLatestMeter(sessionId);

    const existing = await locked.loadBudgetEventByIdempotency(
      sessionId,
      BUDGET_RECONCILED,
      idempotencyKey,
    );
    if (existing) {
      const payload = objectPayload(existing);
      assertSameIdempotentNumber(payload, "requested_actual_cost_lrt", input.actualCostLrt);
      assertSameIdempotentNumber(payload, "requested_reserved_cost_lrt", input.reservedCostLrt);
      return {
        reservedDelta:
          numberPayload(payload, "reserved_delta")
          ?? numberPayload(payload, "reserved_cost_lrt")
          ?? 0,
        usedDelta:
          numberPayload(payload, "used_delta")
          ?? numberPayload(payload, "actual_cost_lrt")
          ?? 0,
        becameExhausted: payload.became_exhausted === true,
        session: summarize(session, latestMeter),
        event: existing,
        exhaustedEvent: null,
      };
    }

    const state = toSentinelState(session, latestMeter);
    const reconciliation = applyReconciliation(
      input.actualCostLrt,
      input.reservedCostLrt,
      state,
    );
    const updated = await locked.updateSessionBudget(sessionId, {
      lrtReserved: reconciliation.state.lrtReserved,
      lrtUsed: reconciliation.state.lrtUsed,
      status: reconciliation.state.status as BudgetSessionRow["status"],
      meterConfidence: state.meterConfidence,
    });
    const summary = summarize(updated, latestMeter);
    const event = updated.room_id
      ? await locked.emitActivity({
          sessionId,
          roomId: updated.room_id,
          eventType: BUDGET_RECONCILED,
          payload: {
            idempotency_key: idempotencyKey,
            requested_actual_cost_lrt: input.actualCostLrt,
            requested_reserved_cost_lrt: input.reservedCostLrt,
            actual_cost_lrt: reconciliation.usedDelta,
            reserved_cost_lrt: reconciliation.reservedDelta,
            used_delta: reconciliation.usedDelta,
            reserved_delta: reconciliation.reservedDelta,
            lrt_reserved: summary.lrtReserved,
            lrt_used: summary.lrtUsed,
            effective_ceiling: summary.effectiveCeiling,
            became_exhausted: reconciliation.becameExhausted,
          },
        })
      : null;
    const exhaustedEvent = reconciliation.becameExhausted && updated.room_id
      ? await locked.emitActivity({
          sessionId,
          roomId: updated.room_id,
          eventType: BUDGET_EXHAUSTED,
          payload: exhaustedPayload("reconciled_ceiling_crossed", summary, {
            actual_cost_lrt: reconciliation.usedDelta,
            reserved_cost_lrt: reconciliation.reservedDelta,
          }),
        })
      : null;

    return {
      reservedDelta: reconciliation.reservedDelta,
      usedDelta: reconciliation.usedDelta,
      becameExhausted: reconciliation.becameExhausted,
      session: summary,
      event,
      exhaustedEvent,
    };
  });
}
