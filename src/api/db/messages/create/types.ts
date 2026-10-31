/** Types for creating a message: the transaction handle, the send options and the results. */
import type { RoomGif } from "../../../../../shared/room-expressions.mjs";
import type { MessageAttachmentUploader, NormalizedMessageAttachmentReference } from "../../../messages/attachments.js";
import type { AgentPromptKind } from "../../../../shared/room-agent-prompts.js";
import type { AgentMessageActivationReason } from "../../../../shared/activation-routing.js";
import type { db } from "../../client.js";
import type { Message, MessageMentionNotice, MessageRecipientAgentTarget, MessageRow } from "../../types.js";

/** The transaction handle message creation runs in, for atomic side effects. */
export type MessageCreateTransaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export interface AddMessageOptions {
  source?: string;
  display_text?: string | null;
  agent_prompt_kind?: AgentPromptKind | null;
  reply_to_message_id?: string | null;
  thread_root_message_id?: string | null;
  attachments?: NormalizedMessageAttachmentReference[];
  /** The request credential; only its own (or unowned legacy) uploads attach. */
  attachment_uploader?: MessageAttachmentUploader | null;
  gif?: RoomGif | null;
  client_message_id?: string | null;
  publisher_agent_key?: string | null;
  publisher_agent_session_id?: string | null;
  account_id?: string | null;
  account_agent_routing?: boolean;
  /**
   * Accounts to notify by desktop push even when they have no recents row for
   * the room (for example a GitHub review request). Resolved and access-checked by the caller.
   */
  notify_account_ids?: readonly string[];
  /**
   * Accounts that get a recents row for the room in the message transaction.
   * Only accounts whose room access was allowed belong here.
   */
  recents_account_ids?: readonly string[];
  /**
   * Runs inside the message-insert transaction after the row is created, so
   * callers can persist state that must be atomic with message creation
   * (e.g. liveness announcement markers). A throw rolls the message back too.
   * Not invoked on the idempotent-replay path: a deduped message means a
   * prior transaction already committed both the message and this side
   * effect together.
   */
  with_created_message_in_transaction?: (tx: MessageCreateTransaction, message: MessageRow) => Promise<void>;
  /**
   * A system notice for exactly one agent. Routing is skipped: this agent
   * receives the only receipt, with this reason, and nobody else is woken or
   * notified. When the agent has no live session the receipt goes to its
   * latest one, which its next session inherits.
   */
  addressed_to?: { agent_key: string; reason: AgentMessageActivationReason };
}

export interface AddMessageResult {
  message: Message;
  canonical_message: Message;
  created: boolean;
  /** Durable recipients resolved in the same transaction as the message. */
  recipientAgentKeys: readonly string[];
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
}
export interface AddMessageTransactionResult {
  messageRow: MessageRow;
  created: boolean;
  recipientAgentKeys: readonly string[];
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
  mentionNotices?: readonly MessageMentionNotice[];
}
