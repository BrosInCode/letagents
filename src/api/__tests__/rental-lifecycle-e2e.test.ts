process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  rentalAccept,
  rentalCancel,
  rentalComplete,
  rentalHeartbeat,
  rentalListRequests,
  rentalProvision,
  rentalReportUsage,
  rentalRequestBudgetExtension,
} from "../../mcp/rental-tools.js";
import {
  BUDGET_EXTENSION_APPROVED,
  BUDGET_EXTENSION_DENIED,
  BUDGET_EXTENSION_REQUESTED,
  SESSION_ACCEPTED,
  SESSION_COMPLETED,
  SESSION_STARTED,
} from "../rental/activity-event-types.js";
import {
  approveBudgetExtension,
  requestBudgetExtension,
  type BudgetExtensionDeps,
} from "../rental/budget-extension.js";
import type { EmitActivityEventInput } from "../rental/activity-emitter.js";
import type {
  IngestUsageReport,
  RentalUsageMeterRow,
} from "../rental/usage-ingest.js";
import type { HeartbeatDeps, SessionRecord } from "../rental/heartbeat.js";
import { isValidTransition } from "../rental/session-state-machine.js";
import type { ReleaseLeaseInput } from "../rental/quota-lease-orchestrator.js";

type SessionStatus =
  | "requested"
  | "accepted"
  | "provisioning"
  | "active"
  | "blocked"
  | "patch_review"
  | "pr_opened"
  | "budget_exhausted"
  | "stale"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

