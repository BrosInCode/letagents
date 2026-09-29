import type { Express, Response } from "express";

import {
  isExecutionApprovalPublicationIdentity,
  parseExecutionApprovalPublicationCloseInput,
  parseExecutionApprovalPublicationInput,
} from "../../../shared/execution-approval-publication.mjs";
import { isSupervisorHostGrantFeatureEnabled } from "../../shared/agent-session-bearer.js";
import {
  ExecutionApprovalPublicationError,
  closeExecutionApprovalPublication,
  getExecutionApprovalPublicationForApprover,
  listExecutionApprovalPublicationsForApprover,
  publishExecutionApprovalPublication,
  type Project,
} from "../db.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../http/helpers.js";
import { normalizeRoomId } from "../rooms/routing.js";
import { queueAgentApprovalInvalidation } from "../server/events.js";
import {
  requireCurrentSupervisorGrant,
  respondToStaleSupervisorGrantFence,
  type RoomResolverDeps,
} from "./supervisor-host-grants.js";

export type ExecutionApprovalPublicationRouteDeps = RoomResolverDeps & {
  getProjectById(roomId: string): Promise<Project | null | undefined>;
};

function notFound(res: Response): void {
  res.status(404).json({ error: "Execution approval request not found." });
}

function concealedMembershipResponse(): Response {
  const response = {
    status: () => response,
    json: () => response,
  } as unknown as Response;
  return response;
}

async function authorizedApproverRoom(
  req: AuthenticatedRequest,
  res: Response,
  deps: ExecutionApprovalPublicationRouteDeps,
  requestedRoom: string,
): Promise<{ room_id: string; account_id: string } | null> {
  if (req.authKind !== "session" || !req.sessionAccount?.account_id) {
    res.status(401).json({ error: "Execution approval requests require an authenticated browser session." });
    return null;
  }
  try {
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(requestedRoom));
    const project = await deps.getProjectById(roomId);
    if (!project) {
      notFound(res);
      return null;
    }
    const participant = await deps.requireParticipant(req, concealedMembershipResponse(), project, {
      freshCollaboratorCheck: true,
      throwOnIndeterminate: true,
    });
    if (!participant) {
      notFound(res);
      return null;
    }
    return { room_id: roomId, account_id: req.sessionAccount.account_id };
  } catch {
    res.status(503).json({
      error: "Room membership could not be revalidated; retry after the provider recovers.",
      code: "EXECUTION_APPROVAL_MEMBERSHIP_REVALIDATION_UNAVAILABLE",
      retryable: true,
    });
    return null;
  }
}

function publicationError(res: Response, error: unknown): void {
  if (error instanceof ExecutionApprovalPublicationError) {
    if (error.code === "publication_work_not_ready" || error.code === "publication_capacity") {
      res.status(409).json({
        error: error.code === "publication_work_not_ready"
          ? "Recorded agent work is not ready for this approval publication."
          : "This approval delegation has reached its active publication capacity.",
        code: error.code,
        retryable: true,
      });
      return;
    }
    const status = error.code === "invalid_publication" ? 400
      : error.code === "publisher_not_authorized" ? 403 : 409;
    res.status(status).json({ error: "Execution approval request was not published.", code: error.code });
    return;
  }
  if (respondToStaleSupervisorGrantFence(res, error)) return;
  respondWithInternalError(
    res,
    "execution-approval-publication.publish",
    error,
    "Execution approval request could not be published.",
  );
}

