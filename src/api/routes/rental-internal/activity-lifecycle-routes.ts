import type { Express } from "express";

import type { AuthenticatedRequest } from "../../http-helpers.js";
import { isValidTransition } from "../../rental/session-state-machine.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { requireAccountId, requireRentEnabled, requireSessionAccess } from "./helpers.js";
import { isPlainObject } from "./validation.js";

export function registerActivityLifecycleRoutes(
  app: Express,
  deps: RentalInternalRouteDeps,
): void {
  // ===== Activity emission (p3.3 §9.4) =====
  app.post(
    "/api/rental/sessions/:id/activity",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;

      const body = req.body;
      if (!isPlainObject(body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      if (typeof body.event_type !== "string" || !body.event_type) {
        res.status(400).json({ error: "event_type is required" });
        return;
      }

      const accountId = (req as AuthenticatedRequest).sessionAccount!.account_id;
      const role = await deps.resolveSessionAccess(sessionId, accountId);
      const source = (typeof body.source === "string" && body.source.trim())
        ? body.source.trim()
        : (role === "provider" ? "agent" : role ?? "agent");

      try {
        const sess = await deps.getSessionLifecycle(sessionId);
        if (!sess?.room_id) {
          res.status(409).json({ error: "session has no room_id" });
          return;
        }
        const event = await deps.emitActivityEvent({
          sessionId,
          roomId: sess.room_id,
          eventType: body.event_type as any,
          source: source as any,
          payload: isPlainObject(body.payload) ? body.payload : {},
          verified: typeof body.verified === "boolean" ? body.verified : undefined,
        });
        res.status(201).json(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to emit activity";
        res.status(500).json({ error: message });
      }
    },
  );

  // ===== Complete session (p3.3 §18.4) =====
  app.post(
    "/api/rental/sessions/:id/complete",
    async (req: AuthenticatedRequest, res) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAccountId(req, res);
      if (!accountId) return;

      const sessionId = req.params.id as string;
      const role = await deps.resolveSessionAccess(sessionId, accountId);
      if (!role) {
        res.status(404).json({ error: "session not found" });
        return;
      }

      const body = req.body ?? {};
      const summary = typeof body.summary === "string" ? body.summary.trim() : undefined;

      try {
        // Read current status for transition validation
        const current = await deps.getSessionLifecycle(sessionId);
        if (!current) {
          res.status(404).json({ error: "session not found" });
          return;
        }
        if (!isValidTransition(current.status, "completed")) {
          res.status(409).json({
            error: `invalid_transition: cannot move from ${current.status} to completed`,
          });
          return;
        }

        const updated = await deps.updateSessionLifecycle(sessionId, {
          status: "completed",
          endedAt: new Date(),
        });

        if (!updated) {
          res.status(404).json({ error: "session not found" });
          return;
        }

        // Emit session.completed event
        if (updated.room_id) {
          const { SESSION_COMPLETED } = await import("../../rental/activity-event-types.js");
          await deps.emitActivityEvent({
            sessionId,
            roomId: updated.room_id,
            eventType: SESSION_COMPLETED,
            source: role,
            payload: { summary: summary ?? null },
          });
        }
        await deps.releaseSessionLease?.({
          sessionId,
          roomId: updated.room_id,
          reason: "completed",
        });

        res.json(updated);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to complete session";
        if (message.includes("invalid_transition")) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );

  // ===== Cancel session (p3.3 §18.4) =====
  //
  // Both renter and provider can cancel — resolveSessionAccess returns
  // the caller's role, which is recorded in the cancellation event.
  app.post(
    "/api/rental/sessions/:id/cancel",
    async (req: AuthenticatedRequest, res) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAccountId(req, res);
      if (!accountId) return;

      const sessionId = req.params.id as string;
      const role = await deps.resolveSessionAccess(sessionId, accountId);
      if (!role) {
        res.status(404).json({ error: "session not found" });
        return;
      }

      const body = req.body ?? {};
      const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;

      try {
        // Read current status for transition validation
        const current = await deps.getSessionLifecycle(sessionId);
        if (!current) {
          res.status(404).json({ error: "session not found" });
          return;
        }
        if (!isValidTransition(current.status, "cancelled")) {
          res.status(409).json({
            error: `invalid_transition: cannot move from ${current.status} to cancelled`,
          });
          return;
        }

        const updated = await deps.updateSessionLifecycle(sessionId, {
          status: "cancelled",
          endedAt: new Date(),
        });

        if (!updated) {
          res.status(404).json({ error: "session not found" });
          return;
        }

        // Emit session.cancelled event
        if (updated.room_id) {
          const { SESSION_CANCELLED } = await import("../../rental/activity-event-types.js");
          await deps.emitActivityEvent({
            sessionId,
            roomId: updated.room_id,
            eventType: SESSION_CANCELLED,
            source: role,
            payload: { reason: reason ?? null, cancelled_by: role },
          });
        }
        await deps.releaseSessionLease?.({
          sessionId,
          roomId: updated.room_id,
          reason: "cancelled",
        });

        res.json(updated);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to cancel session";
        if (message.includes("invalid_transition")) {
          res.status(409).json({ error: message });
          return;
        }
        res.status(500).json({ error: message });
      }
    },
  );
}
