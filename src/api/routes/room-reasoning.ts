import type { EventEmitter } from "events";
import type { Express, Response } from "express";

import {
  appendReasoningSessionUpdate,
  createReasoningSession,
  getReasoningSessionById,
  getReasoningSessionUpdates,
  getReasoningSessions,
  updateReasoningSession,
  type Project,
  type ReasoningSession,
  type ReasoningSessionUpdate,
} from "../db.js";
import {
  parseLimit,
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { normalizeRoomId } from "../room-routing.js";
import { requireWorkerRequestAgentIdentity } from "../request-agent-identity.js";
import {
  normalizeAgentPresenceStatus,
  type AgentPresenceStatus,
} from "../../shared/agent-presence.js";
import type { ReasoningSnapshot } from "../db/schema.js";

interface ReasoningSessionUpdatedEvent {
  projectId: string;
  session: ReasoningSession;
  update?: ReasoningSessionUpdate | null;
}

interface ReasoningSessionRemovedEvent {
  projectId: string;
  session_id: string;
}

export interface RoomReasoningRouteDeps {
  reasoningEvents: EventEmitter;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  reasoningStore?: Partial<RoomReasoningStore>;
}

export interface RoomReasoningStore {
  appendReasoningSessionUpdate: typeof appendReasoningSessionUpdate;
  createReasoningSession: typeof createReasoningSession;
  getReasoningSessionById: typeof getReasoningSessionById;
  getReasoningSessionUpdates: typeof getReasoningSessionUpdates;
  getReasoningSessions: typeof getReasoningSessions;
  updateReasoningSession: typeof updateReasoningSession;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function parseOptionalReasoningStatus(value: unknown): AgentPresenceStatus | null {
  if (value === null) return null;
  const status = normalizeAgentPresenceStatus(value);
  if (!status) {
    throw new Error("status must be one of: idle, working, reviewing, blocked");
  }
  return status;
}

function parseOptionalConfidence(value: unknown): number | null {
  if (value === null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw new Error("confidence must be a number between 0 and 1");
  }
  return numeric;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function parseReasoningSnapshot(body: Record<string, unknown>): ReasoningSnapshot {
  const summary = normalizeOptionalString(body.summary);
  if (!summary) {
    throw new Error("summary is required");
  }

  const snapshot: ReasoningSnapshot = { summary };

  if (hasOwn(body, "goal")) snapshot.goal = normalizeOptionalString(body.goal);
  if (hasOwn(body, "checking")) snapshot.checking = normalizeOptionalString(body.checking);
  if (hasOwn(body, "hypothesis")) snapshot.hypothesis = normalizeOptionalString(body.hypothesis);
  if (hasOwn(body, "blocker")) snapshot.blocker = normalizeOptionalString(body.blocker);
  if (hasOwn(body, "next_action")) snapshot.next_action = normalizeOptionalString(body.next_action);
  if (hasOwn(body, "milestone")) snapshot.milestone = normalizeOptionalString(body.milestone);
  if (hasOwn(body, "status")) snapshot.status = parseOptionalReasoningStatus(body.status);
  if (hasOwn(body, "confidence")) snapshot.confidence = parseOptionalConfidence(body.confidence);

  return snapshot;
}

export function registerRoomReasoningRoutes(
  app: Express,
  deps: RoomReasoningRouteDeps
): void {
  const reasoningStore: RoomReasoningStore = {
    appendReasoningSessionUpdate,
    createReasoningSession,
    getReasoningSessionById,
    getReasoningSessionUpdates,
    getReasoningSessions,
    updateReasoningSession,
    ...deps.reasoningStore,
  };

  app.get(/^\/rooms\/(.+)\/reasoning$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const actor_label =
      typeof req.query.actor_label === "string" ? req.query.actor_label.trim() || null : null;
    const task_id = typeof req.query.task_id === "string" ? req.query.task_id.trim() || null : null;
    const open_only = req.query.open !== "false";

    const sessions = await reasoningStore.getReasoningSessions(project.id, {
      limit,
      open_only,
      actor_label,
      task_id,
    });

    res.json({
      room_id: project.id,
      sessions,
    });
  });

  app.get(/^\/rooms\/(.+)\/reasoning-sessions$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const open_only = req.query.open !== "false";
    const actor_label =
      typeof req.query.actor_label === "string" ? req.query.actor_label.trim() || null : null;
    const task_id = typeof req.query.task_id === "string" ? req.query.task_id.trim() || null : null;

    const sessions = await reasoningStore.getReasoningSessions(project.id, {
      limit,
      open_only,
      actor_label,
      task_id,
    });

    res.json({
      room_id: project.id,
      sessions,
    });
  });

  app.post(/^\/rooms\/(.+)\/reasoning-sessions$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentSessionIdentity = req.authKind === "owner_token"
      ? await requireWorkerRequestAgentIdentity({ req, body, room_id: project.id })
      : null;
    if (agentSessionIdentity && !agentSessionIdentity.ok) {
      res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
      return;
    }
    const workerIdentity = agentSessionIdentity?.ok ? agentSessionIdentity.identity : null;
    const actor_label = workerIdentity?.actor_label ?? normalizeOptionalString(body.actor_label);
    if (!actor_label) {
      res.status(400).json({ error: "actor_label is required" });
      return;
    }

    try {
      const result = await reasoningStore.createReasoningSession({
        room_id: project.id,
        task_id: normalizeOptionalString(body.task_id),
        anchor_message_id: normalizeOptionalString(body.anchor_message_id),
        actor_label,
        agent_key: workerIdentity?.agent_key ?? normalizeOptionalString(body.agent_key),
        snapshot: parseReasoningSnapshot(body),
      });

      deps.reasoningEvents.emit(
        "reasoning:updated",
        {
          projectId: project.id,
          session: result.session,
          update: result.update,
        } satisfies ReasoningSessionUpdatedEvent
      );

      res.status(201).json({
        room_id: project.id,
        session: result.session,
        update: result.update,
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/reasoning-sessions",
        error,
        "Reasoning session could not be created."
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/reasoning-sessions\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const sessionId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const session = await reasoningStore.getReasoningSessionById(project.id, sessionId);
    if (!session) {
      res.status(404).json({ error: "Reasoning session not found" });
      return;
    }

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const updates = await reasoningStore.getReasoningSessionUpdates(project.id, sessionId, { limit });

    res.json({
      room_id: project.id,
      session,
      updates,
    });
  });

  app.patch(/^\/rooms\/(.+)\/reasoning-sessions\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const sessionId = (req.params as Record<string, string>)[1] ?? "";

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentSessionIdentity = req.authKind === "owner_token"
      ? await requireWorkerRequestAgentIdentity({ req, body, room_id: project.id })
      : null;
    if (agentSessionIdentity && !agentSessionIdentity.ok) {
      res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
      return;
    }
    const hasChanges =
      hasOwn(body, "task_id") ||
      hasOwn(body, "anchor_message_id") ||
      hasOwn(body, "closed_at");

    if (!hasChanges) {
      res.status(400).json({ error: "task_id, anchor_message_id, or closed_at is required" });
      return;
    }

    try {
      const session = await reasoningStore.updateReasoningSession({
        room_id: project.id,
        session_id: sessionId,
        ...(hasOwn(body, "task_id") ? { task_id: normalizeOptionalString(body.task_id) } : {}),
        ...(hasOwn(body, "anchor_message_id")
          ? { anchor_message_id: normalizeOptionalString(body.anchor_message_id) }
          : {}),
        ...(hasOwn(body, "closed_at")
          ? { closed_at: normalizeOptionalString(body.closed_at) }
          : {}),
      });

      if (!session) {
        res.status(404).json({ error: "Reasoning session not found" });
        return;
      }

      if (hasOwn(body, "closed_at") && session.closed_at) {
        deps.reasoningEvents.emit(
          "reasoning:removed",
          { projectId: project.id, session_id: session.id } satisfies ReasoningSessionRemovedEvent
        );
      } else {
        deps.reasoningEvents.emit(
          "reasoning:updated",
          { projectId: project.id, session, update: null } satisfies ReasoningSessionUpdatedEvent
        );
      }

      res.json({
        room_id: project.id,
        session,
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "PATCH /rooms/:room_id/reasoning-sessions/:session_id",
        error,
        "Reasoning session could not be updated."
      );
    }
  });

  app.post(
    /^\/rooms\/(.+)\/reasoning-sessions\/([^/]+)\/updates$/,
    async (req: AuthenticatedRequest, res) => {
      const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
      const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
      const sessionId = (req.params as Record<string, string>)[1] ?? "";

      const project = await deps.resolveRoomOrReply(roomId, res);
      if (!project) return;

      if (!(await deps.requireParticipant(req, res, project))) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const agentSessionIdentity = req.authKind === "owner_token"
        ? await requireWorkerRequestAgentIdentity({ req, body, room_id: project.id })
        : null;
      if (agentSessionIdentity && !agentSessionIdentity.ok) {
        res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
        return;
      }
      const workerIdentity = agentSessionIdentity?.ok ? agentSessionIdentity.identity : null;

      try {
        const result = await reasoningStore.appendReasoningSessionUpdate({
          room_id: project.id,
          session_id: sessionId,
          actor_label: workerIdentity?.actor_label ?? normalizeOptionalString(body.actor_label),
          snapshot: parseReasoningSnapshot(body),
        });

        if (!result) {
          res.status(404).json({ error: "Reasoning session not found" });
          return;
        }

        deps.reasoningEvents.emit(
          "reasoning:updated",
          {
            projectId: project.id,
            session: result.session,
            update: result.update,
          } satisfies ReasoningSessionUpdatedEvent
        );

        res.status(201).json({
          room_id: project.id,
          session: result.session,
          update: result.update,
        });
      } catch (error) {
        respondWithBadRequest(
          res,
          "POST /rooms/:room_id/reasoning-sessions/:session_id/updates",
          error,
          "Reasoning update could not be recorded."
        );
      }
    }
  );
}
