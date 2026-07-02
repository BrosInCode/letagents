import type { Express, Response } from "express";

import {
  assignBoardManager,
  approveBoardIntent,
  countBoardIntents,
  createBoardIntent,
  denyBoardIntent,
  getActiveBoardManager,
  getRoomBoardSettings,
  listBoardIntents,
  normalizeBoardManagerMode,
  normalizeBoardManagerRuntimeSource,
  releaseBoardManager,
  setRoomBoardManagerMode,
  type BoardIntentActionType,
  type BoardIntentPayload,
  type Project,
} from "../../db.js";
import { type AuthenticatedRequest } from "../../http/helpers.js";
import {
  requireWorkerRequestAgentIdentity,
  type ResolvedRequestAgentIdentity,
} from "../../request/agent-identity.js";
import { normalizeRoomId } from "../../rooms/routing.js";

export interface RoomBoardRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(
    roomId: string,
    res: Response,
    options?: { allowCreate: boolean }
  ): Promise<Project | null>;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  normalizeOptionalString(value: unknown): string | null;
}

function hasAgentSessionCredentials(input: Record<string, unknown>): boolean {
  return typeof input.agent_session_id === "string" && input.agent_session_id.trim().length > 0
    || typeof input.agent_session_token === "string" && input.agent_session_token.trim().length > 0;
}

async function resolveOptionalWorkerIdentity(input: {
  req: AuthenticatedRequest;
  res: Response;
  room_id: string;
  body: Record<string, unknown>;
}): Promise<ResolvedRequestAgentIdentity | null | "responded"> {
  if (input.req.authKind !== "owner_token" || !hasAgentSessionCredentials(input.body)) {
    return null;
  }
  const result = await requireWorkerRequestAgentIdentity(input);
  if (!result.ok) {
    input.res.status(result.status).json({ error: result.error });
    return "responded";
  }
  return result.identity;
}

function isIntentActionType(value: unknown): value is BoardIntentActionType {
  return value === "task_create"
    || value === "task_claim"
    || value === "task_close"
    || value === "task_override"
    || value === "task_update";
}

function normalizePayload(value: unknown): BoardIntentPayload | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as BoardIntentPayload
    : null;
}

function isBoardManagerMode(value: string | null): value is "off" | "manager_optional" | "intent_required" {
  return value === "off" || value === "manager_optional" || value === "intent_required";
}

function requesterLabel(
  req: AuthenticatedRequest,
  body: Record<string, unknown>,
  workerIdentity: ResolvedRequestAgentIdentity | null
): string {
  const actorLabel = typeof body.actor_label === "string" ? body.actor_label.trim() : "";
  return workerIdentity?.actor_label
    ?? (actorLabel || null)
    ?? req.sessionAccount?.display_name
    ?? req.sessionAccount?.login
    ?? "participant";
}

async function authorizeBoardDecision(input: {
  req: AuthenticatedRequest;
  res: Response;
  project: Project;
  workerIdentity: ResolvedRequestAgentIdentity | null;
  requireAdmin: RoomBoardRouteDeps["requireAdmin"];
}): Promise<boolean> {
  if (input.workerIdentity?.agent_session_id) {
    const activeManager = await getActiveBoardManager(input.project.id);
    if (activeManager?.agent_session_id === input.workerIdentity.agent_session_id) {
      return true;
    }
  }
  return input.requireAdmin(input.req, input.res, input.project);
}

