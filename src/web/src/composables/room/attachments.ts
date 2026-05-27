import { apiFetch, roomPath } from './api'
import type {
  AttachmentUploadTarget,
  OutgoingMessageAttachment,
  StagedMessageAttachment,
} from './types'

export async function prepareMessageAttachments(
  roomIdentifier: string,
  attachments: OutgoingMessageAttachment[],
): Promise<StagedMessageAttachment[]> {
  const prepared: StagedMessageAttachment[] = []
  for (const attachment of attachments) {
    if (attachment.upload_id) {
      prepared.push({ upload_id: attachment.upload_id })
      continue
    }

    prepared.push(await stageAttachmentUpload(roomIdentifier, attachment))
  }
  return prepared
}

export function resolveAttachmentUploadTarget(target: AttachmentUploadTarget): {
  uploadId: string
  uploadUrl: string
} {
  const uploadId =
    target.upload_id ||
    target.attachment?.upload_id ||
    target.attachment_id ||
    target.attachment?.attachment_id ||
    target.id ||
    target.attachment?.id
  const uploadUrl = target.upload_url || target.url
  if (!uploadId || !uploadUrl) {
    throw new Error('Attachment upload target is incomplete.')
  }
  return { uploadId, uploadUrl }
}

export async function stageAttachmentUpload(
  roomIdentifier: string,
  attachment: OutgoingMessageAttachment,
  signal?: AbortSignal,
): Promise<StagedMessageAttachment> {
  if (!attachment.file) {
    throw new Error('Attachment file is missing.')
  }

  let uploadId: string | null = null
  try {
    const target = (await apiFetch(
      `${roomPath(roomIdentifier)}/attachments/uploads`,
      {
        method: 'POST',
        body: JSON.stringify({
          file_name: attachment.file_name,
          mime_type: attachment.mime_type,
          size_bytes: attachment.size_bytes,
        }),
        signal,
      },
    )) as AttachmentUploadTarget

    const resolved = resolveAttachmentUploadTarget(target)
    uploadId = resolved.uploadId

    const headers: Record<string, string> = {
      ...(target.headers || {}),
    }
    if (
      !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    ) {
      headers['Content-Type'] =
        attachment.mime_type || 'application/octet-stream'
    }

    const uploadRes = await fetch(resolved.uploadUrl, {
      method: target.method || 'PUT',
      headers,
      body: attachment.file,
      signal,
    })
    if (!uploadRes.ok) {
      throw new Error(`Attachment upload failed with HTTP ${uploadRes.status}.`)
    }

    return { upload_id: resolved.uploadId }
  } catch (error) {
    if (uploadId) {
      void discardAttachmentUpload(roomIdentifier, uploadId).catch(() => {})
    }
    throw error
  }
}

export async function discardAttachmentUpload(
  roomIdentifier: string,
  uploadId: string,
): Promise<void> {
  await apiFetch(
    `${roomPath(roomIdentifier)}/attachments/uploads/${encodeURIComponent(uploadId)}`,
    {
      method: 'DELETE',
    },
  )
}
