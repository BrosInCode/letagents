import type { OutgoingMessageAttachment } from '@/composables/useRoom'

export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface AttachmentDraft {
  id: string
  name: string
  type: string
  size: number
  file: File
  uploadId: string | null
  uploadState: 'idle' | 'uploading' | 'uploaded' | 'error'
  uploadMessage: string
  abortController: AbortController | null
  previewUrl: string | null
  previewState: 'idle' | 'loading' | 'loaded' | 'error'
}

export type StageAttachmentDraft = (
  roomIdentifier: string,
  attachment: OutgoingMessageAttachment,
  signal?: AbortSignal
) => Promise<{ upload_id: string }>

export type DiscardAttachmentDraft = (
  roomIdentifier: string,
  uploadId: string
) => Promise<void>
