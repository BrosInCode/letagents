import type { Express, Response } from "express";

import {
  createRoomAgentSession,
  endRoomAgentSession,
  getFocusRoomsForParent,
  getActiveRoomAgentSessionsForWorkerIdentity,
  getAgentIdentityByCanonicalKey,
  getMessages,
  getRoomAgentPresence,
  getRoomAgentPresenceSnapshot,
  getRoomParticipants,
  getRoomParticipantsForRooms,
  getProjectById,
  getTasksForRooms,
  setRoomLiveAgentSuppressed,
  setRoomParticipantsHidden,
  upsertRoomAgentPresence,
  type Project,
  type RoomAgentPresence,
  type RoomParticipant,
} from "../db.js";
import {
  parseLimit,
  respondWithInternalError,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { buildSyntheticPresenceEntry } from "../presence-fallback.js";
import {
  buildRoomActivityHistoryEntries,
  filterRoomActivityHistoryEntries,
  paginateRoomActivityHistoryEntries,
  sortRoomActivityHistoryEntries,
  type RoomActivityHistoryKind,
} from "../room-activity-history.js";
import {
  decorateRoomActivityHistoryEntriesWithPresence,
  decorateRoomParticipantsWithPresence,
} from "../room-activity-state.js";
import { buildFallbackRoomParticipants } from "../room-participant-fallback.js";
import { disconnectRoomAgentDeliverySession } from "../room-agent-delivery.js";
import { normalizeRoomId } from "../room-routing.js";
import { requireWorkerRequestAgentIdentity } from "../request-agent-identity.js";
import {
  normalizeAgentPresenceStatus,
  normalizeRoomAgentSessionKind,
  type AgentPresenceStatus,
} from "../../shared/agent-presence.js";
import { buildAgentActorLabel, parseAgentActorLabel } from "../../shared/agent-identity.js";
import { pickLocalCodename } from "../../shared/codenames.js";
import { isWithinRecentlyOfflineWindow } from "../../shared/room-agent-activity.js";

export interface RoomPresenceRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
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
  rememberAgentRoomParticipant(input: {
    projectId: string;
    actorLabel?: string | null;
    agentKey?: string | null;
    displayName?: string | null;
    ownerLabel?: string | null;
    ideLabel?: string | null;
    lastSeenAt?: string | null;
    preserveLastSeenAtOnConflict?: boolean;
  }): Promise<void>;
  maybeEmitStaleWorkPrompt(projectId: string): Promise<unknown>;
}

function toPublicRoomAgentPresence(presence: RoomAgentPresence): RoomAgentPresence {
  return {
    ...presence,
  };
}

