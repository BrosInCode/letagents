import type { Express, Response } from "express";

import {
  assignBoardManager,
  approveBoardIntent,
  approveTaskCreateBoardIntent,
  countBoardIntents,
  createBoardIntent,
  denyBoardIntent,
  getActiveBoardManager,
  getBoardIntent,
  getTaskById,
  getRoomBoardSettings,
  listBoardIntents,
  normalizeTaskCreateBoardIntentPayload,
  normalizeBoardManagerMode,
  normalizeBoardManagerRuntimeSource,
  releaseBoardManager,
  setRoomBoardManagerMode,
  type BoardIntentActionType,
  type BoardIntentPayload,
  type BoardManagerAssignment,
  type BoardIntent,
  type Project,
  getBoardGovernanceSnapshot,
} from "../../db.js";
import { isBoardManagerFailoverMode } from "../../../shared/board-manager-failover.js";
import { type AuthenticatedRequest } from "../../http/helpers.js";
import {
  requireWorkerRequestAgentIdentity,
  type ResolvedRequestAgentIdentity,
} from "../../request/agent-identity.js";
import { resolveGitRoomProjectRole } from "../../rooms/access.js";
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
  resolveOptionalWorkerIdentity?(input: {
    req: AuthenticatedRequest;
    res: Response;
    room_id: string;
    body: Record<string, unknown>;
  }): Promise<ResolvedRequestAgentIdentity | null | "responded">;
  getActiveBoardManagerForRoom?(roomId: string): Promise<BoardManagerAssignment | null>;
  emitProjectMessage?(
    projectId: string,
    sender: string,
    text: string,
    options?: { source?: string; client_message_id?: string | null }
  ): Promise<{ id?: string }>;
  enforceFocusParentBoardWriteIsolation?(input: {
    req: AuthenticatedRequest;
    targetProject: Project;
  }): Promise<{ kind: "allow" } | { kind: "deny"; code: string; error: string }>;
  enforceTaskCreateBoardIntentAdmission?(input: {
    projectId: string;
    title: string;
    sourceMessageId?: string | null;
    actorLabel: string | null;
    actorKey: string | null;
    actorInstanceId: string | null;
  }): Promise<{ kind: "allow" } | { kind: "deny"; code: string; error: string }>;
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
  if (input.req.authKind !== "agent_session"
    && (input.req.authKind !== "owner_token" || !hasAgentSessionCredentials(input.body))) {
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

function mentionAgentKey(key: string | null | undefined): string | null {
  return key && /^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(key)
    && !["agents", "everyone", "room"].includes(key.toLowerCase()) ? `@agent:${key}` : null;
}

function safeNotificationFragment(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/@+/g, "at ")
    .replace(/\ball agents\b/gi, "agent group")
    .replace(/\bany agent\b/gi, "one agent")
    .replace(/\beveryone\b/gi, "every participant")
    .replace(/\byou guys\b/gi, "the group")
    .replace(/\bboth of you\b/gi, "both participants")
    .replace(/\bwhoever owns this\b/gi, "the owner")
    .trim();
  const text = normalized || fallback;
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text;
}

function intentSummary(intent: BoardIntent): string {
  if (intent.action_type === "task_create") {
    const payload = normalizeTaskCreateBoardIntentPayload(intent.payload);
    if (payload) return `Create task "${safeNotificationFragment(payload.title, "Untitled task")}"`;
  }
  return intent.action_type.replaceAll("_", " ");
}

export async function emitBoardIntentManagerNotification(input: {
  deps: RoomBoardRouteDeps;
  project: Project;
  intent: BoardIntent;
  activeManager: BoardManagerAssignment | null;
}): Promise<{ delivered: boolean; target_manager_agent_session_id: string | null; message_id: string | null }> {
  if (!input.deps.emitProjectMessage) {
    return {
      delivered: false,
      target_manager_agent_session_id: input.activeManager?.agent_session_id ?? null,
      message_id: null,
    };
  }

  const proposer = safeNotificationFragment(input.intent.proposer_actor_label, "a participant");
  const summary = intentSummary(input.intent);
  const managerMention = input.activeManager ? mentionAgentKey(input.activeManager.agent_key) : null;
  const text = input.activeManager
    ? `${managerMention ?? safeNotificationFragment(input.activeManager.actor_label, "Board Manager")} New board intent from ${proposer}: ${summary}. Intent ${input.intent.id}: use approve_board_intent or deny_board_intent to decide it.`
    : `New board intent from ${proposer}: ${summary}. It is pending, but no Board Manager is assigned.`;
  const message = await input.deps.emitProjectMessage(
    input.project.id,
    "letagents",
    text,
    {
      source: "system",
      client_message_id: `board_intent:${input.intent.id}:manager_notify`,
    }
  );

  return {
    delivered: Boolean(message.id),
    target_manager_agent_session_id: input.activeManager?.agent_session_id ?? null,
    message_id: message.id ?? null,
  };
}

