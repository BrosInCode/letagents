/**
 * Renter-facing rental routes.
 *
 * Routes:
 *   GET    /api/rental/listings              — public marketplace discovery (paginated)
 *   POST   /api/rental/sessions              — create session (p1.3)
 *   GET    /api/rental/sessions/:id          — get session (p1.3)
 *   POST   /api/rental/sessions/:id/cancel   — cancel session (p1.3)
 *   GET    /api/rental/renter/quota-status
 *   POST   /api/rental/renter/declare-quota-exhausted
 *   POST   /api/rental/sessions/:id/budget-extension-requests
 *   POST   /api/rental/sessions/:id/budget-extension-requests/:requestId/approve
 *   POST   /api/rental/sessions/:id/budget-extension-requests/:requestId/deny
 *
 * Gated by `LETAGENTS_RENT_ENABLED` like the provider routes.
 * Rate-limited per renter session to prevent enumeration of the
 * full provider fleet.
 *
 * Spec §20 (API surface), §1.5 (readiness-gated marketplace),
 * §22.2 (Available to rent UX), §7 (renter session flow),
 * §17.15 (budget extension), §18.2 (session state machine).
 */

import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../http-helpers.js";
import type {
  PublicListingFilters,
  PublicListingsQuery,
  PublicRentalListing,
} from "../rental/listings.js";
import type { rental_sessions } from "../db/schema.js";
import {
  approveBudgetExtension,
  BudgetExtensionError,
  denyBudgetExtension,
  requestBudgetExtension,
  type BudgetExtensionApprovalInput,
  type BudgetExtensionDenialInput,
  type BudgetExtensionRequestInput,
  type BudgetExtensionDecisionResult,
  type BudgetExtensionRequestResult,
} from "../rental/budget-extension.js";
import {
  defaultRenterQuotaStateStore,
  type RenterQuotaStateStore,
  type RenterQuotaStatus,
} from "../rental/renter-quota-state.js";
import {
  listSessionActivityForUi,
  type SessionActivityRole,
  type SessionActivityRow,
} from "../rental/session-activity.js";
import { clampActivityLimit } from "../rental/session-activity-decisions.js";

type Session = typeof rental_sessions.$inferSelect;

// ===== Public deps =====

export interface RentalRenterRouteDeps {
  publicListings: PublicListingsQuery;
  /**
   * Rate-limit gate. Returns `true` if the call should proceed,
   * `false` if the renter is currently throttled. Default uses
   * {@link buildInMemoryListingsRateLimiter}.
   */
  shouldAllowListingsQuery: ListingsRateLimiter;
  // Session management (p1.3)
  createSession(input: {
    listingId: string;
    renterAccountId: string;
    repoOwner: string;
    repoName: string;
    baseBranch: string;
    taskTitle: string;
    taskPrompt: string;
    mode?: "scoped" | "trusted_open";
    continuityMode?: "smart_handoff" | "full_transcript";
    startTrigger?: "quota_exhausted" | "user_initiated" | "scheduled" | "task_handoff";
    triggerConfidence?: "exact" | "inferred" | "manual";
    renterLaneProvider?: string;
    renterLaneModel?: string;
    renterLaneExhaustedAt?: Date;
    renterLaneRefreshEta?: Date;
    renterQuotaSignal?: Record<string, unknown>;
    lrtLimit?: number;
    timeLimitMinutes?: number;
  }): Promise<Session>;
  getSessionById(sessionId: string, accountId: string): Promise<Session | null>;
  cancelSession(
    sessionId: string,
    accountId: string,
    role: "renter" | "provider"
  ): Promise<Session | null>;
  requestBudgetExtension?: (
    sessionId: string,
    requesterAccountId: string,
    input: BudgetExtensionRequestInput,
  ) => Promise<BudgetExtensionRequestResult>;
  approveBudgetExtension?: (
    sessionId: string,
    approverAccountId: string,
    requestId: string,
    input?: BudgetExtensionApprovalInput,
  ) => Promise<BudgetExtensionDecisionResult>;
  denyBudgetExtension?: (
    sessionId: string,
    approverAccountId: string,
    requestId: string,
    input?: BudgetExtensionDenialInput,
  ) => Promise<BudgetExtensionDecisionResult>;
  // p2.6c renter-trigger state mirror
  renterQuotaState?: RenterQuotaStateStore;
  /**
   * p2.10a — session-activity read used by the desktop session-detail
   * modal. Defaults to `listSessionActivityForUi` (DB-backed).
   * Injection is intended for unit tests.
   */
  listSessionActivity?: (
    sessionId: string,
    opts: {
      role: SessionActivityRole;
      limit?: number;
      verifiedOnly?: boolean;
    },
  ) => Promise<SessionActivityRow[]>;
}

