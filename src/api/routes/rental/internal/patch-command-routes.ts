import type { Express } from "express";

import type { AuthenticatedRequest } from "../../../http/helpers.js";
import {
  COMMAND_ALLOWED,
  COMMAND_BLOCKED,
  COMMAND_OUTPUT,
  COMMAND_REQUESTED,
  COMMAND_RUN,
  COMMAND_TIMED_OUT,
  EDIT_PROPOSED,
  PATCH_GATE_STARTED,
  PATCH_PROPOSED,
} from "../../../rental/activity-event-types.js";
import { PatchProposalError } from "../../../rental/patch-proposal.js";
import { SignedChangeJournalError } from "../../../rental/signed-change-journal.js";
import type { RentalInternalRouteDeps } from "./types.js";
import { emitRentalActivity, requireSessionAccess } from "./helpers.js";
import {
  isPlainObject,
  normalizeIdempotencyKey,
  normalizePatchFiles,
  optionalPositiveInteger,
} from "./validation.js";

export function registerPatchCommandRoutes(
  app: Express,
  deps: RentalInternalRouteDeps,
): void {
  // ===== Patch proposal and command broker tools (p5.3) =====
  app.post(
    "/api/rental/sessions/:id/patches/propose-edit",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      const idempotencyKey = normalizeIdempotencyKey(req.body);
      if (typeof idempotencyKey === "object") {
        res.status(400).json({ error: idempotencyKey.error });
        return;
      }
      const beforeContent = req.body.beforeContent ?? req.body.before_content;
      const afterContent = req.body.afterContent ?? req.body.after_content;
      if (typeof req.body.path !== "string" || !req.body.path.trim()) {
        res.status(400).json({ error: "path is required" });
        return;
      }
      if (typeof beforeContent !== "string" || typeof afterContent !== "string") {
        res.status(400).json({ error: "beforeContent and afterContent are required" });
        return;
      }

      try {
        const result = await deps.appendSignedChange(sessionId, {
          idempotencyKey,
          edit: {
            path: req.body.path,
            beforeContent,
            afterContent,
            summary: typeof req.body.summary === "string" ? req.body.summary : null,
            actorAgentKey: req.sessionAccount!.account_id,
            toolName: "rental_propose_edit",
          },
        });
        await emitRentalActivity(deps, sessionId, EDIT_PROPOSED, "agent", {
          proposalId: result.proposal.id,
          path: result.entry.path,
          summary: result.entry.summary,
          idempotent: result.idempotent,
        });
        res.status(result.idempotent ? 200 : 201).json({
          success: true,
          proposalId: result.proposal.id,
          gateStatus: result.proposal.gate_status,
          diffRef: result.proposal.diff_ref,
          patch: result.patch,
          idempotent: result.idempotent,
        });
      } catch (err) {
        if (err instanceof SignedChangeJournalError) {
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        res.status(500).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/patches/propose-patch",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      const idempotencyKey = normalizeIdempotencyKey(req.body);
      if (typeof idempotencyKey === "object") {
        res.status(400).json({ error: idempotencyKey.error });
        return;
      }
      const files = normalizePatchFiles(req.body.files);
      if (!Array.isArray(files)) {
        res.status(400).json({ error: files.error });
        return;
      }

      try {
        await emitRentalActivity(deps, sessionId, PATCH_GATE_STARTED, "patch_gate", {
          idempotencyKey,
          fileCount: files.length,
        });
        const result = await deps.proposePatch(sessionId, {
          idempotencyKey,
          summary: typeof req.body.summary === "string" ? req.body.summary : null,
          files: files as any,
        });
        await emitRentalActivity(deps, sessionId, PATCH_PROPOSED, "patch_gate", {
          proposalId: result.proposal.id,
          gateStatus: result.proposal.gate_status,
          idempotent: result.idempotent,
          warnings: result.gate.warnings,
          rejectionReasons: result.gate.rejectionReasons,
        });
        res.status(result.idempotent ? 200 : 201).json({
          success: true,
          proposalId: result.proposal.id,
          gateStatus: result.proposal.gate_status,
          warnings: result.gate.warnings,
          rejectionReasons: result.gate.rejectionReasons,
          checks: result.gate.checks,
          idempotent: result.idempotent,
        });
      } catch (err) {
        if (err instanceof PatchProposalError) {
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        res.status(500).json({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    "/api/rental/sessions/:id/commands/run",
    async (req: AuthenticatedRequest, res) => {
      const sessionId = await requireSessionAccess(req, res, deps);
      if (!sessionId) return;
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: "body must be an object" });
        return;
      }
      const timeoutMs = optionalPositiveInteger(req.body, "timeoutMs", 120_000);
      if (typeof timeoutMs === "object") {
        res.status(400).json({ error: timeoutMs.error });
        return;
      }

      await emitRentalActivity(deps, sessionId, COMMAND_REQUESTED, "agent", {
        argv: req.body.argv,
      });
      const result = await deps.runWorkspaceCommand(sessionId, {
        argv: req.body.argv as string[],
        timeoutMs,
      });
      if (result.error?.startsWith("command_blocked:")) {
        await emitRentalActivity(deps, sessionId, COMMAND_BLOCKED, "system", {
          argv: result.argv ?? req.body.argv,
          error: result.error,
        });
        res.status(403).json(result);
        return;
      }
      await emitRentalActivity(deps, sessionId, COMMAND_ALLOWED, "system", {
        argv: result.argv ?? req.body.argv,
      });
      await emitRentalActivity(deps, sessionId, COMMAND_RUN, "tool", {
        argv: result.argv ?? req.body.argv,
      });
      if (result.timedOut) {
        await emitRentalActivity(deps, sessionId, COMMAND_TIMED_OUT, "system", {
          argv: result.argv,
          error: result.error ?? null,
        });
      }
      if (result.success) {
        await emitRentalActivity(deps, sessionId, COMMAND_OUTPUT, "tool", {
          argv: result.argv,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } else if (!result.timedOut) {
        await emitRentalActivity(deps, sessionId, COMMAND_OUTPUT, "tool", {
          argv: result.argv,
          exitCode: result.exitCode ?? null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          error: result.error ?? null,
        });
      }
      res.status(result.success ? 200 : 409).json(result);
    },
  );
}
