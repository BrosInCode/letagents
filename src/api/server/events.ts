import {
  addMessageWithCreateStatus,
  type Message,
  type MessageCreateTransaction,
} from "../db.js";
import { createBridgedEmitter } from "./event-bridge.js";
import type { NormalizedMessageAttachmentReference } from "../messages/attachments.js";
import type { MessageRecipientAgentTarget } from "../db/types.js";
import {
  isPromptOnlyAgentMessage,
  type AgentPromptKind,
} from "../../shared/room-agent-prompts.js";

export interface MessageCreatedEvent {
  projectId: string;
  message: Message;
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
}

export const messageEvents = createBridgedEmitter("messages");
export const taskEvents = createBridgedEmitter("tasks");
export const githubRoomEvents = createBridgedEmitter("github");
export const reasoningEvents = createBridgedEmitter("reasoning");
export const artifactEvents = createBridgedEmitter("artifacts");
export const agentWorkEvents = createBridgedEmitter("agent-work");
export const executionDelegationEvents = createBridgedEmitter("execution-delegation");

const ROOM_INVALIDATION_COALESCE_MS = 100;

function createRoomInvalidationQueue(
  emitter: ReturnType<typeof createBridgedEmitter>,
  eventName: string,
) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return (projectId: string): void => {
    if (pending.has(projectId)) return;
    const timer = setTimeout(() => {
      pending.delete(projectId);
      emitter.emit(eventName, { projectId });
    }, ROOM_INVALIDATION_COALESCE_MS);
    timer.unref?.();
    pending.set(projectId, timer);
  };
}

/**
 * Coalesce retained-work mutations into a pointer-only room invalidation.
 * Consumers always repair through the authoritative agent-work poll endpoint.
 */
export const queueAgentWorkInvalidation = createRoomInvalidationQueue(
  agentWorkEvents,
  "agent_work:invalidated",
);

/**
 * Coalesce committed delegation mutations into a pointer-only room hint.
 * Host authority is always repaired through the authenticated exact routes.
 */
export const queueExecutionDelegationInvalidation = createRoomInvalidationQueue(
  executionDelegationEvents,
  "execution_delegation:invalidated",
);

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
    publisher_agent_key?: string | null;
    publisher_agent_session_id?: string | null;
    account_id?: string | null;
    account_agent_routing?: boolean;
    with_created_message_in_transaction?: (tx: MessageCreateTransaction) => Promise<void>;
  }
): Promise<Message> {
  const {
    message,
    canonical_message: canonicalMessage,
    created,
    recipientAgentTargets,
  } = await addMessageWithCreateStatus(projectId, sender, text, {
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    reply_to_message_id: options?.reply_to ?? null,
    thread_root_message_id: options?.thread_root_id ?? null,
    attachments: options?.attachments,
    client_message_id: options?.client_message_id ?? null,
    publisher_agent_key: options?.publisher_agent_key ?? null,
    publisher_agent_session_id: options?.publisher_agent_session_id ?? null,
    account_id: options?.account_id ?? null,
    account_agent_routing: options?.account_agent_routing,
    with_created_message_in_transaction: options?.with_created_message_in_transaction,
  });
  if (created) {
    messageEvents.emit("message:created", {
      projectId,
      message: canonicalMessage,
      recipientAgentTargets: isPromptOnlyAgentMessage(
        canonicalMessage.text,
        canonicalMessage.agent_prompt_kind,
      ) ? recipientAgentTargets ?? [] : [],
    } satisfies MessageCreatedEvent);
  }
  return message;
}
