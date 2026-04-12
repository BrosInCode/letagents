/**
 * Rental API routes — session lifecycle, listings, heartbeat.
 *
 * Extracted as a separate module to avoid bloating server.ts further.
 * Mount via: `app.use(rentalRoutes)` in server.ts.
 */

import crypto from "crypto";
import express, { type Response, type Router } from "express";
import { eq, and, sql, desc, count } from "drizzle-orm";

import { db } from "./db/client.js";
import { getOrCreateCanonicalRoom } from "./db.js";
import {
  rental_listings,
  rental_sessions,
  rental_token_events,
  provider_notification_prefs,
} from "./db/schema.js";

import {
  validateCreateListing,
  validateCreateSession,
  isValidRentalSessionTransition,
  isTerminalRentalSessionStatus,
  MAX_LISTINGS_PER_PROVIDER,
  type RentalSessionStatus,
} from "../shared/rental.js";
import { KNOWN_MODELS } from "../shared/compute-units.js";
import { processHeartbeat, DEFAULT_SESSION_DURATION_MINUTES } from "../shared/rental-metering.js";
import { verifyAgentFingerprint } from "../shared/agent-fingerprint.js";
import {
  listingCreateLimiter,
  sessionCreateLimiter,
  heartbeatLimiter,
} from "./rental-rate-limit.js";
import { createScopedInstallationToken } from "./rental-sandbox-token.js";

// ─── Types ──────────────────────────────────────────────────

interface AuthenticatedRequest extends express.Request {
  sessionAccount?: { account_id: string; login: string } | null;
  authKind?: "session" | "owner_token" | null;
}

function generateRentalId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function respondWithError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function requireAuth(
  req: AuthenticatedRequest,
  res: Response
): req is AuthenticatedRequest & { sessionAccount: { account_id: string; login: string } } {
  if (!req.sessionAccount) {
    respondWithError(res, 401, "Authentication required");
    return false;
  }
  return true;
}

/** Safely extract a route param as a string (Express params can be string | string[]). */
function paramId(req: AuthenticatedRequest, name: string = "id"): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

// ─── Router ─────────────────────────────────────────────────

