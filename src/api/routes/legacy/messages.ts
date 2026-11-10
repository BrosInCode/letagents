// Legacy `/projects/:id/messages*` routes. Each route resolves the legacy
// room id in the legacy way (room id, join code or alias; 404 "Project not
// found"), then calls the same handler as the room route and maps the
// response back to the legacy shape (see message-shapes.ts). There is one
// implementation of list, send, long-poll and stream.

import type { Express, Response } from "express";

import { getProjectById, type Project } from "../../db.js";
import { parseLimit, type AuthenticatedRequest } from "../../http/helpers.js";
import { parseOptionalThreadRootMessageId } from "../../messages/inputs.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { redirectToMessageAttachment } from "../rooms/messages/attachments.js";
import { createRoomMessage } from "../rooms/messages/create-message.js";
import { listRoomMessages, pollRoomMessages } from "../rooms/messages/history.js";
import { streamRoomMessages } from "../rooms/messages/stream.js";
import type { RoomMessageHandlerDeps } from "../rooms/messages/types.js";
import {
  LEGACY_PROJECT_STREAM_FRAMES,
  toLegacyCreatedMessageBody,
  toLegacyMessagePage,
  toLegacyPollBody,
} from "./message-shapes.js";

export interface LegacyProjectMessageRouteDeps
  extends Omit<RoomMessageHandlerDeps, "parseOptionalThreadRootMessageId"> {
  parseOptionalThreadRootMessageId?(value: unknown): string | null;
  getProjectById?(projectId: string): Promise<Project | null | undefined>;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
}

export function registerLegacyProjectMessageRoutes(
  app: Express,
  deps: LegacyProjectMessageRouteDeps
): void {
  const loadProjectById = deps.getProjectById ?? getProjectById;
  const handlerDeps: RoomMessageHandlerDeps = {
    ...deps,
    parseOptionalThreadRootMessageId: deps.parseOptionalThreadRootMessageId ?? parseOptionalThreadRootMessageId,
  };

  async function resolveLegacyProject(req: AuthenticatedRequest, res: Response): Promise<Project | null> {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await loadProjectById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }
    if (!(await deps.requireParticipant(req, res, project))) return null;
    return project;
  }

  app.post("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
    const project = await resolveLegacyProject(req, res);
    if (!project) return;
    await createRoomMessage({
      req,
      res,
      project,
      deps: handlerDeps,
      renderBody: toLegacyCreatedMessageBody,
      route: "POST /projects/:id/messages",
    });
  });

  app.get("/projects/:id/messages/:messageId/attachments/:attachmentId", async (req: AuthenticatedRequest, res) => {
    const project = await resolveLegacyProject(req, res);
    if (!project) return;
    await redirectToMessageAttachment(res, project.id, String(req.params.messageId), String(req.params.attachmentId));
  });

  app.get("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
    const project = await resolveLegacyProject(req, res);
    if (!project) return;
    // The legacy list never validated its cursors and has no account view or
    // context read: a malformed cursor reads as no cursor, `before` wins.
    const result = await listRoomMessages(req, project, {
      after: typeof req.query.after === "string" ? req.query.after : undefined,
      before: typeof req.query.before === "string" ? req.query.before : undefined,
      limit: parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined),
      includePromptOnly: deps.shouldIncludePromptOnlyMessages(req),
      accountId: null,
      accountAgentRouting: false,
      contextOnly: false,
    });
    if (result.kind !== "page") throw new Error("a legacy history read is always a page");
    res.json(toLegacyMessagePage(project.id, result));
  });

  app.get("/projects/:id/messages/stream", async (req: AuthenticatedRequest, res) => {
    const project = await resolveLegacyProject(req, res);
    if (!project) return;
    await streamRoomMessages({
      req,
      res,
      project,
      deps: handlerDeps,
      // Legacy clients read every unnamed frame as a message: send only messages.
      messageOnly: true,
      frames: LEGACY_PROJECT_STREAM_FRAMES,
      logLabel: "legacy room messages stream",
    });
  });

  app.get("/projects/:id/messages/poll", async (req: AuthenticatedRequest, res) => {
    const project = await resolveLegacyProject(req, res);
    if (!project) return;
    await pollRoomMessages({
      req,
      res,
      project,
      deps: handlerDeps,
      renderBody: toLegacyPollBody,
      logLabel: "legacy messages poll",
      route: "GET /projects/:id/messages/poll",
    });
  });
}
