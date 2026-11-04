import { onScopeDispose, ref, watch, type Ref } from 'vue'

import { REPO_ACCESS_UNAVAILABLE } from '@/composables/room/membership'
import type { RoomJoinError } from '@/composables/useRoom'

const FIRST_RETRY_MS = 30_000
const MAX_RETRY_MS = 5 * 60_000

/** The wait before try `attempt` + 1: doubling from 30 s, at least the server's Retry-After, never above 5 min. */
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
  /** True once a join fully opened the room (its first reads all answered). */
  roomOpened: Readonly<Ref<boolean>>
  retry: () => Promise<unknown>
}) {
  const nextRetryAt = ref<number | null>(null)
  /** Automatic tries that came back with the same answer, for this room. */
  const failedRetries = ref(0)
  let timer: ReturnType<typeof setTimeout> | null = null
  let failingRoom: string | null = null

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
    nextRetryAt.value = null
  }

  function endRun() {
    failedRetries.value = 0
    failingRoom = null
  }

  watch(input.joinError, (error) => {
    clearTimer()
    if (error?.code !== REPO_ACCESS_UNAVAILABLE) {
      // A join in progress clears the error and keeps the count; any other error ends the run.
      if (error) endRun()
      return
    }
    if (error.roomId !== failingRoom) {
      endRun()
      failingRoom = error.roomId
    }
    const delay = repoAccessRetryDelay(failedRetries.value, error.retryAfterMs)
    nextRetryAt.value = Date.now() + delay
    timer = setTimeout(() => {
      timer = null
      nextRetryAt.value = null
      failedRetries.value += 1
      void input.retry()
    }, delay)
  })

  // Any join that fully opened the room ends the run: an automatic try, Retry,
  // or another route. The live stream can open before a first read gets the
  // same 503, so the connection state is not the signal.
  watch(input.roomOpened, (opened) => {
    if (opened) endRun()
  })

  onScopeDispose(clearTimer)

  return { nextRetryAt, failedRetries }
}
