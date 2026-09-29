import type { Express, Response } from "express";

import {
  isExecutionDelegationDecision,
  isExecutionDelegationDigest,
  isExecutionDelegationIdentity,
  isExecutionDelegationPositiveInt32,
  parseExecutionDelegationDecisionIntent,
} from "../../../shared/execution-delegation-decision.mjs";

import {
  admitExecutionDelegationDecision,
  ExecutionDelegationDecisionAuthorityError,
  ExecutionDelegationDecisionConflictError,
  ExecutionDelegationDecisionIdempotencyConflictError,
  ExecutionDelegationDecisionPublicationClosedError,
  ExecutionDelegationDecisionRevisionConflictError,
  ExecutionDelegationDecisionTerminalError,
  getExecutionDelegationDecisionForHost,
  getExecutionDelegationGrantForAccount,
  listExecutionDelegationDecisionIdsForHost,
  type ExecutionDelegationDecision,
  type ExecutionDelegationDecisionForHost,
} from "../db.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../http/helpers.js";
import {
  queueAgentApprovalInvalidation,
  queueExecutionDelegationInvalidation,
} from "../server/events.js";
import {
  executionDelegationInventoryQuery,
  requiredExecutionDelegationString,
} from "./execution-delegation-route-input.js";
import {
  requireCurrentSupervisorGrant,
  type RoomResolverDeps,
} from "./supervisor-host-grants.js";
import { requireExecutionDelegationHostAuthority } from "./execution-delegation-host-authority.js";

const DECISION_KEYS = new Set([
  "expected_revision",
  "request_id",
  "request_version",
  "request_sha256",
  "projection_sha256",
  "decision",
  "client_request_id",
]);

function sessionAccountId(req: AuthenticatedRequest, res: Response): string | null {
  if (req.authKind !== "session" || !req.sessionAccount?.account_id) {
    res.status(401).json({ error: "Execution delegation decisions require an authenticated browser session." });
    return null;
  }
  return req.sessionAccount.account_id;
}

function decisionBody(req: AuthenticatedRequest, res: Response): Record<string, unknown> | null {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !DECISION_KEYS.has(key))) {
    res.status(400).json({ error: "Invalid execution delegation decision request." });
    return null;
  }
  return body as Record<string, unknown>;
}

function parseDecision(body: Record<string, unknown>) {
  const requestId = requiredExecutionDelegationString(body, "request_id");
  const requestSha256 = requiredExecutionDelegationString(body, "request_sha256");
  const projectionSha256 = requiredExecutionDelegationString(body, "projection_sha256");
  const clientRequestId = requiredExecutionDelegationString(body, "client_request_id");
  if (!isExecutionDelegationIdentity(requestId) || !isExecutionDelegationIdentity(clientRequestId)
    || !requestSha256 || !projectionSha256
    || !isExecutionDelegationPositiveInt32(body.expected_revision)
    || !isExecutionDelegationPositiveInt32(body.request_version)
    || !isExecutionDelegationDigest(requestSha256) || !isExecutionDelegationDigest(projectionSha256)
    || !isExecutionDelegationDecision(body.decision)) return null;
  return {
    expected_revision: Number(body.expected_revision),
    request_id: requestId,
    request_version: Number(body.request_version),
    request_sha256: requestSha256,
    projection_sha256: projectionSha256,
    decision: body.decision,
    client_request_id: clientRequestId,
  };
}

function publicDecision(decision: ExecutionDelegationDecision) {
  return {
    decision_id: decision.decision_id,
    delegation_instance_id: decision.delegation_instance_id,
    delegation_revision: decision.delegation_revision,
    actor_account_id: decision.actor_account_id,
    request_id: decision.request_id,
    request_version: decision.request_version,
    request_sha256: decision.request_sha256,
    projection_sha256: decision.projection_sha256,
    decision: decision.decision,
    decided_at: decision.decided_at,
  };
}

function hostDecision(decision: ExecutionDelegationDecisionForHost) {
  const intent = parseExecutionDelegationDecisionIntent({
    ...publicDecision(decision),
    owner_account_id: decision.owner_account_id,
    room_id: decision.room_id,
    agent_key: decision.agent_key,
    approver_account_id: decision.approver_account_id,
    category: decision.category,
    risk_ceiling: decision.risk_ceiling,
    scope_sha256: decision.scope_sha256,
  });
  if (!intent) throw new Error("Stored execution delegation decision violated the host wire contract.");
  return intent;
}

function notFound(res: Response): void {
  res.status(404).json({ error: "Execution delegation decision not found." });
}

