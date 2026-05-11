/**
 * Internal rental routes — called by adapters / MCP tools, not browsers.
 *
 * Routes (mounted under /api/rental):
 *   POST /api/rental/sessions/:id/usage  — adapter snapshot ingest (p2.2)
 *
 * Auth: an authenticated session must belong to the rental session as
 *       either the renter or the provider. Anonymous calls are 401.
 * Feature gate: `LETAGENTS_RENT_ENABLED` (404 `rent_disabled` when off).
 *
 * Spec §17.7 (MeterAdapter contract) + §19.6 (rental_usage_meters).
 * Part of PR p2.2 (Phase 2 server-side foundation).
 */

import type { Express, Response } from "express";
import { eq } from "drizzle-orm";

import type { AuthenticatedRequest } from "../http-helpers.js";
import { db } from "../db/client.js";
import { rental_sessions } from "../db/schema.js";
import {
  UsageIngestError,
  defaultUsageIngestDeps,
  ingestUsage,
  type IngestUsageReport,
  type RentalUsageMeterRow,
  type RentalUsageIngestDeps,
} from "../rental/usage-ingest.js";

// ===== Deps =====

export interface RentalInternalRouteDeps {
  ingestUsage: (
    sessionId: string,
    report: IngestUsageReport,
    deps?: RentalUsageIngestDeps,
  ) => Promise<RentalUsageMeterRow>;
  /**
   * Resolve which roles (renter, provider) a session-bound account
   * has for the rental. Returns null when no such session.
   */
  resolveSessionAccess: (
    sessionId: string,
    accountId: string,
  ) => Promise<"renter" | "provider" | null>;
}

export const defaultRentalInternalDeps: RentalInternalRouteDeps = {
  ingestUsage,
  async resolveSessionAccess(sessionId, accountId) {
    const [row] = await db
      .select({
        renter: rental_sessions.renter_account_id,
        provider: rental_sessions.provider_account_id,
      })
      .from(rental_sessions)
      .where(eq(rental_sessions.id, sessionId));
    if (!row) return null;
    if (row.renter === accountId) return "renter";
    if (row.provider === accountId) return "provider";
    return null;
  },
};

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

function requireAccountId(req: AuthenticatedRequest, res: Response): string | null {
  const sa = req.sessionAccount;
  if (!sa) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return sa.account_id;
}

function parseReport(body: unknown): IngestUsageReport | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (!b.source || typeof b.source !== "string") return { error: "source is required" };
  if (!["adapter", "tool", "self_reported", "system"].includes(b.source as string)) {
    return { error: "source must be one of adapter|tool|self_reported|system" };
  }
  if (!b.snapshot || typeof b.snapshot !== "object") return { error: "snapshot is required" };
  if (!b.lrt || typeof b.lrt !== "object") return { error: "lrt is required" };
  if (typeof b.idempotencyKey !== "string" || !b.idempotencyKey.trim()) {
    return { error: "idempotencyKey is required" };
  }
  return b as unknown as IngestUsageReport;
}

// ===== Route registration =====

export function registerRentalInternalRoutes(
  app: Express,
  deps: RentalInternalRouteDeps = defaultRentalInternalDeps,
): void {
  app.post("/api/rental/sessions/:id/usage", async (req: AuthenticatedRequest, res) => {
    if (!requireRentEnabled(res)) return;
    const accountId = requireAccountId(req, res);
    if (!accountId) return;

    const sessionId = req.params.id as string;
    const access = await deps.resolveSessionAccess(sessionId, accountId);
    if (!access) {
      res.status(404).json({ error: "session not found" });
      return;
    }

    const parsed = parseReport(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const row = await deps.ingestUsage(sessionId, parsed);
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof UsageIngestError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: "Failed to ingest usage" });
    }
  });
}
