/**
 * Rental provider routes — listing CRUD for providers.
 *
 * Routes:
 *   POST   /api/rental/provider/listings          — create listing
 *   GET    /api/rental/provider/listings          — list my listings
 *   PATCH  /api/rental/provider/listings/:id      — update listing
 *   POST   /api/rental/provider/listings/:id/pause   — pause listing
 *   POST   /api/rental/provider/listings/:id/resume  — resume listing
 *   POST   /api/rental/provider/sessions/:id/provision — provision accepted session
 *   GET    /api/rental/provider/readiness         — provider-level readiness rollup
 *
 * All routes gated by LETAGENTS_RENT_ENABLED env flag.
 * Part of PR p1.1 (Phase 1: Session Lifecycle & Listings).
 *
 * Spec §6 (provider listing flow), §18.2 (session accept/decline),
 *      §22 (provider readiness rollup — p2.14).
 */

import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import type {
  CreateListingInput,
  UpdateListingInput,
  RentalListing,
} from "../../rental/listings.js";
import type {
  ProvisionRentalRoomForProviderInput,
  RentalRoomResult,
} from "../../rental/room-projection.js";
import { projectProviderReadiness } from "../../rental/provider-readiness.js";

export interface RentalProviderRouteDeps {
  createListing(input: CreateListingInput): Promise<RentalListing>;
  updateListing(
    listingId: string,
    providerAccountId: string,
    input: UpdateListingInput
  ): Promise<RentalListing | null>;
  pauseListing(
    listingId: string,
    providerAccountId: string
  ): Promise<RentalListing | null>;
  resumeListing(
    listingId: string,
    providerAccountId: string
  ): Promise<RentalListing | null>;
  listMyListings(providerAccountId: string): Promise<RentalListing[]>;
  // Session management (p1.3)
  acceptSession(
    sessionId: string,
    providerAccountId: string
  ): Promise<unknown | null>;
  declineSession(
    sessionId: string,
    providerAccountId: string
  ): Promise<unknown | null>;
  provisionSession(
    input: ProvisionRentalRoomForProviderInput,
  ): Promise<RentalRoomResult | null>;
  listProviderRequests(providerAccountId: string): Promise<unknown[]>;
}

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

function requireProviderAccountId(
  req: AuthenticatedRequest,
  res: Response
): string | null {
  const sa = req.sessionAccount;
  if (!sa) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  // Both SessionAccount and OwnerTokenAccount have account_id
  return sa.account_id;
}

