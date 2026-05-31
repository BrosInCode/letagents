import type { Response } from "express";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { PublicListingFilters } from "../../../rental/listings.js";
import { isRentEnabled } from "./validation.js";

export function requireRentEnabled(res: Response): boolean {
  if (!isRentEnabled()) {
    res.status(404).json({ error: "rent_disabled" });
    return false;
  }
  return true;
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
): string | null {
  const sa = req.sessionAccount;
  if (!sa) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  return sa.account_id;
}

export function resolveRenterKey(req: AuthenticatedRequest): string {
  const accountId = req.sessionAccount?.account_id;
  if (accountId) return `acct:${accountId}`;
  // Unauthenticated browse — fall back to remote address so a single
  // anonymous client can't burst-scan the whole fleet. Treat empty as
  // a wildcard so the limiter still caps it.
  const ip = (req.ip || req.socket?.remoteAddress || "anonymous").toString();
  return `ip:${ip}`;
}

export function parseFilters(req: AuthenticatedRequest): PublicListingFilters {
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
