import {
  addMessageWithCreateStatus,
  hydrateMessageReplies,
  type Message,
  type MessageCreateTransaction,
} from "../db.js";
import { parseScopedId } from "../db/utils.js";
import { createBridgedEmitter } from "./event-bridge.js";
import type { NormalizedMessageAttachmentReference } from "../messages/attachments.js";
import type { AgentPromptKind } from "../../shared/room-agent-prompts.js";

export interface MessageCreatedEvent {
  projectId: string;
  message: Message;
}

export const messageEvents = createBridgedEmitter("messages");
export const taskEvents = createBridgedEmitter("tasks");
export const githubRoomEvents = createBridgedEmitter("github");
export const reasoningEvents = createBridgedEmitter("reasoning");
export const artifactEvents = createBridgedEmitter("artifacts");

export async function emitProjectMessage(
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
    account_id?: string | null;
    with_created_message_in_transaction?: (tx: MessageCreateTransaction) => Promise<void>;
  }
): Promise<Message> {
  const { message, created } = await addMessageWithCreateStatus(projectId, sender, text, {
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    reply_to_message_id: options?.reply_to ?? null,
    thread_root_message_id: options?.thread_root_id ?? null,
    attachments: options?.attachments,
    client_message_id: options?.client_message_id ?? null,
    account_id: options?.account_id ?? null,
    with_created_message_in_transaction: options?.with_created_message_in_transaction,
  });
  if (created) {
    messageEvents.emit("message:created", {
      projectId,
      message: await hydrateMessageForSharedEvent(projectId, message),
    } satisfies MessageCreatedEvent);
  }
  return message;
}

async function hydrateMessageForSharedEvent(projectId: string, message: Message): Promise<Message> {
  const messageNumber = parseScopedId(message.id, "msg");
  if (!messageNumber) return message;
  const rootNumber = parseScopedId(message.thread_root_id, "msg");
  const [hydrated] = await hydrateMessageReplies(projectId, [{
    room_id: projectId,
    number: messageNumber,
    reply_to_number: message.thread_reply_to_id ? parseScopedId(message.thread_reply_to_id, "msg") : null,
    thread_root_number: rootNumber && rootNumber !== messageNumber ? rootNumber : null,
    sender: message.sender,
    text: message.text,
    agent_prompt_kind: message.agent_prompt_kind,
    source: message.source,
    client_message_id: message.client_message_id,
    timestamp: message.timestamp,
  }], { accountId: null });
  return hydrated ?? message;
}
