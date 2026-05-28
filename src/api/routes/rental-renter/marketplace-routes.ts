import type { Express } from "express";
import type { AuthenticatedRequest } from "../../http-helpers.js";
import type { PublicRentalListing } from "../../rental/listings.js";
import type { RentalRenterRouteDeps } from "./types.js";
import { parseFilters, requireRentEnabled, resolveRenterKey } from "./helpers.js";

export function registerMarketplaceRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
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
}