function toPublicRoomParticipant(participant: RoomParticipant): RoomParticipant {
  return {
    ...participant,
  };
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHistoryKind(value: unknown): RoomActivityHistoryKind {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "agent" || normalized === "human" ? normalized : "all";
}

function normalizeHistoryRoomId(value: unknown): string | null {
  const normalized = normalizeRoomId(String(value ?? "").trim());
  return normalized || null;
}

function normalizeActorLabel(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeRuntime(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || "unknown";
}

function isActiveWorkerIdentityConflict(error: unknown): boolean {
  const cause = typeof error === "object" && error !== null && "cause" in error
    ? (error as { cause?: unknown }).cause
    : error;
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? (cause as { code?: unknown }).code
    : null;
  const constraint = typeof cause === "object" && cause !== null && "constraint" in cause
    ? (cause as { constraint?: unknown }).constraint
    : null;

  return code === "23505" && constraint === "room_agent_sessions_active_worker_identity_idx";
}

export function buildRoomActivityHistoryParticipants(input: {
  roomId: string;
  storedParticipants: readonly RoomParticipant[];
  presence: readonly RoomAgentPresence[];
  fallbackMessages?: Awaited<ReturnType<typeof getMessages>>["messages"];
}): RoomParticipant[] {
  const participantsByKey = new Map<string, RoomParticipant>();
  for (const participant of input.storedParticipants) {
    participantsByKey.set(participant.participant_key, participant);
  }

  const fallbackParticipants = buildFallbackRoomParticipants({
    roomId: input.roomId,
    messages: input.fallbackMessages ?? [],
    presence: input.presence,
  });
  for (const participant of fallbackParticipants) {
    if (!participantsByKey.has(participant.participant_key)) {
      participantsByKey.set(participant.participant_key, participant);
    }
  }

  return Array.from(participantsByKey.values());
}

export function isSuppressibleDisconnectedPresence(
  entry: RoomAgentPresence,
  now = Date.now()
): boolean {
  return entry.session_kind === "worker"
    && entry.source_flags.includes("delivery")
    && entry.freshness !== "active"
    && isWithinRecentlyOfflineWindow(entry.last_heartbeat_at, now);
}

export function registerRoomPresenceRoutes(
  app: Express,
  deps: RoomPresenceRouteDeps
): void {
  app.get(/^(?:\/api)?\/rooms\/(.+)\/presence$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined) ?? 50;
    try {
      const presence = await getRoomAgentPresence(project.id, { limit });

      res.json({
        room_id: project.id,
        presence: presence.map(toPublicRoomAgentPresence),
      });
    } catch (error) {
      console.error(
        `[presence] failed to read canonical room presence for ${project.id}; returning an empty live roster`,
        error
      );

      res.json({
        room_id: project.id,
        presence: [],
        fallback: "unavailable",
      });
    }
  });

  app.get(/^\/rooms\/(.+)\/participants$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined) ?? 100;

    try {
      const [storedParticipants, storedPresence] = await Promise.all([
        getRoomParticipants(project.id, { limit, includeHidden: true }),
        getRoomAgentPresence(project.id, { limit: 500 }).catch(() => []),
      ]);
      if (storedParticipants.length > 0) {
        const participants = decorateRoomParticipantsWithPresence({
          participants: storedParticipants,
          presence: storedPresence,
        });
        res.json({
          room_id: project.id,
          participants: participants
            .filter((participant) => !participant.hidden_at)
            .map(toPublicRoomParticipant),
          hidden_count: participants.filter((participant) => Boolean(participant.hidden_at)).length,
        });
        return;
      }

      const fallbackMessageLimit = Math.min(Math.max(limit * 4, 100), 200);
      const [messagesResult, presence] = await Promise.all([
        getMessages(project.id, { limit: fallbackMessageLimit }),
        getRoomAgentPresence(project.id, { limit }).catch(() => []),
      ]);

      const participantsFromHistory = decorateRoomParticipantsWithPresence({
        participants: buildFallbackRoomParticipants({
          roomId: project.id,
          messages: messagesResult.messages,
          presence,
        }),
        presence,
      }).slice(0, limit);

      res.json({
        room_id: project.id,
        participants: participantsFromHistory.map(toPublicRoomParticipant),
        fallback: "room_history",
        hidden_count: 0,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /rooms/:room_id/participants",
        error,
        "Room participants could not be loaded."
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/activity-history$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    try {
      const rootRoom = project.parent_room_id
        ? (await getProjectById(project.parent_room_id)) ?? project
        : project;
      const focusRooms = rootRoom.kind === "main"
        ? await getFocusRoomsForParent(rootRoom.id)
        : [];
      const rooms = [rootRoom, ...focusRooms];
      const selectedRoomId = normalizeHistoryRoomId(req.query.room_id) ?? project.id;
      const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? project;
      const scopedRooms = rooms.filter((room) => room.id === selectedRoom.id);
      const [selectedRoomParticipants, roomTasks, selectedRoomPresence] = await Promise.all([
        getRoomParticipantsForRooms([selectedRoom.id], { includeHidden: true }),
        getTasksForRooms([selectedRoom.id]),
        getRoomAgentPresenceSnapshot(selectedRoom.id).catch(() => []),
      ]);
      const fallbackMessages = selectedRoomParticipants.length > 0
        ? []
        : (await getMessages(selectedRoom.id, { limit: 200 })).messages;
      const historyParticipants = buildRoomActivityHistoryParticipants({
        roomId: selectedRoom.id,
        storedParticipants: selectedRoomParticipants,
        presence: selectedRoomPresence,
        fallbackMessages,
      });
      const entries = decorateRoomActivityHistoryEntriesWithPresence({
        entries: buildRoomActivityHistoryEntries({
          rooms: scopedRooms,
          participants: historyParticipants,
          tasks: roomTasks,
        }),
        presence: selectedRoomPresence,
      });
      const filtered = filterRoomActivityHistoryEntries(entries, {
        roomId: selectedRoom.id,
        kind: normalizeHistoryKind(req.query.kind),
        query: typeof req.query.query === "string" ? req.query.query : null,
      });
      const paginated = paginateRoomActivityHistoryEntries(sortRoomActivityHistoryEntries(filtered), {
        page: parsePositiveInteger(req.query.page, 1),
        pageSize: parsePositiveInteger(req.query.page_size, 20),
      });

      res.json({
        room_id: project.id,
        root_room_id: rootRoom.id,
        selected_room_id: selectedRoom.id,
        hidden_count: historyParticipants.filter((participant) => Boolean(participant.hidden_at)).length,
        ...paginated,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /rooms/:room_id/activity-history",
        error,
        "Room activity history could not be loaded."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/participants\/(?:clear|archive)-disconnected$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireAdmin(req, res, project))) return;

    try {
      const [participants, presence] = await Promise.all([
        getRoomParticipantsForRooms([project.id], { includeHidden: true }),
        getRoomAgentPresenceSnapshot(project.id),
      ]);
      const activeActors = new Set(
        presence
          .filter((entry) =>
            entry.session_kind === "worker"
            && entry.freshness === "active"
            && entry.source_flags.includes("delivery")
          )
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      );
      const hiddenParticipantKeys = participants
        .filter((participant) =>
          participant.kind === "agent"
          && !participant.hidden_at
          && !activeActors.has(normalizeActorLabel(participant.actor_label))
        )
        .map((participant) => participant.participant_key);
      const suppressedActorLabels = Array.from(new Set(
        presence
          .filter((entry) => isSuppressibleDisconnectedPresence(entry))
          .map((entry) => normalizeActorLabel(entry.actor_label))
          .filter(Boolean)
      ));
      const [hiddenParticipantCount, suppressedCount] = await Promise.all([
        setRoomParticipantsHidden({
          room_id: project.id,
          participant_keys: hiddenParticipantKeys,
          hidden: true,
          hidden_by: req.sessionAccount?.login ?? "room-admin",
        }),
        setRoomLiveAgentSuppressed({
          room_id: project.id,
          actor_labels: suppressedActorLabels,
          suppressed: true,
          suppressed_by: req.sessionAccount?.login ?? "room-admin",
        }),
      ]);

      res.json({
        room_id: project.id,
        cleared_count: hiddenParticipantCount + suppressedCount,
        participant_hidden_count: hiddenParticipantCount,
        suppressed_count: suppressedCount,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/participants/clear-disconnected",
        error,
        "Disconnected participants could not be cleared from the live roster."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;
    if (!req.sessionAccount?.account_id) {
      res.status(401).json({ error: "Agent session registration requires authenticated owner context." });
      return;
    }

    const {
      actor_key,
      actor_label,
      display_name,
      ide_label,
      agent_instance_id,
      session_kind,
      runtime,
    } = req.body as {
      actor_key?: string;
      actor_label?: string;
      display_name?: string;
      ide_label?: string;
      agent_instance_id?: string | null;
      session_kind?: string;
      runtime?: string;
    };

    const actorKey = typeof actor_key === "string" ? actor_key.trim() : "";
    if (!actorKey) {
      res.status(400).json({ error: "actor_key is required" });
      return;
    }

    try {
      const agent = await getAgentIdentityByCanonicalKey(actorKey);
      if (!agent || agent.owner_account_id !== req.sessionAccount.account_id) {
        res.status(403).json({ error: "actor_key is not owned by this account" });
        return;
      }

      const parsedActorLabel = parseAgentActorLabel(actor_label);
      const resolvedIdeLabel = (
        typeof ide_label === "string" && ide_label.trim()
          ? ide_label.trim()
          : parsedActorLabel?.ide_label ?? "Agent"
      );
      const requestedDisplayName = typeof display_name === "string" ? display_name.trim() : "";
      const genericKeywords = new Set(["antigravity", "codex", "agent", "worker", "local", "claude", "cursor", "cline", "roo"]);
      resolvedIdeLabel.toLowerCase().split(/[\s_-]+/).forEach(t => { if (t) genericKeywords.add(t); });
      const requestedTokens = requestedDisplayName.toLowerCase().split(/[\s_-]+/).filter(t => t.length > 0);
      const isGenericName = !requestedDisplayName || requestedTokens.every(t => genericKeywords.has(t));
      
      let baseDisplayName = isGenericName ? pickLocalCodename(agent.canonical_key).display_name : (requestedDisplayName || agent.display_name);
      let sessionDisplayName = baseDisplayName;

      const activeParticipants = await getRoomParticipants(project.id, { limit: 200 });
      let offset = 0;
      while (activeParticipants.some(p => p.display_name === sessionDisplayName && p.agent_key !== agent.canonical_key)) {
        offset++;
        sessionDisplayName = isGenericName ? pickLocalCodename(`${agent.canonical_key}:${offset}`).display_name : `${baseDisplayName} ${offset}`;
      }
      const requestedSessionKind = normalizeRoomAgentSessionKind(session_kind || "worker");
      const normalizedAgentInstanceId = typeof agent_instance_id === "string" ? agent_instance_id.trim() || null : null;
      if (requestedSessionKind === "worker") {
        const activeSessions = await getActiveRoomAgentSessionsForWorkerIdentity({
          room_id: project.id,
          agent_key: agent.canonical_key,
        });
        if (activeSessions.length > 0) {
          const conflictingSession = activeSessions.find((activeSession) => !(
            normalizedAgentInstanceId &&
            activeSession.agent_instance_id &&
            activeSession.agent_instance_id === normalizedAgentInstanceId
          ));
          if (!conflictingSession) {
            for (const activeSession of activeSessions) {
              await disconnectRoomAgentDeliverySession({
                room_id: project.id,
                agent_session_id: activeSession.session_id,
              });
            }
            for (const activeSession of activeSessions) {
              await endRoomAgentSession({
                session_id: activeSession.session_id,
                room_id: project.id,
                owner_account_id: req.sessionAccount.account_id,
              });
            }
          } else {
            res.status(409).json({
              error: `${conflictingSession.display_name} is already registered as an active worker in this room. Use a different agent identity or disconnect the existing worker first.`,
              code: "agent_identity_already_active",
              active_agent_session_id: conflictingSession.session_id,
              active_display_name: conflictingSession.display_name,
              active_runtime: conflictingSession.runtime,
            });
            return;
          }
        }
      }
      try {
        const session = await createRoomAgentSession({
          room_id: project.id,
          session_kind: requestedSessionKind,
          runtime: normalizeRuntime(runtime || resolvedIdeLabel),
          actor_label: buildAgentActorLabel({
            display_name: sessionDisplayName,
            owner_label: agent.owner_label,
            ide_label: resolvedIdeLabel,
          }),
          agent_key: agent.canonical_key,
          agent_instance_id: normalizedAgentInstanceId,
          display_name: sessionDisplayName,
          owner_account_id: req.sessionAccount.account_id,
          owner_label: agent.owner_label,
          ide_label: resolvedIdeLabel,
        });

        res.status(201).json(session);
      } catch (error) {
        if (isActiveWorkerIdentityConflict(error)) {
          const [activeSession] = await getActiveRoomAgentSessionsForWorkerIdentity({
            room_id: project.id,
            agent_key: agent.canonical_key,
          });
          res.status(409).json({
            error: `${activeSession?.display_name ?? agent.display_name} is already registered as an active worker in this room. Use a different agent identity or disconnect the existing worker first.`,
            code: "agent_identity_already_active",
            active_agent_session_id: activeSession?.session_id ?? null,
            active_display_name: activeSession?.display_name ?? agent.display_name,
            active_runtime: activeSession?.runtime ?? null,
          });
          return;
        }
        throw error;
      }
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/agent-sessions",
        error,
        "Agent session could not be registered."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/agent-sessions\/([^/]+)\/disconnect$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const targetSessionId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "").trim();
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!targetSessionId) {
      res.status(400).json({ error: "agent_session_id is required" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) return;

    const body = req.body as {
      agent_session_id?: string;
      agent_session_token?: string;
    };
    const hasSelfCredentials =
      typeof body.agent_session_id === "string" || typeof body.agent_session_token === "string";
    let ownerAccountScope: string | null = null;

    if (hasSelfCredentials) {
      const agentSessionIdentity = await requireWorkerRequestAgentIdentity({
        req,
        body,
        room_id: project.id,
      });
      if (!agentSessionIdentity.ok) {
        res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
        return;
      }
      if (agentSessionIdentity.identity.agent_session_id !== targetSessionId) {
        res.status(403).json({ error: "Worker sessions can only disconnect themselves." });
        return;
      }
      ownerAccountScope = req.sessionAccount?.account_id ?? null;
    } else if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    try {
      const endedSession = await endRoomAgentSession({
        session_id: targetSessionId,
        room_id: project.id,
        owner_account_id: ownerAccountScope,
      });
      if (!endedSession) {
        res.status(404).json({ error: "Agent session not found" });
        return;
      }

      const deliverySession = await disconnectRoomAgentDeliverySession({
        room_id: project.id,
        agent_session_id: targetSessionId,
      });

      res.json({
        room_id: project.id,
        agent_session: endedSession,
        delivery_session: deliverySession,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "POST /rooms/:room_id/agent-sessions/:agent_session_id/disconnect",
        error,
        "Agent session could not be disconnected."
      );
    }
  });

  app.post(/^\/rooms\/(.+)\/presence$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const { status, status_text, agent_session_id, agent_session_token } = req.body as {
      status?: string;
      status_text?: string | null;
      agent_session_id?: string;
      agent_session_token?: string;
    };

    const agentSessionIdentity = await requireWorkerRequestAgentIdentity({
      req,
      body: { agent_session_id, agent_session_token },
      room_id: project.id,
    });
    if (!agentSessionIdentity.ok) {
      res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
      return;
    }

    const actorLabel = agentSessionIdentity.identity.actor_label;
    const displayName = agentSessionIdentity.identity.display_name;
    const agentKey = agentSessionIdentity.identity.agent_key;
    const ownerLabel = agentSessionIdentity.identity.owner_label;
    const ideLabel = agentSessionIdentity.identity.ide_label;
    const statusText = typeof status_text === "string" ? status_text.trim() || null : null;
    const normalizedStatus = normalizeAgentPresenceStatus(status);

    if (!actorLabel || !displayName || !normalizedStatus) {
      res.status(400).json({
        error: "actor_label, display_name, and a valid status are required",
      });
      return;
    }

    try {
      const presence = await upsertRoomAgentPresence({
        room_id: project.id,
        actor_label: actorLabel,
        agent_key: agentKey,
        agent_session_id: agentSessionIdentity.identity.agent_session_id,
        session_kind: agentSessionIdentity.identity.session_kind,
        runtime: agentSessionIdentity.identity.runtime,
        display_name: displayName,
        owner_label: ownerLabel,
        ide_label: ideLabel,
        status: normalizedStatus as AgentPresenceStatus,
        status_text: statusText,
      });
      await deps.rememberAgentRoomParticipant({
        projectId: project.id,
        actorLabel: presence.actor_label,
        agentKey: presence.agent_key,
        displayName: presence.display_name,
        ownerLabel: presence.owner_label,
        ideLabel: presence.ide_label,
        lastSeenAt: presence.last_heartbeat_at,
        preserveLastSeenAtOnConflict: true,
      });

      await deps.maybeEmitStaleWorkPrompt(project.id);

      res.status(200).json({
        ...toPublicRoomAgentPresence(presence),
      });
    } catch (error) {
      console.error(
        `[presence] failed to persist room presence for ${project.id}; returning a synthetic presence response`,
        error
      );

      const presence = buildSyntheticPresenceEntry({
        roomId: project.id,
        actorLabel,
        agentKey,
        displayName,
        ownerLabel,
        ideLabel,
        status: normalizedStatus as AgentPresenceStatus,
        statusText,
      });

      res.status(200).json({
        ...toPublicRoomAgentPresence(presence),
        fallback: "synthetic_response",
      });
    }
  });
}
