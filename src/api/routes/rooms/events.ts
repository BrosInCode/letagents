import type { Express, Response } from "express";

import {
  getGitHubRoomEvents,
  type GitHubRoomEvent,
  type GitHubRoomEventMetadata,
  type Project,
} from "../../db.js";
import {
  parseLimit,
  type AuthenticatedRequest,
} from "../../http/helpers.js";
import { isGeneratedGitRefFocusRoom } from "../../github/git-room-lifecycle.js";
import { getFocusRoomSettings } from "../../rooms/formatting.js";
import { normalizeRoomId } from "../../rooms/routing.js";

export interface RoomEventRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  getProjectAccessRoomId(project: Project): string;
}

export function getGitHubEventLaneRoomId(project: Project, accessRoomId: string): string {
  if (isGeneratedGitRefFocusRoom(project)) {
    return project.id;
  }

  if (
    project.kind === "focus" &&
    getFocusRoomSettings(project).github_event_routing === "focus_owned_only"
  ) {
    return project.id;
  }

  return accessRoomId;
}

export function redactGitHubEventMetadata(
  event: GitHubRoomEvent
): GitHubRoomEventMetadata | null {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }

  if (!Object.prototype.hasOwnProperty.call(metadata, "body")) {
    return metadata;
  }

  return {
    ...metadata,
    body: null,
    body_redacted: true,
  };
}

export function toPublicGitHubRoomEvent(event: GitHubRoomEvent): Record<string, unknown> {
  return {
    id: event.id,
    event_type: event.event_type,
    action: event.action,
    semantic_id: event.semantic_id,
    github_object_id: event.github_object_id,
    github_object_url: event.github_object_url,
    title: event.title,
    state: event.state,
    actor_login: event.actor_login,
    provider_event_at: event.provider_event_at,
    provider_object_updated_at: event.provider_object_updated_at,
    event_order_at: event.event_order_at,
    ref: event.ref,
    base_ref: event.base_ref,
    head_ref: event.head_ref,
    head_sha: event.head_sha,
    metadata: redactGitHubEventMetadata(event),
    linked_task_id: event.linked_task_id,
    created_at: event.created_at,
  };
}

export function registerRoomEventRoutes(
  app: Express,
  deps: RoomEventRouteDeps
): void {
  app.get(/^(?:\/api)?\/rooms\/(.+)\/events$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const event_type = typeof req.query.event_type === "string" ? req.query.event_type : undefined;
    const github_object_id = typeof req.query.object_id === "string" ? req.query.object_id : undefined;
    const actor_login = typeof req.query.actor === "string" ? req.query.actor : undefined;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const until = typeof req.query.until === "string" ? req.query.until : undefined;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);

    const githubRoomId = getGitHubEventLaneRoomId(project, deps.getProjectAccessRoomId(project));
    const result = await getGitHubRoomEvents({
      room_id: githubRoomId,
      event_type,
      github_object_id,
      actor_login,
      since,
      until,
      after,
      limit,
    });

    res.json({
      room_id: project.id,
      github_room_id: githubRoomId,
      events: result.events.map(toPublicGitHubRoomEvent),
      has_more: result.has_more,
    });
  });
}
