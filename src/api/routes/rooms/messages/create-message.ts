import type { Express } from "express";

import {
  respondWithValidationOrInternalError,
  type AuthenticatedRequest,
} from "../../../http/helpers.js";
import { requireWorkerRequestAgentIdentity } from "../../../request/agent-identity.js";
import { normalizeMessageAttachmentReferences } from "../../../messages/attachments.js";
import { parseCreateMessageBody } from "../../../messages/inputs.js";
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

    try {
      const body = parseCreateMessageBody(req.body);
      const sessionCredentials = {
        agent_session_id: body.agent_session_id ?? undefined,
        agent_session_token: body.agent_session_token ?? undefined,
      };
      const promptKind = deps.parseOptionalAgentPromptKind(body.agent_prompt_kind);
      const replyToMessageId = deps.parseOptionalReplyToMessageId(body.reply_to);
      const threadRootMessageId = deps.parseOptionalThreadRootMessageId(body.thread_root_id);
      const attachments = normalizeMessageAttachmentReferences(body.attachments);
      const desktopHumanWrite = isDesktopHumanWrite(req, sessionCredentials);
      const requiresWorkerSession = !desktopHumanWrite && (req.authKind === "owner_token"
        || req.authKind === "agent_session"
        || hasAgentSessionCredentials(sessionCredentials)
        || isAgentLikeSender(body.sender));
      const agentSessionIdentity = requiresWorkerSession
        ? await requireWorkerRequestAgentIdentity({
          req,
          body: sessionCredentials,
          room_id: project.id,
        })
        : null;
      if (agentSessionIdentity && !agentSessionIdentity.ok) {
        res.status(agentSessionIdentity.status).json({ error: agentSessionIdentity.error });
        return;
      }
      const workerIdentity = agentSessionIdentity?.ok ? agentSessionIdentity.identity : null;
      const normalizedSender = workerIdentity?.actor_label || body.sender?.trim() || "";
      const text = body.text;
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
        thread_root_id: threadRootMessageId,
        attachments,
        ...(body.client_message_id ? { client_message_id: body.client_message_id } : {}),
        account_id: req.sessionAccount?.account_id ?? null,
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
      respondWithValidationOrInternalError(
        res,
        "POST /rooms/:room_id/messages",
        error,
        "Message could not be created."
      );
    }
  });
}
