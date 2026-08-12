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
} from "../../db.js";
import {
  parseLimit,
  parsePollTimeout,
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../http/helpers.js";
import { requireWorkerRequestAgentIdentity } from "../../request/agent-identity.js";
import {
  InvalidRoomAgentDeliverySessionError,
} from "../../rooms/agent-delivery.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { openSseConnection, type SseConnection } from "../../http/sse.js";
import {
  type AgentPromptKind,
} from "../../../shared/room-agent-prompts.js";
import { parseAgentActorLabel } from "../../../shared/agent-identity.js";
import {
  normalizeMessageAttachmentReferences,
  type NormalizedMessageAttachmentReference,
} from "../../messages/attachments.js";
import {
  createPresignedAttachmentDownload,
  isAttachmentStorageConfigured,
} from "../../messages/attachment-storage.js";
import type { RoomEventBroker, RoomEventSubscription } from "../../server/room-event-broker.js";
import type { RoomMessageOverlayBatcher } from "../../server/room-message-overlays.js";
import { createTrailingSingleFlight } from "../../single-flight.js";
import { getCanonicalRoomMessageCatchUp } from "../../server/room-message-catchup.js";
import {
  resolveRequestProjectRepoAccessRoomName,
} from "../../rooms/access.js";
import { resolveMessageActivationIdentity } from "../rooms/messages/activation-identity.js";
import { attachReceiptAuthorityActivations } from "../rooms/messages/receipt-activation.js";
import {
  openLiveRoomDeliveryController,
  roomSyncSseFrame,
  subscribeVisibleRoomEvents,
  type LiveRoomDeliveryController,
} from "../rooms/messages/live-controller.js";
import {
  hydrateLiveMessageForSubscriber,
  hydrateLiveMessagesForSubscriber,
  isMessageVisibleToCurrentWorker,
  resolveLiveMessageOverlayTarget,
} from "../rooms/messages/live-message-delivery.js";

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
  getMessagesAfter?: typeof getMessagesAfter;
  resolveRequestProjectRepoAccessRoomName?(
    req: AuthenticatedRequest,
    project: Project,
  ): Promise<string>;
  reauthorizeGitRoomParticipant?(
    req: AuthenticatedRequest,
    project: Project,
  ): Promise<boolean>;
  roomEventBroker: RoomEventBroker;
  roomMessageOverlayBatcher: RoomMessageOverlayBatcher;
  getProjectById?(projectId: string): Promise<Project | null>;
  attachReceiptAuthorityActivations?: typeof attachReceiptAuthorityActivations;
  beginRoomAgentDelivery?: typeof import("../../rooms/agent-delivery.js").beginRoomAgentDelivery;
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
      publisher_agent_key?: string | null;
      publisher_agent_session_id?: string | null;
      account_id?: string | null;
    }
  ): Promise<Message>;
  rememberRoomParticipantFromMessage(input: {
    projectId: string;
    sender: string;
    source?: string | null;
    sessionAccount?: AuthenticatedRequest["sessionAccount"];
    timestamp?: string;
  }): Promise<void>;
  rememberAccountRoom(input: {
    accountId: string;
    roomId: string;
    displayName?: string | null;
    source?: string | null;
  }): Promise<void>;
}

