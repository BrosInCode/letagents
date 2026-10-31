import { computed, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import { createMessageSearchController, type MessageSearchState } from '../../../../shared/message-search-controller.mjs'
import type { MessageSearchResponse } from '../../../../shared/message-search.mjs'
import type { MessageSearchHit } from '../../../../shared/ui/MessageSearchResults.vue'
import { apiFetch, roomPath } from './room/api'
import { resolveAgentIdentity } from './room/identity'
import type { RoomMessage } from './room/types'

/**
 * Search the room's whole history on the server while the header search has a
 * query. The message list keeps highlighting the matches already on screen;
 * this adds every match the room has ever had.
 */
export function useRoomHistorySearch(roomIdentifier: Readonly<Ref<string>>, query: Readonly<Ref<string>>) {
  const controller = createMessageSearchController<RoomMessage>({
    search: (text, before): Promise<MessageSearchResponse<RoomMessage>> => {
      const params = new URLSearchParams({ q: text.trim() })
      if (before) params.set('before', before)
      return apiFetch(`${roomPath(roomIdentifier.value)}/messages/search?${params}`)
    },
    onChange: () => { state.value = controller.state },
  })
  const state = shallowRef<MessageSearchState<RoomMessage>>(controller.state)

  watch(
    () => [roomIdentifier.value, query.value] as const,
    ([room, text], previous) => {
      // Another room's results must never show under this room's search.
      if (previous && previous[0] !== room) controller.reset()
      if (room) controller.setQuery(text)
      else controller.reset()
    },
    { immediate: true },
  )
  onScopeDispose(() => controller.reset())

  const hits = computed<MessageSearchHit[]>(() => state.value.hits.map((message) => ({
    id: message.id,
    sender: resolveAgentIdentity(message.sender, message.agent_identity).displayName || message.sender,
    timestamp: message.timestamp,
    text: message.display_text || message.text,
  })))

  return { state, hits, loadMore: () => controller.loadMore() }
}
