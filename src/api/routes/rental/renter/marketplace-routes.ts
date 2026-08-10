import type { Express } from "express";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { PublicRentalListing } from "../../../rental/listings.js";
import type { RentalRenterRouteDeps } from "./types.js";
import { parseFilters, requireRentEnabled, resolveRenterKey } from "./helpers.js";

export function registerMarketplaceRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
): void {
  app.get("/api/rental/providers", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    if (!req.sessionAccount || req.authKind === "agent_session" || req.authKind === "supervisor_grant") {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (!deps.publicProviders) return res.status(503).json({ error: "provider_marketplace_unavailable" });
    const renterKey = resolveRenterKey(req);
    if (!deps.shouldAllowListingsQuery(renterKey)) {
      return res.status(429).json({ error: "rate_limited", retryAfterMs: 60_000 });
    }
    try {
      res.json({
        providers: await deps.publicProviders(req.sessionAccount.account_id),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      res.status(500).json({ error: "Failed to list rental providers" });
    }
  });

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
}
