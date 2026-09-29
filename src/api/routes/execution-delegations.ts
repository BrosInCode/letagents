import type { Express, Response } from "express";

import {
  admitExecutionDelegationGrantRevision,
  ExecutionDelegationAuthorityError,
  ExecutionDelegationIdempotencyConflictError,
  ExecutionDelegationRevisionConflictError,
  ExecutionDelegationTerminalError,
  getExecutionDelegationGrantForAccount,
  getExecutionDelegationGrantForHost,
  getExecutionDelegationGrantForOwner,
  listExecutionDelegationIdsForHost,
  revokeExecutionDelegationGrant,
  type ExecutionDelegationGrant,
} from "../db.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../http/helpers.js";
import {
  requireCurrentSupervisorGrant,
  type RoomResolverDeps,
} from "./supervisor-host-grants.js";
import {
  queueAgentApprovalInvalidation,
  queueExecutionDelegationInvalidation,
} from "../server/events.js";
import {
  executionDelegationInventoryQuery,
  requiredExecutionDelegationString,
} from "./execution-delegation-route-input.js";
import { requireExecutionDelegationHostAuthority } from "./execution-delegation-host-authority.js";

const ACCOUNT_MUTATION_KEYS = new Set([
  "supervisor_grant_id",
  "room_id",
  "agent_key",
  "approver_account_id",
  "category",
  "risk_ceiling",
  "expires_at",
  "client_request_id",
  "expected_revision",
]);

function accountId(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.sessionAccount?.account_id || (req.authKind !== "session" && req.authKind !== "owner_token")) {
    res.status(401).json({ error: "Execution delegation requires human account authentication." });
    return null;
  }
  return req.sessionAccount.account_id;
}

function mutationBody(req: AuthenticatedRequest, res: Response): Record<string, unknown> | null {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !ACCOUNT_MUTATION_KEYS.has(key))) {
    res.status(400).json({ error: "Invalid execution delegation request." });
    return null;
  }
  return body as Record<string, unknown>;
}

function parseAdmission(body: Record<string, unknown>, revision: boolean) {
  const supervisorGrantId = requiredExecutionDelegationString(body, "supervisor_grant_id");
  const roomId = requiredExecutionDelegationString(body, "room_id");
  const agentKey = requiredExecutionDelegationString(body, "agent_key");
  const approverAccountId = requiredExecutionDelegationString(body, "approver_account_id");
  const expiresAt = requiredExecutionDelegationString(body, "expires_at");
  const clientRequestId = requiredExecutionDelegationString(body, "client_request_id");
  const expectedRevision = revision ? body.expected_revision : 0;
  if (!supervisorGrantId || !roomId || !agentKey || !approverAccountId || !expiresAt || !clientRequestId
    || body.category !== "file_change" || body.risk_ceiling !== "low"
    || !Number.isInteger(expectedRevision) || Number(expectedRevision) < (revision ? 1 : 0)) {
    return null;
  }
  return {
    supervisor_grant_id: supervisorGrantId,
    room_id: roomId,
    agent_key: agentKey,
    approver_account_id: approverAccountId,
    category: "file_change" as const,
    risk_ceiling: "low" as const,
    expires_at: expiresAt,
    client_request_id: clientRequestId,
    expected_revision: Number(expectedRevision),
  };
}

function publicGrant(grant: ExecutionDelegationGrant) {
  const status = grant.revoked_at
    ? "revoked"
    : grant.expired_at || Date.parse(grant.expires_at) <= Date.now()
      ? "expired"
      : "active";
  return {
    delegation_instance_id: grant.delegation_instance_id,
    revision: grant.revision,
    owner_account_id: grant.owner_account_id,
    room_id: grant.room_id,
    agent_key: grant.agent_key,
    approver_account_id: grant.approver_account_id,
    category: grant.category,
    risk_ceiling: grant.risk_ceiling,
    created_at: grant.created_at,
    expires_at: grant.expires_at,
    revoked_at: grant.revoked_at,
    status,
  };
}

function hostGrant(grant: ExecutionDelegationGrant) {
  return {
    ...publicGrant(grant),
    scope_sha256: grant.scope_sha256,
  };
}

function notFound(res: Response): void {
  res.status(404).json({ error: "Execution delegation not found." });
}

function queueDelegationInvalidation(roomId: string, includeApprovals = false): void {
  try {
    queueExecutionDelegationInvalidation(roomId);
    if (includeApprovals) queueAgentApprovalInvalidation(roomId);
  } catch (error) {
    console.error("[execution delegation] failed to queue room invalidation", error);
  }
}

function respondMutationError(res: Response, error: unknown): void {
  if (error instanceof ExecutionDelegationIdempotencyConflictError
    || error instanceof ExecutionDelegationRevisionConflictError
    || error instanceof ExecutionDelegationTerminalError) {
    res.status(409).json({ error: "Execution delegation was not admitted.", code: error.code });
    return;
  }
  if (error instanceof ExecutionDelegationAuthorityError) {
    res.status(403).json({ error: "Execution delegation is not authorized.", code: error.code });
    return;
  }
  respondWithInternalError(res, "execution-delegation.mutate", error, "Execution delegation could not be changed.");
}

