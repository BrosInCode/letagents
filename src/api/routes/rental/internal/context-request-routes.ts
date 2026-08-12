import type { Express, Response } from "express";

import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { ContextRequestError } from "../../../rental/context-requests.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { requireAccountId, requireRentEnabled } from "./helpers.js";
import { isPlainObject } from "./validation.js";

/**
 * Context access requests + exposure ledger.
 *
 * Providers file requests for out-of-scope context; renters review them.
 * Decisions (approve/deny) are renter-only. The exposure ledger is
 * readable by both parties — it is the shared audit trail.
 */
export function registerContextRequestRoutes(
  app: Express,
  deps: RentalInternalRouteDeps,
): void {
  app.post(
    "/api/rental/sessions/:id/context-requests",
    async (req: AuthenticatedRequest, res) => {
      const access = await resolveAccess(req, res, deps);
      if (!access) return;
      // Requests are provider-originated by definition (the rented agent
      // asking for out-of-scope context) and are audited as such — a
      // renter must not be able to file requests attributed to the
      // provider and then approve them.
      if (access.role !== "provider") {
        res.status(403).json({ error: "only the provider can file context requests" });
        return;
      }
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      if (typeof req.body.path !== "string" || !req.body.path.trim()) {
        res.status(400).json({ error: "path is required" });
        return;
      }

      try {
        const record = await deps.createContextRequest(access.sessionId, {
          path: req.body.path,
          reason: typeof req.body.reason === "string" ? req.body.reason : undefined,
          requestType:
            typeof req.body.requestType === "string"
              ? (req.body.requestType as never)
              : undefined,
          requestedBy: access.accountId,
        });
        res.status(201).json(record);
      } catch (err) {
        handleContextRequestError(res, err);
      }
    },
  );

  app.get(
    "/api/rental/sessions/:id/context-requests",
    async (req: AuthenticatedRequest, res) => {
      const access = await resolveAccess(req, res, deps);
      if (!access) return;
      try {
        const records = await deps.listContextRequests(access.sessionId);
        res.json(records);
      } catch (err) {
        handleContextRequestError(res, err);
      }
    },
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post(
      `/api/rental/sessions/:id/context-requests/:requestId/${decision}`,
      async (req: AuthenticatedRequest, res) => {
        const access = await resolveAccess(req, res, deps);
        if (!access) return;
        if (access.role !== "renter") {
          res.status(403).json({ error: "only the renter can decide context requests" });
          return;
        }

        try {
          const result = await deps.decideContextRequest(access.sessionId, {
            requestId: String(req.params.requestId),
            decision: decision === "approve" ? "approved" : "denied",
            decidedBy: access.accountId,
          });
          res.json(result);
        } catch (err) {
          handleContextRequestError(res, err);
        }
      },
    );
  }

  app.get(
    "/api/rental/sessions/:id/exposures",
    async (req: AuthenticatedRequest, res) => {
      const access = await resolveAccess(req, res, deps);
      if (!access) return;
      try {
        const exposures = await deps.listSessionExposures(access.sessionId);
        res.json(exposures);
      } catch (err) {
        handleContextRequestError(res, err);
      }
    },
  );
}

interface SessionAccess {
  sessionId: string;
  accountId: string;
  role: "renter" | "provider";
}

async function resolveAccess(
  req: AuthenticatedRequest,
  res: Response,
  deps: RentalInternalRouteDeps,
): Promise<SessionAccess | null> {
  if (!requireRentEnabled(res)) return null;
  const accountId = requireAccountId(req, res);
  if (!accountId) return null;

  const sessionId = req.params.id as string;
  const role = await deps.resolveSessionAccess(sessionId, accountId);
  if (!role) {
    res.status(404).json({ error: "session not found" });
    return null;
  }
  return { sessionId, accountId, role };
}

function handleContextRequestError(res: Response, err: unknown): void {
  if (err instanceof ContextRequestError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : "unknown_error";
  res.status(500).json({ error: message });
}
