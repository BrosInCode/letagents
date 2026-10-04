import { ref, watch } from 'vue'
import type { RoomAgentPresence, RoomMessage } from '@/composables/useRoom'
import { sameMotionAgent } from '../../../../../shared/ui/room-message-motion'

interface RoomWorkIndicator {
  id: string; session: string | null; key: string | null; name: string;
  summary: string; after: string | null; retired: boolean;
  retiredAfter?: string; retiredAt?: number;
}
const messageIdentity = (message: RoomMessage) => ({
  session: message.agent_identity?.agent_session_id, key: message.agent_identity?.agent_key,
})
const timestamp = (value: string) => Date.parse(value) || 0
/** Presence is already public room state. Retire only the matching agent's turn. */
export function useRoomWorkIndicators(
  presence: () => readonly RoomAgentPresence[], messages: () => readonly RoomMessage[], scope: () => string | undefined,
) {
  const visible = ref<RoomWorkIndicator[]>([])
  const turns = new Map<string, RoomWorkIndicator>()
  watch(scope, () => { turns.clear(); visible.value = [] }, { flush: 'sync' })
  watch([presence, () => messages().map(message => message.id)], () => {
    const active = presence().filter(agent => agent.freshness === 'active' && ['working', 'reviewing'].includes(agent.status) && (agent.agent_session_id || agent.agent_key))
    const ids = new Set(active.map(agent => agent.agent_session_id || agent.agent_key!))
    for (const id of turns.keys()) if (!ids.has(id)) turns.delete(id)
    const currentMessages = messages()
    for (const agent of active) {
      const id = agent.agent_session_id || agent.agent_key!
      let turn = turns.get(id)
      if (!turn) {
        turn = { id, session: agent.agent_session_id, key: agent.agent_key, name: agent.display_name,
          summary: '', after: currentMessages.at(-1)?.id || null, retired: false }
        turns.set(id, turn)
      }
      turn.summary = (agent.status_text || (agent.status === 'reviewing' ? 'Reviewing the work' : 'Thinking through the request'))
        .replace(/\s+/g, ' ').trim().slice(0, 100)
      if (turn.retired) {
        const replyIndex = currentMessages.findIndex(message => message.id === turn!.retiredAfter)
        // Polling can miss idle between turns. Require a new conversation request
        // AND newer server-stamped work; a heartbeat alone cannot revive old work.
        const request = replyIndex < 0 ? undefined : currentMessages.slice(replyIndex + 1).reverse().find(message =>
          ['browser', 'agent'].includes(message.source || '') && !sameMotionAgent(turn!, messageIdentity(message)))
        if (!request || !timestamp(request.timestamp)
          || timestamp(agent.updated_at) <= Math.max(timestamp(request.timestamp), turn.retiredAt || 0)) continue
        turn.after = request.id
        turn.retired = false
      }
      const start = turn.after ? currentMessages.findIndex(message => message.id === turn!.after) : -1
      const reply = (!turn.after || start >= 0) && currentMessages.slice(start + 1)
        .reverse().find(message => sameMotionAgent(turn!, messageIdentity(message)))
      if (reply) {
        turn.retired = true
        turn.retiredAfter = reply.id
        turn.retiredAt = Math.max(timestamp(reply.timestamp), timestamp(agent.updated_at))
      }
    }
    visible.value = [...turns.values()].filter(turn => !turn.retired).map(turn => ({ ...turn }))
  }, { immediate: true })
  return visible
}
