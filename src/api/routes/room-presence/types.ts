import type { Response } from "express";

import type { Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http-helpers.js";

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
