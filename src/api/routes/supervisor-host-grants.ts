import type { Express, Response } from "express";

import {
  advanceSupervisorHostGrantGeneration,
  createRoomAgentSession,
  createSupervisorHostGrant,
  endRoomAgentSession,
  getAgentIdentityByCanonicalKey,
  getSupervisorHostGrantById,
  getSupervisorRoomAgentSession,
  revokeSupervisorHostGrant,
  rotateRoomAgentSessionBearer,
  rotateSupervisorHostGrant,
} from "../db.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../http/helpers.js";
import { buildAgentActorLabel } from "../../shared/agent-identity.js";
import { getAgentSessionBearerTtlMs, isAgentSessionBearerFeatureEnabled, isSupervisorHostGrantFeatureEnabled } from "../../shared/agent-session-bearer.js";

const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

type RoomResolverDeps = {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<{ id: string } | null>;
  requireParticipant(req: AuthenticatedRequest, res: Response, project: { id: string }): Promise<boolean>;
};

function strings(value: unknown, max = 64): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const result = [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
  return result.length ? result : null;
}

function requestedGeneration(req: AuthenticatedRequest): number | null {
  const value = (req.body as { generation?: unknown } | undefined)?.generation
    ?? req.headers["x-letagents-supervisor-generation"];
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function requireCurrentSupervisorGrant(req: AuthenticatedRequest, res: Response) {
  const grant = req.authKind === "supervisor_grant" ? req.supervisorGrant : null;
  const generation = requestedGeneration(req);
  if (!grant || generation === null || generation !== grant.current_generation) {
    res.status(403).json({ error: "A current supervisor grant and generation proof are required." });
    return null;
  }
  // Re-read immediately before a privileged mutation. A bearer resolved before
  // a concurrent renewal, handoff, lapse, or revocation is rejected rather
  // than relying on the middleware snapshot.
  const current = await getSupervisorHostGrantById(grant.grant_id);
  if (!current || current.revoked_at || new Date(current.expires_at).getTime() <= Date.now()
    || current.current_generation !== generation || current.token_version !== grant.token_version) {
    res.status(409).json({ error: "Supervisor grant fence is stale." });
    return null;
  }
  return current;
}

function cappedExpiry(grantExpiry: string): string {
  return new Date(Math.min(Date.now() + getAgentSessionBearerTtlMs(), new Date(grantExpiry).getTime())).toISOString();
}

function fence(grant: { grant_id: string; current_generation: number; token_version: number }) {
  return { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version };
}

/** Default-deny route registry: only these lifecycle endpoints accept a supervisor grant. */
export function registerSupervisorHostGrantRoutes(app: Express, deps: RoomResolverDeps): void {
  const enabled = isSupervisorHostGrantFeatureEnabled();
  // Owner revocation is deliberately always registered: turning the rollout
  // off must never make a previously issued credential impossible to revoke.
  app.delete("/supervisor-host-grants/:grantId", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount?.account_id || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "Supervisor grant revocation requires owner authentication." });
      return;
    }
    const revoked = await revokeSupervisorHostGrant({ grant_id: String(req.params.grantId ?? "").trim(), owner_account_id: req.sessionAccount.account_id });
    if (!revoked) { res.status(404).json({ error: "Active supervisor grant not found." }); return; }
    res.json(revoked);
  });
  if (!enabled) return;
  app.post("/supervisor-host-grants", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount?.account_id || (req.authKind !== "session" && req.authKind !== "owner_token")) {
      res.status(401).json({ error: "Supervisor grant provisioning requires owner authentication." });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const hostId = typeof body.host_id === "string" ? body.host_id.trim() : "";
    const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : "";
    const roomIds = strings(body.allowed_room_ids);
    const agentKeys = strings(body.allowed_agent_keys);
    if (!hostId || !installationId || !roomIds || !agentKeys) {
      res.status(400).json({ error: "host_id, installation_id, non-empty allowed_room_ids, and allowed_agent_keys are required." });
      return;
    }
    try {
      const canonicalRoomIds: string[] = [];
      for (const roomId of roomIds) {
        const room = await deps.resolveRoomOrReply(await deps.resolveCanonicalRoomRequestId(roomId), res);
        if (!room || !(await deps.requireParticipant(req, res, room))) return;
        canonicalRoomIds.push(room.id);
      }
      for (const agentKey of agentKeys) {
        const agent = await getAgentIdentityByCanonicalKey(agentKey);
        if (!agent || agent.owner_account_id !== req.sessionAccount.account_id) {
          res.status(403).json({ error: "Every allowed agent identity must be owned by this account." });
          return;
        }
      }
      const ttlMs = typeof body.ttl_ms === "number" && Number.isFinite(body.ttl_ms)
        ? Math.max(60_000, Math.min(body.ttl_ms, MAX_GRANT_TTL_MS)) : MAX_GRANT_TTL_MS;
      const created = await createSupervisorHostGrant({
        owner_account_id: req.sessionAccount.account_id,
        host_id: hostId,
        installation_id: installationId,
        allowed_room_ids: [...new Set(canonicalRoomIds)],
        allowed_agent_keys: agentKeys,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      });
      res.status(201).json({ ...created.grant, supervisor_grant: created.token });
    } catch (error) {
      respondWithInternalError(res, "POST /supervisor-host-grants", error, "Supervisor grant could not be provisioned.");
    }
  });

  app.post("/supervisor-host-grants/:grantId/renew", async (req: AuthenticatedRequest, res) => {
    const grant = await requireCurrentSupervisorGrant(req, res);
    if (!grant) return;
    const grantId = String(req.params.grantId ?? "").trim();
    const body = req.body as Record<string, unknown>;
    if (grant.grant_id !== grantId || body.host_id !== grant.host_id || body.installation_id !== grant.installation_id) {
      res.status(403).json({ error: "Grant renewal is bound to its original host and installation." });
      return;
    }
    const ttlMs = typeof body.ttl_ms === "number" && Number.isFinite(body.ttl_ms)
      ? Math.max(60_000, Math.min(body.ttl_ms, MAX_GRANT_TTL_MS)) : MAX_GRANT_TTL_MS;
    const renewed = await rotateSupervisorHostGrant({ grant_id: grantId, expected_generation: grant.current_generation, expected_token_version: grant.token_version, expires_at: new Date(Date.now() + ttlMs).toISOString() });
    if (!renewed) {
      res.status(409).json({ error: "Grant renewal lost its fence or the grant is no longer active." });
      return;
    }
    res.json({ ...renewed.grant, supervisor_grant: renewed.token });
  });

  app.post("/supervisor-host-grants/:grantId/handoff", async (req: AuthenticatedRequest, res) => {
    const grant = await requireCurrentSupervisorGrant(req, res);
    if (!grant || grant.grant_id !== String(req.params.grantId ?? "").trim()) return;
    const advanced = await advanceSupervisorHostGrantGeneration({ grant_id: grant.grant_id, expected_generation: grant.current_generation, expected_token_version: grant.token_version });
    if (!advanced) {
      res.status(409).json({ error: "Host handoff lost its generation fence." });
      return;
    }
    res.json({ grant_id: advanced.grant_id, generation: advanced.current_generation });
  });

  app.post("/supervisor-host-grants/:grantId/worker-sessions", async (req: AuthenticatedRequest, res) => {
    const grant = await requireCurrentSupervisorGrant(req, res);
    if (!grant || grant.grant_id !== String(req.params.grantId ?? "").trim()) return;
    if (!isAgentSessionBearerFeatureEnabled()) {
      res.status(503).json({ error: "Worker bearer mode is not enabled." });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const roomId = typeof body.room_id === "string" ? body.room_id.trim() : "";
    const agentKey = typeof body.agent_key === "string" ? body.agent_key.trim() : "";
    if (!grant.allowed_room_ids.includes(roomId) || !grant.allowed_agent_keys.includes(agentKey)) {
      res.status(403).json({ error: "Grant does not authorize that room and agent identity." });
      return;
    }
    const agent = await getAgentIdentityByCanonicalKey(agentKey);
    if (!agent || agent.owner_account_id !== grant.owner_account_id) {
      res.status(403).json({ error: "Grant agent identity is no longer valid." });
      return;
    }
    const displayName = typeof body.display_name === "string" && body.display_name.trim() ? body.display_name.trim().slice(0, 64) : agent.display_name;
    const ideLabel = typeof body.ide_label === "string" && body.ide_label.trim() ? body.ide_label.trim().slice(0, 64) : "Supervisor worker";
    try {
      const session = await createRoomAgentSession({
        room_id: roomId, session_kind: "worker", runtime: typeof body.runtime === "string" ? body.runtime.slice(0, 64) : "supervisor",
        registration_liveness: { host_id: grant.host_id, host_kind: "supervisor", host_label: grant.installation_id },
        repo_branch: typeof body.repo_branch === "string" ? body.repo_branch.slice(0, 255) : null,
        actor_label: buildAgentActorLabel({ display_name: displayName, owner_label: agent.owner_label, ide_label: ideLabel }),
        agent_key: agent.canonical_key, agent_instance_id: typeof body.agent_instance_id === "string" ? body.agent_instance_id.slice(0, 255) : null,
        display_name: displayName, owner_account_id: grant.owner_account_id, owner_label: agent.owner_label, ide_label: ideLabel,
        supervisor_grant_id: grant.grant_id, worker_bearer_expires_at: cappedExpiry(grant.expires_at),
        supervisor_grant_fence: fence(grant),
      });
      // Never hand the supervisor an owner-capable session token.
      res.status(201).json({ ...session, session_token: undefined });
    } catch (error) {
      respondWithInternalError(res, "POST /supervisor-host-grants/:grantId/worker-sessions", error, "Worker session could not be minted.");
    }
  });

  app.post("/supervisor-host-grants/:grantId/worker-sessions/:sessionId/rotate", async (req: AuthenticatedRequest, res) => {
    const grant = await requireCurrentSupervisorGrant(req, res);
    if (!grant || grant.grant_id !== String(req.params.grantId ?? "").trim()) return;
    const sessionId = String(req.params.sessionId ?? "").trim();
    const session = await getSupervisorRoomAgentSession({ session_id: sessionId, supervisor_grant_id: grant.grant_id });
    if (!session || !grant.allowed_room_ids.includes(session.room_id) || !grant.allowed_agent_keys.includes(session.agent_key)) {
      res.status(403).json({ error: "Grant does not authorize that worker session." });
      return;
    }
    const body = req.body as { bearer_id?: unknown };
    const bearerId = typeof body.bearer_id === "string" ? body.bearer_id.trim() : "";
    if (!bearerId) { res.status(400).json({ error: "bearer_id is required." }); return; }
    const rotated = await rotateRoomAgentSessionBearer({ bearer_id: bearerId, session_id: sessionId, supervisor_grant_id: grant.grant_id, supervisor_grant_fence: fence(grant), expires_at: cappedExpiry(grant.expires_at) });
    if (!rotated) {
      res.status(403).json({ error: "Grant does not authorize that worker bearer." });
      return;
    }
    res.json(rotated);
  });

  app.post("/supervisor-host-grants/:grantId/worker-sessions/:sessionId/end", async (req: AuthenticatedRequest, res) => {
    const grant = await requireCurrentSupervisorGrant(req, res);
    if (!grant || grant.grant_id !== String(req.params.grantId ?? "").trim()) return;
    const sessionId = String(req.params.sessionId ?? "").trim();
    // A supervisor never receives a session token; this fetch is only a
    // grant-bound ownership check before ending the exact worker session.
    const session = await getSupervisorRoomAgentSession({ session_id: sessionId, supervisor_grant_id: grant.grant_id });
    if (!session || !grant.allowed_room_ids.includes(session.room_id) || !grant.allowed_agent_keys.includes(session.agent_key)) {
      res.status(403).json({ error: "Grant does not authorize that worker session." });
      return;
    }
    const ended = await endRoomAgentSession({ session_id: sessionId, owner_account_id: grant.owner_account_id, supervisor_grant_fence: fence(grant) });
    res.json(ended);
  });
}
