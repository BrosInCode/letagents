import { prepareMessageAttachments } from './attachments'
import { apiFetch, roomPath } from './api'
import { fetchMessages, mergeMessages } from './data'
import { isVisibleRoomMessage } from './identity'
import {
  appendRoomMessage,
  isLoadingOlderMessages,
  lastSendError,
  messages,
  messagesHasOlder,
  replaceRoomMessages,
  room,
} from './state'
import type { OutgoingMessageAttachment } from './types'

export function createRoomMessageActions() {
  async function sendMessage(
    text: string,
    sender?: string,
    agentPromptKind?: string | null,
    replyTo?: string | null,
    attachments: OutgoingMessageAttachment[] = [],
    threadRootId?: string | null,
    onSent?: (messageId: string) => void,
  ): Promise<boolean> {
    if (!room.value) return false
    const sendingRoom = room.value
    const roomIdentifier = sendingRoom.identifier
    lastSendError.value = ''
    try {
      const preparedAttachments = attachments.length
        ? await prepareMessageAttachments(roomIdentifier, attachments)
        : []
      const body: Record<string, unknown> = {
        text,
        sender: sender || 'anonymous',
      }
      if (agentPromptKind) {
        body.agent_prompt_kind = agentPromptKind
      }
      if (replyTo) {
        body.reply_to = replyTo
        // A bare reply_to is a top-level quote-reply by design. Replies made to a
        // message that lives inside a thread must carry the thread root so the
        // reply stays in that thread instead of starting a new top-level exchange.
        if (threadRootId) {
          body.thread_root_id = threadRootId
        }
      }
      if (preparedAttachments.length) {
        body.attachments = preparedAttachments
      }
      const msg = await apiFetch(`${roomPath(roomIdentifier)}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (room.value !== sendingRoom) return true
      if (msg?.id && isVisibleRoomMessage(msg)) {
        onSent?.(msg.id)
        appendRoomMessage(msg)
      }
      return true
    } catch (error) {
      if (room.value !== sendingRoom) return false
      const message = error instanceof Error ? error.message.trim() : ''
      lastSendError.value = /attachment object storage is not configured/i.test(
        message,
      )
        ? 'Attachments are unavailable right now.'
        : message || 'Message could not be sent.'
      return false
    }
  }

  async function loadOlderMessages(): Promise<boolean> {
    if (!room.value || isLoadingOlderMessages.value || !messagesHasOlder.value) {
      return false
    }

    const firstMessageId = messages.value[0]?.id
    if (!firstMessageId) {
      return false
    }

    isLoadingOlderMessages.value = true
    try {
      const page = await fetchMessages(room.value.identifier, firstMessageId)
      replaceRoomMessages(mergeMessages(messages.value, page.messages))
      messagesHasOlder.value = page.hasOlder
      return page.messages.length > 0
    } finally {
      isLoadingOlderMessages.value = false
    }
  }

  return {
    loadOlderMessages,
    sendMessage,
  }
}