export async function emitBoardIntentDecisionNotification(input: {
  deps: RoomBoardRouteDeps; project: Project; intent: BoardIntent;
}): Promise<{ delivered: boolean; message_id: string | null; error?: string }> {
  const mention = mentionAgentKey(input.intent.proposer_actor_key);
  if (!mention || !input.intent.proposer_agent_session_id || !input.deps.emitProjectMessage) {
    return { delivered: false, message_id: null };
  }
  const outcome = input.intent.status === "denied" ? "denied" : "approved";
  const followUp = outcome === "denied" ? "Do not perform the requested action."
    : input.intent.status === "used" && input.intent.action_type !== "task_create" ? "The approved action was already applied; read the board for its current state."
    : input.intent.action_type === "task_create" ? "The approved task was created; read the board for its current state."
      : "Continue the exact approved action with board_intent_id and your own worker session; no approval token is needed.";
  try {
    const message = await input.deps.emitProjectMessage(input.project.id, "letagents",
    `${mention} Board intent ${input.intent.id} was ${outcome}. ${followUp}`,
    { source: "system", client_message_id: `board_intent:${input.intent.id}:${outcome}:proposer_notify` });
    return { delivered: Boolean(message.id), message_id: message.id ?? null };
  } catch {
    return { delivered: false, message_id: null, error: "The decision was recorded, but notification failed. Retry this decision to notify the proposer." };
  }
}

function isBoardManagerMode(value: string | null): value is "off" | "manager_optional" | "intent_required" {
  return value === "off" || value === "manager_optional" || value === "intent_required";
}

export function requesterLabel(
  req: AuthenticatedRequest,
  body: Record<string, unknown>,
  workerIdentity: ResolvedRequestAgentIdentity | null
): string {
  const actorLabel = typeof body.actor_label === "string" ? body.actor_label.trim() : "";
  return workerIdentity?.actor_label
    ?? req.sessionAccount?.display_name
    ?? req.sessionAccount?.login
    ?? (actorLabel || null)
    ?? "participant";
}

export async function authorizeBoardDecision(input: {
  req: AuthenticatedRequest;
  res: Response;
  project: Project;
  workerIdentity: ResolvedRequestAgentIdentity | null;
  requireAdmin: RoomBoardRouteDeps["requireAdmin"];
  getActiveBoardManagerForRoom?: (roomId: string) => Promise<BoardManagerAssignment | null>;
}): Promise<boolean> {
  if (input.workerIdentity?.agent_session_id) {
    const activeManager = await (input.getActiveBoardManagerForRoom ?? getActiveBoardManager)(input.project.id);
    if (activeManager?.agent_session_id === input.workerIdentity.agent_session_id) {
      return true;
    }
    input.res.status(403).json({
      error: "Only the active Board Manager can decide board intents with worker credentials.",
    });
    return false;
  }
  return input.requireAdmin(input.req, input.res, input.project);
}