interface MemorySession {
  id: string;
  listing_id: string;
  renter_account_id: string;
  provider_account_id: string;
  repo_provider: string;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  task_title: string;
  task_prompt: string;
  mode: string;
  continuity_mode: string;
  status: SessionStatus;
  room_id: string | null;
  lrt_limit: number | null;
  time_limit_minutes: number | null;
  heartbeat_count: number;
  last_heartbeat_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MemoryEvent {
  id: string;
  session_id: string;
  room_id: string;
  event_type: string;
  source: string;
  verified: boolean;
  visibility: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

const RENTER_ID = "acct_renter_e2e";
const PROVIDER_ID = "acct_provider_e2e";
const ROOM_ID = "rroom_e2e";
const SESSION_ID = "rsess_e2e";

function makeReport(overrides: Partial<IngestUsageReport> = {}): IngestUsageReport {
  return {
    source: "adapter",
    snapshot: {
      provider: "claude_code",
      model: "claude-3.7-sonnet",
      nativeUnit: "tokens",
      nativeUsed: 4_100,
      nativeRemaining: null,
      nativeResetAt: null,
    },
    delta: {
      inputTokens: 1_500,
      outputTokens: 420,
      cacheCreationTokens: 2_000,
      cacheReadTokens: 15_000,
      reasoningTokens: 0,
      heartbeats: 1,
    },
    lrt: {
      lrtUsed: 7_180,
      confidence: "local_exact",
    },
    idempotencyKey: "e2e-usage-1",
    ...overrides,
  };
}

function publicEvent(input: EmitActivityEventInput, id: string): MemoryEvent {
  return {
    id,
    session_id: input.sessionId,
    room_id: input.roomId,
    event_type: input.eventType,
    source: input.source,
    verified: input.verified ?? input.eventType !== "agent.note",
    visibility: input.visibility ?? "rental_visible",
    payload: input.payload,
    created_at: new Date(),
  };
}

describe("rental lifecycle E2E over MCP tool wrappers and API routes", () => {
  let server: http.Server;
  let baseUrl: string;
  let sessions: Map<string, MemorySession>;
  let events: MemoryEvent[];
  let meters: RentalUsageMeterRow[];
  let leaseReleases: ReleaseLeaseInput[];
  let eventSeq: number;

  beforeEach(async () => {
    process.env.LETAGENTS_RENT_ENABLED = "true";
    sessions = new Map();
    events = [];
    meters = [];
    leaseReleases = [];
    eventSeq = 0;

    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    app.use((req: import("express").Request, _res, next) => {
      const accountId = req.header("x-account-id");
      if (accountId) {
        (req as Record<string, unknown>).sessionAccount = {
          account_id: accountId,
        };
      }
      next();
    });

    const emitActivityEvent = async (
      input: EmitActivityEventInput,
    ): Promise<MemoryEvent> => {
      const event = publicEvent(input, `rev_${++eventSeq}`);
      events.push(event);
      return event;
    };

    const budgetDeps: BudgetExtensionDeps = {
      now: () => new Date("2026-05-11T22:00:00.000Z"),
      getSession: async (sessionId) => (sessions.get(sessionId) ?? null) as never,
      getRequestEvent: async (sessionId, requestId) =>
        (events.find(
          (event) =>
            event.session_id === sessionId
            && event.id === requestId
            && event.event_type === BUDGET_EXTENSION_REQUESTED,
        ) ?? null) as never,
      hasDecision: async (sessionId, requestId) =>
        events.some(
          (event) =>
            event.session_id === sessionId
            && [BUDGET_EXTENSION_APPROVED, BUDGET_EXTENSION_DENIED].includes(
              event.event_type as typeof BUDGET_EXTENSION_APPROVED,
            )
            && event.payload.request_id === requestId,
        ),
      updateSessionBudget: async (sessionId, update) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error("session_not_found");
        session.lrt_limit = update.lrtLimit;
        session.status = update.status;
        session.updated_at = new Date();
        return session as never;
      },
      emitActivityEvent: async (input) => emitActivityEvent(input) as never,
    };

    const heartbeatDeps: HeartbeatDeps = {
      getSession: async (sessionId) =>
        (sessions.get(sessionId) ?? null) as unknown as SessionRecord | null,
      updateSession: async (sessionId, data) => {
        const session = sessions.get(sessionId);
        if (!session) return null;
        Object.assign(session, data, { updated_at: new Date() });
        return session as unknown as SessionRecord;
      },
      emitActivityEvent: async (sessionId, roomId, eventType, source, payload) => {
        await emitActivityEvent({
          sessionId,
          roomId,
          eventType: eventType as never,
          source: source as never,
          payload,
        });
      },
    };

    const resolveSessionAccess = async (
      sessionId: string,
      accountId: string,
    ): Promise<"renter" | "provider" | null> => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (session.renter_account_id === accountId) return "renter";
      if (session.provider_account_id === accountId) return "provider";
      return null;
    };

    const { registerRentalProviderRoutes } = await import(
      "../routes/rental-provider.js"
    );
    const { registerRentalInternalRoutes } = await import(
      "../routes/rental-internal.js"
    );
    const { registerRentalRenterRoutes } = await import(
      "../routes/rental-renter.js"
    );

    registerRentalProviderRoutes(app, {
      createListing: async () => ({}),
      updateListing: async () => null,
      pauseListing: async () => null,
      resumeListing: async () => null,
      listMyListings: async () => [],
      listProviderRequests: async (providerAccountId) =>
        [...sessions.values()].filter(
          (session) =>
            session.provider_account_id === providerAccountId
            && session.status === "requested",
        ) as never,
      acceptSession: async (sessionId, providerAccountId) => {
        const session = sessions.get(sessionId);
        if (!session || session.provider_account_id !== providerAccountId) {
          return null;
        }
        if (!isValidTransition(session.status, "accepted")) {
          throw new Error(
            `invalid_transition: cannot move from ${session.status} to accepted`,
          );
        }
        session.status = "accepted";
        session.updated_at = new Date();
        await emitActivityEvent({
          sessionId,
          roomId: session.room_id ?? ROOM_ID,
          eventType: SESSION_ACCEPTED,
          source: "provider",
          payload: { provider_account_id: providerAccountId },
        });
        return session as never;
      },
      provisionSession: async (input) => {
        const session = sessions.get(input.sessionId);
        if (!session || session.provider_account_id !== input.providerAccountId) {
          return null;
        }
        if (!isValidTransition(session.status, "provisioning")) {
          throw new Error(
            `invalid_status: session must be accepted to provision, got ${session.status}`,
          );
        }
        session.room_id = "rroom_e2e";
        session.status = "provisioning";
        session.updated_at = new Date();
        return {
          roomId: "rroom_e2e",
          participantId: "rpart_e2e",
          session: session as never,
        };
      },
      declineSession: async () => null,
    });

    // Matches production order: this must be before renter routes so the
    // shared cancel endpoint is handled by the route that accepts either role.
    registerRentalInternalRoutes(app, {
      resolveSessionAccess,
      heartbeatDeps: async () => heartbeatDeps,
      getSessionForLiveness: async (sessionId) =>
        (sessions.get(sessionId) ?? null) as unknown as SessionRecord | null,
      getSessionLifecycle: async (sessionId) => {
        const session = sessions.get(sessionId);
        return session
          ? { status: session.status as never, room_id: session.room_id }
          : null;
      },
      updateSessionLifecycle: async (sessionId, update) => {
        const session = sessions.get(sessionId);
        if (!session) return null;
        session.status = update.status;
        session.ended_at = update.endedAt;
        session.updated_at = new Date();
        return session as never;
      },
      emitActivityEvent: async (input) => emitActivityEvent(input) as never,
      releaseSessionLease: async (input) => {
        leaseReleases.push(input);
        return { released: true, lease: null };
      },
      ingestUsage: async (sessionId, report) => {
        const row = {
          id: `rusg_${meters.length + 1}`,
          session_id: sessionId,
          source: report.source,
          confidence: report.lrt.confidence,
          lrt_delta: report.lrt.lrtUsed,
          lrt_total: report.lrt.lrtUsed,
          idempotency_key: report.idempotencyKey,
          created_at: new Date(),
          updated_at: new Date(),
        } as unknown as RentalUsageMeterRow;
        meters.push(row);
        return row;
      },
      reserveBudget: async () => {
        throw new Error("reserveBudget not used");
      },
      reconcileBudget: async () => {
        throw new Error("reconcileBudget not used");
      },
    });

    registerRentalRenterRoutes(app, {
      publicListings: async () => [],
      shouldAllowListingsQuery: () => true,
      createSession: async (input) => {
        const session: MemorySession = {
          id: SESSION_ID,
          listing_id: input.listingId,
          renter_account_id: input.renterAccountId,
          provider_account_id: PROVIDER_ID,
          repo_provider: "github",
          repo_owner: input.repoOwner,
          repo_name: input.repoName,
          base_branch: input.baseBranch,
          task_title: input.taskTitle,
          task_prompt: input.taskPrompt,
          mode: input.mode ?? "scoped",
          continuity_mode: input.continuityMode ?? "smart_handoff",
          status: "requested",
          room_id: null,
          lrt_limit: input.lrtLimit ?? 1_000,
          time_limit_minutes: input.timeLimitMinutes ?? 60,
          heartbeat_count: 0,
          last_heartbeat_at: null,
          started_at: null,
          ended_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        sessions.set(session.id, session);
        return session as never;
      },
      getSessionById: async (sessionId, accountId) => {
        const session = sessions.get(sessionId);
        if (!session) return null;
        if (
          session.renter_account_id !== accountId
          && session.provider_account_id !== accountId
        ) {
          return null;
        }
        return session as never;
      },
      cancelSession: async () => {
        throw new Error("renter cancel route should be shadowed by internal");
      },
      requestBudgetExtension: (sessionId, accountId, input) =>
        requestBudgetExtension(sessionId, accountId, input, budgetDeps),
      approveBudgetExtension: (sessionId, accountId, requestId, input) =>
        approveBudgetExtension(sessionId, accountId, requestId, input, budgetDeps),
      denyBudgetExtension: async () => {
        throw new Error("denyBudgetExtension not used");
      },
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = server.address() as import("net").AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    delete process.env.LETAGENTS_RENT_ENABLED;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function requestAs<T>(
    accountId: string,
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    headers.set("x-account-id", accountId);
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = await res.json().catch(() => null) as T & { error?: string };
    if (!res.ok) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return body as T;
  }

  it("runs request, accept, heartbeat, usage, budget extension, complete, and rejected cancel", async () => {
    const created = await requestAs<MemorySession>(RENTER_ID, "/api/rental/sessions", {
      method: "POST",
      body: JSON.stringify({
        listingId: "rlst_e2e",
        repoOwner: "BrosInCode",
        repoName: "letagents",
        baseBranch: "staging",
        taskTitle: "E2E validation",
        taskPrompt: "Exercise rental lifecycle",
        lrtLimit: 1_000,
      }),
    });
    assert.equal(created.status, "requested");

    const providerDeps = {
      apiCall: <T,>(path: string, options?: RequestInit) =>
        requestAs<T>(PROVIDER_ID, path, options),
    };

    const listed = await rentalListRequests(providerDeps);
    assert.equal(listed.success, true);
    assert.equal(listed.count, 1);

    const accepted = await rentalAccept(providerDeps, { session_id: created.id });
    assert.equal(accepted.success, true);
    assert.equal((accepted.session as MemorySession).status, "accepted");

    const provisioned = await rentalProvision(providerDeps, {
      session_id: created.id,
      parent_room_id: ROOM_ID,
      provider_display_name: "Provider Agent",
    });
    assert.equal(provisioned.success, true);
    assert.equal(provisioned.room_id, "rroom_e2e");
    assert.equal((provisioned.session as MemorySession).status, "provisioning");

    const heartbeat = await rentalHeartbeat(providerDeps, {
      session_id: created.id,
    });
    assert.equal(heartbeat.success, true);
    assert.equal(heartbeat.status, "active");
    assert.equal(heartbeat.transitioned, true);
    assert.equal(sessions.get(created.id)!.status, "active");

    const usage = await rentalReportUsage(providerDeps, {
      session_id: created.id,
      report: makeReport(),
    });
    assert.equal(usage.success, true);
    assert.equal(meters.length, 1);

    sessions.get(created.id)!.status = "budget_exhausted";

    const extension = await rentalRequestBudgetExtension(providerDeps, {
      session_id: created.id,
      requested_additional_lrt: 500,
      reason: "finish validation",
    });
    assert.equal(extension.success, true);
    const requestId = (extension.request as MemoryEvent).id;

    const approved = await requestAs<{
      newLrtLimit: number;
      session: MemorySession;
    }>(
      RENTER_ID,
      `/api/rental/sessions/${created.id}/budget-extension-requests/${requestId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ approvedAdditionalLrt: 400, note: "approved" }),
      },
    );
    assert.equal(approved.newLrtLimit, 1_400);
    assert.equal(approved.session.status, "active");
    assert.equal(sessions.get(created.id)!.lrt_limit, 1_400);

    sessions.get(created.id)!.status = "pr_opened";

    const completed = await rentalComplete(providerDeps, {
      session_id: created.id,
      summary: "E2E validation done",
    });
    assert.equal(completed.success, true);
    assert.equal((completed.session as MemorySession).status, "completed");
    assert.deepEqual(leaseReleases, [
      { sessionId: created.id, roomId: "rroom_e2e", reason: "completed" },
    ]);

    const rejectedCancel = await rentalCancel(providerDeps, {
      session_id: created.id,
      reason: "should reject after completion",
    });
    assert.equal(rejectedCancel.success, false);
    assert.match(rejectedCancel.error ?? "", /completed to cancelled/);

    assert.deepEqual(
      events.map((event) => event.event_type),
      [
        SESSION_ACCEPTED,
        SESSION_STARTED,
        BUDGET_EXTENSION_REQUESTED,
        BUDGET_EXTENSION_APPROVED,
        SESSION_COMPLETED,
      ],
    );
  });

  it("releases the quota lease when a provider cancels an active session", async () => {
    const created = await requestAs<MemorySession>(RENTER_ID, "/api/rental/sessions", {
      method: "POST",
      body: JSON.stringify({
        listingId: "rlst_e2e",
        repoOwner: "BrosInCode",
        repoName: "letagents",
        baseBranch: "staging",
        taskTitle: "Cancel validation",
        taskPrompt: "Exercise rental cancellation",
      }),
    });

    const providerDeps = {
      apiCall: <T,>(path: string, options?: RequestInit) =>
        requestAs<T>(PROVIDER_ID, path, options),
    };

    const accepted = await rentalAccept(providerDeps, { session_id: created.id });
    assert.equal(accepted.success, true);

    const provisioned = sessions.get(created.id)!;
    provisioned.room_id = ROOM_ID;
    provisioned.status = "active";

    const cancelled = await rentalCancel(providerDeps, {
      session_id: created.id,
      reason: "provider stopped",
    });

    assert.equal(cancelled.success, true);
    assert.equal((cancelled.session as MemorySession).status, "cancelled");
    assert.deepEqual(leaseReleases, [
      { sessionId: created.id, roomId: ROOM_ID, reason: "cancelled" },
    ]);
  });
});
