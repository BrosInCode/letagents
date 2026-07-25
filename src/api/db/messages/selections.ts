import { message_attachment_uploads, message_attachments, messages } from "../schema.js";

export const messageRowSelection = {
  room_id: messages.room_id,
  number: messages.number,
  reply_to_number: messages.reply_to_number,
  thread_root_number: messages.thread_root_number,
  sender: messages.sender,
  text: messages.text,
  agent_prompt_kind: messages.agent_prompt_kind,
  source: messages.source,
  client_message_id: messages.client_message_id,
  publisher_agent_key: messages.publisher_agent_key,
  publisher_agent_session_id: messages.publisher_agent_session_id,
  publisher_account_id: messages.publisher_account_id,
  routing_snapshot_version: messages.routing_snapshot_version,
  timestamp: messages.timestamp,
};

export const messageReplySelection = {
  number: messages.number,
  sender: messages.sender,
  text: messages.text,
  source: messages.source,
  timestamp: messages.timestamp,
};

export const messageAttachmentSelection = {
  room_id: message_attachments.room_id,
  message_number: message_attachments.message_number,
  attachment_number: message_attachments.attachment_number,
  upload_id: message_attachments.upload_id,
  filename: message_attachments.filename,
  content_type: message_attachments.content_type,
  byte_size: message_attachments.byte_size,
  storage_provider: message_attachments.storage_provider,
  bucket: message_attachments.bucket,
  object_key: message_attachments.object_key,
  created_at: message_attachments.created_at,
};

export const messageAttachmentUploadSelection = {
  upload_id: message_attachment_uploads.upload_id,
  room_id: message_attachment_uploads.room_id,
  filename: message_attachment_uploads.filename,
  content_type: message_attachment_uploads.content_type,
  byte_size: message_attachment_uploads.byte_size,
  storage_provider: message_attachment_uploads.storage_provider,
  bucket: message_attachment_uploads.bucket,
  object_key: message_attachment_uploads.object_key,
  status: message_attachment_uploads.status,
  expires_at: message_attachment_uploads.expires_at,
  attached_message_number: message_attachment_uploads.attached_message_number,
  created_at: message_attachment_uploads.created_at,
  attached_at: message_attachment_uploads.attached_at,
};
