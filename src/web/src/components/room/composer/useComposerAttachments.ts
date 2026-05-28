import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { OutgoingMessageAttachment } from '@/composables/useRoom'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type AttachmentDraft,
  type DiscardAttachmentDraft,
  type StageAttachmentDraft,
} from './types'

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
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

export function useComposerAttachments(input: {
  disabled: ComputedRef<boolean>
  isSending: Ref<boolean>
  attachmentsAvailable: ComputedRef<boolean>
  roomIdentifier: ComputedRef<string>
  stageAttachmentDraft: ComputedRef<StageAttachmentDraft | undefined>
  discardAttachmentDraft: ComputedRef<DiscardAttachmentDraft | undefined>
}) {
  const fileInputEl = ref<HTMLInputElement | null>(null)
  const attachmentDrafts = ref<AttachmentDraft[]>([])
  const attachmentError = ref('')
  const isDragActive = ref(false)
  let dragDepth = 0

  const dropAttachmentsEnabled = computed(() =>
    input.attachmentsAvailable.value && !input.disabled.value && !input.isSending.value
  )
  const eagerUploadsEnabled = computed(() =>
    Boolean(input.stageAttachmentDraft.value && input.roomIdentifier.value && input.attachmentsAvailable.value)
  )
  const hasUploadingAttachments = computed(() =>
    attachmentDrafts.value.some((attachment) => attachment.uploadState === 'uploading')
  )
  const hasFailedAttachments = computed(() =>
    eagerUploadsEnabled.value
      && attachmentDrafts.value.some((attachment) => attachment.uploadState === 'error')
  )

  const attachmentStatusSummary = computed(() => {
    if (hasUploadingAttachments.value) {
      const count = attachmentDrafts.value.filter((attachment) => attachment.uploadState === 'uploading').length
      return count === 1 ? 'Uploading 1 attachment...' : `Uploading ${count} attachments...`
    }
    if (hasFailedAttachments.value) {
      const count = attachmentDrafts.value.filter((attachment) => attachment.uploadState === 'error').length
      return count === 1
        ? 'Remove the failed attachment before sending.'
        : 'Remove the failed attachments before sending.'
    }
    return ''
  })

  function updateAttachmentDraft(id: string, update: (draft: AttachmentDraft) => AttachmentDraft) {
    attachmentDrafts.value = attachmentDrafts.value.map((attachment) =>
      attachment.id === id ? update(attachment) : attachment
    )
  }

  function findAttachmentDraft(id: string): AttachmentDraft | undefined {
    return attachmentDrafts.value.find((attachment) => attachment.id === id)
  }

  function releaseAttachmentPreview(attachment: AttachmentDraft) {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  }

  function describeAttachmentUploadError(error: unknown, fileName: string): string {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return `${fileName} upload was cancelled.`
    }
    const message = error instanceof Error ? error.message.trim() : ''
    if (/attachment object storage is not configured/i.test(message)) {
      return 'Attachments are unavailable right now.'
    }
    return message || `${fileName} could not be uploaded.`
  }

  function attachmentSecondaryText(attachment: AttachmentDraft): string {
    const size = formatFileSize(attachment.size)
    if (attachment.uploadState === 'uploading') {
      return size ? `Uploading... · ${size}` : 'Uploading...'
    }
    if (attachment.uploadState === 'uploaded') {
      return size ? `Ready · ${size}` : 'Ready'
    }
    if (attachment.uploadState === 'error') {
      return size ? `Upload failed · ${size}` : 'Upload failed'
    }
    return size
  }

  function markAttachmentPreviewLoaded(id: string) {
    updateAttachmentDraft(id, (attachment) => ({
      ...attachment,
      previewState: 'loaded',
    }))
  }

  function markAttachmentPreviewError(id: string) {
    updateAttachmentDraft(id, (attachment) => ({
      ...attachment,
      previewState: 'error',
    }))
  }

  async function startAttachmentDraftUpload(id: string) {
    const attachment = findAttachmentDraft(id)
    const stageAttachmentDraft = input.stageAttachmentDraft.value
    if (!attachment || !stageAttachmentDraft || !input.roomIdentifier.value) return

    const abortController = new AbortController()
    updateAttachmentDraft(id, (draft) => ({
      ...draft,
      abortController,
      uploadState: 'uploading',
      uploadMessage: '',
    }))

    try {
      const staged = await stageAttachmentDraft(input.roomIdentifier.value, {
        file_name: attachment.name,
        mime_type: attachment.type,
        size_bytes: attachment.size,
        file: attachment.file,
      }, abortController.signal)

      if (!findAttachmentDraft(id)) return

      updateAttachmentDraft(id, (draft) => ({
        ...draft,
        uploadId: staged.upload_id,
        uploadState: 'uploaded',
        uploadMessage: '',
        abortController: null,
      }))
    } catch (error) {
      if (!findAttachmentDraft(id)) return
      if (abortController.signal.aborted) return

      const uploadMessage = describeAttachmentUploadError(error, attachment.name)
      updateAttachmentDraft(id, (draft) => ({
        ...draft,
        uploadState: 'error',
        uploadMessage,
        uploadId: null,
        abortController: null,
      }))
      attachmentError.value = uploadMessage
    }
  }

  async function discardUploadedAttachment(attachment: AttachmentDraft) {
    const discardAttachmentDraft = input.discardAttachmentDraft.value
    if (!discardAttachmentDraft || !input.roomIdentifier.value || !attachment.uploadId) return
    try {
      await discardAttachmentDraft(input.roomIdentifier.value, attachment.uploadId)
    } catch {
      attachmentError.value = `${attachment.name} could not be removed from draft storage.`
    }
  }

  function openFilePicker() {
    attachmentError.value = ''
    if (input.isSending.value) {
      attachmentError.value = 'Wait for the current send to finish.'
      return
    }
    if (!input.attachmentsAvailable.value) {
      attachmentError.value = 'Attachments are unavailable right now.'
      return
    }
    fileInputEl.value?.click()
  }

  async function handleFileSelection(event: Event) {
    const fileInput = event.target as HTMLInputElement
    const selected = Array.from(fileInput.files || [])
    fileInput.value = ''
    if (!selected.length) return

    await addAttachmentFiles(selected)
  }

  async function addAttachmentFiles(selected: readonly File[]) {
    if (!selected.length) return

    attachmentError.value = ''
    if (input.disabled.value) {
      attachmentError.value = 'Attachments cannot be added right now.'
      return
    }
    if (input.isSending.value) {
      attachmentError.value = 'Wait for the current send to finish.'
      return
    }
    if (!input.attachmentsAvailable.value) {
      attachmentError.value = 'Attachments are unavailable right now.'
      return
    }
    const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachmentDrafts.value.length)
    const acceptedFiles = selected.slice(0, availableSlots)
    if (selected.length > availableSlots) {
      attachmentError.value = `Attach up to ${MAX_ATTACHMENTS} files per message.`
    }

    for (const file of acceptedFiles) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        attachmentError.value = `${file.name} is larger than ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`
        continue
      }
      try {
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
        const id = `${file.name}-${file.size}-${file.lastModified}-${globalThis.crypto?.randomUUID?.() || Date.now()}`
        const draft: AttachmentDraft = {
          id,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          file,
          uploadId: null,
          uploadState: eagerUploadsEnabled.value ? 'uploading' : 'idle',
          uploadMessage: '',
          abortController: null,
          previewUrl,
          previewState: previewUrl ? 'loading' : 'idle',
        }
        attachmentDrafts.value = [
          ...attachmentDrafts.value,
          draft,
        ]
        if (eagerUploadsEnabled.value) {
          void startAttachmentDraftUpload(id)
        }
      } catch {
        attachmentError.value = `${file.name} could not be attached.`
      }
    }
  }

  function dragContainsFiles(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types || [])
    return types.includes('Files')
  }

  function resetDragState() {
    dragDepth = 0
    isDragActive.value = false
  }

  function handleDragEnter(event: DragEvent) {
    if (!dragContainsFiles(event)) return
    event.preventDefault()
    if (!dropAttachmentsEnabled.value) return
    dragDepth += 1
    isDragActive.value = true
  }

  function handleDragOver(event: DragEvent) {
    if (!dragContainsFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = dropAttachmentsEnabled.value ? 'copy' : 'none'
    }
    if (!dropAttachmentsEnabled.value) {
      isDragActive.value = false
      return
    }
    isDragActive.value = true
  }

  function handleDragLeave(event: DragEvent) {
    if (!dragContainsFiles(event)) return
    if (!dropAttachmentsEnabled.value) return
    if (dragDepth > 0) {
      dragDepth -= 1
    }
    if (dragDepth === 0) {
      isDragActive.value = false
    }
  }

  async function handleDrop(event: DragEvent) {
    const dropped = Array.from(event.dataTransfer?.files || [])
    if (dropped.length) {
      event.preventDefault()
    }
    resetDragState()
    if (!dropped.length) return
    await addAttachmentFiles(dropped)
  }

  function removeAttachment(id: string) {
    if (input.isSending.value) return
    const attachment = findAttachmentDraft(id)
    if (!attachment) return

    attachment.abortController?.abort()
    releaseAttachmentPreview(attachment)
    attachmentDrafts.value = attachmentDrafts.value.filter((draft) => draft.id !== id)

    if (attachment.uploadId) {
      void discardUploadedAttachment(attachment)
    }
  }

  function clearAttachments(options: { discardUploads?: boolean } = {}) {
    const drafts = attachmentDrafts.value
    attachmentDrafts.value = []
    const shouldDiscardUploads = Boolean(options.discardUploads && !input.isSending.value)

    for (const attachment of drafts) {
      attachment.abortController?.abort()
      releaseAttachmentPreview(attachment)
      if (shouldDiscardUploads && attachment.uploadId) {
        void discardUploadedAttachment(attachment)
      }
    }
  }

  function buildOutgoingAttachments(): OutgoingMessageAttachment[] {
    return attachmentDrafts.value.map((attachment) => ({
      file_name: attachment.name,
      mime_type: attachment.type,
      size_bytes: attachment.size,
      file: attachment.file,
      upload_id: attachment.uploadId,
    }))
  }

  return {
    fileInputEl,
    attachmentDrafts,
    attachmentError,
    isDragActive,
    dropAttachmentsEnabled,
    hasUploadingAttachments,
    hasFailedAttachments,
    attachmentStatusSummary,
    attachmentSecondaryText,
    markAttachmentPreviewLoaded,
    markAttachmentPreviewError,
    openFilePicker,
    handleFileSelection,
    addAttachmentFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeAttachment,
    clearAttachments,
    buildOutgoingAttachments,
  }
}
