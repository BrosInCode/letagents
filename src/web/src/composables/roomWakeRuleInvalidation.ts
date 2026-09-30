import { ref } from 'vue'

export interface WakeRuleInvalidation {
  roomId: string
  tick: number
}

/**
 * Pointer-only bridge from the room stream (and local cancel/undo) to the
 * wake-rule reader. It says which room changed; readers re-read the rules.
 */
export const lastWakeRuleInvalidation = ref<WakeRuleInvalidation | null>(null)

let tick = 0

export function publishWakeRuleInvalidation(roomId: string): void {
  tick += 1
  lastWakeRuleInvalidation.value = { roomId, tick }
}