export function registerRentalProviderRoutes(
  app: Express,
  deps: RentalProviderRouteDeps
): void {
  // POST /api/rental/provider/listings — create
  app.post("/api/rental/provider/listings", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    const accountId = requireProviderAccountId(req, res);
    if (!accountId) return;

    const { displayName, ideKind, modelLabel, quotaLaneId, quotaLaneLabel, supportedModes, defaultLrtLimit, defaultTimeLimitMinutes, manualAcceptRequired } = req.body as {
      displayName?: string;
      ideKind?: string;
      modelLabel?: string | null;
      quotaLaneId?: string | null;
      quotaLaneLabel?: string | null;
      supportedModes?: string[];
      defaultLrtLimit?: number | null;
      defaultTimeLimitMinutes?: number | null;
      manualAcceptRequired?: boolean;
    };

    if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
      res.status(400).json({ error: "displayName is required" });
      return;
    }
    if (!ideKind || typeof ideKind !== "string" || !ideKind.trim()) {
      res.status(400).json({ error: "ideKind is required" });
      return;
    }

    try {
      const listing = await deps.createListing({
        providerAccountId: accountId,
        displayName: displayName.trim(),
        ideKind: ideKind.trim(),
        modelLabel,
        quotaLaneId,
        quotaLaneLabel,
        supportedModes,
        defaultLrtLimit,
        defaultTimeLimitMinutes,
        manualAcceptRequired,
      });
      res.status(201).json(listing);
    } catch (error) {
      res.status(500).json({ error: "Failed to create listing" });
    }
  });

  // GET /api/rental/provider/listings — list mine
  app.get("/api/rental/provider/listings", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    const accountId = requireProviderAccountId(req, res);
    if (!accountId) return;

    try {
      const listings = await deps.listMyListings(accountId);
      res.json({ listings });
    } catch (error) {
      res.status(500).json({ error: "Failed to list listings" });
    }
  });

  // PATCH /api/rental/provider/listings/:id — update
  app.patch("/api/rental/provider/listings/:id", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    const accountId = requireProviderAccountId(req, res);
    if (!accountId) return;

    const listingId = req.params.id as string;
    const input = req.body as {
      displayName?: string;
      modelLabel?: string | null;
      quotaLaneId?: string | null;
      quotaLaneLabel?: string | null;
      supportedModes?: string[];
      defaultLrtLimit?: number | null;
      defaultTimeLimitMinutes?: number | null;
      manualAcceptRequired?: boolean;
    };

    try {
      // Validate displayName if provided — must not be empty/whitespace
      if (input.displayName !== undefined) {
        if (typeof input.displayName !== "string" || !input.displayName.trim()) {
          res.status(400).json({ error: "displayName must not be empty" });
          return;
        }
        input.displayName = input.displayName.trim();
      }

      const listing = await deps.updateListing(listingId, accountId, input);
      if (!listing) {
        res.status(404).json({ error: "Listing not found" });
        return;
      }
      res.json(listing);
    } catch (error) {
      res.status(500).json({ error: "Failed to update listing" });
    }
  });

  // POST /api/rental/provider/listings/:id/pause
  app.post("/api/rental/provider/listings/:id/pause", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    const accountId = requireProviderAccountId(req, res);
    if (!accountId) return;

    try {
      const listing = await deps.pauseListing(req.params.id as string, accountId);
      if (!listing) {
        res.status(404).json({ error: "Listing not found" });
        return;
      }
      res.json(listing);
    } catch (error) {
      res.status(500).json({ error: "Failed to pause listing" });
    }
  });

  // POST /api/rental/provider/listings/:id/resume
  app.post("/api/rental/provider/listings/:id/resume", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    const accountId = requireProviderAccountId(req, res);
    if (!accountId) return;

    try {
      const listing = await deps.resumeListing(req.params.id as string, accountId);
      if (!listing) {
        res.status(404).json({ error: "Listing not found" });
        return;
      }
      res.json(listing);
    } catch (error) {
      res.status(500).json({ error: "Failed to resume listing" });
    }
  });

  // GET /api/rental/provider/readiness — provider-level readiness rollup (p2.14)
  app.get(
    "/api/rental/provider/readiness",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireProviderAccountId(req, res);
      if (!accountId) return;

      try {
        const listings = await deps.listMyListings(accountId);
        res.json(projectProviderReadiness(listings));
      } catch (error) {
        res.status(500).json({ error: "Failed to compute readiness" });
      }
    }
  );

  // ===== Session management routes (p1.3) =====

  // GET /api/rental/provider/requests — list incoming session requests
  app.get(
    "/api/rental/provider/requests",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireProviderAccountId(req, res);
      if (!accountId) return;

      try {
        const requests = await deps.listProviderRequests(accountId);
        res.json(requests);
      } catch (error) {
        res.status(500).json({ error: "Failed to list requests" });
      }
    }
  );

  // POST /api/rental/provider/sessions/:id/accept — accept a session request
  app.post(
    "/api/rental/provider/sessions/:id/accept",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireProviderAccountId(req, res);
      if (!accountId) return;

      try {
        const session = await deps.acceptSession(
          req.params.id as string,
          accountId
        );
        if (!session) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        res.json(session);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown_error";
        if (
          message.startsWith("invalid_transition")
          || message.startsWith("quota_lease_")
          || message === "listing_at_capacity"
        ) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: "Failed to accept session" });
      }
    }
  );

  // POST /api/rental/provider/sessions/:id/provision — create rental room
  app.post(
    "/api/rental/provider/sessions/:id/provision",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireProviderAccountId(req, res);
      if (!accountId) return;

      const parentRoomId = typeof req.body?.parentRoomId === "string"
        ? req.body.parentRoomId.trim()
        : typeof req.body?.parent_room_id === "string"
          ? req.body.parent_room_id.trim()
          : "";
      if (!parentRoomId) {
        res.status(400).json({ error: "parentRoomId is required" });
        return;
      }

      const account = req.sessionAccount;
      const providerDisplayName = typeof req.body?.providerDisplayName === "string"
        && req.body.providerDisplayName.trim()
        ? req.body.providerDisplayName.trim()
        : typeof req.body?.provider_display_name === "string"
          && req.body.provider_display_name.trim()
          ? req.body.provider_display_name.trim()
          : account?.display_name || account?.login || "Rental Agent";

      try {
        const result = await deps.provisionSession({
          sessionId: req.params.id as string,
          providerAccountId: accountId,
          parentRoomId,
          providerDisplayName,
          providerGithubLogin: account?.login ?? undefined,
          providerGithubId: account?.provider_user_id ?? undefined,
        });
        if (!result) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        res.status(201).json(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown_error";
        if (message.startsWith("invalid_status")) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: "Failed to provision session" });
      }
    }
  );

  // POST /api/rental/provider/sessions/:id/decline — decline a session request
  app.post(
    "/api/rental/provider/sessions/:id/decline",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireProviderAccountId(req, res);
      if (!accountId) return;

      try {
        const session = await deps.declineSession(
          req.params.id as string,
          accountId
        );
        if (!session) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        res.json(session);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown_error";
        if (message.startsWith("invalid_transition")) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: "Failed to decline session" });
      }
    }
  );
}
