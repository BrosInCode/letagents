import type { Express } from "express";

import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { BudgetOrchestratorError } from "../../../rental/budget-orchestrator.js";
import { UsageIngestError } from "../../../rental/usage-ingest.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { requireSessionAccess } from "./helpers.js";
import { parseReconcile, parseReport, parseReserve } from "./validation.js";

export function registerUsageBudgetRoutes(
  app: Express,
  deps: RentalInternalRouteDeps,
): void {
  app.post("/api/rental/sessions/:id/usage", async (req: AuthenticatedRequest, res) => {
    const sessionId = await requireSessionAccess(req, res, deps);
    if (!sessionId) return;

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

  app.post("/api/rental/sessions/:id/budget/reserve", async (req: AuthenticatedRequest, res) => {
    const sessionId = await requireSessionAccess(req, res, deps);
    if (!sessionId) return;

    const parsed = parseReserve(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const result = await deps.reserveBudget(sessionId, parsed);
      res.status(result.decision.allowed ? 201 : 409).json(result);
    } catch (err) {
      if (err instanceof BudgetOrchestratorError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: "Failed to reserve budget" });
    }
  });

  app.post("/api/rental/sessions/:id/budget/reconcile", async (req: AuthenticatedRequest, res) => {
    const sessionId = await requireSessionAccess(req, res, deps);
    if (!sessionId) return;

    const parsed = parseReconcile(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const result = await deps.reconcileBudget(sessionId, parsed);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof BudgetOrchestratorError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: "Failed to reconcile budget" });
    }
  });
}
