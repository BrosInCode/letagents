import {
  ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS,
  type RoomJoinRequestSummary,
} from '../../../../../shared/room-membership.mjs'

export type JoinRequestView =
  | { kind: 'main_room_only' }
  | { kind: 'ask'; previouslyDeclined: boolean }
  | { kind: 'pending'; requestId: string; askedAt: string }
  | { kind: 'declined'; retryAt: number }

/** When a declined person can ask the same room again, as epoch ms, or null if unknown. */
export function joinRequestRetryAt(request: RoomJoinRequestSummary | null): number | null {
  if (!request || request.state !== 'declined') return null
  const retryAfter = request.retry_after ? Date.parse(request.retry_after) : NaN
  if (Number.isFinite(retryAfter)) return retryAfter
  const decidedAt = request.decided_at ? Date.parse(request.decided_at) : NaN
  return Number.isFinite(decidedAt) ? decidedAt + ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS : null
}

/**
 * Picks the screen for a person who is not a member yet. An approved request
 * of a person who is still not a member (they left or were removed) and a
 * cancelled request both lead back to "Ask to join".
 */
export function resolveJoinRequestView(request: RoomJoinRequestSummary | null, now: number): JoinRequestView {
  if (request?.state === 'pending') {
    return { kind: 'pending', requestId: request.id, askedAt: request.created_at }
  }
  if (request?.state === 'declined') {
    const retryAt = joinRequestRetryAt(request)
    if (retryAt !== null && retryAt > now) return { kind: 'declined', retryAt }
    return { kind: 'ask', previouslyDeclined: true }
  }
  return { kind: 'ask', previouslyDeclined: false }
}

export function formatJoinRequestTime(epochMs: number, now: number): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return 'later'
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay
    ? `at ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : `on ${date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}
