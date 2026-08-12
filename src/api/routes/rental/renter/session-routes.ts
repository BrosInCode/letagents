import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { projectSessionUsage } from "../../../rental/session-usage.js";
import {
  listSessionActivityForUi,
  type SessionActivityRole,
} from "../../../rental/session-activity.js";
import { clampActivityLimit } from "../../../rental/session-activity-decisions.js";
import type { RentalRenterRouteDeps } from "./types.js";
import { requireAuth, requireRentEnabled } from "./helpers.js";
import { parseTriggerContext } from "./validation.js";

export function registerSessionRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
): void {
  // POST /api/rental/sessions — renter creates a session
  app.post(
    "/api/rental/sessions",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const {
        listingId,
        targetRoomId,
        target_room_id,
        roomHistoryAccess,
        room_history_access,
        capabilityEnvelope,
        capability_envelope,
        repoOwner,
        repoName,
        baseBranch,
        taskTitle,
        taskPrompt,
        mode,
        continuityMode,
        approvedScope,
        approved_scope,
        policy,
        lrtLimit,
        timeLimitMinutes,
      } = req.body;

      const normalizedListingId = typeof listingId === "string" ? listingId.trim() : "";
      const normalizedRepoOwner = typeof repoOwner === "string" ? repoOwner.trim() : "";
      const normalizedRepoName = typeof repoName === "string" ? repoName.trim() : "";
      const normalizedBaseBranch = typeof baseBranch === "string" ? baseBranch.trim() : "";
      const normalizedTaskTitle = typeof taskTitle === "string" ? taskTitle.trim() : "";
      const normalizedTaskPrompt = typeof taskPrompt === "string" ? taskPrompt.trim() : "";
      if (!normalizedListingId) {
        return res.status(400).json({ error: "listingId is required" });
      }
      const requestedTargetRoomId = typeof targetRoomId === "string"
        ? targetRoomId.trim()
        : typeof target_room_id === "string"
          ? target_room_id.trim()
          : "";
      const malformedRepoField = [repoOwner, repoName, baseBranch]
        .some((value) => value !== undefined && value !== null && typeof value !== "string");
      if (malformedRepoField) {
        return res.status(400).json({ error: "Repository fields must be strings" });
      }
      const hasAnyRepoField = Boolean(normalizedRepoOwner || normalizedRepoName || normalizedBaseBranch);
      if (requestedTargetRoomId && hasAnyRepoField) {
        return res.status(400).json({ error: "repository_rentals_not_available" });
      }
      if (!requestedTargetRoomId && (!normalizedRepoOwner || !normalizedRepoName || !normalizedBaseBranch)) {
        return res.status(400).json({ error: "Legacy rentals require repoOwner, repoName, and baseBranch" });
      }
      if (hasAnyRepoField && (!normalizedRepoOwner || !normalizedRepoName || !normalizedBaseBranch)) {
        return res.status(400).json({ error: "Repository access requires repoOwner, repoName, and baseBranch" });
      }
      if (!normalizedTaskTitle) {
        return res.status(400).json({ error: "taskTitle is required" });
      }
      if (!normalizedTaskPrompt) {
        return res.status(400).json({ error: "taskPrompt is required" });
      }
      if (normalizedTaskTitle.length > 240 || normalizedTaskPrompt.length > 32_000) {
        return res.status(400).json({ error: "Rental task is too large" });
      }
      if (lrtLimit !== undefined && (!Number.isInteger(lrtLimit) || lrtLimit < 1 || lrtLimit > 1_000_000_000)) {
        return res.status(400).json({ error: "lrt_limit_invalid" });
      }
      if (timeLimitMinutes !== undefined && (
        !Number.isInteger(timeLimitMinutes)
        || timeLimitMinutes < 1
        || timeLimitMinutes > 24 * 60
      )) {
        return res.status(400).json({ error: "timeLimitMinutes must be between 1 and 1440" });
      }

      const triggerContext = parseTriggerContext(req.body as Record<string, unknown>);
      if (!triggerContext.ok) {
        return res.status(400).json({ error: triggerContext.error });
      }

      try {
        let authorizedTargetRoomId: string | undefined;
        if (requestedTargetRoomId) {
          if (!deps.resolveAuthorizedTargetRoom) {
            return res.status(503).json({ error: "target_room_authorization_unavailable" });
          }
          const resolved = await deps.resolveAuthorizedTargetRoom(req, res, requestedTargetRoomId);
          if (!resolved) return;
          authorizedTargetRoomId = resolved;
        }
        const requestedHistoryAccess = roomHistoryAccess ?? room_history_access;
        if (requestedHistoryAccess !== undefined && requestedHistoryAccess !== "full" && requestedHistoryAccess !== "filtered") {
          return res.status(400).json({ error: "roomHistoryAccess must be full or filtered" });
        }
        const session = await deps.createSession({
          listingId: normalizedListingId,
          renterAccountId: accountId,
          targetRoomId: authorizedTargetRoomId,
          roomHistoryAccess: requestedHistoryAccess ?? (authorizedTargetRoomId ? "full" : "filtered"),
          capabilityEnvelope: capabilityEnvelope ?? capability_envelope ?? null,
          repoOwner: normalizedRepoOwner || undefined,
          repoName: normalizedRepoName || undefined,
          baseBranch: normalizedBaseBranch || undefined,
          taskTitle: normalizedTaskTitle,
          taskPrompt: normalizedTaskPrompt,
          mode,
          continuityMode,
          approvedScope: approvedScope ?? approved_scope ?? null,
          policy: policy ?? null,
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
          message === "listing_not_active" ||
          message === "provider_offline"
        ) {
          return res.status(404).json({ error: message });
        }
        if (
          message === "mode_not_supported" ||
          message === "lrt_limit_required" ||
          message === "lrt_limit_invalid" ||
          message === "repository_rentals_not_available"
        ) {
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

  // GET /api/rental/sessions/:id/usage — p2.11a
  //
  // Projects the existing `rental_sessions` row into the same shape
  // the desktop `DesktopRentalUsageSnapshot` expects. Auth-gated by
  // `getSessionById`, which only returns rows where the caller is
  // the renter or the provider. Pure projection (no extra DB read)
  // so the route is cheap; the latest native quota snapshot rides
  // along from `native_quota_latest_snapshot` jsonb.
  app.get(
    "/api/rental/sessions/:id/usage",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const session = await deps.getSessionById(req.params.id as string, accountId);
      if (!session) {
        return res.status(404).json({ error: "session_not_found" });
      }
      return res.json(projectSessionUsage(session));
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
        if (message.startsWith("invalid_transition") || message === "transition_fence_lost") {
          return res.status(409).json({ error: message });
        }
        return res.status(500).json({ error: message });
      }
    }
  );
}
