import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import {
  defaultRenterQuotaStateStore,
  type RenterQuotaStatus,
} from "../../../rental/renter-quota-state.js";
import type { RentalRenterRouteDeps } from "./types.js";
import { requireAuth, requireRentEnabled } from "./helpers.js";
import { parseTriggerContext } from "./validation.js";

export function registerRenterQuotaRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
): void {
  // ===== p2.6c: renter-trigger state mirror =====
  //
  // Two thin routes wrap the in-memory RenterQuotaStateStore so the
  // renter's desktop adapter (or UI) can declare quota exhaustion
  // and the next browse session sees it. The state lifts cleanly
  // out of memory once a rental_session is created with these D3
  // fields — at which point the row on rental_sessions becomes the
  // source of truth.

  const renterQuotaState = deps.renterQuotaState ?? defaultRenterQuotaStateStore;

  app.get(
    "/api/rental/renter/quota-status",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const decl = renterQuotaState.get(accountId);
      const payload: RenterQuotaStatus = renterQuotaState.serialize(decl);
      return res.json(payload);
    },
  );

  app.post(
    "/api/rental/renter/declare-quota-exhausted",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      // Reuse the p1.7 trigger-context parser so the validation
      // surface is identical to POST /api/rental/sessions. The
      // caller can ship `clear: true` to explicitly drop a stale
      // declaration instead of creating one.
      if ((req.body as { clear?: unknown })?.clear === true) {
        renterQuotaState.clear(accountId);
        const empty = renterQuotaState.serialize(null);
        return res.json(empty);
      }

      const triggerContext = parseTriggerContext(
        req.body as Record<string, unknown>,
      );
      if (!triggerContext.ok) {
        return res.status(400).json({ error: triggerContext.error });
      }

      const ctx = triggerContext.value;
      // Manual-declare semantics: the renter is asserting their own
      // lane is exhausted. The endpoint is /declare-quota-exhausted,
      // so only the `quota_exhausted` start_trigger value is
      // semantically valid here — other triggers (user_initiated /
      // scheduled / task_handoff) describe different intents and
      // shouldn't be stored as a quota-exhausted state mirror.
      // Require the same fields a quota_exhausted session-create
      // would require so the GET /quota-status payload can populate
      // everything the next session-create needs.
      if (!ctx.startTrigger) {
        return res.status(400).json({ error: "startTrigger is required" });
      }
      if (ctx.startTrigger !== "quota_exhausted") {
        return res.status(400).json({
          error:
            "startTrigger must be 'quota_exhausted' on the declare-quota-exhausted endpoint",
        });
      }
      if (!ctx.triggerConfidence) {
        return res.status(400).json({ error: "triggerConfidence is required" });
      }
      if (!ctx.renterLaneProvider) {
        return res.status(400).json({ error: "renterLaneProvider is required" });
      }
      if (!ctx.renterLaneExhaustedAt) {
        return res
          .status(400)
          .json({ error: "renterLaneExhaustedAt is required" });
      }

      renterQuotaState.declare(accountId, {
        startTrigger: ctx.startTrigger,
        triggerConfidence: ctx.triggerConfidence,
        provider: ctx.renterLaneProvider,
        model: ctx.renterLaneModel ?? null,
        exhaustedAt: ctx.renterLaneExhaustedAt,
        refreshEta: ctx.renterLaneRefreshEta ?? null,
        signal: ctx.renterQuotaSignal ?? null,
      });

      const stored = renterQuotaState.get(accountId);
      return res.json(renterQuotaState.serialize(stored));
    },
  );
}
