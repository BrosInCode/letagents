import type { AgentPromptKind } from "../../../shared/room-agent-prompts.js";

export interface Message {
  id: string;
  /**
   * Caller-owned idempotency identity. This is intentionally returned with
   * the canonical message so trusted clients can join a durable publication
   * back to the operation that created it.
   */
  client_message_id: string | null;
  sender: string;
  text: string;
  agent_prompt_kind: AgentPromptKind | null;
  source: string | null;
  timestamp: string;
  thread_root_id: string;
  thread_reply_to_id: string | null;
  thread: MessageThreadSummary | null;
  reply_to: MessageReplyReference | null;
  attachments: MessageAttachment[];
}

export interface MessageReplyReference {
  id: string;
  sender: string;
  text: string;
  source: string | null;
  timestamp: string;
}

export interface MessageThreadParticipant {
  sender: string;
  source: string | null;
  message_count: number;
  latest_message_id: string;
}

export interface MessageThreadSummary {
  root_message_id: string;
  reply_count: number;
  unread_count: number;
  has_unread: boolean;
  latest_reply: MessageReplyReference | null;
  participants: MessageThreadParticipant[];
  last_read_message_id: string | null;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  file_name: string;
  content_type: string;
  mime_type: string;
  byte_size: number;
  size_bytes: number;
  download_url: string;
}

export interface MessageAttachmentData extends MessageAttachment {
  storage_provider: string;
  bucket: string;
  object_key: string;
}

export interface MessageAttachmentUpload {
  upload_id: string;
  room_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  status: "pending" | "attached";
  expires_at: string;
  attached_message_number: number | null;
  created_at: string;
  attached_at: string | null;
}

export interface MessageRow {
  room_id: string;
  number: number;
  reply_to_number: number | null;
  thread_root_number: number | null;
  sender: string;
  text: string;
  agent_prompt_kind: string | null;
  source: string | null;
  client_message_id: string | null;
  timestamp: string;
}

export interface MessageThreadReadRow {
  room_id: string;
  thread_root_number: number;
  account_id: string;
  last_read_message_number: number;
  read_at: string;
}

export interface MessageAttachmentRow {
  room_id: string;
  message_number: number;
  attachment_number: number;
  upload_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  created_at: string;
}

export interface MessageAttachmentUploadRow {
  upload_id: string;
  room_id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  storage_provider: string;
  bucket: string;
  object_key: string;
  status: string;
  expires_at: string;
  attached_message_number: number | null;
  created_at: string;
  attached_at: string | null;
}
