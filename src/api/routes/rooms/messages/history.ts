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
  InvalidRoomAgentDeliverySessionError,
} from "../../../rooms/agent-delivery.js";
import { resolveMessageActivationIdentity } from "./activation-identity.js";
import { isDesktopHumanClient } from "./request-identity.js";
import { attachReceiptAuthorityActivations } from "./receipt-activation.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";
import { parsePositivePgIntegerScopedId } from "../../../../shared/scoped-ids.js";
import type { RoomEventSubscription } from "../../../server/room-event-broker.js";
import { createTrailingSingleFlight } from "../../../single-flight.js";
import { createBoundedExecutor } from "../../../bounded-async.js";
import { getCanonicalRoomMessageCatchUp } from "../../../server/room-message-catchup.js";
import { resolveRequestProjectRepoAccessRoomName } from "../../../rooms/access.js";
import {
  openLiveRoomDeliveryController,
  subscribeVisibleRoomEvents,
  type LiveRoomDeliveryController,
} from "./live-controller.js";
import {
  hydrateLiveMessageForSubscriber,
  hydrateLiveMessagesForSubscriber,
  isMessageVisibleToCurrentWorker,
  resolveLiveMessageOverlayTarget,
} from "./live-message-delivery.js";

const runPollOverlay = createBoundedExecutor({
  label: "room message poll activation overlay",
  maxConcurrent: 64,
  maxQueued: 512,
  timeoutMs: 8_000,
});

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
      const accountAgentRouting = isDesktopHumanClient(req);
      const activationIdentity = await resolveMessageActivationIdentity(req, project.id);
      const result = before === "latest"
        ? await getLatestMessages(project.id, { limit, include_prompt_only: includePromptOnly, account_id: accountId, account_agent_routing: accountAgentRouting })
        : before
          ? await getMessagesBefore(project.id, before, { limit, include_prompt_only: includePromptOnly, account_id: accountId, account_agent_routing: accountAgentRouting })
          : await getMessages(project.id, {
            limit,
            after,
            include_prompt_only: includePromptOnly,
            account_id: accountId,
            account_agent_routing: accountAgentRouting,
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
        account_agent_routing: isDesktopHumanClient(req),
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
    const accessRoomName = await (
      deps.resolveRequestProjectRepoAccessRoomName ?? resolveRequestProjectRepoAccessRoomName
    )(req, project);
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
    const accountId = req.sessionAccount?.account_id ?? null;
    const accountAgentRouting = isDesktopHumanClient(req);
    let settled = false;
    let resolving = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let subscription: RoomEventSubscription | null = null;
    let live: LiveRoomDeliveryController | null = null;
    try {
      live = await openLiveRoomDeliveryController({
        req,
        project,
        accessRoomName,
        transport: "long_poll",
        trackDelivery: !isDesktopHumanClient(req),
        onSessionDisconnected: resolveDisconnectedRequest,
        onAuthorizationDenied: denyRequest,
        reauthorize: deps.reauthorizeGitRoomParticipant,
        onEndError: (error) => {
          console.error(`[room messages poll] failed to end agent delivery for ${projectId}`, error);
        },
        beginDelivery: deps.beginRoomAgentDelivery,
      });
    } catch (error) {
        if (error instanceof InvalidRoomAgentDeliverySessionError) {
          res.status(401).json({ error: error.message });
          return;
        }
        throw error;
    }
    if (!live) return;
    const liveController = live;
    const messageOverlayTarget = resolveLiveMessageOverlayTarget(
      req,
      liveController.activationIdentity,
    );
    async function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      subscription?.close();
      subscription = null;
      req.off("close", onClientClose);
      await liveController.close();
    }

    function denyRequest() {
      void denyRequestAsync();
    }

    async function denyRequestAsync() {
      if (settled) return;
      settled = true;
      await cleanup();
      if (!res.headersSent) res.status(403).json({ error: "Room access is no longer authorized." });
    }

    function resolveDisconnectedRequest() {
      void resolveDisconnectedRequestAsync();
    }

    async function resolveDisconnectedRequestAsync() {
      if (settled) return;
      settled = true;
      await cleanup();
      res.json({ room_id: projectId, messages: [], has_more: false });
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
      if (settled || resolving) return;
      resolving = true;
      try {
        if (!(await liveController.check())) {
          await denyRequestAsync();
          return;
        }
        const attached = await runPollOverlay(
          () => attachReceiptAuthorityActivations(projectId, liveController.activationIdentity, msgs, options),
        );
        if (!(await liveController.check())) {
          await denyRequestAsync();
          return;
        }
        settled = true;
        await cleanup();
        res.json({
          room_id: projectId,
          messages: attached,
          has_more: hasMore,
        });
      } catch (error) {
        console.error(`[room messages poll] failed to resolve poll for ${projectId}`, error);
        if (!settled) {
          settled = true;
          await cleanup();
        }
        if (!res.headersSent) {
          res.status(500).json({ error: "Messages could not be fetched." });
        }
      } finally {
        resolving = false;
      }
    }

    async function resolveBrokerClosedRequestAsync() {
      if (settled) return;
      settled = true;
      await cleanup();
      res.json({ room_id: projectId, messages: [], has_more: false });
    }

    async function resolveCanonicalEventAsync(message: Message) {
      if (settled || resolving) return;
      resolving = true;
      try {
        if (!(await liveController.check())) {
          await denyRequestAsync();
          return;
        }
        // Normal broker delivery is already bounded/coalesced across every
        // subscriber. Keep the executor for backlog pages, not this shared
        // canonical event, or large poll populations fail before batching.
        const attached = await hydrateLiveMessageForSubscriber({
          roomId: projectId,
          message,
          identity: liveController.activationIdentity,
          target: messageOverlayTarget,
          broker: deps.roomEventBroker,
          batcher: deps.roomMessageOverlayBatcher,
        });
        if (!(await liveController.check())) {
          await denyRequestAsync();
          return;
        }
        settled = true;
        await cleanup();
        res.json({ room_id: projectId, messages: [attached], has_more: false });
      } catch (error) {
        console.error(`[room messages poll] failed to hydrate broker message for ${projectId}`, error);
        if (!settled) {
          settled = true;
          await cleanup();
        }
        if (!res.headersSent) res.status(500).json({ error: "Messages could not be fetched." });
      } finally {
        resolving = false;
      }
    }

    async function resolveCanonicalCatchUpAsync(msgs: Message[], hasMore: boolean) {
      if (settled || resolving) return;
      resolving = true;
      try {
        if (!(await liveController.check())) return void await denyRequestAsync();
        const hydratedPage = await hydrateLiveMessagesForSubscriber({
          roomId: projectId,
          messages: msgs,
          identity: liveController.activationIdentity,
          target: messageOverlayTarget,
          broker: deps.roomEventBroker,
          batcher: deps.roomMessageOverlayBatcher,
          allowSilentPromptOnly: true,
        });
        const attached: Message[] = [];
        for (const hydrated of hydratedPage) {
          if (!liveController.activationIdentity
            || isMessageVisibleToCurrentWorker(hydrated)) attached.push(hydrated);
        }
        if (!(await liveController.check())) return void await denyRequestAsync();
        settled = true;
        await cleanup();
        res.json({
          room_id: projectId,
          messages: attached,
          has_more: hasMore,
          last_observed_message_id: msgs.at(-1)?.id ?? null,
        });
      } catch (error) {
        console.error(`[room messages poll] failed canonical gap catch-up for ${projectId}`, error);
        if (!settled) { settled = true; await cleanup(); }
        if (!res.headersSent) res.status(500).json({ error: "Messages could not be fetched." });
      } finally {
        resolving = false;
      }
    }

    const runRefreshAfterCursor = createTrailingSingleFlight(async () => {
      if (settled) return;
      if (!(await liveController.check())) {
        await denyRequestAsync();
        return;
      }
      const next = await getCanonicalRoomMessageCatchUp({
        roomId: projectId,
        after,
        limit,
        includePromptOnly,
        load: deps.getMessagesAfter ?? getMessagesAfter,
      });
      if (next.messages.length > 0) {
        await resolveCanonicalCatchUpAsync(next.messages, next.has_more);
      }
    });
    const refreshAfterCursor = () => runRefreshAfterCursor();

    async function pumpMessageEvents() {
      while (!settled && subscription) {
        const delivery = await subscription.next();
        if (!delivery) {
          await resolveBrokerClosedRequestAsync();
          return;
        }
        if (settled) return;
        if (delivery.type === "gap") {
          await refreshAfterCursor();
          continue;
        }
        if (delivery.envelope.event.kind === "message_created") {
          await resolveCanonicalEventAsync(delivery.envelope.event.message);
        }
      }
    }

    function onClientClose() {
      if (settled) return;
      settled = true;
      void cleanup();
    }

    liveController.activate();
    if (settled) return;

    // Subscribe before the initial fetch so a message created while the fetch
    // is in flight wakes this poll instead of waiting out the full timeout.
    timeout = setTimeout(() => {
      resolveRequest([]);
    }, timeoutMs);
    subscription = subscribeVisibleRoomEvents({
      broker: deps.roomEventBroker,
      roomId: projectId,
      includePromptOnly,
      activationIdentity: liveController.activationIdentity,
      messageOnly: true,
      messageOverlayTarget,
    });
    req.on("close", onClientClose);
    void pumpMessageEvents().catch(async (error: unknown) => {
      console.error(`[room messages poll] failed to observe room event for ${projectId}`, error);
      if (!settled) {
        settled = true;
        await cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Messages could not be fetched." });
      }
    });

    try {
      const existing = await (deps.getMessagesAfter ?? getMessagesAfter)(projectId, after, {
        limit,
        include_prompt_only: includePromptOnly,
        account_id: accountId,
        account_agent_routing: accountAgentRouting,
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
        await cleanup();
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
      // The inbox is intentionally visible-thread-only. Prompt-only messages
      // remain available from timeline/history endpoints but never affect
      // inbox ordering, counts, or cursors.
      const activationIdentity = await (
        deps.resolveMessageActivationIdentity ?? resolveMessageActivationIdentity
      )(req, project.id);
      const page = await (deps.getMessageThreads ?? getMessageThreads)(project.id, {
        filter,
        limit,
        before,
        account_id: req.sessionAccount?.account_id ?? null,
        account_agent_routing: isDesktopHumanClient(req),
      });
      const attachedRoots = await (
        deps.attachReceiptAuthorityActivations ?? attachReceiptAuthorityActivations
      )(
        project.id,
        activationIdentity,
        page.threads.map((thread) => thread.root),
        { includeTaskOwnerLeases: false },
      );

      res.json({
        room_id: project.id,
        threads: page.threads.map((thread, index) => ({
          ...thread,
          root: attachedRoots[index] ?? thread.root,
        })),
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
      const activationIdentity = await (
        deps.resolveMessageActivationIdentity ?? resolveMessageActivationIdentity
      )(req, project.id);
      const page = await (deps.getMessageThread ?? getMessageThread)(project.id, rootMessageId, {
        limit,
        before,
        include_prompt_only: includePromptOnly,
        account_id: req.sessionAccount?.account_id ?? null,
        account_agent_routing: isDesktopHumanClient(req),
      });
      if (!page) {
        res.status(404).json({ error: "thread not found" });
        return;
      }

      const attached = await (
        deps.attachReceiptAuthorityActivations ?? attachReceiptAuthorityActivations
      )(project.id, activationIdentity, [page.root, ...page.replies], {
        includeTaskOwnerLeases: false,
      });
      const [root = page.root, ...replies] = attached;

      res.json({
        room_id: project.id,
        ...page,
        root,
        replies,
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
  return parsePositivePgIntegerScopedId(value, "msg") !== null;
}
