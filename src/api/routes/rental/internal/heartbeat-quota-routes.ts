import type { Express } from "express";

import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { rental_sessions } from "../../../db/schema.js";
import {
  getLivenessStatus,
  recordHeartbeat,
  type HeartbeatDeps,
  type HeartbeatResult,
  type LivenessInfo,
  type SessionRecord,
} from "../../../rental/heartbeat.js";
import { buildRefreshQuotaResponse, parseProviderHint } from "../../../rental/refresh-quota.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { requireAccountId, requireRentEnabled, requireSessionAccess } from "./helpers.js";

export function registerHeartbeatQuotaRoutes(
  app: Express,
  deps: RentalInternalRouteDeps,
): void {
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

  // ===== Refresh quota (p2.13) =====
  //
  // The MCP `rental_refresh_quota` tool posts here. V1 semantics:
  // we return the cached `native_quota_latest_snapshot` from the
  // session row without push-polling the provider's adapter (no
  // server→desktop push channel exists yet). `refreshed=false`
  // documents that no new poll happened. Auth is the same renter-or-
  // provider gate as the other internal routes.
  app.post(
    "/api/rental/sessions/:id/refresh-quota",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;

      const providerHint = parseProviderHint(req.body);

      const reader = deps.getSessionForRefreshQuota;
      if (!reader) {
        res.status(500).json({ error: "refresh_quota_unconfigured" });
        return;
      }

      let session: typeof rental_sessions.$inferSelect | null;
      try {
        session = await reader(sessionId);
      } catch {
        res.status(500).json({ error: "refresh_quota_read_failed" });
        return;
      }
      if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }

      const body = buildRefreshQuotaResponse(session, providerHint);
      res.json(body);
    },
  );
}
