import { ref } from 'vue'

export interface MessageReactionInvalidation {
  roomId: string
  tick: number
}

/**
 * Pointer-only bridge from the room stream to the reaction reader. It says
 * which room changed; the reader re-reads the reactions of the messages on
 * screen.
 */
export const lastMessageReactionInvalidation = ref<MessageReactionInvalidation | null>(null)

let tick = 0

export function publishMessageReactionInvalidation(roomId: string): void {
  tick += 1
  lastMessageReactionInvalidation.value = { roomId, tick }
}
