import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { KnowledgeRecord } from '../../../../../shared/room-knowledge.mjs'
import { apiFetch, roomPath } from '../../composables/room/api'

/** Only requests waiting for a human answer belong in the room's Needs you action. */
export function useRoomAttention(
  roomId: Readonly<Ref<string | null>>,
  accountId: Readonly<Ref<string | null>>,
  fetcher: typeof apiFetch = apiFetch,
) {
  const count = ref(0), confirmed = ref(false)
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  let request = 0, alive = true, controller: AbortController | null = null
  async function refresh() {
    if (!alive || !roomId.value || !accountId.value || !visible.value) return
    controller?.abort()
    controller = new AbortController()
    const run = ++request, signal = controller.signal
    try {
      const result = await fetcher(`${roomPath(roomId.value)}/attention`, { signal }) as { records: KnowledgeRecord[] }
      if (alive && run === request) {
        count.value = new Set(result.records.filter(record => !record.response && !record.archived).map(record => record.id)).size
        confirmed.value = true
      }
    } catch {
      if (alive && run === request) confirmed.value = false
    }
  }
  watch([roomId, accountId], () => {
    request++; controller?.abort(); count.value = 0; confirmed.value = false
    void refresh()
  }, { immediate: true, flush: 'sync' })
  function visibilityChanged() {
    visible.value = document.visibilityState !== 'hidden'
    if (visible.value) void refresh()
  }
  const timer = setInterval(() => { void refresh() }, 30_000)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged)
  onScopeDispose(() => {
    alive = false; request++; controller?.abort(); clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged)
  })
  return { count, pulse: computed(() => visible.value && confirmed.value && count.value > 0), refresh }
}
