import type { Express } from "express";

import {
  respondWithBadRequest,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { requireWorkerRequestAgentIdentity } from "../../../request/agent-identity.js";
import { normalizeMessageAttachmentReferences } from "../../../messages/attachments.js";
import {
  hasAgentSessionCredentials,
  isAgentLikeSender,
  isDesktopHumanWrite,
} from "./request-identity.js";
import { resolveParticipantRoom } from "./helpers.js";
import type { RoomMessageRouteDeps } from "./types.js";

export function registerCreateMessageRoute(
  app: Express,
  deps: RoomMessageRouteDeps
): void {
  app.post(/^\/rooms\/(.+)\/messages$/, async (req: AuthenticatedRequest, res) => {
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;

    const {
      sender,
      text,
      agent_prompt_kind,
      reply_to,
      attachments: rawAttachments,
      agent_session_id,
      agent_session_token,
      client_message_id,
    } = req.body as {
      sender?: string;
      text?: string;
      agent_prompt_kind?: string;
      reply_to?: string;
      attachments?: unknown;
      agent_session_id?: string;
      agent_session_token?: string;
      client_message_id?: string;
    };
    try {
      const promptKind = deps.parseOptionalAgentPromptKind(agent_prompt_kind);
      const replyToMessageId = deps.parseOptionalReplyToMessageId(reply_to);
      const attachments = normalizeMessageAttachmentReferences(rawAttachments);
      const desktopHumanWrite = isDesktopHumanWrite(req, {
        agent_session_id,
        agent_session_token,
      });
      const requiresWorkerSession = !desktopHumanWrite && (req.authKind === "owner_token"
        || hasAgentSessionCredentials({ agent_session_id, agent_session_token })
        || isAgentLikeSender(sender));
      const agentSessionIdentity = requiresWorkerSession
        ? await requireWorkerRequestAgentIdentity({
          req,
          body: { agent_session_id, agent_session_token },
          room_id: project.id,
        })
        : null;
      if (agentSessionIdentity && !agentSessionIdentity.ok) {
        res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
        return;
      }
      const workerIdentity = agentSessionIdentity?.ok ? agentSessionIdentity.identity : null;
      const normalizedSender = workerIdentity?.actor_label
        || (typeof sender === "string" ? sender.trim() : "");
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
      const source = workerIdentity
        ? "agent"
        : req.authKind === "session" || desktopHumanWrite
        ? "browser"
        : undefined;
      const message = await deps.emitProjectMessage(project.id, normalizedSender, text, {
        source,
        agent_prompt_kind: promptKind,
        reply_to: replyToMessageId,
        attachments,
        ...(typeof client_message_id === "string" ? { client_message_id } : {}),
      });
      await deps.rememberRoomParticipantFromMessage({
        projectId: project.id,
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
}
