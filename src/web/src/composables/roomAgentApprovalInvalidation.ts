import { ref } from 'vue'

export interface AgentApprovalInvalidation {
  roomId: string
  tick: number
}

/** Pointer-only bridge from the room stream to the authoritative approval reader. */
export const lastAgentApprovalInvalidation = ref<AgentApprovalInvalidation | null>(null)

let tick = 0

export function publishAgentApprovalInvalidation(roomId: string): void {
  tick += 1
  lastAgentApprovalInvalidation.value = { roomId, tick }
}