export function registerRoomBoardRoutes(
  app: Express,
  deps: RoomBoardRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/board-settings$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const [settings, activeManager, pendingIntentCount] = await Promise.all([
      getRoomBoardSettings(project.id),
      getActiveBoardManager(project.id),
      countBoardIntents({ room_id: project.id, status: "pending" }),
    ]);
    res.json({
      room_id: project.id,
      settings,
      active_manager: activeManager,
      pending_intent_count: pendingIntentCount,
    });
  });

  app.patch(/^\/rooms\/(.+)\/board-settings$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireAdmin(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = deps.normalizeOptionalString(body.manager_mode);
    if (!isBoardManagerMode(mode)) {
      res.status(400).json({ error: "manager_mode is invalid" });
      return;
    }
    const settings = await setRoomBoardManagerMode({
      room_id: project.id,
      manager_mode: normalizeBoardManagerMode(mode),
      updated_by: req.sessionAccount?.login ?? "admin",
    });
    res.json({ room_id: project.id, settings });
  });

  app.post(/^\/rooms\/(.+)\/board-managers$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireAdmin(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentSessionId = deps.normalizeOptionalString(body.agent_session_id);
    if (!agentSessionId) {
      res.status(400).json({ error: "agent_session_id is required" });
      return;
    }
    const runtimeSource = deps.normalizeOptionalString(body.runtime_source);
    const manager = await assignBoardManager({
      room_id: project.id,
      agent_session_id: agentSessionId,
      runtime_source: runtimeSource ? normalizeBoardManagerRuntimeSource(runtimeSource) : null,
      assigned_by: req.sessionAccount?.login ?? "admin",
    });
    if (!manager) {
      res.status(404).json({ error: "Active agent session not found" });
      return;
    }
    res.status(201).json({ room_id: project.id, manager });
  });

  app.delete(/^\/rooms\/(.+)\/board-managers\/active$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireAdmin(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const manager = await releaseBoardManager({
      room_id: project.id,
      released_by: req.sessionAccount?.login ?? "admin",
      reason: deps.normalizeOptionalString(body.reason),
    });
    res.json({ room_id: project.id, manager });
  });

  app.get(/^\/rooms\/(.+)\/board-intents$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const intents = await listBoardIntents({ room_id: project.id, status, limit: 200 });
    res.json({ room_id: project.id, intents });
  });

  app.post(/^\/rooms\/(.+)\/board-intents$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const workerIdentity = await resolveOptionalWorkerIdentity({
      req,
      res,
      room_id: project.id,
      body,
    });
    if (workerIdentity === "responded") return;
    if (!isIntentActionType(body.action_type)) {
      res.status(400).json({ error: "action_type is invalid" });
      return;
    }
    const payload = normalizePayload(body.payload);
    if (!payload) {
      res.status(400).json({ error: "payload must be an object" });
      return;
    }

    const intent = await createBoardIntent({
      room_id: project.id,
      action_type: body.action_type,
      task_id: deps.normalizeOptionalString(body.task_id),
      payload,
      proposer_actor_label: requesterLabel(req, body, workerIdentity),
      proposer_actor_key: workerIdentity?.agent_key ?? deps.normalizeOptionalString(body.actor_key),
      proposer_actor_instance_id: workerIdentity?.agent_instance_id ?? deps.normalizeOptionalString(body.actor_instance_id),
      proposer_agent_session_id: workerIdentity?.agent_session_id ?? deps.normalizeOptionalString(body.agent_session_id),
    });
    res.status(201).json({ room_id: project.id, intent });
  });

  app.post(/^\/rooms\/(.+)\/board-intents\/([^/]+)\/approve$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const intentId = (req.params as Record<string, string>)[1] ?? "";
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const workerIdentity = await resolveOptionalWorkerIdentity({
      req,
      res,
      room_id: project.id,
      body,
    });
    if (workerIdentity === "responded") return;
    if (!(await authorizeBoardDecision({ req, res, project, workerIdentity, requireAdmin: deps.requireAdmin }))) {
      return;
    }

    const approved = await approveBoardIntent({
      room_id: project.id,
      intent_id: intentId,
      decision_by: requesterLabel(req, body, workerIdentity),
      reason: deps.normalizeOptionalString(body.reason),
    });
    if (!approved) {
      res.status(404).json({ error: "Pending board intent not found" });
      return;
    }
    res.json({
      room_id: project.id,
      intent: approved.intent,
      approval_token: approved.approval_token,
    });
  });

  app.post(/^\/rooms\/(.+)\/board-intents\/([^/]+)\/deny$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const intentId = (req.params as Record<string, string>)[1] ?? "";
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const workerIdentity = await resolveOptionalWorkerIdentity({
      req,
      res,
      room_id: project.id,
      body,
    });
    if (workerIdentity === "responded") return;
    if (!(await authorizeBoardDecision({ req, res, project, workerIdentity, requireAdmin: deps.requireAdmin }))) {
      return;
    }

    const denied = await denyBoardIntent({
      room_id: project.id,
      intent_id: intentId,
      decision_by: requesterLabel(req, body, workerIdentity),
      reason: deps.normalizeOptionalString(body.reason),
    });
    if (!denied) {
      res.status(404).json({ error: "Pending board intent not found" });
      return;
    }
    res.json({ room_id: project.id, intent: denied });
  });
}
