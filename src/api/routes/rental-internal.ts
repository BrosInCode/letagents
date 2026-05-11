/**
 * Internal rental routes — called by adapters / MCP tools, not browsers.
 *
 * Routes (mounted under /api/rental):
 *   POST /api/rental/sessions/:id/usage      — adapter snapshot ingest (p2.2)
 *   POST /api/rental/sessions/:id/heartbeat  — provider liveness beat (p1.5
 *                                              service + p3.2 route wiring)
 *   GET  /api/rental/sessions/:id/liveness   — read current liveness state
 *
 * Auth: an authenticated session must belong to the rental session as
 *       either the renter or the provider. Anonymous calls are 401.
 *       Heartbeats are provider-only — `recordHeartbeat` returns
 *       `not_provider` (403) when the caller doesn't own the lane.
 * Feature gate: `LETAGENTS_RENT_ENABLED` (404 `rent_disabled` when off).
 *
 * Spec §17.7 (MeterAdapter contract) + §18.3 (heartbeats / liveness) +
 * §19.6 (rental_usage_meters).
 *
 * Lands in PR p2.2 (usage) + p3.2 (heartbeat route + MCP tool wrapper).
 */

import type { Express, Response } from "express";
import { eq } from "drizzle-orm";

import type { AuthenticatedRequest } from "../http-helpers.js";
import { db } from "../db/client.js";
import { rental_sessions } from "../db/schema.js";
import {
  INGEST_CONFIDENCE_VALUES,
  UsageIngestError,
  defaultUsageIngestDeps,
  ingestUsage,
  type IngestUsageReport,
  type RentalUsageMeterRow,
  type RentalUsageIngestDeps,
} from "../rental/usage-ingest.js";
import {
  createDefaultDeps as createDefaultHeartbeatDeps,
  getLivenessStatus,
  recordHeartbeat,
  type HeartbeatDeps,
  type HeartbeatResult,
  type LivenessInfo,
  type SessionRecord,
} from "../rental/heartbeat.js";

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
  /**
   * Resolve heartbeat-backing dependencies. Lazily called per-process
   * (the underlying `createDefaultDeps()` opens DB clients on import,
   * so we defer until route hit to keep test isolation).
   */
  heartbeatDeps: () => Promise<HeartbeatDeps>;
  /**
   * Read a session by id for liveness reporting. Mirrors the
   * `getSession` shape from heartbeat.ts so tests can inject one
   * implementation for both routes.
   */
  getSessionForLiveness: (
    sessionId: string,
  ) => Promise<SessionRecord | null>;
}

let cachedHeartbeatDeps: HeartbeatDeps | null = null;

