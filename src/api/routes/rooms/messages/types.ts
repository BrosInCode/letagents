import type { EventEmitter } from "events";
import type { Request, Response } from "express";

import type {
  Message,
  Project,
  GitHubRoomEvent,
  ReasoningSession,
  ReasoningSessionUpdate,
  RoomSharedArtifact,
  Task,
} from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { NormalizedMessageAttachmentReference } from "../../../messages/attachments.js";
import type { AgentPromptKind } from "../../../../shared/room-agent-prompts.js";

export interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

export interface TaskUpdatedEvent {
  projectId: string;
  task: Task;
}

export interface GitHubRoomEventUpdatedEvent {
  projectId: string;
  event: GitHubRoomEvent;
}

export interface ReasoningSessionUpdatedEvent {
  projectId: string;
  session: ReasoningSession;
  update?: ReasoningSessionUpdate | null;
}

export interface ReasoningSessionRemovedEvent {
  projectId: string;
  session_id: string;
}

export interface RoomArtifactUpdatedEvent {
  projectId: string;
  artifact: RoomSharedArtifact | null;
}

export interface RoomMessageRouteDeps {
  messageEvents: EventEmitter;
  taskEvents: EventEmitter;
  githubRoomEvents?: EventEmitter;
  reasoningEvents: EventEmitter;
  artifactEvents?: EventEmitter;
  rentalActivityEvents?: EventEmitter;
  beginRoomAgentDelivery?: typeof import("../../../rooms/agent-delivery.js").beginRoomAgentDelivery;
  attachReceiptAuthorityActivations?: typeof import("./receipt-activation.js").attachReceiptAuthorityActivations;
  getMessageById?: typeof import("../../../db.js").getMessageById;
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
