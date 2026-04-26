import type { EventEmitter } from "events";
import type { Express, Request, Response } from "express";

import {
  getLatestMessages,
  getMessageAttachment,
  getMessages,
  getMessagesAfter,
  getMessagesBefore,
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
import { requireWorkerRequestAgentIdentity } from "../request-agent-identity.js";
import {
  beginRoomAgentDelivery,
  InvalidRoomAgentDeliverySessionError,
} from "../room-agent-delivery.js";
import { normalizeRoomId } from "../room-routing.js";
import { startSseStream, stopSseStream } from "../sse.js";
import {
  isPromptOnlyAgentMessage,
  type AgentPromptKind,
} from "../../shared/room-agent-prompts.js";
import { parseAgentActorLabel } from "../../shared/agent-identity.js";
import {
  normalizeMessageAttachmentReferences,
  type NormalizedMessageAttachmentReference,
} from "../message-attachments.js";
import {
  createPresignedAttachmentDownload,
  isAttachmentStorageConfigured,
} from "../attachment-storage.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

function hasAgentSessionCredentials(input: {
  agent_session_id?: string;
  agent_session_token?: string;
}): boolean {
  return Boolean(
    (typeof input.agent_session_id === "string" && input.agent_session_id.trim())
      || (typeof input.agent_session_token === "string" && input.agent_session_token.trim())
  );
}

function isAgentLikeSender(sender: unknown): boolean {
  if (typeof sender !== "string") {
    return false;
  }

  const parsed = parseAgentActorLabel(sender);
  return Boolean(parsed && (parsed.structured || parsed.owner_attribution || parsed.ide_label));
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
      attachments?: NormalizedMessageAttachmentReference[];
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

    const {
      sender,
      text,
      agent_prompt_kind,
      reply_to,
      attachments: rawAttachments,
      agent_session_id,
      agent_session_token,
    } = req.body as {
      sender?: string;
      text?: string;
      agent_prompt_kind?: string;
      reply_to?: string;
      attachments?: unknown;
      agent_session_id?: string;
      agent_session_token?: string;
    };

    try {
      const requiresWorkerSession = req.authKind === "owner_token"
        || hasAgentSessionCredentials({ agent_session_id, agent_session_token })
        || isAgentLikeSender(sender);
      const workerIdentity = requiresWorkerSession
        ? await requireWorkerRequestAgentIdentity({
          req,
          body: { agent_session_id, agent_session_token },
          room_id: projectId,
        })
        : null;
      if (workerIdentity && !workerIdentity.ok) {
        res.status(workerIdentity.status).json({ error: workerIdentity.error });
        return;
      }

      const promptKind = deps.parseOptionalAgentPromptKind(agent_prompt_kind);
      const replyToMessageId = deps.parseOptionalReplyToMessageId(reply_to);
      const attachments = normalizeMessageAttachmentReferences(rawAttachments);
      const normalizedSender = workerIdentity?.ok
        ? workerIdentity.identity.actor_label
        : typeof sender === "string" ? sender.trim() : "";
      if (
        !normalizedSender ||
        typeof text !== "string" ||
        (!text.trim() && attachments.length === 0 && (!promptKind || promptKind !== "auto"))
      ) {
        res.status(400).json({ error: "sender and text or attachments are required" });
        return;
      }
      if (promptKind === "auto" && attachments.length > 0) {
        res.status(400).json({ error: "auto prompt messages cannot include attachments" });
        return;
      }
      const source = workerIdentity?.ok ? "agent" : req.authKind === "session" ? "browser" : undefined;
      const message = await deps.emitProjectMessage(projectId, normalizedSender, text, {
        source,
        agent_prompt_kind: promptKind,
        reply_to: replyToMessageId,
        attachments,
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

  app.get("/projects/:id/messages/:messageId/attachments/:attachmentId", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await getProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }

    const attachment = await getMessageAttachment(
      projectId,
      String(req.params.messageId),
      String(req.params.attachmentId)
    );
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found", code: "ATTACHMENT_NOT_FOUND" });
      return;
    }

    if (!isAttachmentStorageConfigured()) {
      res.status(503).json({ error: "Attachment object storage is not configured" });
      return;
    }

    res.redirect(302, createPresignedAttachmentDownload(attachment));
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
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    const result = before === "latest"
      ? await getLatestMessages(projectId, { limit, include_prompt_only: includePromptOnly })
      : before
        ? await getMessagesBefore(projectId, before, { limit, include_prompt_only: includePromptOnly })
        : await getMessages(projectId, {
          limit,
          after,
          include_prompt_only: includePromptOnly,
        });

    res.json({
      project_id: projectId,
      messages: result.messages,
      has_more: result.has_more,
      has_older: before ? result.has_more : undefined,
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

    let endDelivery: (() => Promise<void>) | null = null;
    try {
      endDelivery = await beginRoomAgentDelivery({
        req,
        roomId: project.id,
        transport: "sse",
        onSessionDisconnected: () => {
          res.write(`event: session_disconnect\ndata: ${JSON.stringify({ project_id: projectId })}\n\n`);
          res.end();
        },
      });
    } catch (error) {
      if (error instanceof InvalidRoomAgentDeliverySessionError) {
        res.status(401).json({ error: error.message });
        return;
      }
      throw error;
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
      if (endDelivery) {
        void endDelivery().catch((error: unknown) => {
          console.error(`[legacy messages stream] failed to end agent delivery for ${project.id}`, error);
        });
      }
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
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let endDelivery: (() => Promise<void>) | null = null;
    try {
      endDelivery = await beginRoomAgentDelivery({
        req,
        roomId: project.id,
        transport: "long_poll",
        onSessionDisconnected: () => resolveRequest([]),
      });
    } catch (error) {
      if (error instanceof InvalidRoomAgentDeliverySessionError) {
        res.status(401).json({ error: error.message });
        return;
      }
      throw error;
    }
    const existing = await getMessagesAfter(projectId, after, {
      limit,
      include_prompt_only: includePromptOnly,
    });

    if (settled) {
      return;
    }

    if (existing.messages.length > 0) {
      await endDelivery?.().catch((error: unknown) => {
        console.error(`[legacy messages poll] failed to end agent delivery for ${project.id}`, error);
      });
      res.json({ project_id: projectId, messages: existing.messages, has_more: existing.has_more });
      return;
    }

    function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      deps.messageEvents.off("message:created", onMessageCreated);
      req.off("close", onClientClose);
      if (endDelivery) {
        void endDelivery().catch((error: unknown) => {
          console.error(`[legacy messages poll] failed to end agent delivery for ${projectId}`, error);
        });
      }
    }

    function resolveRequest(msgs: Message[], hasMore = false) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      res.json({ project_id: projectId, messages: msgs, has_more: hasMore });
    }

    async function onMessageCreated({ projectId: eventProjectId }: MessageCreatedEvent) {
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
    }

    function onClientClose() {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
    }

    timeout = setTimeout(() => {
      resolveRequest([]);
    }, timeoutMs);

    deps.messageEvents.on("message:created", onMessageCreated);
    req.on("close", onClientClose);
  });
}