export function createRentalRoutes(): Router {
  const router = express.Router();

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // LISTINGS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/rental/listings — Browse marketplace (public, paginated)
   */
  router.get("/api/rental/listings", async (req: AuthenticatedRequest, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
      const offset = (page - 1) * limit;

      const modelFilter = typeof req.query.model === "string" ? req.query.model.trim() : null;
      const ideFilter = typeof req.query.ide === "string" ? req.query.ide.trim() : null;

      const conditions = [eq(rental_listings.status, "active")];
      if (modelFilter) conditions.push(eq(rental_listings.agent_model, modelFilter));
      if (ideFilter) conditions.push(eq(rental_listings.agent_ide, ideFilter));

      const where = conditions.length === 1 ? conditions[0] : and(...conditions);

      const [listings, totalResult] = await Promise.all([
        db
          .select()
          .from(rental_listings)
          .where(where)
          .orderBy(desc(rental_listings.created_at))
          .limit(limit)
          .offset(offset),
        db
          .select({ total: count() })
          .from(rental_listings)
          .where(where),
      ]);

      const total = totalResult[0]?.total ?? 0;

      res.json({
        listings: listings.map((l) => ({
          id: l.id,
          provider_account_id: l.provider_account_id,
          agent: {
            display_name: l.agent_display_name,
            model: l.agent_model,
            ide: l.agent_ide,
            description: l.agent_description,
            model_verified: l.agent_model_verified,
            ide_verified: l.agent_ide_verified,
          },
          cu: {
            budget_total: l.cu_budget_total,
            budget_used: l.cu_budget_used,
            available: l.cu_budget_total - l.cu_budget_used,
            per_session_cap: l.cu_budget_per_session,
          },
          availability: {
            status: l.status,
            available_from: l.available_from,
            available_until: l.available_until,
            max_concurrent_sessions: l.max_concurrent_sessions,
          },
          pricing: {
            price_per_1k_cu: l.price_per_1k_cu,
            currency: l.currency,
            is_free: l.price_per_1k_cu === 0,
          },
          supported_output_types: l.supported_output_types,
          created_at: l.created_at,
        })),
        pagination: { page, limit, total },
      });
    } catch (error) {
      console.error("GET /api/rental/listings", error);
      respondWithError(res, 500, "Failed to fetch listings");
    }
  });

  /**
   * GET /api/rental/listings/mine — Provider's own listings
   */
  router.get("/api/rental/listings/mine", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const listings = await db
        .select()
        .from(rental_listings)
        .where(eq(rental_listings.provider_account_id, req.sessionAccount.account_id))
        .orderBy(desc(rental_listings.created_at));

      res.json({ listings });
    } catch (error) {
      console.error("GET /api/rental/listings/mine", error);
      respondWithError(res, 500, "Failed to fetch your listings");
    }
  });

  /**
   * GET /api/rental/listings/:id — Listing detail
   */
  router.get("/api/rental/listings/:id", async (req: AuthenticatedRequest, res) => {
    try {
      const [listing] = await db
        .select()
        .from(rental_listings)
        .where(eq(rental_listings.id, paramId(req)))
        .limit(1);

      if (!listing) {
        return respondWithError(res, 404, "Listing not found");
      }

      res.json({ listing });
    } catch (error) {
      console.error("GET /api/rental/listings/:id", error);
      respondWithError(res, 500, "Failed to fetch listing");
    }
  });

  /**
   * POST /api/rental/listings — Create a new listing
   */
  router.post("/api/rental/listings", listingCreateLimiter, async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const body = req.body;
      const errors = validateCreateListing(body, KNOWN_MODELS);
      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }

      // Check max listings per provider
      const [existingCount] = await db
        .select({ total: count() })
        .from(rental_listings)
        .where(
          and(
            eq(rental_listings.provider_account_id, req.sessionAccount.account_id),
            sql`${rental_listings.status} != 'retired'`
          )
        );
      if ((existingCount?.total ?? 0) >= MAX_LISTINGS_PER_PROVIDER) {
        return respondWithError(res, 400, `Maximum ${MAX_LISTINGS_PER_PROVIDER} active listings per provider`);
      }

      // Best-effort fingerprint verification.
      const now = nowISO();
      // We check the provider's agent presence in any room they've been in.
      // For v1 this is advisory-only (listings are still created even if unverified).
      let agent_model_verified: string | null = null;
      let agent_ide_verified: string | null = null;
      let fingerprint_verified_at: string | null = null;

      try {
        // Attempt to find agent presence for this account to get signals
        // In production, this would query room_agent_presence for matching account
        // For now, we verify against the claimed values from the request
        const fpResult = verifyAgentFingerprint(
          body.agent_model,
          body.agent_ide,
          {
            // Signals would come from agent presence / session headers
            // For v1 we record the attempt but can't verify without presence data
            actor_label: null,
            ide_label: null,
            display_name: body.agent_display_name,
            user_agent: req.headers["user-agent"] || null,
          }
        );

        if (fpResult.model_verified) {
          agent_model_verified = fpResult.model_match_source;
        }
        if (fpResult.ide_verified) {
          agent_ide_verified = fpResult.ide_match_source;
        }
        if (fpResult.confidence !== "none") {
          fingerprint_verified_at = now;
        }
      } catch {
        // Fingerprint verification is best-effort — don't block listing creation
      }

      const listing = {
        id: generateRentalId("lst"),
        provider_account_id: req.sessionAccount.account_id,
        agent_display_name: body.agent_display_name.trim(),
        agent_model: body.agent_model,
        agent_ide: body.agent_ide,
        agent_description: body.agent_description?.trim() || null,
        agent_model_verified,
        agent_ide_verified,
        fingerprint_verified_at,
        cu_budget_total: body.cu_budget_total,
        cu_budget_used: 0,
        cu_budget_per_session: body.cu_budget_per_session ?? null,
        status: "active" as const,
        available_from: body.available_from || null,
        available_until: body.available_until || null,
        max_concurrent_sessions: body.max_concurrent_sessions,
        price_per_1k_cu: 0, // v1: always free
        currency: "usd",
        supported_output_types: body.supported_output_types,
        created_at: now,
        updated_at: now,
      };

      await db.insert(rental_listings).values(listing);
      res.status(201).json({ listing });
    } catch (error) {
      console.error("POST /api/rental/listings", error);
      respondWithError(res, 500, "Failed to create listing");
    }
  });

  /**
   * PATCH /api/rental/listings/:id — Update listing (owner only)
   */
  router.patch("/api/rental/listings/:id", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [listing] = await db
        .select()
        .from(rental_listings)
        .where(eq(rental_listings.id, paramId(req)))
        .limit(1);

      if (!listing) return respondWithError(res, 404, "Listing not found");
      if (listing.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Not your listing");
      }

      const updates: Record<string, unknown> = { updated_at: nowISO() };
      const { body } = req;

      if (body.agent_description !== undefined) updates.agent_description = body.agent_description?.trim() || null;
      if (body.cu_budget_per_session !== undefined) updates.cu_budget_per_session = body.cu_budget_per_session;
      if (body.available_until !== undefined) updates.available_until = body.available_until;
      if (body.max_concurrent_sessions !== undefined) updates.max_concurrent_sessions = body.max_concurrent_sessions;
      if (body.status !== undefined && ["active", "paused"].includes(body.status)) {
        updates.status = body.status;
      }

      await db.update(rental_listings).set(updates).where(eq(rental_listings.id, paramId(req)));
      res.json({ ok: true });
    } catch (error) {
      console.error("PATCH /api/rental/listings/:id", error);
      respondWithError(res, 500, "Failed to update listing");
    }
  });

  /**
   * DELETE /api/rental/listings/:id — Retire listing (owner only)
   */
  router.delete("/api/rental/listings/:id", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [listing] = await db
        .select()
        .from(rental_listings)
        .where(eq(rental_listings.id, paramId(req)))
        .limit(1);

      if (!listing) return respondWithError(res, 404, "Listing not found");
      if (listing.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Not your listing");
      }

      await db
        .update(rental_listings)
        .set({ status: "retired", updated_at: nowISO() })
        .where(eq(rental_listings.id, paramId(req)));

      res.json({ ok: true });
    } catch (error) {
      console.error("DELETE /api/rental/listings/:id", error);
      respondWithError(res, 500, "Failed to retire listing");
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PROVIDER STATS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/rental/stats — Provider dashboard stats
   */
  router.get("/api/rental/stats", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const accountId = req.sessionAccount.account_id;

      const [listingStats] = await db
        .select({
          total_listings: count(),
          total_cu_budget: sql<number>`COALESCE(SUM(${rental_listings.cu_budget_total}), 0)`,
          total_cu_used: sql<number>`COALESCE(SUM(${rental_listings.cu_budget_used}), 0)`,
        })
        .from(rental_listings)
        .where(
          and(
            eq(rental_listings.provider_account_id, accountId),
            sql`${rental_listings.status} != 'retired'`
          )
        );

      const [sessionStats] = await db
        .select({
          total_sessions: count(),
          active_sessions: sql<number>`COALESCE(SUM(CASE WHEN ${rental_sessions.status} IN ('requested', 'accepted', 'active') THEN 1 ELSE 0 END), 0)`,
          completed_sessions: sql<number>`COALESCE(SUM(CASE WHEN ${rental_sessions.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
        })
        .from(rental_sessions)
        .where(eq(rental_sessions.provider_account_id, accountId));

      res.json({
        listings: {
          total: listingStats?.total_listings ?? 0,
          cu_budget_total: listingStats?.total_cu_budget ?? 0,
          cu_budget_used: listingStats?.total_cu_used ?? 0,
        },
        sessions: {
          total: sessionStats?.total_sessions ?? 0,
          active: sessionStats?.active_sessions ?? 0,
          completed: sessionStats?.completed_sessions ?? 0,
        },
      });
    } catch (error) {
      console.error("GET /api/rental/stats", error);
      respondWithError(res, 500, "Failed to fetch stats");
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SESSIONS (LIFECYCLE)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * POST /api/rental/sessions — Request a rental (renter)
   */
  router.post("/api/rental/sessions", sessionCreateLimiter, async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const body = req.body;
      const errors = validateCreateSession(body);
      if (errors.length > 0) {
        return res.status(400).json({ errors });
      }

      // Fetch listing
      const [listing] = await db
        .select()
        .from(rental_listings)
        .where(eq(rental_listings.id, body.listing_id))
        .limit(1);

      if (!listing) return respondWithError(res, 404, "Listing not found");
      if (listing.status !== "active") return respondWithError(res, 400, "Listing is not active");

      // Self-rental check
      if (listing.provider_account_id === req.sessionAccount.account_id) {
        return respondWithError(res, 400, "Cannot rent from yourself");
      }

      // Budget check
      const cuAvailable = listing.cu_budget_total - listing.cu_budget_used;
      const sessionBudget = listing.cu_budget_per_session
        ? Math.min(listing.cu_budget_per_session, cuAvailable)
        : cuAvailable;

      if (sessionBudget < 1000) {
        return respondWithError(res, 400, "Listing has insufficient CU budget remaining");
      }

      // Global concurrent session limit check
      const [activeSessions] = await db
        .select({ total: count() })
        .from(rental_sessions)
        .where(
          and(
            eq(rental_sessions.provider_account_id, listing.provider_account_id),
            sql`${rental_sessions.status} IN ('requested', 'accepted', 'active')`
          )
        );

      if ((activeSessions?.total ?? 0) >= listing.max_concurrent_sessions) {
        return respondWithError(res, 400, "Provider has reached maximum concurrent sessions");
      }

      const now = nowISO();
      const session = {
        id: generateRentalId("rses"),
        listing_id: listing.id,
        provider_account_id: listing.provider_account_id,
        renter_account_id: req.sessionAccount.account_id,
        task_title: body.task_title.trim(),
        task_description: body.task_description.trim(),
        task_acceptance_criteria: body.task_acceptance_criteria?.trim() || null,
        repo_scope: body.repo_scope.trim(),
        target_branch: body.target_branch.trim(),
        expected_outcome: body.expected_outcome,
        sandbox_room_id: null,
        cu_budget: sessionBudget,
        cu_used: 0,
        status: "requested" as const,
        started_at: null,
        ended_at: null,
        last_heartbeat_at: null,
        max_duration_minutes: body.max_duration_minutes || DEFAULT_SESSION_DURATION_MINUTES,
        result_pr_url: null,
        result_summary: null,
        total_cost_cents: 0,
        payment_status: "free",
        payment_intent_id: null,
        created_at: now,
        updated_at: now,
      };

      await db.insert(rental_sessions).values(session);
      res.status(201).json({ session });
    } catch (error) {
      console.error("POST /api/rental/sessions", error);
      respondWithError(res, 500, "Failed to create rental session");
    }
  });

  /**
   * GET /api/rental/sessions/mine — My sessions (as provider or renter)
   */
  router.get("/api/rental/sessions/mine", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const sessions = await db
        .select()
        .from(rental_sessions)
        .where(
          sql`${rental_sessions.provider_account_id} = ${req.sessionAccount.account_id}
            OR ${rental_sessions.renter_account_id} = ${req.sessionAccount.account_id}`
        )
        .orderBy(desc(rental_sessions.created_at));

      res.json({ sessions });
    } catch (error) {
      console.error("GET /api/rental/sessions/mine", error);
      respondWithError(res, 500, "Failed to fetch sessions");
    }
  });

  /**
   * GET /api/rental/sessions/:id — Session detail
   */
  router.get("/api/rental/sessions/:id", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");

      // Only provider or renter can view
      if (
        session.provider_account_id !== req.sessionAccount.account_id &&
        session.renter_account_id !== req.sessionAccount.account_id
      ) {
        return respondWithError(res, 403, "Not authorized to view this session");
      }

      res.json({ session });
    } catch (error) {
      console.error("GET /api/rental/sessions/:id", error);
      respondWithError(res, 500, "Failed to fetch session");
    }
  });

  /**
   * POST /api/rental/sessions/:id/accept — Provider accepts a request (manual only)
   */
  router.post("/api/rental/sessions/:id/accept", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (session.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Only the provider can accept");
      }
      if (!isValidRentalSessionTransition(session.status as RentalSessionStatus, "accepted")) {
        return respondWithError(res, 400, `Cannot accept session in ${session.status} status`);
      }

      const now = nowISO();

      // Create a sandbox room for this rental session.
      // The canonical ID format is `rental:<session_id>` which ensures uniqueness
      // and makes it easy to identify rental rooms.
      const sandboxRoomId = `rental:${session.id}`;
      const { room: sandboxRoom } = await getOrCreateCanonicalRoom(sandboxRoomId);

      await db
        .update(rental_sessions)
        .set({
          status: "accepted",
          sandbox_room_id: sandboxRoom.id,
          updated_at: now,
        })
        .where(eq(rental_sessions.id, paramId(req)));

      res.json({
        ok: true,
        status: "accepted",
        sandbox_room_id: sandboxRoom.id,
        sandbox_room_display_name: sandboxRoom.display_name,
      });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/accept", error);
      respondWithError(res, 500, "Failed to accept session");
    }
  });

  /**
   * POST /api/rental/sessions/:id/reject — Provider rejects a request
   */
  router.post("/api/rental/sessions/:id/reject", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (session.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Only the provider can reject");
      }
      if (!isValidRentalSessionTransition(session.status as RentalSessionStatus, "cancelled")) {
        return respondWithError(res, 400, `Cannot reject session in ${session.status} status`);
      }

      await db
        .update(rental_sessions)
        .set({
          status: "cancelled",
          ended_at: nowISO(),
          updated_at: nowISO(),
        })
        .where(eq(rental_sessions.id, paramId(req)));

      res.json({ ok: true, status: "cancelled" });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/reject", error);
      respondWithError(res, 500, "Failed to reject session");
    }
  });

  /**
   * POST /api/rental/sessions/:id/start — Transition accepted → active
   */
  router.post("/api/rental/sessions/:id/start", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (session.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Only the provider can start the session");
      }
      if (!isValidRentalSessionTransition(session.status as RentalSessionStatus, "active")) {
        return respondWithError(res, 400, `Cannot start session in ${session.status} status`);
      }

      const now = nowISO();

      // Create a repo-scoped GitHub token for the sandbox session
      let sandbox_token: { token: string; expires_at: string } | null = null;
      try {
        const scopedResult = await createScopedInstallationToken(session.repo_scope);
        if (scopedResult) {
          sandbox_token = {
            token: scopedResult.token,
            expires_at: scopedResult.expires_at,
          };
        }
      } catch {
        // Token creation is best-effort — session can still start without it
      }

      await db
        .update(rental_sessions)
        .set({
          status: "active",
          started_at: now,
          last_heartbeat_at: now,
          updated_at: now,
        })
        .where(eq(rental_sessions.id, paramId(req)));

      res.json({
        ok: true,
        status: "active",
        sandbox_room_id: session.sandbox_room_id,
        sandbox_token, // null if GitHub App not configured or repo not installed
      });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/start", error);
      respondWithError(res, 500, "Failed to start session");
    }
  });

  /**
   * POST /api/rental/sessions/:id/heartbeat — Agent reports token usage
   */
  router.post("/api/rental/sessions/:id/heartbeat", heartbeatLimiter, async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (session.status !== "active") {
        return respondWithError(res, 400, `Cannot heartbeat session in ${session.status} status`);
      }

      // Only provider's agent can heartbeat
      if (session.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Only the provider can send heartbeats");
      }

      const { tokens_input = 0, tokens_output = 0 } = req.body;

      // Fetch the listing to get the model for CU conversion
      const [listing] = await db
        .select()
        .from(rental_listings)
        .where(eq(rental_listings.id, session.listing_id))
        .limit(1);

      if (!listing) return respondWithError(res, 500, "Listing not found for session");

      const result = processHeartbeat(
        listing.agent_model,
        tokens_input,
        tokens_output,
        session.cu_used,
        session.cu_budget
      );

      const now = nowISO();

      // Record the token event
      await db.insert(rental_token_events).values({
        id: generateRentalId("rte"),
        session_id: session.id,
        tokens_input,
        tokens_output,
        cu_delta: result.cu_delta,
        event_type: "heartbeat",
        created_at: now,
      });

      // Update session totals
      const sessionUpdates: Record<string, unknown> = {
        cu_used: result.cu_used_total,
        last_heartbeat_at: now,
        updated_at: now,
      };

      // Auto-expire if budget exhausted
      if (result.budget_exhausted) {
        sessionUpdates.status = "expired";
        sessionUpdates.ended_at = now;
      }

      await db
        .update(rental_sessions)
        .set(sessionUpdates)
        .where(eq(rental_sessions.id, session.id));

      // Update listing CU used
      await db
        .update(rental_listings)
        .set({
          cu_budget_used: sql`${rental_listings.cu_budget_used} + ${result.cu_delta}`,
          updated_at: now,
        })
        .where(eq(rental_listings.id, listing.id));

      res.json({
        ok: true,
        cu_used_this_heartbeat: result.cu_delta,
        cu_used_total: result.cu_used_total,
        cu_remaining: result.cu_remaining,
        budget_warning: result.budget_warning,
        budget_exhausted: result.budget_exhausted,
      });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/heartbeat", error);
      respondWithError(res, 500, "Failed to process heartbeat");
    }
  });

  /**
   * POST /api/rental/sessions/:id/complete — Mark session completed
   */
  router.post("/api/rental/sessions/:id/complete", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (
        session.provider_account_id !== req.sessionAccount.account_id &&
        session.renter_account_id !== req.sessionAccount.account_id
      ) {
        return respondWithError(res, 403, "Not authorized");
      }
      if (!isValidRentalSessionTransition(session.status as RentalSessionStatus, "completed")) {
        return respondWithError(res, 400, `Cannot complete session in ${session.status} status`);
      }

      const now = nowISO();
      await db
        .update(rental_sessions)
        .set({
          status: "completed",
          ended_at: now,
          result_summary: req.body.summary?.trim() || null,
          result_pr_url: req.body.pr_url?.trim() || null,
          updated_at: now,
        })
        .where(eq(rental_sessions.id, session.id));

      res.json({ ok: true, status: "completed" });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/complete", error);
      respondWithError(res, 500, "Failed to complete session");
    }
  });

  /**
   * POST /api/rental/sessions/:id/cancel — Cancel session (either party)
   */
  router.post("/api/rental/sessions/:id/cancel", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (
        session.provider_account_id !== req.sessionAccount.account_id &&
        session.renter_account_id !== req.sessionAccount.account_id
      ) {
        return respondWithError(res, 403, "Not authorized");
      }
      if (!isValidRentalSessionTransition(session.status as RentalSessionStatus, "cancelled")) {
        return respondWithError(res, 400, `Cannot cancel session in ${session.status} status`);
      }

      await db
        .update(rental_sessions)
        .set({
          status: "cancelled",
          ended_at: nowISO(),
          updated_at: nowISO(),
        })
        .where(eq(rental_sessions.id, session.id));

      res.json({ ok: true, status: "cancelled" });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/cancel", error);
      respondWithError(res, 500, "Failed to cancel session");
    }
  });

  /**
   * POST /api/rental/sessions/:id/resume — Resume a paused session
   */
  router.post("/api/rental/sessions/:id/resume", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [session] = await db
        .select()
        .from(rental_sessions)
        .where(eq(rental_sessions.id, paramId(req)))
        .limit(1);

      if (!session) return respondWithError(res, 404, "Session not found");
      if (session.provider_account_id !== req.sessionAccount.account_id) {
        return respondWithError(res, 403, "Only the provider can resume");
      }
      if (!isValidRentalSessionTransition(session.status as RentalSessionStatus, "active")) {
        return respondWithError(res, 400, `Cannot resume session in ${session.status} status`);
      }

      const now = nowISO();
      await db
        .update(rental_sessions)
        .set({
          status: "active",
          last_heartbeat_at: now,
          updated_at: now,
        })
        .where(eq(rental_sessions.id, session.id));

      res.json({ ok: true, status: "active" });
    } catch (error) {
      console.error("POST /api/rental/sessions/:id/resume", error);
      respondWithError(res, 500, "Failed to resume session");
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // NOTIFICATION PREFERENCES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/rental/notifications — Get notification preferences
   */
  router.get("/api/rental/notifications", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const [prefs] = await db
        .select()
        .from(provider_notification_prefs)
        .where(eq(provider_notification_prefs.account_id, req.sessionAccount.account_id))
        .limit(1);

      if (!prefs) {
        // Return defaults
        return res.json({
          email_enabled: true,
          email_address: null,
          telegram_enabled: false,
          telegram_chat_id: null,
          whatsapp_enabled: false,
          whatsapp_number: null,
        });
      }

      res.json({
        email_enabled: !!prefs.email_enabled,
        email_address: prefs.email_address,
        telegram_enabled: !!prefs.telegram_enabled,
        telegram_chat_id: prefs.telegram_chat_id,
        whatsapp_enabled: !!prefs.whatsapp_enabled,
        whatsapp_number: prefs.whatsapp_number,
      });
    } catch (error) {
      console.error("GET /api/rental/notifications", error);
      respondWithError(res, 500, "Failed to fetch notification preferences");
    }
  });

  /**
   * PUT /api/rental/notifications — Update notification preferences
   */
  router.put("/api/rental/notifications", async (req: AuthenticatedRequest, res) => {
    if (!requireAuth(req, res)) return;
    try {
      const body = req.body || {};
      const now = nowISO();
      const accountId = req.sessionAccount.account_id;

      // Validate email if provided
      if (body.email_address && typeof body.email_address === "string") {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(body.email_address.trim())) {
          return respondWithError(res, 400, "Invalid email address");
        }
      }

      // Validate WhatsApp number if provided
      if (body.whatsapp_number && typeof body.whatsapp_number === "string") {
        const cleaned = body.whatsapp_number.replace(/[\s\-()]/g, "");
        if (!/^\+?\d{7,15}$/.test(cleaned)) {
          return respondWithError(res, 400, "Invalid WhatsApp number");
        }
      }

      const values = {
        account_id: accountId,
        email_enabled: body.email_enabled !== undefined ? (body.email_enabled ? 1 : 0) : 1,
        email_address: body.email_address?.trim() || null,
        telegram_enabled: body.telegram_enabled ? 1 : 0,
        telegram_chat_id: body.telegram_chat_id?.trim() || null,
        whatsapp_enabled: body.whatsapp_enabled ? 1 : 0,
        whatsapp_number: body.whatsapp_number?.trim() || null,
        created_at: now,
        updated_at: now,
      };

      await db
        .insert(provider_notification_prefs)
        .values(values)
        .onConflictDoUpdate({
          target: provider_notification_prefs.account_id,
          set: {
            email_enabled: values.email_enabled,
            email_address: values.email_address,
            telegram_enabled: values.telegram_enabled,
            telegram_chat_id: values.telegram_chat_id,
            whatsapp_enabled: values.whatsapp_enabled,
            whatsapp_number: values.whatsapp_number,
            updated_at: now,
          },
        });

      res.json({
        ok: true,
        email_enabled: !!values.email_enabled,
        email_address: values.email_address,
        telegram_enabled: !!values.telegram_enabled,
        telegram_chat_id: values.telegram_chat_id,
        whatsapp_enabled: !!values.whatsapp_enabled,
        whatsapp_number: values.whatsapp_number,
      });
    } catch (error) {
      console.error("PUT /api/rental/notifications", error);
      respondWithError(res, 500, "Failed to update notification preferences");
    }
  });

  return router;
}
