import { EventEmitter } from "events";

import {
  addMessage,
  type Message,
} from "../db.js";
import type { NormalizedMessageAttachmentReference } from "../messages/attachments.js";
import type { AgentPromptKind } from "../../shared/room-agent-prompts.js";

export interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

export const messageEvents = new EventEmitter();
export const taskEvents = new EventEmitter();
export const reasoningEvents = new EventEmitter();

export async function emitProjectMessage(
  projectId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    reply_to?: string | null;
    attachments?: NormalizedMessageAttachmentReference[];
  }
): Promise<Message> {
  const message = await addMessage(projectId, sender, text, {
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    reply_to_message_id: options?.reply_to ?? null,
    attachments: options?.attachments,
  });
  messageEvents.emit("message:created", { projectId, message } satisfies MessageCreatedEvent);
  return message;
}
