import { ref } from 'vue'

export interface MessageInfoInvalidation {
  roomId: string
  /** null means the whole room was invalidated (server-side id cap overflow). */
  messageIds: string[] | null
  tick: number
}

/**
 * Module-level signal bridging the room SSE stream to an open Message info
 * card. Invalidation-only: consumers repair through the GET endpoint.
 */
export const lastMessageInfoInvalidation = ref<MessageInfoInvalidation | null>(null)

let tick = 0

export function publishMessageInfoInvalidation(roomId: string, messageIds: string[] | null): void {
  tick += 1
  lastMessageInfoInvalidation.value = { roomId, messageIds, tick }
}

export function invalidationCoversMessage(
  invalidation: MessageInfoInvalidation | null,
  roomId: string,
  messageId: string,
): boolean {
  if (!invalidation || invalidation.roomId !== roomId) return false
  return invalidation.messageIds === null || invalidation.messageIds.includes(messageId)
}
