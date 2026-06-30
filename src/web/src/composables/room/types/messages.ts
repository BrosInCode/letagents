export interface MessageReplyReference {
  id: string
  sender: string
  text: string
  source: string | null
  timestamp: string
}

export interface RoomMessageThreadSummary {
  root_message_id: string
  reply_count: number
  unread_count: number
  has_unread: boolean
  latest_reply: MessageReplyReference | null
  last_read_message_id: string | null
}

export interface RoomMessageAttachment {
  id?: string | null
  name?: string | null
  file_name?: string | null
  filename?: string | null
  mime_type?: string | null
  content_type?: string | null
  size_bytes?: number | null
  byte_size?: number | null
  url?: string | null
  download_url?: string | null
  data_url?: string | null
  content_base64?: string | null
}

export interface OutgoingMessageAttachment {
  file_name: string
  mime_type: string
  size_bytes: number
  file?: File | null
  upload_id?: string | null
}

export interface StagedMessageAttachment {
  upload_id: string
}

export interface AttachmentUploadTarget {
  upload_id?: string
  attachment_id?: string
  id?: string
  upload_url?: string
  url?: string
  method?: string
  fields?: Record<string, string>
  headers?: Record<string, string>
  attachment?: {
    upload_id?: string
    attachment_id?: string
    id?: string
  }
}

export interface RoomMessage {
  id: string
  sender: string
  text: string
  attachments?: readonly RoomMessageAttachment[]
  agent_prompt_kind?: string | null
  source: string | null
  timestamp: string
  thread_root_id?: string | null
  thread_reply_to_id?: string | null
  thread?: RoomMessageThreadSummary | null
  reply_to?: MessageReplyReference | null
  agent_identity?: {
    name: string
    display_name: string
    owner_label: string
    owner_attribution: string
    ide_label: string
    actor_label: string
  } | null
}

export interface MessagePage {
  messages: RoomMessage[]
  hasOlder: boolean
}