export function registerLegacyProjectMessageRoutes(
  app: Express,
  deps: LegacyProjectMessageRouteDeps
): void {
  const loadProjectById = deps.getProjectById ?? getProjectById;
  const loadMessagesAfter = deps.getMessagesAfter ?? getMessagesAfter;
  const attachActivations = deps.attachReceiptAuthorityActivations
    ?? attachReceiptAuthorityActivations;
  app.post("/projects/:id/messages", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await loadProjectById(projectId);

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
        || req.authKind === "agent_session"
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
        ...(workerIdentity?.ok ? {
          publisher_agent_key: workerIdentity.identity.agent_key,
          publisher_agent_session_id: workerIdentity.identity.agent_session_id,
        } : {}),
        account_id: workerIdentity?.ok
          ? workerIdentity.identity.owner_account_id ?? null
          : req.sessionAccount?.account_id ?? null,
      });
      await deps.rememberRoomParticipantFromMessage({
        projectId,
        sender: normalizedSender,
        source,
        sessionAccount: req.sessionAccount,
        timestamp: message.timestamp,
      });
      if (req.sessionAccount && (source === "browser" || source === "agent")) {
        await deps.rememberAccountRoom({
          accountId: req.sessionAccount.account_id,
          roomId: project.id,
          displayName: project.display_name,
          source: "open_room",
        });
      }
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
    const project = await loadProjectById(projectId);

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
    const project = await loadProjectById(projectId);

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
    const activationIdentity = await resolveMessageActivationIdentity(req, projectId);
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
      messages: await attachActivations(projectId, activationIdentity, result.messages, {
        includeTaskOwnerLeases: false,
      }),
      has_more: result.has_more,
      has_older: before ? result.has_more : undefined,
    });
  });

  app.get("/projects/:id/messages/stream", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await loadProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }
    const accessRoomName = await (
      deps.resolveRequestProjectRepoAccessRoomName ?? resolveRequestProjectRepoAccessRoomName
    )(req, project);

    let connection: SseConnection | null = null;
    let streamClosed = false;
    let live: LiveRoomDeliveryController | null = null;
    try {
      live = await openLiveRoomDeliveryController({
        req,
        project,
        accessRoomName,
        transport: "sse",
        trackDelivery: true,
        onSessionDisconnected: () => {
          streamClosed = true;
          void connection?.write(`event: session_disconnect\ndata: ${JSON.stringify({ project_id: projectId })}\n\n`)
            .finally(() => connection?.close());
        },
        onAuthorizationDenied: () => connection?.close(),
        reauthorize: deps.reauthorizeGitRoomParticipant,
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
    liveController.activate();
    if (streamClosed) {
      await liveController.close();
      if (!res.headersSent) res.status(401).json({ error: "Agent delivery session is no longer active." });
      return;
    }
    connection = openSseConnection(req, res, `legacy room messages stream ${projectId}`);
    const writeEvent = connection.write;
    const eventCursor = req.get?.("Last-Event-ID")
      || (typeof req.query?.event_cursor === "string" ? req.query.event_cursor : null);
    const subscription = subscribeVisibleRoomEvents({
      broker: deps.roomEventBroker,
      roomId: projectId,
      includePromptOnly: deps.shouldIncludePromptOnlyMessages(req),
      activationIdentity: liveController.activationIdentity,
      eventCursor,
      messageOnly: true,
      messageOverlayTarget,
    });
    connection.addCleanup(() => {
      streamClosed = true;
      subscription.close();
    });
    connection.addCleanup(() => liveController.close());
    if (!(await liveController.check())) {
      connection.close();
      return;
    }
    await writeEvent(roomSyncSseFrame({
      project_id: projectId,
      event_cursor: subscription.checkpointCursor,
      gap: subscription.checkpointGap,
    }));

    void (async () => {
      while (!streamClosed) {
        const delivery = await subscription.next();
        if (!delivery) {
          connection?.close();
          return;
        }
        if (streamClosed) return;
        if (!(await liveController.check())) {
          connection?.close();
          return;
        }
        if (delivery.type === "gap") {
          await writeEvent(roomSyncSseFrame({
            project_id: projectId,
            event_cursor: delivery.cursor,
            gap: true,
          }));
          continue;
        }
        const event = delivery.envelope.event;
        if (event.kind !== "message_created") continue;
        try {
          const attached = await hydrateLiveMessageForSubscriber({
            roomId: projectId,
            message: event.message,
            identity: liveController.activationIdentity,
            target: messageOverlayTarget,
            broker: deps.roomEventBroker,
            batcher: deps.roomMessageOverlayBatcher,
          });
          await writeEvent(`id: ${delivery.envelope.cursor}\ndata: ${JSON.stringify(attached)}\n\n`);
        } catch (error) {
          console.error(`[legacy messages stream] failed to hydrate message authority for ${projectId}`, error);
          if (!streamClosed) {
            // Advance the transport through an explicit repair boundary. A
            // close-only failure would reconnect from the prior cursor and
            // replay the same unhydratable frame forever.
            await writeEvent(roomSyncSseFrame({
              project_id: projectId,
              event_cursor: delivery.envelope.cursor,
              gap: true,
            }));
            streamClosed = true;
            connection?.close();
          }
          return;
        }
      }
    })().catch((error: unknown) => {
      console.error(`[legacy messages stream] failed to deliver event for ${projectId}`, error);
      if (!streamClosed) connection?.close();
    });
  });

  app.get("/projects/:id/messages/poll", async (req: AuthenticatedRequest, res) => {
    const projectId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(String(req.params.id)));
    const project = await loadProjectById(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!(await deps.requireParticipant(req, res, project))) {
      return;
    }
    const accessRoomName = await (
      deps.resolveRequestProjectRepoAccessRoomName ?? resolveRequestProjectRepoAccessRoomName
    )(req, project);

    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    const timeoutMs = parsePollTimeout(typeof req.query.timeout === "string" ? req.query.timeout : undefined);
    const limit = parseLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
    const includePromptOnly = deps.shouldIncludePromptOnlyMessages(req);
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
        trackDelivery: true,
        onSessionDisconnected: resolveDisconnectedRequest,
        onAuthorizationDenied: denyRequest,
        reauthorize: deps.reauthorizeGitRoomParticipant,
        onEndError: (error) => {
          console.error(`[legacy messages poll] failed to end agent delivery for ${projectId}`, error);
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
      res.json({ project_id: projectId, messages: [], has_more: false });
    }

    async function resolveBrokerClosedRequestAsync() {
      if (settled) return;
      settled = true;
      await cleanup();
      res.json({ project_id: projectId, messages: [], has_more: false });
    }

    async function resolveCanonicalEventAsync(message: Message) {
      if (settled || resolving) return;
      resolving = true;
      try {
        if (!(await liveController.check())) {
          await denyRequestAsync();
          return;
        }
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
        res.json({ project_id: projectId, messages: [attached], has_more: false });
      } catch (error) {
        console.error(`[legacy messages poll] failed to hydrate broker message for ${projectId}`, error);
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
          project_id: projectId,
          messages: attached,
          has_more: hasMore,
          last_observed_message_id: msgs.at(-1)?.id ?? null,
        });
      } catch (error) {
        console.error(`[legacy messages poll] failed canonical gap catch-up for ${projectId}`, error);
        if (!settled) { settled = true; await cleanup(); }
        if (!res.headersSent) res.status(500).json({ error: "Messages could not be fetched." });
      } finally {
        resolving = false;
      }
    }

    function resolveRequest(msgs: Message[], hasMore = false) {
      void resolveRequestAsync(msgs, hasMore);
    }

    async function resolveRequestAsync(msgs: Message[], hasMore = false) {
      if (settled || resolving) {
        return;
      }
      resolving = true;
      try {
        settled = true;
        await cleanup();
        const attached = await attachActivations(
          projectId,
          liveController.activationIdentity,
          msgs,
          { includeTaskOwnerLeases: false },
        );
        res.json({ project_id: projectId, messages: attached, has_more: hasMore });
      } finally {
        resolving = false;
      }
    }

    const refreshAfterCursor = createTrailingSingleFlight(async () => {
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
        load: loadMessagesAfter,
      });
      if (!(await liveController.check())) {
        await denyRequestAsync();
        return;
      }
      if (next.messages.length > 0) await resolveCanonicalCatchUpAsync(next.messages, next.has_more);
    });

    async function pumpMessageEvents(): Promise<void> {
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
      if (settled) {
        return;
      }

      settled = true;
      void cleanup();
    }

    liveController.activate();
    if (settled) return;

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
      console.error(`[legacy messages poll] failed to observe room event for ${projectId}`, error);
      if (!settled) {
        settled = true;
        await cleanup();
        if (!res.headersSent) res.status(500).json({ error: "Messages could not be fetched." });
      }
    });

    try {
      await refreshAfterCursor();
    } catch (error) {
      if (!settled) {
        settled = true;
        await cleanup();
        console.error(`[legacy messages poll] failed initial fetch for ${projectId}`, error);
        if (!res.headersSent) res.status(500).json({ error: "Messages could not be fetched." });
      }
    }
  });
}