export type ListingsRateLimiter = (renterKey: string) => boolean;

// ===== Rate limiter (token-bucket-ish, in-memory) =====

export interface ListingsRateLimiterOptions {
  /** Max queries per window. Defaults to 30. */
  capacity?: number;
  /** Window length in ms. Defaults to 60_000 (1 minute). */
  windowMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface BucketState {
  count: number;
  windowStart: number;
}

/**
 * Per-renter token bucket. Caps `capacity` requests per `windowMs`.
 * Pure in-memory; one process. Good enough for V1 anti-enumeration.
 * Production hardening (Redis/distributed) lands in pc.4.
 */
export function buildInMemoryListingsRateLimiter(
  options: ListingsRateLimiterOptions = {}
): ListingsRateLimiter {
  const capacity = options.capacity ?? 30;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, BucketState>();

  return (renterKey: string): boolean => {
    const t = now();
    const bucket = buckets.get(renterKey);
    if (!bucket || t - bucket.windowStart >= windowMs) {
      buckets.set(renterKey, { count: 1, windowStart: t });
      return true;
    }
    if (bucket.count >= capacity) {
      return false;
    }
    bucket.count += 1;
    return true;
  };
}

// ===== Helpers =====

export function isRentEnabled(): boolean {
  const v = process.env.LETAGENTS_RENT_ENABLED ?? "";
  return /^(1|true|yes)$/i.test(v.trim());
}

function requireRentEnabled(res: Response): boolean {
  if (!isRentEnabled()) {
    res.status(404).json({ error: "rent_disabled" });
    return false;
  }
  return true;
}

// ===== D3 trigger context validators (p1.7) =====
//
// The shape of `start_trigger`, `trigger_confidence`, and the renter
// lane fields is defined in spec §19.2 (rental_sessions D3 columns).
// We validate at the route boundary so malformed input never reaches
// the service or the DB enum check (which would 500 instead of 400).

export const RENTAL_START_TRIGGERS = [
  "quota_exhausted",
  "user_initiated",
  "scheduled",
  "task_handoff",
] as const;
export type RentalStartTrigger = (typeof RENTAL_START_TRIGGERS)[number];

export const RENTAL_TRIGGER_CONFIDENCES = [
  "exact",
  "inferred",
  "manual",
] as const;
export type RentalTriggerConfidence = (typeof RENTAL_TRIGGER_CONFIDENCES)[number];

export function isRentalStartTrigger(value: unknown): value is RentalStartTrigger {
  return typeof value === "string"
    && (RENTAL_START_TRIGGERS as readonly string[]).includes(value);
}

export function isRentalTriggerConfidence(
  value: unknown,
): value is RentalTriggerConfidence {
  return typeof value === "string"
    && (RENTAL_TRIGGER_CONFIDENCES as readonly string[]).includes(value);
}

/**
 * Parsed renter-side trigger context. Returned by
 * {@link parseTriggerContext} as a discriminated success/error so the
 * route handler can either forward it to the service or 400 the caller.
 */
export type ParsedTriggerContext =
  | { ok: true; value: TriggerContext }
  | { ok: false; error: string };

interface TriggerContext {
  startTrigger?: RentalStartTrigger;
  triggerConfidence?: RentalTriggerConfidence;
  renterLaneProvider?: string;
  renterLaneModel?: string;
  renterLaneExhaustedAt?: Date;
  renterLaneRefreshEta?: Date;
  renterQuotaSignal?: Record<string, unknown>;
}

function parseIsoDateOrError(
  value: unknown,
  field: string,
): { ok: true; value: Date } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${field} must be an ISO-8601 timestamp string` };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `${field} is not a valid ISO-8601 timestamp` };
  }
  return { ok: true, value: new Date(ms) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveLrt(
  body: Record<string, unknown>,
  field: string,
): number | { error: string } {
  const value = body[field];
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
  ) {
    return { error: `${field} must be a finite positive integer` };
  }
  return value;
}

function parseOptionalText(
  body: Record<string, unknown>,
  field: string,
): string | undefined | { error: string } {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    return { error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseBudgetExtensionRequest(
  body: unknown,
): BudgetExtensionRequestInput | { error: string } {
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const requestedAdditionalLrt = parsePositiveLrt(body, "requestedAdditionalLrt");
  if (typeof requestedAdditionalLrt !== "number") return requestedAdditionalLrt;
  const reason = parseOptionalText(body, "reason");
  if (typeof reason === "object") return reason;
  return { requestedAdditionalLrt, reason };
}

function parseBudgetExtensionApproval(
  body: unknown,
): BudgetExtensionApprovalInput | { error: string } {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) return { error: "body must be an object" };

  let approvedAdditionalLrt: number | undefined;
  if (body.approvedAdditionalLrt !== undefined && body.approvedAdditionalLrt !== null) {
    const parsed = parsePositiveLrt(body, "approvedAdditionalLrt");
    if (typeof parsed !== "number") return parsed;
    approvedAdditionalLrt = parsed;
  }
  const note = parseOptionalText(body, "note");
  if (typeof note === "object") return note;
  return { approvedAdditionalLrt, note };
}

function parseBudgetExtensionDenial(
  body: unknown,
): BudgetExtensionDenialInput | { error: string } {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const reason = parseOptionalText(body, "reason");
  if (typeof reason === "object") return reason;
  return { reason };
}

/**
 * Parse + validate the D3 trigger-context fields from a session-create
 * request body. Returns a structured success or a 400-quality error.
 * Exported for unit tests; the route uses it directly.
 */
export function parseTriggerContext(body: Record<string, unknown>): ParsedTriggerContext {
  const ctx: TriggerContext = {};

  if (body.startTrigger !== undefined && body.startTrigger !== null) {
    if (!isRentalStartTrigger(body.startTrigger)) {
      return {
        ok: false,
        error: `startTrigger must be one of: ${RENTAL_START_TRIGGERS.join(", ")}`,
      };
    }
    ctx.startTrigger = body.startTrigger;
  }

  if (body.triggerConfidence !== undefined && body.triggerConfidence !== null) {
    if (!isRentalTriggerConfidence(body.triggerConfidence)) {
      return {
        ok: false,
        error: `triggerConfidence must be one of: ${RENTAL_TRIGGER_CONFIDENCES.join(", ")}`,
      };
    }
    ctx.triggerConfidence = body.triggerConfidence;
  }

  if (body.renterLaneProvider !== undefined && body.renterLaneProvider !== null) {
    if (typeof body.renterLaneProvider !== "string" || !body.renterLaneProvider.trim()) {
      return { ok: false, error: "renterLaneProvider must be a non-empty string" };
    }
    ctx.renterLaneProvider = body.renterLaneProvider.trim();
  }

  if (body.renterLaneModel !== undefined && body.renterLaneModel !== null) {
    if (typeof body.renterLaneModel !== "string" || !body.renterLaneModel.trim()) {
      return { ok: false, error: "renterLaneModel must be a non-empty string" };
    }
    ctx.renterLaneModel = body.renterLaneModel.trim();
  }

  if (body.renterLaneExhaustedAt !== undefined && body.renterLaneExhaustedAt !== null) {
    const parsed = parseIsoDateOrError(body.renterLaneExhaustedAt, "renterLaneExhaustedAt");
    if (!parsed.ok) return parsed;
    ctx.renterLaneExhaustedAt = parsed.value;
  }

  if (body.renterLaneRefreshEta !== undefined && body.renterLaneRefreshEta !== null) {
    const parsed = parseIsoDateOrError(body.renterLaneRefreshEta, "renterLaneRefreshEta");
    if (!parsed.ok) return parsed;
    ctx.renterLaneRefreshEta = parsed.value;
  }

  if (body.renterQuotaSignal !== undefined && body.renterQuotaSignal !== null) {
    if (!isPlainObject(body.renterQuotaSignal)) {
      return { ok: false, error: "renterQuotaSignal must be a JSON object" };
    }
    ctx.renterQuotaSignal = body.renterQuotaSignal;
  }

  // §19.2 cross-field consistency: when the renter signals an exhausted
  // lane, we want at least the provider + start_trigger so the server
  // can later index, attribute, and emit lane.exhausted events. This is
  // a soft requirement (warning-quality), enforced strictly here so
  // partially-populated D3 records don't slip through.
  if (ctx.renterLaneExhaustedAt && !ctx.renterLaneProvider) {
    return {
      ok: false,
      error: "renterLaneProvider is required when renterLaneExhaustedAt is set",
    };
  }
  if (ctx.renterLaneExhaustedAt && !ctx.startTrigger) {
    return {
      ok: false,
      error: "startTrigger is required when renterLaneExhaustedAt is set",
    };
  }

  return { ok: true, value: ctx };
}

function resolveRenterKey(req: AuthenticatedRequest): string {
  const accountId = req.sessionAccount?.account_id;
  if (accountId) return `acct:${accountId}`;
  // Unauthenticated browse — fall back to remote address so a single
  // anonymous client can't burst-scan the whole fleet. Treat empty as
  // a wildcard so the limiter still caps it.
  const ip = (req.ip || req.socket?.remoteAddress || "anonymous").toString();
  return `ip:${ip}`;
}

function parseFilters(req: AuthenticatedRequest): PublicListingFilters {
  const q = req.query as Record<string, unknown>;
  const filters: PublicListingFilters = {};

  if (typeof q.ide_kind === "string" && q.ide_kind.trim()) {
    filters.ideKind = q.ide_kind.trim();
  } else if (typeof q.ideKind === "string" && q.ideKind.trim()) {
    filters.ideKind = q.ideKind.trim();
  }

  if (typeof q.model_label === "string" && q.model_label.trim()) {
    filters.modelLabel = q.model_label.trim();
  } else if (typeof q.modelLabel === "string" && q.modelLabel.trim()) {
    filters.modelLabel = q.modelLabel.trim();
  }

  const rawMode = typeof q.mode === "string" ? q.mode.trim() : "";
  if (rawMode === "scoped" || rawMode === "trusted_open") {
    filters.mode = rawMode;
  }

  const limitRaw = typeof q.limit === "string" ? Number.parseInt(q.limit, 10) : NaN;
  if (Number.isFinite(limitRaw) && limitRaw > 0) {
    filters.limit = limitRaw;
  }

  const offsetRaw = typeof q.offset === "string" ? Number.parseInt(q.offset, 10) : NaN;
  if (Number.isFinite(offsetRaw) && offsetRaw >= 0) {
    filters.offset = offsetRaw;
  }

  return filters;
}

// ===== Route registration =====

export function registerRentalRenterRoutes(
  app: Express,
  deps: RentalRenterRouteDeps
): void {
  const requestBudgetExtensionImpl =
    deps.requestBudgetExtension ?? requestBudgetExtension;
  const approveBudgetExtensionImpl =
    deps.approveBudgetExtension ?? approveBudgetExtension;
  const denyBudgetExtensionImpl =
    deps.denyBudgetExtension ?? denyBudgetExtension;

  // ===== p1.1b: public marketplace discovery =====
  app.get("/api/rental/listings", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;

    const renterKey = resolveRenterKey(req);
    if (!deps.shouldAllowListingsQuery(renterKey)) {
      res.status(429).json({ error: "rate_limited", retryAfterMs: 60_000 });
      return;
    }

    const filters = parseFilters(req);
    try {
      const listings: PublicRentalListing[] = await deps.publicListings(filters);
      res.json({ listings, filters });
    } catch {
      res.status(500).json({ error: "Failed to list public listings" });
    }
  });

  // ===== p1.3: session management =====

  function requireAuth(
    req: AuthenticatedRequest,
    res: Response
  ): string | null {
    const sa = req.sessionAccount;
    if (!sa) {
      res.status(401).json({ error: "unauthenticated" });
      return null;
    }
    return sa.account_id;
  }

  // POST /api/rental/sessions — renter creates a session
  app.post(
    "/api/rental/sessions",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const {
        listingId,
        repoOwner,
        repoName,
        baseBranch,
        taskTitle,
        taskPrompt,
        mode,
        continuityMode,
        lrtLimit,
        timeLimitMinutes,
      } = req.body;

      if (!listingId?.trim()) {
        return res.status(400).json({ error: "listingId is required" });
      }
      if (!repoOwner?.trim()) {
        return res.status(400).json({ error: "repoOwner is required" });
      }
      if (!repoName?.trim()) {
        return res.status(400).json({ error: "repoName is required" });
      }
      if (!baseBranch?.trim()) {
        return res.status(400).json({ error: "baseBranch is required" });
      }
      if (!taskTitle?.trim()) {
        return res.status(400).json({ error: "taskTitle is required" });
      }
      if (!taskPrompt?.trim()) {
        return res.status(400).json({ error: "taskPrompt is required" });
      }

      const triggerContext = parseTriggerContext(req.body as Record<string, unknown>);
      if (!triggerContext.ok) {
        return res.status(400).json({ error: triggerContext.error });
      }

      try {
        const session = await deps.createSession({
          listingId: listingId.trim(),
          renterAccountId: accountId,
          repoOwner: repoOwner.trim(),
          repoName: repoName.trim(),
          baseBranch: baseBranch.trim(),
          taskTitle: taskTitle.trim(),
          taskPrompt: taskPrompt.trim(),
          mode,
          continuityMode,
          startTrigger: triggerContext.value.startTrigger,
          triggerConfidence: triggerContext.value.triggerConfidence,
          renterLaneProvider: triggerContext.value.renterLaneProvider,
          renterLaneModel: triggerContext.value.renterLaneModel,
          renterLaneExhaustedAt: triggerContext.value.renterLaneExhaustedAt,
          renterLaneRefreshEta: triggerContext.value.renterLaneRefreshEta,
          renterQuotaSignal: triggerContext.value.renterQuotaSignal,
          lrtLimit,
          timeLimitMinutes,
        });
        return res.status(201).json(session);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown_error";
        if (
          message === "listing_not_found" ||
          message === "listing_not_active"
        ) {
          return res.status(404).json({ error: message });
        }
        if (message === "mode_not_supported") {
          return res.status(400).json({ error: message });
        }
        return res.status(500).json({ error: message });
      }
    }
  );

  // GET /api/rental/sessions/:id
  app.get(
    "/api/rental/sessions/:id",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const session = await deps.getSessionById(req.params.id as string, accountId);
      if (!session) {
        return res.status(404).json({ error: "session_not_found" });
      }
      return res.json(session);
    }
  );

  // GET /api/rental/sessions/:id/activity — p2.10a
  // Returns activity events visible to the caller's role (renter or
  // provider) for the session, newest-first. The renderer's session
  // -detail modal (p5.4) wires this in via the desktop IPC channel
  // `desktop:rental:get-activity` once the matching client method
  // lands.
  app.get(
    "/api/rental/sessions/:id/activity",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const sessionId = req.params.id as string;
      const session = await deps.getSessionById(sessionId, accountId);
      if (!session) {
        return res.status(404).json({ error: "session_not_found" });
      }

      // getSessionById already enforces that the caller is either
      // renter or provider. The role decides which visibility values
      // are returned.
      const role: SessionActivityRole =
        session.renter_account_id === accountId ? "renter" : "provider";

      const limit = clampActivityLimit(req.query.limit);
      const verifiedOnly =
        typeof req.query.verified_only === "string"
        && /^(1|true|yes)$/i.test(req.query.verified_only);

      try {
        const list = deps.listSessionActivity ?? listSessionActivityForUi;
        const events = await list(sessionId, { role, limit, verifiedOnly });
        return res.json({ events });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  // POST /api/rental/sessions/:id/cancel
  app.post(
    "/api/rental/sessions/:id/cancel",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      try {
        const session = await deps.cancelSession(
          req.params.id as string,
          accountId,
          "renter"
        );
        if (!session) {
          return res.status(404).json({ error: "session_not_found" });
        }
        return res.json(session);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown_error";
        if (message.startsWith("invalid_transition")) {
          return res.status(409).json({ error: message });
        }
        return res.status(500).json({ error: message });
      }
    }
  );

  // ===== p2.6c: renter-trigger state mirror =====
  //
  // Two thin routes wrap the in-memory RenterQuotaStateStore so the
  // renter's desktop adapter (or UI) can declare quota exhaustion
  // and the next browse session sees it. The state lifts cleanly
  // out of memory once a rental_session is created with these D3
  // fields — at which point the row on rental_sessions becomes the
  // source of truth.

  const renterQuotaState = deps.renterQuotaState ?? defaultRenterQuotaStateStore;

  app.get(
    "/api/rental/renter/quota-status",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const decl = renterQuotaState.get(accountId);
      const payload: RenterQuotaStatus = renterQuotaState.serialize(decl);
      return res.json(payload);
    },
  );

  app.post(
    "/api/rental/renter/declare-quota-exhausted",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      // Reuse the p1.7 trigger-context parser so the validation
      // surface is identical to POST /api/rental/sessions. The
      // caller can ship `clear: true` to explicitly drop a stale
      // declaration instead of creating one.
      if ((req.body as { clear?: unknown })?.clear === true) {
        renterQuotaState.clear(accountId);
        const empty = renterQuotaState.serialize(null);
        return res.json(empty);
      }

      const triggerContext = parseTriggerContext(
        req.body as Record<string, unknown>,
      );
      if (!triggerContext.ok) {
        return res.status(400).json({ error: triggerContext.error });
      }

      const ctx = triggerContext.value;
      // Manual-declare semantics: the renter is asserting their own
      // lane is exhausted. The endpoint is /declare-quota-exhausted,
      // so only the `quota_exhausted` start_trigger value is
      // semantically valid here — other triggers (user_initiated /
      // scheduled / task_handoff) describe different intents and
      // shouldn't be stored as a quota-exhausted state mirror.
      // Require the same fields a quota_exhausted session-create
      // would require so the GET /quota-status payload can populate
      // everything the next session-create needs.
      if (!ctx.startTrigger) {
        return res.status(400).json({ error: "startTrigger is required" });
      }
      if (ctx.startTrigger !== "quota_exhausted") {
        return res.status(400).json({
          error:
            "startTrigger must be 'quota_exhausted' on the declare-quota-exhausted endpoint",
        });
      }
      if (!ctx.triggerConfidence) {
        return res.status(400).json({ error: "triggerConfidence is required" });
      }
      if (!ctx.renterLaneProvider) {
        return res.status(400).json({ error: "renterLaneProvider is required" });
      }
      if (!ctx.renterLaneExhaustedAt) {
        return res
          .status(400)
          .json({ error: "renterLaneExhaustedAt is required" });
      }

      renterQuotaState.declare(accountId, {
        startTrigger: ctx.startTrigger,
        triggerConfidence: ctx.triggerConfidence,
        provider: ctx.renterLaneProvider,
        model: ctx.renterLaneModel ?? null,
        exhaustedAt: ctx.renterLaneExhaustedAt,
        refreshEta: ctx.renterLaneRefreshEta ?? null,
        signal: ctx.renterQuotaSignal ?? null,
      });

      const stored = renterQuotaState.get(accountId);
      return res.json(renterQuotaState.serialize(stored));
    },
  );

  app.post(
    "/api/rental/sessions/:id/budget-extension-requests",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parseBudgetExtensionRequest(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      try {
        const result = await requestBudgetExtensionImpl(
          req.params.id as string,
          accountId,
          parsed,
        );
        return res.status(201).json(result);
      } catch (err: unknown) {
        if (err instanceof BudgetExtensionError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/budget-extension-requests/:requestId/approve",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parseBudgetExtensionApproval(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      try {
        const result = await approveBudgetExtensionImpl(
          req.params.id as string,
          accountId,
          req.params.requestId as string,
          parsed,
        );
        return res.json(result);
      } catch (err: unknown) {
        if (err instanceof BudgetExtensionError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/budget-extension-requests/:requestId/deny",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parseBudgetExtensionDenial(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      try {
        const result = await denyBudgetExtensionImpl(
          req.params.id as string,
          accountId,
          req.params.requestId as string,
          parsed,
        );
        return res.json(result);
      } catch (err: unknown) {
        if (err instanceof BudgetExtensionError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );
}
