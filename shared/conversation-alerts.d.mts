import type { Conversation, ConversationMessage } from "./conversation-contracts.mjs";

export interface IncomingConversationMessage {
  conversation: Conversation;
  message: ConversationMessage;
}
export declare function newIncomingConversationMessages(
  previous: readonly Conversation[] | null,
  next: readonly Conversation[],
  accountId: string,
): IncomingConversationMessage[];
export declare function conversationAlertText(
  conversation: Conversation,
  message: ConversationMessage,
): { title: string; body: string };
