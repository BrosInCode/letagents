import { prepareMessageAttachments } from './attachments'
import { apiFetch, roomPath } from './api'
import { fetchMessages, mergeMessages } from './data'
import { isPromptOnlyRoomMessage } from './identity'
import {
  isLoadingOlderMessages,
  lastSendError,
  messages,
  messagesHasOlder,
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
  ): Promise<boolean> {
    if (!room.value) return false
    lastSendError.value = ''
    try {
      const preparedAttachments = attachments.length
        ? await prepareMessageAttachments(room.value.identifier, attachments)
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
      const msg = await apiFetch(`${roomPath(room.value.identifier)}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (
        msg?.id &&
        !isPromptOnlyRoomMessage(msg) &&
        !messages.value.some((m) => m.id === msg.id)
      ) {
        messages.value = [...messages.value, msg]
      }
      return true
    } catch (error) {
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
      messages.value = mergeMessages(messages.value, page.messages)
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
