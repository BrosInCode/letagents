import type { Request, Response } from "express";

import type {
  Message,
  Project,
} from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { NormalizedMessageAttachmentReference } from "../../../messages/attachments.js";
import type { AgentPromptKind } from "../../../../shared/room-agent-prompts.js";
import type { RoomEventBroker } from "../../../server/room-event-broker.js";
import type { RoomMessageOverlayBatcher } from "../../../server/room-message-overlays.js";

export interface RoomMessageRouteDeps {
  roomEventBroker: RoomEventBroker;
  roomMessageOverlayBatcher: RoomMessageOverlayBatcher;
  resolveRequestProjectRepoAccessRoomName?(
    req: AuthenticatedRequest,
    project: Project,
  ): Promise<string>;
  reauthorizeGitRoomParticipant?(
    req: AuthenticatedRequest,
    project: Project,
  ): Promise<boolean>;
  getMessageStreamCheckpoint?(
    roomId: string,
    options: { requestedCursor?: string | null; includePromptOnly?: boolean },
  ): Promise<{ checkpoint: string | null; cursorExists: boolean }>;
  beginRoomAgentDelivery?: typeof import("../../../rooms/agent-delivery.js").beginRoomAgentDelivery;
  attachReceiptAuthorityActivations?: typeof import("./receipt-activation.js").attachReceiptAuthorityActivations;
  getMessagesAfter?: typeof import("../../../db.js").getMessagesAfter;
  getMessageThreads?: typeof import("../../../db.js").getMessageThreads;
  getMessageThread?: typeof import("../../../db.js").getMessageThread;
  resolveMessageActivationIdentity?: typeof import("./activation-identity.js").resolveMessageActivationIdentity;
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  parseOptionalAgentPromptKind(value: unknown): AgentPromptKind | null;
  parseOptionalReplyToMessageId(value: unknown): string | null;
  parseOptionalThreadRootMessageId(value: unknown): string | null;
  shouldIncludePromptOnlyMessages(req: Request): boolean;
  emitProjectMessage(
    projectId: string,
    sender: string,
    text: string,
    options?: {
      source?: string;
      agent_prompt_kind?: AgentPromptKind | null;
      reply_to?: string | null;
      thread_root_id?: string | null;
      attachments?: NormalizedMessageAttachmentReference[];
      client_message_id?: string | null;
      publisher_agent_key?: string | null;
      publisher_agent_session_id?: string | null;
      account_id?: string | null;
      account_agent_routing?: boolean;
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
