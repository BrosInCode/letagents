import { onScopeDispose, ref, watch, type Ref } from 'vue'

import { REPO_ACCESS_UNAVAILABLE } from '@/composables/room/membership'
import type { RoomJoinError } from '@/composables/useRoom'

const FIRST_RETRY_MS = 30_000
const MAX_RETRY_MS = 5 * 60_000

/** The wait before try `attempt` + 1: at least what the server asked, doubling from 30 s up to 5 min. */
export function repoAccessRetryDelay(attempt: number, retryAfterMs: number | null): number {
  const backoff = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_RETRY_MS)
}

/**
 * When GitHub gives no answer to a repository role check, the join is not
 * refused: the room page tries it again on its own, with a growing wait, and
 * says when. The Retry button still tries at once.
 */
export function useRepoAccessRetry(input: {
  joinError: Readonly<Ref<RoomJoinError | null>>
  isConnected: Readonly<Ref<boolean>>
  retry: () => Promise<unknown>
}) {
  const nextRetryAt = ref<number | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let failingRoom: string | null = null

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
    nextRetryAt.value = null
  }

  watch(input.joinError, (error) => {
    clearTimer()
    if (error?.code !== REPO_ACCESS_UNAVAILABLE) {
      // A join in progress clears the error and keeps the count; any other error ends the run.
      if (error) {
        attempt = 0
        failingRoom = null
      }
      return
    }
    if (error.roomId !== failingRoom) {
      attempt = 0
      failingRoom = error.roomId
    }
    const delay = repoAccessRetryDelay(attempt, error.retryAfterMs)
    nextRetryAt.value = Date.now() + delay
    timer = setTimeout(() => {
      timer = null
      nextRetryAt.value = null
      attempt += 1
      void input.retry()
    }, delay)
  })

  watch(input.isConnected, (connected) => {
    if (!connected) return
    attempt = 0
    failingRoom = null
  })

  onScopeDispose(clearTimer)

  return { nextRetryAt }
}
