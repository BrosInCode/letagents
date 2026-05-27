import type { RoomReasoningSession } from '@/composables/useRoom'

export function previewMessage(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'No message body'
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

export function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : -1
}

export function latestTimestamp(
  ...values: Array<string | null | undefined>
): string | null {
  let best: string | null = null
  let bestValue = -1
  for (const value of values) {
    const current = timestampValue(value)
    if (current > bestValue) {
      best = value || null
      bestValue = current
    }
  }
  return best
}

export function sortTasksByUpdated<T extends { updated_at: string }>(
  tasks: readonly T[],
): T[] {
  return [...tasks].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  )
}

export function latestTaskTimestamp(
  tasks: readonly { updated_at: string }[],
): string | null {
  return sortTasksByUpdated(tasks)[0]?.updated_at || null
}

export function reasoningTimestamp(
  session: Partial<RoomReasoningSession> | null | undefined,
): string | null {
  if (!session) return null
  return (
    session.updated_at ||
    session.created_at ||
    session.entries?.[session.entries.length - 1]?.timestamp ||
    null
  )
}

export function sortReasoningSessions(
  sessions: readonly RoomReasoningSession[],
): RoomReasoningSession[] {
  return [...sessions].sort(
    (left, right) =>
      timestampValue(reasoningTimestamp(right)) -
      timestampValue(reasoningTimestamp(left)),
  )
}

export function formatLastSeen(value: string | null): string {
  if (!value) return 'unknown'
  const diffMs = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'unknown'
  }

  const diffMinutes = Math.round(diffMs / 60_000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}
