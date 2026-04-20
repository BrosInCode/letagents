import type { EventEmitter } from "events";
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";

import {
  createMessageAttachmentUpload,
  getLatestMessages,
  getMessageAttachment,
  getMessages,
  getMessagesAfter,
  getMessagesBefore,
  type Message,
  type Project,
  type Task,
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
import {
  normalizeAttachmentUploadRequest,
  normalizeMessageAttachmentReferences,
  type NormalizedMessageAttachmentReference,
} from "../message-attachments.js";
import {
  createAttachmentObjectKey,
  createPresignedAttachmentDownload,
  createPresignedAttachmentUpload,
  isAttachmentStorageConfigured,
} from "../attachment-storage.js";

interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

interface TaskUpdatedEvent {
  projectId: string;
  task: Task;
}

export interface RoomMessageRouteDeps {
  messageEvents: EventEmitter;
  taskEvents: EventEmitter;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
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

export function registerRoomMessageRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.post(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const { sender, text, agent_prompt_kind, reply_to, attachments: rawAttachments } = req.body as {
      sender?: string;
      text?: string;
      agent_prompt_kind?: string;
      reply_to?: string;
      attachments?: unknown;
    };
    try {
      const promptKind = deps.parseOptionalAgentPromptKind(agent_prompt_kind);
      const replyToMessageId = deps.parseOptionalReplyToMessageId(reply_to);
      const attachments = normalizeMessageAttachmentReferences(rawAttachments);
      const normalizedSender = typeof sender === "string" ? sender.trim() : "";
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
      const source = req.authKind === "session" ? "browser" : req.authKind === "owner_token" ? "agent" : undefined;
      const message = await deps.emitProjectMessage(project.id, normalizedSender, text, {
        source,
        agent_prompt_kind: promptKind,
        reply_to: replyToMessageId,
        attachments,
      });
      await deps.rememberRoomParticipantFromMessage({
        projectId: project.id,
        sender: normalizedSender,
        source,
        sessionAccount: req.sessionAccount,
        timestamp: message.timestamp,
      });
      res.status(201).json({
        ...message,
        room_id: project.id,
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/messages",
        error,
        "Message could not be created."
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/messages\/([^/]+)\/attachments\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const messageId = decodeURIComponent((req.params as Record<string, string>)[1] ?? "");
    const attachmentId = decodeURIComponent((req.params as Record<string, string>)[2] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const attachment = await getMessageAttachment(project.id, messageId, attachmentId);
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

  app.post(/^\/rooms\/(.+)\/attachments\/uploads$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    if (!isAttachmentStorageConfigured()) {
      res.status(503).json({ error: "Attachment object storage is not configured" });
      return;
    }

    try {
      const attachment = normalizeAttachmentUploadRequest(req.body);
      const uploadId = `upl_${crypto.randomUUID().replace(/-/g, "")}`;
      const objectKey = createAttachmentObjectKey({
        roomId: project.id,
        uploadId,
        filename: attachment.filename,
      });
      const presigned = createPresignedAttachmentUpload({
        object_key: objectKey,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
      });
      const upload = await createMessageAttachmentUpload({
        upload_id: uploadId,
        room_id: project.id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        byte_size: attachment.byte_size,
        storage_provider: presigned.storage_provider,
        bucket: presigned.bucket,
        object_key: objectKey,
        expires_at: presigned.expires_at,
      });

      res.status(201).json({
        room_id: project.id,
        upload_id: upload.upload_id,
        upload_url: presigned.upload_url,
        method: "PUT",
        headers: presigned.headers,
        expires_at: upload.expires_at,
        attachment: {
          filename: upload.filename,
          file_name: upload.filename,
          content_type: upload.content_type,
          mime_type: upload.content_type,
          byte_size: upload.byte_size,
          size_bytes: upload.byte_size,
        },
      });
    } catch (error) {
      respondWithBadRequest(
        res,
        "POST /rooms/:room_id/attachments/uploads",
        error,
        "Attachment upload could not be staged."
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    const result = before === "latest"
      ? await getLatestMessages(project.id, { limit, include_prompt_only: includePromptOnly })
      : before
        ? await getMessagesBefore(project.id, before, { limit, include_prompt_only: includePromptOnly })
        : await getMessages(project.id, {
          limit,
          after,
          include_prompt_only: includePromptOnly,
        });

    res.json({
      room_id: project.id,
      messages: result.messages,
      has_more: result.has_more,
      has_older: before ? result.has_more : undefined,
    });
  });

  app.get(/^\/rooms\/(.+)\/messages\/poll$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const projectId = project.id;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    const existing = await getMessagesAfter(projectId, after, {
      limit,
      include_prompt_only: includePromptOnly,
    });

    if (existing.messages.length > 0) {
      res.json({ room_id: project.id, messages: existing.messages, has_more: existing.has_more });
      return;
    }

    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      deps.messageEvents.off("message:created", onMessageCreated);
      req.off("close", onClientClose);
    };

    const resolveRequest = (msgs: Message[], hasMore = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      res.json({ room_id: project.id, messages: msgs, has_more: hasMore });
    };

    const onMessageCreated = async ({ projectId: eventProjectId }: MessageCreatedEvent) => {
      if (eventProjectId !== projectId) return;
      const next = await getMessagesAfter(projectId, after, {
        limit,
        include_prompt_only: includePromptOnly,
      });
      if (next.messages.length > 0) resolveRequest(next.messages, next.has_more);
    };

    const onClientClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    const timeout = setTimeout(() => resolveRequest([]), timeoutMs);
    deps.messageEvents.on("message:created", onMessageCreated);
    req.on("close", onClientClose);
  });

  app.get(/^\/rooms\/(.+)\/messages\/stream$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));

    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    if (!(await deps.requireParticipant(req, res, project))) return;

    const projectId = project.id;

    const heartbeat = startSseStream(res);

    const onMessageCreated = ({ projectId: eventProjectId, message }: MessageCreatedEvent) => {
      if (eventProjectId !== projectId) return;
      if (!deps.shouldIncludePromptOnlyMessages(req) && isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) {
        return;
      }
      res.write(`data: ${JSON.stringify({ ...message, room_id: project.id })}\n\n`);
    };

    const onTaskUpdated = (event: TaskUpdatedEvent) => {
      if (event.projectId !== projectId) return;
      res.write(`event: task_update\ndata: ${JSON.stringify({ ...event.task, room_id: project.id })}\n\n`);
    };

    deps.messageEvents.on("message:created", onMessageCreated);
    deps.taskEvents.on("task:updated", onTaskUpdated);

    req.on("close", () => {
      deps.messageEvents.off("message:created", onMessageCreated);
      deps.taskEvents.off("task:updated", onTaskUpdated);
      stopSseStream(res, heartbeat);
    });
  });
}
