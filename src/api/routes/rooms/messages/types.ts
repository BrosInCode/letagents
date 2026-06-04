import type { EventEmitter } from "events";
import type { Request, Response } from "express";

import type {
  Message,
  Project,
  ReasoningSession,
  ReasoningSessionUpdate,
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

export interface ReasoningSessionUpdatedEvent {
  projectId: string;
  session: ReasoningSession;
  update?: ReasoningSessionUpdate | null;
}

export interface ReasoningSessionRemovedEvent {
  projectId: string;
  session_id: string;
}

export interface RoomMessageRouteDeps {
  messageEvents: EventEmitter;
  taskEvents: EventEmitter;
  reasoningEvents: EventEmitter;
  rentalActivityEvents?: EventEmitter;
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
      client_message_id?: string | null;
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