export function registerRoomBoardRoutes(
  app: Express,
  deps: RoomBoardRouteDeps
): void {
  const resolveBoardWorkerIdentity = deps.resolveOptionalWorkerIdentity ?? resolveOptionalWorkerIdentity;
  const getActiveBoardManagerForRoom = deps.getActiveBoardManagerForRoom ?? getActiveBoardManager;

  app.get(/^\/rooms\/(.+)\/board-governance$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const isAdmin = req.sessionAccount
      ? (await resolveGitRoomProjectRole(project, req.sessionAccount)) === "admin"
      : false;

    const governance = await getBoardGovernanceSnapshot({
      room_id: project.id,
      is_admin: isAdmin,
    });
    res.json(governance);
  });

  app.get(/^\/rooms\/(.+)\/board-settings$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const [settings, activeManager, pendingIntentCount] = await Promise.all([
      getRoomBoardSettings(project.id),
      getActiveBoardManagerForRoom(project.id),
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
    const failover = deps.normalizeOptionalString(body.manager_failover);
    if (failover !== null && !isBoardManagerFailoverMode(failover)) {
      res.status(400).json({ error: "manager_failover is invalid" });
      return;
    }
    const settings = await setRoomBoardManagerMode({
      room_id: project.id,
      manager_mode: normalizeBoardManagerMode(mode),
      manager_failover: failover !== null && isBoardManagerFailoverMode(failover) ? failover : null,
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
    const workerIdentity = await resolveBoardWorkerIdentity({
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
    if (body.action_type === "task_create") {
      if (!normalizeTaskCreateBoardIntentPayload(payload)) {
        res.status(400).json({ error: "task_create payload must include a title" });
        return;
      }
      const isolation = await deps.enforceFocusParentBoardWriteIsolation?.({
        req,
        targetProject: project,
      });
      if (isolation?.kind === "deny") {
        res.status(409).json({ error: isolation.error, code: isolation.code });
        return;
      }
    }

    const intent = await createBoardIntent({
      room_id: project.id,
      action_type: body.action_type,
      task_id: deps.normalizeOptionalString(body.task_id),
      payload,
      proposer_actor_label: requesterLabel(req, body, workerIdentity),
      proposer_actor_key: workerIdentity ? workerIdentity.agent_key : deps.normalizeOptionalString(body.actor_key),
      proposer_actor_instance_id: workerIdentity ? workerIdentity.agent_instance_id : deps.normalizeOptionalString(body.actor_instance_id),
      proposer_agent_session_id: workerIdentity ? workerIdentity.agent_session_id : deps.normalizeOptionalString(body.agent_session_id),
    });
    const activeManager = await getActiveBoardManagerForRoom(project.id);
    const managerNotification = await emitBoardIntentManagerNotification({
      deps,
      project,
      intent,
      activeManager,
    });
    res.status(201).json({
      room_id: project.id,
      intent,
      manager_notification: managerNotification,
    });
  });

  app.post(/^\/rooms\/(.+)\/board-intents\/([^/]+)\/approve$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const intentId = (req.params as Record<string, string>)[1] ?? "";
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;
    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const workerIdentity = await resolveBoardWorkerIdentity({
      req,
      res,
      room_id: project.id,
      body,
    });
    if (workerIdentity === "responded") return;
    if (!(await authorizeBoardDecision({
      req,
      res,
      project,
      workerIdentity,
      requireAdmin: deps.requireAdmin,
      getActiveBoardManagerForRoom,
    }))) {
      return;
    }

    const decisionBy = requesterLabel(req, body, workerIdentity);
    const reason = deps.normalizeOptionalString(body.reason);
    const existingIntent = await getBoardIntent({
      room_id: project.id,
      intent_id: intentId,
    });
    if (existingIntent && (existingIntent.status === "used"
      || existingIntent.status === "approved" && (!existingIntent.expires_at || Date.parse(existingIntent.expires_at) > Date.now()))) {
      const proposerNotification = await emitBoardIntentDecisionNotification({ deps, project, intent: existingIntent });
      const task = existingIntent.action_type === "task_create" && existingIntent.task_id
        ? await getTaskById(project.id, existingIntent.task_id) : null;
      res.json({ room_id: project.id, intent: existingIntent, proposer_notification: proposerNotification,
        result: task ? { kind: "task_created", task } : { kind: "approval_recorded", requires_follow_up: existingIntent.status === "approved" } });
      return;
    }
    if (existingIntent?.action_type === "task_create") {
      const taskPayload = normalizeTaskCreateBoardIntentPayload(existingIntent.payload);
      if (!taskPayload) {
        res.status(400).json({ error: `Board intent ${intentId} has an invalid task creation payload.` });
        return;
      }

      const admission = await deps.enforceTaskCreateBoardIntentAdmission?.({
        projectId: project.id,
        title: taskPayload.title,
        sourceMessageId: taskPayload.sourceMessageId ?? null,
        actorLabel: existingIntent.proposer_actor_label,
        actorKey: existingIntent.proposer_actor_key,
        actorInstanceId: existingIntent.proposer_actor_instance_id,
      });
      if (admission?.kind === "deny") {
        res.status(409).json({ error: admission.error, code: admission.code });
        return;
      }

      try {
        const taskCreateApproval = await approveTaskCreateBoardIntent({
          room_id: project.id,
          intent_id: intentId,
          decision_by: decisionBy,
          reason,
        });
        if (!taskCreateApproval) {
          res.status(404).json({ error: "Pending board intent not found" });
          return;
        }
        const proposerNotification = await emitBoardIntentDecisionNotification({ deps, project, intent: taskCreateApproval.intent });
        res.json({
          proposer_notification: proposerNotification,
          room_id: project.id,
          intent: taskCreateApproval.intent,
          result: {
            kind: "task_created",
            task: taskCreateApproval.task,
          },
        });
        return;
      } catch (error) {
        if (error instanceof Error && error.message.includes("invalid task creation payload")) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
    }

    const approved = await approveBoardIntent({
      room_id: project.id,
      intent_id: intentId,
      decision_by: decisionBy,
      reason,
    });
    if (!approved) {
      res.status(404).json({ error: "Pending board intent not found" });
      return;
    }
    const proposerNotification = await emitBoardIntentDecisionNotification({ deps, project, intent: approved.intent });
    res.json({
      proposer_notification: proposerNotification,
      room_id: project.id,
      intent: approved.intent,
      approval_token: approved.approval_token,
      result: {
        kind: "approval_token",
        requires_follow_up: true,
      },
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
    const workerIdentity = await resolveBoardWorkerIdentity({
      req,
      res,
      room_id: project.id,
      body,
    });
    if (workerIdentity === "responded") return;
    if (!(await authorizeBoardDecision({
      req,
      res,
      project,
      workerIdentity,
      requireAdmin: deps.requireAdmin,
      getActiveBoardManagerForRoom,
    }))) {
      return;
    }

    const existingIntent = await getBoardIntent({ room_id: project.id, intent_id: intentId });
    if (existingIntent?.status === "denied") {
      const proposerNotification = await emitBoardIntentDecisionNotification({ deps, project, intent: existingIntent });
      res.json({ room_id: project.id, intent: existingIntent, proposer_notification: proposerNotification });
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
    const proposerNotification = await emitBoardIntentDecisionNotification({ deps, project, intent: denied });
    res.json({ room_id: project.id, intent: denied, proposer_notification: proposerNotification });
  });
}
