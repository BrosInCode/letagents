/**
 * Budget extension request orchestration — p3.4.
 *
 * A rented agent may request more LRT, but only the renter may approve it.
 * Requests and decisions are recorded as rental activity events; approval is
 * the only path that mutates `rental_sessions.lrt_limit`.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { db as DbClient } from "../db/client.js";
import {
  rental_activity_events,
  rental_sessions,
} from "../db/schema.js";
import type {
  ActivityEvent,
  EmitActivityEventInput,
} from "./activity-emitter.js";
import {
  BUDGET_EXTENSION_APPROVED,
  BUDGET_EXTENSION_DENIED,
  BUDGET_EXTENSION_REQUESTED,
} from "./activity-event-types.js";

type RentalSession = typeof rental_sessions.$inferSelect;
type RentalActivityEvent = typeof rental_activity_events.$inferSelect;

export interface BudgetExtensionRequestInput {
  requestedAdditionalLrt: number;
  reason?: string;
}

export interface BudgetExtensionApprovalInput {
  approvedAdditionalLrt?: number;
  note?: string;
}

export interface BudgetExtensionDenialInput {
  reason?: string;
}

export interface BudgetExtensionRequestResult {
  session: RentalSession;
  request: ActivityEvent;
}

export interface BudgetExtensionDecisionResult {
  session: RentalSession;
  request: RentalActivityEvent;
  decision: ActivityEvent;
  previousLrtLimit: number | null;
  newLrtLimit: number | null;
}

interface SessionUpdate {
  additionalLrt: number;
  status: RentalSession["status"];
}

interface SessionBudgetUpdateResult {
  session: RentalSession;
  previousLrtLimit: number | null;
  newLrtLimit: number | null;
}

export interface BudgetExtensionDeps {
  now(): Date;
  getSession(sessionId: string): Promise<RentalSession | null>;
  getRequestEvent(sessionId: string, requestId: string): Promise<RentalActivityEvent | null>;
  hasDecision(sessionId: string, requestId: string): Promise<boolean>;
  incrementSessionBudget(sessionId: string, update: SessionUpdate): Promise<SessionBudgetUpdateResult>;
  emitActivityEvent(input: EmitActivityEventInput): Promise<ActivityEvent>;
  withSessionLock?<T>(
    sessionId: string,
    body: (locked: BudgetExtensionDeps) => Promise<T>,
  ): Promise<T>;
}

export class BudgetExtensionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "BudgetExtensionError";
  }
}

const TERMINAL_STATUSES = new Set<RentalSession["status"]>([
  "completed",
  "cancelled",
  "expired",
  "failed",
]);

function assertPositiveLrt(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new BudgetExtensionError(
      "invalid_lrt_amount",
      400,
      `${field} must be a finite positive integer`,
    );
  }
}

function roleForAccount(
  session: RentalSession,
  accountId: string,
): "renter" | "provider" | null {
  if (session.renter_account_id === accountId) return "renter";
  if (session.provider_account_id === accountId) return "provider";
  return null;
}

function ensureParticipant(
  session: RentalSession | null,
  accountId: string,
): "renter" | "provider" {
  if (!session) {
    throw new BudgetExtensionError("session_not_found", 404);
  }
  const role = roleForAccount(session, accountId);
  if (!role) {
    throw new BudgetExtensionError("session_not_found", 404);
  }
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new BudgetExtensionError("session_terminal", 409);
  }
  if (!session.room_id) {
    throw new BudgetExtensionError("room_not_assigned", 409);
  }
  return role;
}

function payloadObject(event: RentalActivityEvent): Record<string, unknown> {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new BudgetExtensionError("invalid_extension_request", 409);
  }
  return payload as Record<string, unknown>;
}

function requestedLrtFrom(event: RentalActivityEvent): number {
  const payload = payloadObject(event);
  const value = payload.requested_additional_lrt;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
  ) {
    throw new BudgetExtensionError("invalid_extension_request", 409);
  }
  return value;
}

type BudgetExtensionExecutor = typeof DbClient;

async function getDb(): Promise<BudgetExtensionExecutor> {
  const mod = await import("../db/client.js");
  return mod.db;
}

function buildBudgetExtensionDeps(
  executor: BudgetExtensionExecutor,
): Omit<BudgetExtensionDeps, "withSessionLock"> {
  return {
    now: () => new Date(),
    async getSession(sessionId) {
      const [session] = await executor
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, sessionId));
      return session ?? null;
    },
    async getRequestEvent(sessionId, requestId) {
      const [event] = await executor
        .select()
        .from(rental_activity_events)
        .where(
          and(
            eq(rental_activity_events.id, requestId),
            eq(rental_activity_events.session_id, sessionId),
            eq(rental_activity_events.event_type, BUDGET_EXTENSION_REQUESTED),
          ),
        );
      return event ?? null;
    },
    async hasDecision(sessionId, requestId) {
      const [event] = await executor
        .select({ id: rental_activity_events.id })
        .from(rental_activity_events)
        .where(
          and(
            eq(rental_activity_events.session_id, sessionId),
            inArray(rental_activity_events.event_type, [
              BUDGET_EXTENSION_APPROVED,
              BUDGET_EXTENSION_DENIED,
            ]),
            sql`${rental_activity_events.payload}->>'request_id' = ${requestId}`,
          ),
        )
        .limit(1);
      return Boolean(event);
    },
    async incrementSessionBudget(sessionId, update) {
      const [session] = await executor
        .update(rental_sessions)
        .set({
          lrt_limit: sql`COALESCE(${rental_sessions.lrt_limit}, 0) + ${update.additionalLrt}`,
          status: update.status,
          updated_at: new Date(),
        })
        .where(eq(rental_sessions.id, sessionId))
        .returning();
      if (!session) {
        throw new BudgetExtensionError("session_not_found", 404);
      }
      const newLrtLimit = session.lrt_limit;
      return {
        session,
        previousLrtLimit:
          typeof newLrtLimit === "number" ? Math.max(0, newLrtLimit - update.additionalLrt) : null,
        newLrtLimit,
      };
    },
    async emitActivityEvent(input) {
      const mod = await import("./activity-emitter.js");
      return mod.emitActivityEvent(input);
    },
  };
}

export const defaultBudgetExtensionDeps: BudgetExtensionDeps = {
  now: () => new Date(),
  async getSession(sessionId) {
    return buildBudgetExtensionDeps(await getDb()).getSession(sessionId);
  },
  async getRequestEvent(sessionId, requestId) {
    return buildBudgetExtensionDeps(await getDb()).getRequestEvent(sessionId, requestId);
  },
  async hasDecision(sessionId, requestId) {
    return buildBudgetExtensionDeps(await getDb()).hasDecision(sessionId, requestId);
  },
  async incrementSessionBudget(sessionId, update) {
    return buildBudgetExtensionDeps(await getDb()).incrementSessionBudget(sessionId, update);
  },
  async emitActivityEvent(input) {
    return buildBudgetExtensionDeps(await getDb()).emitActivityEvent(input);
  },
  async withSessionLock(sessionId, body) {
    const db = await getDb();
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`);
      const txDeps: BudgetExtensionDeps = {
        ...buildBudgetExtensionDeps(tx as unknown as BudgetExtensionExecutor),
        withSessionLock: defaultBudgetExtensionDeps.withSessionLock,
      };
      return body(txDeps);
    });
  },
};

export async function requestBudgetExtension(
  sessionId: string,
  requesterAccountId: string,
  input: BudgetExtensionRequestInput,
  deps: BudgetExtensionDeps = defaultBudgetExtensionDeps,
): Promise<BudgetExtensionRequestResult> {
  assertPositiveLrt(input.requestedAdditionalLrt, "requestedAdditionalLrt");

  const session = await deps.getSession(sessionId);
  const role = ensureParticipant(session, requesterAccountId);
  const requestedAt = deps.now().toISOString();
  const request = await deps.emitActivityEvent({
    sessionId,
    roomId: session!.room_id!,
    eventType: BUDGET_EXTENSION_REQUESTED,
    source: role === "provider" ? "agent" : "renter",
    verified: false,
    payload: {
      request_status: "pending",
      requested_additional_lrt: input.requestedAdditionalLrt,
      reason: input.reason ?? null,
      requested_by_account_id: requesterAccountId,
      requested_by_role: role,
      requested_at: requestedAt,
    },
  });

  return { session: session!, request };
}

export async function approveBudgetExtension(
  sessionId: string,
  approverAccountId: string,
  requestId: string,
  input: BudgetExtensionApprovalInput = {},
  deps: BudgetExtensionDeps = defaultBudgetExtensionDeps,
): Promise<BudgetExtensionDecisionResult> {
  if (deps.withSessionLock) {
    return deps.withSessionLock(sessionId, (locked) =>
      approveBudgetExtensionLocked(sessionId, approverAccountId, requestId, input, locked)
    );
  }
  return approveBudgetExtensionLocked(sessionId, approverAccountId, requestId, input, deps);
}

async function approveBudgetExtensionLocked(
  sessionId: string,
  approverAccountId: string,
  requestId: string,
  input: BudgetExtensionApprovalInput,
  deps: BudgetExtensionDeps,
): Promise<BudgetExtensionDecisionResult> {
  const session = await deps.getSession(sessionId);
  const role = ensureParticipant(session, approverAccountId);
  if (role !== "renter") {
    throw new BudgetExtensionError("not_renter", 403);
  }

  const request = await deps.getRequestEvent(sessionId, requestId);
  if (!request) {
    throw new BudgetExtensionError("request_not_found", 404);
  }
  if (await deps.hasDecision(sessionId, requestId)) {
    throw new BudgetExtensionError("request_already_decided", 409);
  }

  const requestedAdditionalLrt = requestedLrtFrom(request);
  const approvedAdditionalLrt =
    input.approvedAdditionalLrt ?? requestedAdditionalLrt;
  assertPositiveLrt(approvedAdditionalLrt, "approvedAdditionalLrt");

  const previousStatus = session!.status;
  const nextStatus = previousStatus === "budget_exhausted" ? "active" : previousStatus;
  const budgetUpdate = await deps.incrementSessionBudget(sessionId, {
    additionalLrt: approvedAdditionalLrt,
    status: nextStatus,
  });
  const updated = budgetUpdate.session;

  const decision = await deps.emitActivityEvent({
    sessionId,
    roomId: session!.room_id!,
    eventType: BUDGET_EXTENSION_APPROVED,
    source: "renter",
    payload: {
      request_id: requestId,
      requested_additional_lrt: requestedAdditionalLrt,
      approved_additional_lrt: approvedAdditionalLrt,
      previous_lrt_limit: session!.lrt_limit,
      new_lrt_limit: budgetUpdate.newLrtLimit,
      previous_status: previousStatus,
      new_status: nextStatus,
      approved_by_account_id: approverAccountId,
      note: input.note ?? null,
      decided_at: deps.now().toISOString(),
    },
  });

  return {
    session: updated,
    request,
    decision,
    previousLrtLimit: session!.lrt_limit,
    newLrtLimit: budgetUpdate.newLrtLimit,
  };
}

export async function denyBudgetExtension(
  sessionId: string,
  approverAccountId: string,
  requestId: string,
  input: BudgetExtensionDenialInput = {},
  deps: BudgetExtensionDeps = defaultBudgetExtensionDeps,
): Promise<BudgetExtensionDecisionResult> {
  if (deps.withSessionLock) {
    return deps.withSessionLock(sessionId, (locked) =>
      denyBudgetExtensionLocked(sessionId, approverAccountId, requestId, input, locked)
    );
  }
  return denyBudgetExtensionLocked(sessionId, approverAccountId, requestId, input, deps);
}

async function denyBudgetExtensionLocked(
  sessionId: string,
  approverAccountId: string,
  requestId: string,
  input: BudgetExtensionDenialInput,
  deps: BudgetExtensionDeps,
): Promise<BudgetExtensionDecisionResult> {
  const session = await deps.getSession(sessionId);
  const role = ensureParticipant(session, approverAccountId);
  if (role !== "renter") {
    throw new BudgetExtensionError("not_renter", 403);
  }

  const request = await deps.getRequestEvent(sessionId, requestId);
  if (!request) {
    throw new BudgetExtensionError("request_not_found", 404);
  }
  if (await deps.hasDecision(sessionId, requestId)) {
    throw new BudgetExtensionError("request_already_decided", 409);
  }

  const requestedAdditionalLrt = requestedLrtFrom(request);
  const decision = await deps.emitActivityEvent({
    sessionId,
    roomId: session!.room_id!,
    eventType: BUDGET_EXTENSION_DENIED,
    source: "renter",
    payload: {
      request_id: requestId,
      requested_additional_lrt: requestedAdditionalLrt,
      denied_by_account_id: approverAccountId,
      reason: input.reason ?? null,
      decided_at: deps.now().toISOString(),
    },
  });

  return {
    session: session!,
    request,
    decision,
    previousLrtLimit: session!.lrt_limit,
    newLrtLimit: session!.lrt_limit,
  };
}
