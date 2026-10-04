import { ref, watch } from 'vue'
import type { RoomAgentPresence, RoomMessage } from '@/composables/useRoom'
import { sameMotionAgent } from '../../../../../shared/ui/room-message-motion'

interface RoomWorkIndicator {
  id: string; session: string | null; key: string | null; name: string;
  summary: string; after: string | null; retired: boolean;
}
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
      const start = turn.after ? currentMessages.findIndex(message => message.id === turn!.after) : -1
      if ((!turn.after || start >= 0) && currentMessages.slice(start + 1).some(message => sameMotionAgent(turn!, {
        session: message.agent_identity?.agent_session_id, key: message.agent_identity?.agent_key,
      }))) turn.retired = true
    }
    visible.value = [...turns.values()].filter(turn => !turn.retired).map(turn => ({ ...turn }))
  }, { immediate: true })
  return visible
}
