import type { RoomMessage, RoomMessageAttachment } from '@/composables/useRoom'

export interface MessageImageAttachment {
  id: string
  messageId: string
  attachment: RoomMessageAttachment
  href: string
  name: string
  mimeType: string
  sizeBytes: number
  metaLabel: string
  sender: string
  timestamp: string
}

export function attachmentName(attachment: RoomMessageAttachment): string {
  return attachment.file_name || attachment.filename || attachment.name || 'attachment'
}

export function attachmentMimeType(attachment: RoomMessageAttachment): string {
  return attachment.mime_type || attachment.content_type || 'application/octet-stream'
}

export function attachmentSize(attachment: RoomMessageAttachment): number {
  return Number(attachment.size_bytes ?? attachment.byte_size ?? 0)
}

export function attachmentHref(attachment: RoomMessageAttachment): string {
  if (attachment.url) return attachment.url
  if (attachment.download_url) return attachment.download_url
  if (attachment.data_url) return attachment.data_url
  if (attachment.content_base64) {
    return `data:${attachmentMimeType(attachment)};base64,${attachment.content_base64}`
  }
  return '#'
}

export function isImageAttachment(attachment: RoomMessageAttachment): boolean {
  return attachmentMimeType(attachment).startsWith('image/') && attachmentHref(attachment) !== '#'
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1
  return `${size.toFixed(precision)} ${units[unitIndex]}`
}

export function attachmentMeta(attachment: RoomMessageAttachment): string {
  return [attachmentMimeType(attachment), formatAttachmentSize(attachmentSize(attachment))]
    .filter(Boolean)
    .join(' · ')
}

export function attachmentKey(attachment: RoomMessageAttachment): string {
  return attachment.id || `${attachmentName(attachment)}-${attachmentSize(attachment)}-${attachmentMimeType(attachment)}`
}

export function imageAttachmentId(messageId: string, attachment: RoomMessageAttachment): string {
  return `${messageId}:${attachmentKey(attachment)}`
}

export function collectMessageImageAttachments(messages: readonly RoomMessage[]): MessageImageAttachment[] {
  const images: MessageImageAttachment[] = []
  for (const message of messages) {
    for (const attachment of message.attachments || []) {
      if (!isImageAttachment(attachment)) continue
      images.push({
        id: imageAttachmentId(message.id, attachment),
        messageId: message.id,
        attachment,
        href: attachmentHref(attachment),
        name: attachmentName(attachment),
        mimeType: attachmentMimeType(attachment),
        sizeBytes: attachmentSize(attachment),
        metaLabel: attachmentMeta(attachment),
        sender: message.sender,
        timestamp: message.timestamp,
      })
    }
  }
  return images
}
