import type { Response } from "express";

import type { Message, Project } from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { RoomRequestResolver } from "../../../rooms/request-room.js";

export interface RoomPresenceRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  /** Both room resolvers in one statement where it can; see `resolveRoomRequest`. */
  resolveRoomRequestOrReply: RoomRequestResolver;
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
  emitProjectMessage(
    projectId: string,
    sender: string,
    text: string,
    options?: { source?: string; client_message_id?: string | null },
  ): Promise<Message>;
}