async function defaultHeartbeatDeps(): Promise<HeartbeatDeps> {
  if (cachedHeartbeatDeps) return cachedHeartbeatDeps;
  cachedHeartbeatDeps = await createDefaultHeartbeatDeps();
  return cachedHeartbeatDeps;
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
  heartbeatDeps: defaultHeartbeatDeps,
  async getSessionForLiveness(sessionId) {
    const deps = await defaultHeartbeatDeps();
    return deps.getSession(sessionId);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isFinite(value);
}

function parseReport(body: unknown): IngestUsageReport | { error: string } {
  if (!isPlainObject(body)) return { error: "body must be an object" };
  const b = body;

  // source enum
  if (typeof b.source !== "string"
      || !["adapter", "tool", "self_reported", "system"].includes(b.source)) {
    return { error: "source must be one of adapter|tool|self_reported|system" };
  }

  // snapshot — nested shape must be valid before reaching the service.
  if (!isPlainObject(b.snapshot)) return { error: "snapshot is required" };
  const snap = b.snapshot;
  if (typeof snap.provider !== "string" || !snap.provider.trim()) {
    return { error: "snapshot.provider must be a non-empty string" };
  }
  if (snap.model !== undefined && snap.model !== null && typeof snap.model !== "string") {
    return { error: "snapshot.model must be string|null|undefined" };
  }
  if (snap.nativeUnit !== undefined && snap.nativeUnit !== null && typeof snap.nativeUnit !== "string") {
    return { error: "snapshot.nativeUnit must be string|null|undefined" };
  }
  if (!isOptionalFiniteNumber(snap.nativeUsed)
      || !isOptionalFiniteNumber(snap.nativeRemaining)) {
    return { error: "snapshot.nativeUsed / nativeRemaining must be finite numbers or null" };
  }
  if (snap.nativeResetAt !== undefined && snap.nativeResetAt !== null
      && (typeof snap.nativeResetAt !== "string" || Number.isNaN(Date.parse(snap.nativeResetAt)))) {
    return { error: "snapshot.nativeResetAt must be an ISO timestamp or null" };
  }

  // lrt — nested shape must be valid.
  if (!isPlainObject(b.lrt)) return { error: "lrt is required" };
  const lrt = b.lrt;
  if (typeof lrt.lrtUsed !== "number" || !Number.isFinite(lrt.lrtUsed)) {
    return { error: "lrt.lrtUsed must be a finite number" };
  }
  if (typeof lrt.confidence !== "string"
      || !(INGEST_CONFIDENCE_VALUES as readonly string[]).includes(lrt.confidence)) {
    return {
      error: `lrt.confidence must be one of ${INGEST_CONFIDENCE_VALUES.join("|")}`,
    };
  }

  // delta — optional but must be an object when present, every numeric
  // field finite and non-negative when present. Reject silently-bad input
  // (e.g. "12.4" string) rather than coercing it to 0.
  if (b.delta !== undefined) {
    if (!isPlainObject(b.delta)) {
      return { error: "delta must be an object when provided" };
    }
    const deltaIntFields = [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "reasoningTokens",
      "requests",
      "toolCalls",
      "commandRuns",
      "filesExposed",
      "heartbeats",
    ] as const;
    for (const f of deltaIntFields) {
      const v = (b.delta as Record<string, unknown>)[f];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { error: `delta.${f} must be a finite number when provided` };
      }
    }
    const deltaNumericFields = ["credits", "usd"] as const;
    for (const f of deltaNumericFields) {
      const v = (b.delta as Record<string, unknown>)[f];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { error: `delta.${f} must be a finite number or null when provided` };
      }
    }
  }

  // idempotencyKey
  if (typeof b.idempotencyKey !== "string" || !b.idempotencyKey.trim()) {
    return { error: "idempotencyKey is required" };
  }

  // adapterPayload optional
  if (b.adapterPayload !== undefined
      && b.adapterPayload !== null
      && !isPlainObject(b.adapterPayload)) {
    return { error: "adapterPayload must be an object or null" };
  }

  // lastHeartbeatAt optional
  if (b.lastHeartbeatAt !== undefined
      && b.lastHeartbeatAt !== null
      && (typeof b.lastHeartbeatAt !== "string" || Number.isNaN(Date.parse(b.lastHeartbeatAt)))) {
    return { error: "lastHeartbeatAt must be an ISO timestamp or null" };
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

  // ===== Heartbeat (§18.3) =====
  //
  // The recordHeartbeat service from rental/heartbeat.ts lifts straight
  // into a route here: provider-only auth, transitions provisioning →
  // active on first beat, recovers stale → active. The route maps
  // recordHeartbeat's error string into HTTP status codes the same way
  // the p1.5 test stub did, so MCP / desktop clients see a stable
  // contract.
  app.post(
    "/api/rental/sessions/:id/heartbeat",
    async (req: AuthenticatedRequest, res) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAccountId(req, res);
      if (!accountId) return;

      const sessionId = req.params.id as string;
      let heartbeatDeps: HeartbeatDeps;
      try {
        heartbeatDeps = await deps.heartbeatDeps();
      } catch {
        res.status(500).json({ error: "heartbeat_deps_unavailable" });
        return;
      }

      let result: HeartbeatResult;
      try {
        result = await recordHeartbeat(sessionId, accountId, heartbeatDeps);
      } catch {
        res.status(500).json({ error: "Failed to record heartbeat" });
        return;
      }

      if (!result.ok) {
        const status = result.error === "session_not_found"
          ? 404
          : result.error === "not_provider"
            ? 403
            : 409;
        res.status(status).json({ error: result.error ?? "heartbeat_failed" });
        return;
      }
      res.json(result);
    },
  );

  app.get(
    "/api/rental/sessions/:id/liveness",
    async (req: AuthenticatedRequest, res) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAccountId(req, res);
      if (!accountId) return;

      const sessionId = req.params.id as string;
      const access = await deps.resolveSessionAccess(sessionId, accountId);
      if (!access) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }

      let session: SessionRecord | null;
      try {
        session = await deps.getSessionForLiveness(sessionId);
      } catch {
        res.status(500).json({ error: "liveness_deps_unavailable" });
        return;
      }
      if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }

      const info: LivenessInfo = getLivenessStatus(session);
      res.json(info);
    },
  );
}