export function registerExecutionApprovalPublicationRoutes(
  app: Express,
  deps: ExecutionApprovalPublicationRouteDeps,
): void {
  app.get(/^\/rooms\/(.+)\/agent-approvals$/, async (req: AuthenticatedRequest, res) => {
    const authority = await authorizedApproverRoom(req, res, deps, String(req.params[0] ?? ""));
    if (!authority) return;
    const after = req.query.after;
    if (after !== undefined && (typeof after !== "string" || !isExecutionApprovalPublicationIdentity(after))) {
      res.status(409).json({ error: "Execution approval cursor is not valid for this view.", code: "invalid_cursor" });
      return;
    }
    try {
      const inventory = await listExecutionApprovalPublicationsForApprover({
        room_id: authority.room_id,
        approver_account_id: authority.account_id,
        after: after ?? null,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(inventory);
    } catch (error) {
      if (error instanceof ExecutionApprovalPublicationError && error.code === "invalid_publication") {
        res.status(409).json({ error: "Execution approval cursor is not valid for this view.", code: "invalid_cursor" });
        return;
      }
      respondWithInternalError(
        res,
        "execution-approval-publication.list",
        error,
        "Execution approval requests could not be read.",
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/agent-approvals\/([^/]+)\/projection$/, async (req: AuthenticatedRequest, res) => {
    const authority = await authorizedApproverRoom(req, res, deps, String(req.params[0] ?? ""));
    if (!authority) return;
    const publicationId = String(req.params[1] ?? "");
    if (!isExecutionApprovalPublicationIdentity(publicationId)) {
      notFound(res);
      return;
    }
    try {
      const record = await getExecutionApprovalPublicationForApprover({
        room_id: authority.room_id,
        approver_account_id: authority.account_id,
        publication_id: publicationId,
      });
      if (!record) {
        notFound(res);
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.type("application/json").send(record.projection_json);
    } catch (error) {
      respondWithInternalError(
        res,
        "execution-approval-publication.read",
        error,
        "Execution approval request could not be read.",
      );
    }
  });

  if (!isSupervisorHostGrantFeatureEnabled()) return;

  app.post(
    "/supervisor-host-grants/:grantId/worker-sessions/:sessionId/execution-approval-publications",
    async (req: AuthenticatedRequest, res) => {
      if (req.authKind !== "supervisor_grant" || req.supervisorGrant?.grant_id !== req.params.grantId) {
        res.status(403).json({ error: "A current supervisor grant is required." });
        return;
      }
      const parsed = parseExecutionApprovalPublicationInput(req.body);
      if (!parsed) {
        res.status(400).json({ error: "Invalid execution approval publication." });
        return;
      }
      try {
        const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(parsed.room_id));
        if (roomId !== parsed.room_id) {
          res.status(400).json({
            error: "Execution approval publication must use the canonical room id.",
            code: "noncanonical_room_id",
          });
          return;
        }
        const current = await requireCurrentSupervisorGrant(req, res, deps, {
          kind: "rooms",
          room_ids: [roomId],
        });
        if (!current) return;
        const result = await publishExecutionApprovalPublication({
          fence: {
            grant_id: current.grant_id,
            generation: current.current_generation,
            token_version: current.token_version,
          },
          session_id: String(req.params.sessionId ?? ""),
          publication: parsed,
        });
        queueAgentApprovalInvalidation(roomId);
        res.setHeader("Cache-Control", "no-store");
        res.status(result.status === "created" ? 201 : 200).json(result);
      } catch (error) {
        publicationError(res, error);
      }
    },
  );

  app.post(
    "/supervisor-host-grants/:grantId/worker-sessions/:sessionId/execution-approval-publications/:publicationId/close",
    async (req: AuthenticatedRequest, res) => {
      if (req.authKind !== "supervisor_grant" || req.supervisorGrant?.grant_id !== req.params.grantId) {
        res.status(403).json({ error: "A current supervisor grant is required." });
        return;
      }
      const publicationId = String(req.params.publicationId ?? "");
      const parsed = parseExecutionApprovalPublicationCloseInput(req.body);
      if (!isExecutionApprovalPublicationIdentity(publicationId) || !parsed) {
        res.status(400).json({ error: "Invalid execution approval publication closure." });
        return;
      }
      try {
        const sessionId = String(req.params.sessionId ?? "");
        const current = await requireCurrentSupervisorGrant(req, res, deps, {
          kind: "sessions",
          session_ids: [sessionId],
        });
        if (!current) return;
        const result = await closeExecutionApprovalPublication({
          fence: {
            grant_id: current.grant_id,
            generation: current.current_generation,
            token_version: current.token_version,
          },
          session_id: sessionId,
          publication_id: publicationId,
          publication_digest: parsed.publication_digest,
        });
        queueAgentApprovalInvalidation(result.room_id);
        res.setHeader("Cache-Control", "no-store");
        res.json(result.receipt);
      } catch (error) {
        publicationError(res, error);
      }
    },
  );
}
