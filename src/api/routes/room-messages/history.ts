import type { Express } from "express";

import {
  getLatestMessages,
  getMessages,
  getMessagesAfter,
  getMessagesBefore,
  type Message,
} from "../../db.js";
import {
  parseLimit,
  parsePollTimeout,
  type AuthenticatedRequest,
} from "../../http-helpers.js";
import {
  beginRoomAgentDelivery,
  InvalidRoomAgentDeliverySessionError,
} from "../../room-agent-delivery.js";
import { isDesktopHumanClient } from "./request-identity.js";
import { resolveParticipantRoom } from "./helpers.js";
import type {
  MessageCreatedEvent,
  RoomMessageRouteDeps,
} from "./types.js";

export function registerMessageHistoryRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

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
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const projectId = project.id;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let endDelivery: (() => Promise<void>) | null = null;
    if (!isDesktopHumanClient(req)) {
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
        console.error(`[room messages poll] failed to end agent delivery for ${project.id}`, error);
      });
      res.json({ room_id: project.id, messages: existing.messages, has_more: existing.has_more });
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
          console.error(`[room messages poll] failed to end agent delivery for ${projectId}`, error);
        });
      }
    }

    function resolveRequest(msgs: Message[], hasMore = false) {
      if (settled) return;
      settled = true;
      cleanup();
      res.json({ room_id: projectId, messages: msgs, has_more: hasMore });
    }

    async function onMessageCreated({ projectId: eventProjectId }: MessageCreatedEvent) {
      if (eventProjectId !== projectId) return;
      const next = await getMessagesAfter(projectId, after, {
        limit,
        include_prompt_only: includePromptOnly,
      });
      if (next.messages.length > 0) resolveRequest(next.messages, next.has_more);
    }

    function onClientClose() {
      if (settled) return;
      settled = true;
      cleanup();
    }

    timeout = setTimeout(() => resolveRequest([]), timeoutMs);
    deps.messageEvents.on("message:created", onMessageCreated);
    req.on("close", onClientClose);
  });
}
