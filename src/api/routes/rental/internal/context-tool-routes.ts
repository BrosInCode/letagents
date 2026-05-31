import type { Express } from "express";

import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { requireSessionAccess } from "./helpers.js";
import { contextErrorStatus, isPlainObject, optionalPositiveInteger } from "./validation.js";

export function registerContextToolRoutes(
  app: Express,
  deps: RentalInternalRouteDeps,
): void {
  // ===== Context Broker tools (p4.4) =====
  app.post(
    "/api/rental/sessions/:id/context/read-file",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      if (typeof req.body.path !== "string" || !req.body.path.trim()) {
        res.status(400).json({ error: "path is required" });
        return;
      }
      const maxBytes = optionalPositiveInteger(req.body, "maxBytes", 1024 * 1024);
      if (typeof maxBytes === "object") {
        res.status(400).json({ error: maxBytes.error });
        return;
      }

      const result = await deps.readContextFile(sessionId, {
        path: req.body.path,
        maxBytes,
        requestedBy: req.sessionAccount!.account_id,
      });
      if (!result.success) {
        res.status(contextErrorStatus(result.error)).json(result);
        return;
      }
      res.json(result);
    },
  );

  app.post(
    "/api/rental/sessions/:id/context/search",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      if (typeof req.body.query !== "string" || !req.body.query.trim()) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      const maxResults = optionalPositiveInteger(req.body, "maxResults", 100);
      if (typeof maxResults === "object") {
        res.status(400).json({ error: maxResults.error });
        return;
      }

      const result = await deps.searchContext(sessionId, {
        query: req.body.query,
        maxResults,
        caseSensitive: req.body.caseSensitive === true,
        requestedBy: req.sessionAccount!.account_id,
      });
      if (!result.success) {
        res.status(contextErrorStatus(result.error)).json(result);
        return;
      }
      res.json(result);
    },
  );
}
