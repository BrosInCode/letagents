import type { Express, Response } from "express";
import {
  DEFAULT_ROOM_AGENT_REPLY_ORDER,
  GITHUB_ROOM_CHAT_EVENT_KINDS,
  ROOM_AGENT_GUIDELINES_MAX_BYTES,
  ROOM_AGENT_REPLY_ORDERS,
  ROOM_AGENT_GUIDELINES_NOTE,
  ROOM_AGENT_GUIDELINES_TOKEN_BUDGET,
  normalizeGitHubRoomChatEventKinds,
  normalizeRoomAgentGuidelines,
  normalizeRoomAgentReplyOrder,
  roomAgentGuidelinesBytes,
  type GitHubRoomChatEventFilter,
  type RoomAgentGuidelines,
  type RoomAgentReplyOrderSetting,
} from "../../../../shared/room-settings.mjs";
import type { Project } from "../../db.js";
import * as store from "../../db/room-settings.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { isHumanAppWrite } from "../../request/app-session.js";
import { resolveProjectRepoAccessTarget } from "../../rooms/access.js";
import { emitProjectMessage } from "../../server/events.js";
import type { RoomMetadataRouteDeps } from "./metadata.js";
import { resolveParticipantRoom } from "./messages/helpers.js";
import type { RoomMessageRouteDeps } from "./messages/types.js";

/**
 * A focus room follows its parent and a branch room follows its repository
 * room, for guidelines and for GitHub event kinds alike, until an admin
 * chooses for that room itself.
 */
export type RoomSettingsRouteDeps =
  Pick<RoomMetadataRouteDeps, "resolveCanonicalRoomRequestId" | "resolveRoomOrReply" | "requireAdmin" | "resolveProjectRole">
  & Pick<RoomMessageRouteDeps, "requireParticipant">
  & {
    store?: typeof store;
    emitMessage?: typeof emitProjectMessage;
    resolveInheritedRoomIds?: typeof resolveInheritedGitHubFilterRoomIds;
  };

export async function resolveInheritedGitHubFilterRoomIds(project: Project): Promise<string[]> {
  const inherited = project.parent_room_id ? [project.parent_room_id] : [];
  const target = await resolveProjectRepoAccessTarget(project);
  if (target?.repoRoomName) inherited.push(target.repoRoomName);
  return [...new Set(inherited)].filter((id) => id !== project.id);
}

