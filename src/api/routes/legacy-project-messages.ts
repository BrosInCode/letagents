import type { EventEmitter } from "events";
import type { Express, Request, Response } from "express";

import {
  getMessages,
  getMessagesAfter,
  getProjectById,
  type Message,
  type Project,
} from "../db.js";
import {
  parseLimit,
  parsePollTimeout,
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../http-helpers.js";
import { normalizeRoomId } from "../room-routing.js";
import { startSseStream, stopSseStream } from "../sse.js";
import {
  isPromptOnlyAgentMessage,
  type AgentPromptKind,
} from "../../shared/room-agent-prompts.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

export interface LegacyProjectMessageRouteDeps {
  messageEvents: EventEmitter;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  parseOptionalAgentPromptKind(value: unknown): AgentPromptKind | null;
  parseOptionalReplyToMessageId(value: unknown): string | null;
  shouldIncludePromptOnlyMessages(req: Request): boolean;
  emitProjectMessage(
    projectId: string,
    sender: string,
    text: string,
    options?: {
      source?: string;
      agent_prompt_kind?: AgentPromptKind | null;
      reply_to?: string | null;
    }
  ): Promise<Message>;
  rememberRoomParticipantFromMessage(input: {
    projectId: string;
    sender: string;
    source?: string | null;
    sessionAccount?: AuthenticatedRequest["sessionAccount"];
    timestamp?: string;
  }): Promise<void>;
}

export function registerLegacyProjectMessageRoutes(
  app: Express,
  deps: LegacyProjectMessageRouteDeps
): void {
  app.post("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const { sender, text, agent_prompt_kind, reply_to } = req.body as {
      sender?: string;
      text?: string;
      agent_prompt_kind?: string;
      reply_to?: string;
    };

    try {
      const promptKind = deps.parseOptionalAgentPromptKind(agent_prompt_kind);
      const replyToMessageId = deps.parseOptionalReplyToMessageId(reply_to);
      const normalizedSender = typeof sender === "string" ? sender.trim() : "";
      if (
        !normalizedSender ||
        typeof text !== "string" ||
        (!text.trim() && (!promptKind || promptKind !== "auto"))
      ) {
        res.status(400).json({ error: "sender and text are required" });
        return;
      }
      const source = req.authKind === "session" ? "browser" : req.authKind === "owner_token" ? "agent" : undefined;
      const message = await deps.emitProjectMessage(projectId, normalizedSender, text, {
        source,
        agent_prompt_kind: promptKind,
        reply_to: replyToMessageId,
      });
      await deps.rememberRoomParticipantFromMessage({
        projectId,
        sender: normalizedSender,
        source,
        sessionAccount: req.sessionAccount,
        timestamp: message.timestamp,
      });
      res.status(201).json(message);
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /projects/:id/messages",
        error,
        "Message could not be created."
      );
    }
  });

  app.get("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const result = await getMessages(projectId, {
      limit,
      after,
      include_prompt_only: deps.shouldIncludePromptOnlyMessages(req),
    });

    res.json({
      project_id: projectId,
      messages: result.messages,
      has_more: result.has_more,
    });
  });

  app.get("/projects/:id/messages/stream", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const heartbeat = startSseStream(res);

    const onMessageCreated = ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
      if (eventProjectId !== projectId) {
        return;
      }
      if (!deps.shouldIncludePromptOnlyMessages(req) && isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) {
        return;
      }

      res.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    deps.messageEvents.on("message:created", onMessageCreated);

    req.on("close", () => {
      deps.messageEvents.off("message:created", onMessageCreated);
      stopSseStream(res, heartbeat);
    });
  });

  app.get("/projects/:id/messages/poll", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    const existing = await getMessagesAfter(projectId, after, {
      limit,
      include_prompt_only: includePromptOnly,
    });

    if (existing.messages.length > 0) {
      res.json({ project_id: projectId, messages: existing.messages, has_more: existing.has_more });
      return;
    }

    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      deps.messageEvents.off("message:created", onMessageCreated);
      req.off("close", onClientClose);
    };

    const resolveRequest = (msgs: Message[], hasMore = false) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      res.json({ project_id: projectId, messages: msgs, has_more: hasMore });
    };

    const onMessageCreated = async ({ projectId: eventProjectId }: MessageCreatedEvent) => {
      if (eventProjectId !== projectId) {
        return;
      }

      const next = await getMessagesAfter(projectId, after, {
        limit,
        include_prompt_only: includePromptOnly,
      });
      if (next.messages.length > 0) {
        resolveRequest(next.messages, next.has_more);
      }
    };

    const onClientClose = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
    };

    const timeout = setTimeout(() => {
      resolveRequest([]);
    }, timeoutMs);

    deps.messageEvents.on("message:created", onMessageCreated);
    req.on("close", onClientClose);
  });
}
