import type { Express } from "express";

import {
  getLatestMessages,
  getMessageById,
  getMessageThread,
  getMessageThreads,
  getMessages,
  getMessagesAfter,
  getMessagesBefore,
  markMessageThreadRead,
  type Message,
} from "../../../db.js";
import {
  parseLimit,
  parsePollTimeout,
  respondWithInternalError,
  respondWithValidationOrInternalError,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import {
  beginRoomAgentDelivery,
  InvalidRoomAgentDeliverySessionError,
} from "../../../rooms/agent-delivery.js";
import { resolveMessageActivationIdentity } from "./activation-identity.js";
import { isDesktopHumanClient } from "./request-identity.js";
import { attachReceiptAuthorityActivations } from "./receipt-activation.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import type {
  MessageCreatedEvent,
  RoomMessageRouteDeps,
} from "./types.js";

export function registerMessageHistoryRoutes(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.get(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await resolveParticipantRoom(req, res, deps);
      if (!project) return;

      const after = typeof req.query.after === "string" ? req.query.after : undefined;
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);

      if (after && before) {
        res.status(400).json({ error: "Cannot specify both 'after' and 'before' query parameters." });
        return;
      }
      if ((after && !isMessageId(after)) || (before && before !== "latest" && !isMessageId(before))) {
        res.status(400).json({ error: "message cursor must be a valid message id" });
        return;
      }
      const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
      const accountId = req.sessionAccount?.account_id ?? null;
      const activationIdentity = await resolveMessageActivationIdentity(req, project.id);
      const result = before === "latest"
        ? await getLatestMessages(project.id, { limit, include_prompt_only: includePromptOnly, account_id: accountId })
        : before
          ? await getMessagesBefore(project.id, before, { limit, include_prompt_only: includePromptOnly, account_id: accountId })
          : await getMessages(project.id, {
            limit,
            after,
            include_prompt_only: includePromptOnly,
            account_id: accountId,
          });

      res.json({
        room_id: project.id,
        messages: await attachReceiptAuthorityActivations(project.id, activationIdentity, result.messages, {
          includeTaskOwnerLeases: false,
        }),
        has_more: result.has_more,
        has_older: before ? result.has_more : undefined,
      });
    } catch (error) {
      respondWithInternalError(res, "GET /rooms/:room_id/messages", error, "Messages could not be fetched.");
    }
  });

  app.get(/^\/rooms\/(.+)\/messages\/(msg_\d+)$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await resolveParticipantRoom(req, res, deps);
      if (!project) return;

      const messageId = req.params[1];
      const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
      const activationIdentity = await resolveMessageActivationIdentity(req, project.id);
      const message = await getMessageById(project.id, messageId, {
        include_prompt_only: includePromptOnly,
        account_id: req.sessionAccount?.account_id ?? null,
      });
      if (!message) {
        // Body deliberately avoids the phrase "not found" so MCP clients can
        // tell a missing message apart from a missing route (isMissingRouteError).
        res.status(404).json({ error: "message does not exist in this room" });
        return;
      }
      const [attached] = await attachReceiptAuthorityActivations(project.id, activationIdentity, [message], {
        includeTaskOwnerLeases: false,
      });
      res.json({
        room_id: project.id,
        message: attached ?? message,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /rooms/:room_id/messages/:message_id",
        error,
        "Message could not be fetched.",
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/messages\/poll$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const projectId = project.id;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    const accountId = req.sessionAccount?.account_id ?? null;
    let activationIdentity: ResolvedRequestAgentIdentity | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let endDelivery: (() => Promise<void>) | null = null;
    if (!isDesktopHumanClient(req)) {
      try {
        const delivery = await beginRoomAgentDelivery({
          req,
          roomId: project.id,
          transport: "long_poll",
          onSessionDisconnected: () => resolveRequest([]),
        });
        endDelivery = delivery?.end ?? null;
        activationIdentity = delivery?.identity.session_kind === "worker" ? delivery.identity : null;
      } catch (error) {
        if (error instanceof InvalidRoomAgentDeliverySessionError) {
          res.status(401).json({ error: error.message });
          return;
        }
        throw error;
      }
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

    function resolveRequest(
      msgs: Message[],
      hasMore = false,
      options?: { includeTaskOwnerLeases?: boolean }
    ) {
      void resolveRequestAsync(msgs, hasMore, options).catch((error: unknown) => {
        console.error(`[room messages poll] failed to resolve poll for ${projectId}`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Messages could not be fetched." });
        }
      });
    }

    async function resolveRequestAsync(
      msgs: Message[],
      hasMore = false,
      options?: { includeTaskOwnerLeases?: boolean }
    ) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const attached = await attachReceiptAuthorityActivations(projectId, activationIdentity, msgs, options);
        res.json({
          room_id: projectId,
          messages: attached,
          has_more: hasMore,
        });
      } catch (error) {
        console.error(`[room messages poll] failed to resolve poll for ${projectId}`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Messages could not be fetched." });
        }
      }
    }

    async function onMessageCreated({ projectId: eventProjectId }: MessageCreatedEvent) {
      if (eventProjectId !== projectId) return;
      const next = await getMessagesAfter(projectId, after, {
        limit,
        include_prompt_only: includePromptOnly,
        account_id: accountId,
      });
      if (next.messages.length > 0) {
        resolveRequest(next.messages, next.has_more);
      }
    }

    function onClientClose() {
      if (settled) return;
      settled = true;
      cleanup();
    }

    // Subscribe before the initial fetch so a message created while the fetch
    // is in flight wakes this poll instead of waiting out the full timeout.
    timeout = setTimeout(() => {
      resolveRequest([]);
    }, timeoutMs);
    deps.messageEvents.on("message:created", onMessageCreated);
    req.on("close", onClientClose);

    try {
      const existing = await getMessagesAfter(projectId, after, {
        limit,
        include_prompt_only: includePromptOnly,
        account_id: accountId,
      });
      if (!settled && existing.messages.length > 0) {
        // The initial/backlog response is awaited so the route handler does
        // not return before the response body is written; only the timeout
        // and message-created event callbacks stay fire-and-forget.
        await resolveRequestAsync(existing.messages, existing.has_more, { includeTaskOwnerLeases: false });
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanup();
        respondWithInternalError(
          res,
          "GET /rooms/:room_id/messages/poll",
          error,
          "Messages could not be fetched.",
        );
      }
    }
  });

  app.get(/^\/rooms\/(.+)\/messages\/threads$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await resolveParticipantRoom(req, res, deps);
      if (!project) return;

      const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
      if (filter !== "all" && filter !== "unread") {
        res.status(400).json({ error: "filter must be all or unread" });
        return;
      }
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      if (before && !isMessageId(before)) {
        res.status(400).json({ error: "before must be a valid message id" });
        return;
      }
      const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
      const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
      const page = await getMessageThreads(project.id, {
        filter,
        limit,
        before,
        include_prompt_only: includePromptOnly,
        account_id: req.sessionAccount?.account_id ?? null,
      });

      res.json({
        room_id: project.id,
        threads: page.threads,
        has_more: page.has_more,
        unread_thread_count: page.unread_thread_count,
      });
    } catch (error) {
      respondWithInternalError(
        res,
        "GET /rooms/:room_id/messages/threads",
        error,
        "Threads could not be fetched.",
      );
    }
  });

  app.get(/^\/rooms\/(.+)\/messages\/(msg_\d+)\/thread$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await resolveParticipantRoom(req, res, deps);
      if (!project) return;

      const rootMessageId = req.params[1];
      const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
      const before = typeof req.query.before === "string" ? req.query.before : undefined;
      if (before && !isMessageId(before)) {
        res.status(400).json({ error: "before must be a valid message id" });
        return;
      }
      const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
      const page = await getMessageThread(project.id, rootMessageId, {
        limit,
        before,
        include_prompt_only: includePromptOnly,
        account_id: req.sessionAccount?.account_id ?? null,
      });
      if (!page) {
        res.status(404).json({ error: "thread not found" });
        return;
      }

      res.json({
        room_id: project.id,
        ...page,
      });
    } catch (error) {
      respondWithValidationOrInternalError(
        res,
        "GET /rooms/:room_id/messages/:message_id/thread",
        error,
        "Thread could not be fetched.",
      );
    }
  });

  app.put(/^\/rooms\/(.+)\/messages\/(msg_\d+)\/thread\/read$/, async (req: AuthenticatedRequest, res) => {
    try {
      const project = await resolveParticipantRoom(req, res, deps);
      if (!project) return;

      const accountId = req.sessionAccount?.account_id;
      if (!accountId) {
        res.status(401).json({ error: "account session required" });
        return;
      }

      const rootMessageId = req.params[1];
      const { message_id } = req.body as { message_id?: string | null };
      if (message_id !== undefined && message_id !== null && typeof message_id !== "string") {
        res.status(400).json({ error: "message_id must be a valid message id" });
        return;
      }
      const summary = await markMessageThreadRead(project.id, rootMessageId, accountId, {
        message_id: message_id ?? null,
      });
      if (!summary) {
        res.status(404).json({ error: "thread not found" });
        return;
      }

      res.json({
        room_id: project.id,
        thread: summary,
      });
    } catch (error) {
      respondWithValidationOrInternalError(
        res,
        "PUT /rooms/:room_id/messages/:message_id/thread/read",
        error,
        "Thread read state could not be updated.",
      );
    }
  });
}

function isMessageId(value: string): boolean {
  return /^msg_\d+$/.test(value);
}
