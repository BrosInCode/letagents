/**
 * The private messages that should alert, from one conversation list to the
 * next. Same rule as the server push (`canNotifyConversation`): the latest
 * message of a conversation, new since the previous list, sent by someone
 * else, still unread, in a conversation the person has not muted or archived.
 * A list with no previous one alerts nothing: those messages came before the
 * app was watching.
 */
export function newIncomingConversationMessages(previous, next, accountId) {
  if (!previous) return [];
  const seen = new Map(previous.map((conversation) => [conversation.id, conversation.last_message?.number ?? 0]));
  return next.flatMap((conversation) => {
    const message = conversation.last_message;
    if (!message || message.sender_account_id === accountId) return [];
    if (conversation.muted || conversation.archived || !(conversation.unread_count > 0)) return [];
    if (message.number <= (seen.get(conversation.id) ?? 0)) return [];
    return [{ conversation, message }];
  });
}

/** The server push's words for a private message: the sender, and no message text. */
export function conversationAlertText(conversation, message) {
  const sender = conversation.members.find((member) => member.id === message.sender_account_id);
  return {
    title: sender?.display_name?.trim() || sender?.login || "Someone",
    body: conversation.accepted ? "Sent you a private message" : "Sent you a message request",
  };
}