export function registerRoomSettingsRoutes(app: Express, deps: RoomSettingsRouteDeps): void {
  const db = deps.store ?? store;
  const publish = deps.emitMessage ?? emitProjectMessage;
  const inheritedRoomIds = deps.resolveInheritedRoomIds ?? resolveInheritedGitHubFilterRoomIds;
  const room = (req: AuthenticatedRequest, res: Response) =>
    resolveParticipantRoom(req, res, deps as unknown as RoomMessageRouteDeps);
  // These settings steer every agent in the room, so an agent must not be
  // able to change them, not even with the token of an admin who owns it.
  const isPerson = (req: AuthenticatedRequest) => isHumanAppWrite(req, req.body ?? {});
  const canManage = async (req: AuthenticatedRequest, project: Project) =>
    isPerson(req) && await deps.resolveProjectRole(project, req.sessionAccount) === "admin";

  async function requirePersonWhoIsAdmin(req: AuthenticatedRequest, res: Response, project: Project): Promise<boolean> {
    if (!await deps.requireAdmin(req, res, project)) return false;
    if (isPerson(req)) return true;
    res.status(403).json({ error: "Room settings can only be changed by a person signed in to LetAgents." });
    return false;
  }

  function fail(res: Response, error: unknown): void {
    console.error("[room settings]", error);
    res.status(500).json({ error: "Room settings could not be loaded or saved. Please retry." });
  }

  async function filterResponse(req: AuthenticatedRequest, project: Project): Promise<GitHubRoomChatEventFilter> {
    const resolved = await db.resolveGitHubRoomChatEventKinds([project.id, ...await inheritedRoomIds(project)]);
    return {
      room_id: project.id,
      enabled_kinds: resolved.enabled_kinds,
      all_kinds: [...GITHUB_ROOM_CHAT_EVENT_KINDS],
      inherited_from_room_id: resolved.source_room_id === project.id ? null : resolved.source_room_id,
      can_manage: await canManage(req, project),
    };
  }

  async function guidelinesResponse(req: AuthenticatedRequest, project: Project): Promise<RoomAgentGuidelines> {
    const stored = await db.resolveRoomAgentGuidelines([project.id, ...await inheritedRoomIds(project)]);
    return {
      room_id: project.id,
      guidelines: stored.guidelines,
      updated_by: stored.updated_by,
      updated_at: stored.updated_at,
      inherited_from_room_id: stored.source_room_id === project.id ? null : stored.source_room_id,
      max_bytes: ROOM_AGENT_GUIDELINES_MAX_BYTES,
      token_budget: ROOM_AGENT_GUIDELINES_TOKEN_BUDGET,
      note: ROOM_AGENT_GUIDELINES_NOTE,
      can_manage: await canManage(req, project),
    };
  }

  // Per room, without inheritance: the send path reads it in the message
  // transaction, where resolving parent and repository rooms is too costly.
  async function replyOrderResponse(req: AuthenticatedRequest, project: Project): Promise<RoomAgentReplyOrderSetting> {
    const chosen = await db.getRoomAgentReplyOrder(project.id);
    return {
      room_id: project.id,
      order: chosen ?? DEFAULT_ROOM_AGENT_REPLY_ORDER,
      chosen: chosen !== null,
      can_manage: await canManage(req, project),
    };
  }

  app.get(/^\/rooms\/(.+)\/agent-reply-order$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      res.json(await replyOrderResponse(req, project));
    } catch (error) { fail(res, error); }
  });

  app.put(/^\/rooms\/(.+)\/agent-reply-order$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      if (!await requirePersonWhoIsAdmin(req, res, project)) return;
      // null resets the room to the default.
      const order = req.body?.order === null ? null : normalizeRoomAgentReplyOrder(req.body?.order);
      if (order === null && req.body?.order !== null) {
        res.status(400).json({ error: `order must be one of: ${ROOM_AGENT_REPLY_ORDERS.join(", ")}, or null for the default` });
        return;
      }
      await db.setRoomAgentReplyOrder(project.id, order);
      res.json(await replyOrderResponse(req, project));
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/github-event-filter$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      res.json(await filterResponse(req, project));
    } catch (error) { fail(res, error); }
  });

  app.put(/^\/rooms\/(.+)\/github-event-filter$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      if (!await requirePersonWhoIsAdmin(req, res, project)) return;
      const kinds = normalizeGitHubRoomChatEventKinds(req.body?.enabled_kinds);
      if (!kinds) {
        res.status(400).json({ error: `enabled_kinds must be a list of: ${GITHUB_ROOM_CHAT_EVENT_KINDS.join(", ")}` });
        return;
      }
      await db.setGitHubRoomChatEventKinds(project.id, kinds);
      res.json(await filterResponse(req, project));
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/agent-guidelines$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      res.json(await guidelinesResponse(req, project));
    } catch (error) { fail(res, error); }
  });

  app.put(/^\/rooms\/(.+)\/agent-guidelines$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await room(req, res); if (!project) return;
      if (!await requirePersonWhoIsAdmin(req, res, project)) return;
      if (typeof req.body?.guidelines !== "string") {
        res.status(400).json({ error: "guidelines must be text. Send an empty string to clear them." });
        return;
      }
      const guidelines = normalizeRoomAgentGuidelines(req.body.guidelines);
      const bytes = roomAgentGuidelinesBytes(guidelines);
      if (bytes > ROOM_AGENT_GUIDELINES_MAX_BYTES) {
        // Every agent in the room reads this text, so the limit is never waived.
        res.status(413).json({
          error: `Guidelines are ${bytes} bytes. The limit is ${ROOM_AGENT_GUIDELINES_MAX_BYTES} (about ${ROOM_AGENT_GUIDELINES_TOKEN_BUDGET} tokens). Shorten them, or link to longer documents.`,
          bytes,
          max_bytes: ROOM_AGENT_GUIDELINES_MAX_BYTES,
        });
        return;
      }
      const previous = await db.getRoomAgentGuidelines(project.id);
      if ((previous.guidelines ?? "") === guidelines) {
        res.json(await guidelinesResponse(req, project));
        return;
      }
      const login = req.sessionAccount?.login ?? "a room admin";
      await db.setRoomAgentGuidelines(project.id, guidelines, login);
      // Agents read guidelines when they start work; this tells the ones already working.
      await publish(
        project.id,
        "letagents",
        guidelines
          ? `Room guidelines were updated by ${login}. Agents: read get_room_guidelines before your next task.`
          : `Room guidelines were cleared by ${login}.`,
        { source: "room_settings" },
      ).catch((error) => console.error("[room settings] guidelines announcement failed", error));
      res.json(await guidelinesResponse(req, project));
    } catch (error) { fail(res, error); }
  });
}
