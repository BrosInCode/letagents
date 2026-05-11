/**
 * Renter-facing rental routes.
 *
 * Routes:
 *   GET    /api/rental/listings              — public marketplace discovery (paginated)
 *   POST   /api/rental/sessions              — create session (p1.3)
 *   GET    /api/rental/sessions/:id          — get session (p1.3)
 *   POST   /api/rental/sessions/:id/cancel   — cancel session (p1.3)
 *
 * Gated by `LETAGENTS_RENT_ENABLED` like the provider routes.
 * Rate-limited per renter session to prevent enumeration of the
 * full provider fleet.
 *
 * Spec §20 (API surface), §1.5 (readiness-gated marketplace),
 * §22.2 (Available to rent UX), §7 (renter session flow),
 * §18.2 (session state machine).
 */

import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../http-helpers.js";
import type {
  PublicListingFilters,
  PublicListingsQuery,
  PublicRentalListing,
} from "../rental/listings.js";
import type { rental_sessions } from "../db/schema.js";

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
        startTrigger,
        triggerConfidence,
        renterLaneProvider,
        renterLaneModel,
        renterLaneExhaustedAt,
        renterLaneRefreshEta,
        renterQuotaSignal,
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
          startTrigger,
          triggerConfidence,
          renterLaneProvider,
          renterLaneModel,
          renterLaneExhaustedAt: renterLaneExhaustedAt
            ? new Date(renterLaneExhaustedAt)
            : undefined,
          renterLaneRefreshEta: renterLaneRefreshEta
            ? new Date(renterLaneRefreshEta)
            : undefined,
          renterQuotaSignal,
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
}