export function registerExecutionDelegationRoutes(app: Express, deps: RoomResolverDeps): void {
  // Revocation is the independently authenticated owner kill switch for
  // already-issued authority.
  app.delete("/execution-delegations/:delegationInstanceId", async (req: AuthenticatedRequest, res) => {
    const ownerAccountId = accountId(req, res);
    if (!ownerAccountId) return;
    try {
      const revoked = await revokeExecutionDelegationGrant({
        owner_account_id: ownerAccountId,
        delegation_instance_id: String(req.params.delegationInstanceId ?? "").trim(),
      });
      if (!revoked) {
        notFound(res);
        return;
      }
      queueDelegationInvalidation(revoked.room_id, true);
      res.setHeader("Cache-Control", "no-store");
      res.json({ delegation: publicGrant(revoked) });
    } catch (error) {
      respondWithInternalError(res, "execution-delegation.revoke", error, "Execution delegation could not be revoked.");
    }
  });

  app.get("/execution-delegations/:delegationInstanceId", async (req: AuthenticatedRequest, res) => {
    const requesterAccountId = accountId(req, res);
    if (!requesterAccountId) return;
    const grant = await getExecutionDelegationGrantForAccount({
      account_id: requesterAccountId,
      delegation_instance_id: String(req.params.delegationInstanceId ?? "").trim(),
    });
    if (!grant) {
      notFound(res);
      return;
    }
    if (requesterAccountId !== grant.owner_account_id) {
      if (req.authKind !== "session") {
        res.status(401).json({ error: "Approver visibility requires an authenticated browser session." });
        return;
      }
      const roomId = await deps.resolveCanonicalRoomRequestId(grant.room_id);
      const room = await deps.resolveRoomOrReply(roomId, res);
      if (!room || !(await deps.requireParticipant(req, res, room, { freshCollaboratorCheck: true }))) return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ delegation: publicGrant(grant) });
  });

  app.get(
    "/supervisor-host-grants/:grantId/execution-delegations",
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
      const inventory = await listExecutionDelegationIdsForHost({
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
    "/supervisor-host-grants/:grantId/execution-delegations/:delegationInstanceId",
    async (req: AuthenticatedRequest, res) => {
      const current = await requireCurrentSupervisorGrant(req, res, deps, { kind: "all" });
      if (!current) return;
      if (!requireExecutionDelegationHostAuthority({
        grant: current,
        requested_grant_id: String(req.params.grantId ?? "").trim(),
        conceal: () => notFound(res),
        res,
      })) return;
      const grant = await getExecutionDelegationGrantForHost({
        owner_account_id: current.owner_account_id,
        host_id: current.host_id,
        installation_id: current.installation_id,
        delegation_instance_id: String(req.params.delegationInstanceId ?? "").trim(),
      });
      if (!grant) {
        notFound(res);
        return;
      }
      if (!requireExecutionDelegationHostAuthority({
        grant: current,
        requested_grant_id: current.grant_id,
        resource: grant,
        conceal: () => notFound(res),
        res,
      })) return;
      res.setHeader("Cache-Control", "no-store");
      res.json({ delegation: hostGrant(grant) });
    },
  );

  app.post("/execution-delegations", async (req: AuthenticatedRequest, res) => {
    const ownerAccountId = accountId(req, res);
    if (!ownerAccountId) return;
    const body = mutationBody(req, res);
    if (!body) return;
    const parsed = parseAdmission(body, false);
    if (!parsed || body.expected_revision !== undefined) {
      res.status(400).json({ error: "Invalid execution delegation request." });
      return;
    }
    try {
      const result = await admitExecutionDelegationGrantRevision({
        ...parsed,
        owner_account_id: ownerAccountId,
      });
      queueDelegationInvalidation(result.grant.room_id);
      res.status(result.status === "created" ? 201 : 200).json({
        status: result.status,
        delegation: publicGrant(result.grant),
      });
    } catch (error) {
      respondMutationError(res, error);
    }
  });

  app.post("/execution-delegations/:delegationInstanceId/revisions", async (req: AuthenticatedRequest, res) => {
    const ownerAccountId = accountId(req, res);
    if (!ownerAccountId) return;
    const delegationInstanceId = String(req.params.delegationInstanceId ?? "").trim();
    const existing = await getExecutionDelegationGrantForOwner({
      owner_account_id: ownerAccountId,
      delegation_instance_id: delegationInstanceId,
    });
    if (!existing) {
      notFound(res);
      return;
    }
    const body = mutationBody(req, res);
    if (!body) return;
    const parsed = parseAdmission(body, true);
    if (!parsed) {
      res.status(400).json({ error: "Invalid execution delegation request." });
      return;
    }
    try {
      const result = await admitExecutionDelegationGrantRevision({
        ...parsed,
        owner_account_id: ownerAccountId,
        delegation_instance_id: delegationInstanceId,
      });
      queueDelegationInvalidation(result.grant.room_id, true);
      res.json({ status: result.status, delegation: publicGrant(result.grant) });
    } catch (error) {
      respondMutationError(res, error);
    }
  });

}
