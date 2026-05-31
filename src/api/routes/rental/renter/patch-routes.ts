import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import {
  approvePatchForRenter,
  listPatchProposalsForReview,
  PatchReviewError,
  requestPatchChangesForRenter,
} from "../../../rental/patch-review.js";
import type { RentalRenterRouteDeps } from "./types.js";
import { requireAuth, requireRentEnabled } from "./helpers.js";
import { parsePatchReviewNote } from "./validation.js";

export function registerPatchRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
): void {
  const listPatchProposalsImpl =
    deps.listPatchProposals ?? listPatchProposalsForReview;
  const approvePatchImpl =
    deps.approvePatch ?? approvePatchForRenter;
  const requestPatchChangesImpl =
    deps.requestPatchChanges ?? requestPatchChangesForRenter;

  // GET /api/rental/sessions/:id/patches — p5.4 renter patch review
  app.get(
    "/api/rental/sessions/:id/patches",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const sessionId = req.params.id as string;
      const session = await deps.getSessionById(sessionId, accountId);
      if (!session) {
        return res.status(404).json({ error: "session_not_found" });
      }

      try {
        const patches = await listPatchProposalsImpl(sessionId);
        return res.json({ patches });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/patches/:patchId/approve",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parsePatchReviewNote(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      const sessionId = req.params.id as string;
      const session = await deps.getSessionById(sessionId, accountId);
      if (!session) {
        return res.status(404).json({ error: "session_not_found" });
      }

      try {
        const result = await approvePatchImpl(
          session,
          accountId,
          req.params.patchId as string,
          parsed,
        );
        return res.json(result);
      } catch (err: unknown) {
        if (err instanceof PatchReviewError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/patches/:patchId/request-changes",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parsePatchReviewNote(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      const sessionId = req.params.id as string;
      const session = await deps.getSessionById(sessionId, accountId);
      if (!session) {
        return res.status(404).json({ error: "session_not_found" });
      }

      try {
        const result = await requestPatchChangesImpl(
          session,
          accountId,
          req.params.patchId as string,
          parsed,
        );
        return res.json(result);
      } catch (err: unknown) {
        if (err instanceof PatchReviewError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );
}