function respondMutationError(res: Response, error: unknown): void {
  if (error instanceof ExecutionDelegationDecisionIdempotencyConflictError
    || error instanceof ExecutionDelegationDecisionConflictError
    || error instanceof ExecutionDelegationDecisionPublicationClosedError
    || error instanceof ExecutionDelegationDecisionRevisionConflictError
    || error instanceof ExecutionDelegationDecisionTerminalError) {
    res.status(409).json({ error: "Execution delegation decision was not recorded.", code: error.code });
    return;
  }
  if (error instanceof ExecutionDelegationDecisionAuthorityError) {
    res.status(403).json({ error: "Execution delegation decision is not authorized.", code: error.code });
    return;
  }
  respondWithInternalError(res, "execution-delegation-decision.mutate", error,
    "Execution delegation decision could not be recorded.");
}

export function registerExecutionDelegationDecisionRoutes(app: Express, deps: RoomResolverDeps): void {
  app.get(
    "/supervisor-host-grants/:grantId/execution-delegation-decisions",
    async (req: AuthenticatedRequest, res) => {
      const query = executionDelegationInventoryQuery(req, res);
      if (!query) return;
      const current = await requireCurrentSupervisorGrant(req, res, deps, {
        kind: "rooms",
        room_ids: [query.room_id],
      });
      if (!current) return;
      if (!requireExecutionDelegationHostAuthority({
        grant: current,
        requested_grant_id: String(req.params.grantId ?? "").trim(),
        resource: query,
        conceal: () => notFound(res),
        res,
      })) return;
      const inventory = await listExecutionDelegationDecisionIdsForHost({
        owner_account_id: current.owner_account_id,
        host_id: current.host_id,
        installation_id: current.installation_id,
        room_id: query.room_id,
        agent_key: query.agent_key,
        after: query.after,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(inventory);
    },
  );

  app.get(
    "/supervisor-host-grants/:grantId/execution-delegation-decisions/:decisionId",
    async (req: AuthenticatedRequest, res) => {
      const current = await requireCurrentSupervisorGrant(req, res, deps, { kind: "all" });
      if (!current) return;
      if (!requireExecutionDelegationHostAuthority({
        grant: current,
        requested_grant_id: String(req.params.grantId ?? "").trim(),
        conceal: () => notFound(res),
        res,
      })) return;
      const decision = await getExecutionDelegationDecisionForHost({
        owner_account_id: current.owner_account_id,
        host_id: current.host_id,
        installation_id: current.installation_id,
        decision_id: String(req.params.decisionId ?? "").trim(),
      });
      if (!decision) {
        notFound(res);
        return;
      }
      if (!requireExecutionDelegationHostAuthority({
        grant: current,
        requested_grant_id: current.grant_id,
        resource: decision,
        conceal: () => notFound(res),
        res,
      })) return;
      res.setHeader("Cache-Control", "no-store");
      res.json({ decision: hostDecision(decision) });
    },
  );

  app.post(
    "/execution-delegations/:delegationInstanceId/decisions",
    async (req: AuthenticatedRequest, res) => {
      const actorAccountId = sessionAccountId(req, res);
      if (!actorAccountId) return;
      const body = decisionBody(req, res);
      if (!body) return;
      const parsed = parseDecision(body);
      if (!parsed) {
        res.status(400).json({ error: "Invalid execution delegation decision request." });
        return;
      }
      const delegationInstanceId = String(req.params.delegationInstanceId ?? "").trim();
      const grant = await getExecutionDelegationGrantForAccount({
        account_id: actorAccountId,
        delegation_instance_id: delegationInstanceId,
      });
      if (!grant || grant.approver_account_id !== actorAccountId) {
        notFound(res);
        return;
      }
      try {
        const roomId = await deps.resolveCanonicalRoomRequestId(grant.room_id);
        const room = await deps.resolveRoomOrReply(roomId, res);
        if (!room || !(await deps.requireParticipant(req, res, room, {
          freshCollaboratorCheck: true,
          throwOnIndeterminate: true,
        }))) return;
      } catch {
        res.status(503).json({
          error: "Room membership could not be revalidated; retry after the provider recovers.",
          code: "EXECUTION_DELEGATION_MEMBERSHIP_REVALIDATION_UNAVAILABLE",
          retryable: true,
        });
        return;
      }
      try {
        const result = await admitExecutionDelegationDecision({
          ...parsed,
          actor_account_id: actorAccountId,
          delegation_instance_id: delegationInstanceId,
        });
        queueExecutionDelegationInvalidation(result.room_id);
        queueAgentApprovalInvalidation(result.room_id);
        res.status(result.status === "created" ? 201 : 200).json({
          status: result.status,
          decision: publicDecision(result.decision),
        });
      } catch (error) {
        respondMutationError(res, error);
      }
    },
  );
}
