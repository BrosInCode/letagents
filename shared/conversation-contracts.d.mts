export interface ConversationPerson {
  id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}
export interface ConversationMember extends ConversationPerson {
  accepted: boolean;
  blocked: boolean;
}
export interface ConversationMessage {
  conversation_id: string;
  number: number;
  sender_account_id: string;
  client_message_id: string;
  text: string;
  created_at: string;
}
export interface Conversation {
  id: string;
  created_by: string;
  members: ConversationMember[];
  accepted: boolean;
  muted: boolean;
  archived: boolean;
  can_send: boolean;
  unread_count: number;
  last_message: ConversationMessage | null;
  updated_at: string;
}
export interface ConversationList {
  conversations: Conversation[];
  version: string;
}
export interface ConversationApi {
  list(): Promise<ConversationList>;
  people(query: string): Promise<{ people: ConversationPerson[] }>;
  create(
    accountIds: string[],
    fromConversationId?: string,
  ): Promise<{ conversation_id: string }>;
  messages(
    id: string,
    cursor?: { before?: number; after?: number },
  ): Promise<{ messages: ConversationMessage[]; has_more: boolean }>;
  send(
    id: string,
    text: string,
    clientMessageId: string,
  ): Promise<ConversationMessage>;
  update(
    id: string,
    changes: {
      accept?: boolean;
      last_read_number?: number;
      muted?: boolean;
      archived?: boolean;
    },
  ): Promise<void>;
  block(accountId: string, blocked: boolean): Promise<void>;
  changes(after: string): Promise<{ version: string }>;
}
