import type { Express, Response } from "express";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import {
  approveBudgetExtension,
  BudgetExtensionError,
  denyBudgetExtension,
  requestBudgetExtension,
} from "../../rental/budget-extension.js";
import type { RentalRenterRouteDeps } from "./types.js";
import { requireAuth, requireRentEnabled } from "./helpers.js";
import {
  parseBudgetExtensionApproval,
  parseBudgetExtensionDenial,
  parseBudgetExtensionRequest,
} from "./validation.js";

export function registerBudgetExtensionRoutes(
  app: Express,
  deps: RentalRenterRouteDeps,
): void {
  const requestBudgetExtensionImpl =
    deps.requestBudgetExtension ?? requestBudgetExtension;
  const approveBudgetExtensionImpl =
    deps.approveBudgetExtension ?? approveBudgetExtension;
  const denyBudgetExtensionImpl =
    deps.denyBudgetExtension ?? denyBudgetExtension;

  app.post(
    "/api/rental/sessions/:id/budget-extension-requests",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parseBudgetExtensionRequest(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      try {
        const result = await requestBudgetExtensionImpl(
          req.params.id as string,
          accountId,
          parsed,
        );
        return res.status(201).json(result);
      } catch (err: unknown) {
        if (err instanceof BudgetExtensionError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/budget-extension-requests/:requestId/approve",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parseBudgetExtensionApproval(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      try {
        const result = await approveBudgetExtensionImpl(
          req.params.id as string,
          accountId,
          req.params.requestId as string,
          parsed,
        );
        return res.json(result);
      } catch (err: unknown) {
        if (err instanceof BudgetExtensionError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/budget-extension-requests/:requestId/deny",
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireRentEnabled(res)) return;
      const accountId = requireAuth(req, res);
      if (!accountId) return;

      const parsed = parseBudgetExtensionDenial(req.body);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      try {
        const result = await denyBudgetExtensionImpl(
          req.params.id as string,
          accountId,
          req.params.requestId as string,
          parsed,
        );
        return res.json(result);
      } catch (err: unknown) {
        if (err instanceof BudgetExtensionError) {
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : "unknown_error";
        return res.status(500).json({ error: message });
      }
    },
  );
}
