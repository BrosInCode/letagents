import { apiFetch, roomPath } from './api'
import { MAX_LIVE_REASONING_UPDATES } from './constants'
import type { RoomReasoningSession, RoomReasoningUpdate } from './types'

export function reasoningSortValue(session: RoomReasoningSession): number {
  const detailEntries = session.entries || session.updates
  const latestEntry = detailEntries?.[detailEntries.length - 1]
  const latestTimestamp = latestEntry
    ? 'timestamp' in latestEntry
      ? latestEntry.timestamp
      : latestEntry.created_at
    : null
  const timestamp =
    session.updated_at || session.created_at || latestTimestamp || ''
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : -1
}

export function sortReasoningSessions(
  sessions: readonly RoomReasoningSession[],
): RoomReasoningSession[] {
  return [...sessions].sort((left, right) => {
    const byTime = reasoningSortValue(right) - reasoningSortValue(left)
    if (byTime !== 0) return byTime
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

export function sortReasoningUpdates(
  updates: readonly RoomReasoningUpdate[],
): RoomReasoningUpdate[] {
  return [...updates].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '')
    const rightTime = Date.parse(right.created_at || '')
    if (
      Number.isFinite(leftTime) &&
      Number.isFinite(rightTime) &&
      leftTime !== rightTime
    ) {
      return leftTime - rightTime
    }
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

export function mergeReasoningUpdates(
  existing: readonly RoomReasoningUpdate[] | null | undefined,
  incoming: readonly RoomReasoningUpdate[] | null | undefined,
  appended: RoomReasoningUpdate | null | undefined,
): RoomReasoningUpdate[] {
  const merged = new Map<string, RoomReasoningUpdate>()

  for (const update of existing || []) {
    if (update?.id) merged.set(update.id, update)
  }
  for (const update of incoming || []) {
    if (update?.id) merged.set(update.id, update)
  }
  if (appended?.id) {
    merged.set(appended.id, appended)
  }

  const sorted = sortReasoningUpdates([...merged.values()])
  if (sorted.length <= MAX_LIVE_REASONING_UPDATES) {
    return sorted
  }
  return sorted.slice(-MAX_LIVE_REASONING_UPDATES)
}

export function mergeReasoningSession(
  existing: RoomReasoningSession,
  incoming: RoomReasoningSession,
  appendedUpdate?: RoomReasoningUpdate | null,
): RoomReasoningSession {
  const mergedUpdates = mergeReasoningUpdates(
    existing.updates,
    incoming.updates,
    appendedUpdate,
  )
  const mergedEntries =
    Array.isArray(incoming.entries) && incoming.entries.length > 0
      ? incoming.entries
      : Array.isArray(existing.entries) && existing.entries.length > 0
        ? existing.entries
        : (incoming.entries ?? existing.entries)

  return {
    ...existing,
    ...incoming,
    ...(mergedEntries !== undefined ? { entries: mergedEntries } : {}),
    ...(mergedUpdates.length > 0 ? { updates: mergedUpdates } : {}),
  }
}

export async function fetchReasoningSessions(
  roomIdentifier: string,
): Promise<RoomReasoningSession[]> {
  const paths = [
    `${roomPath(roomIdentifier)}/reasoning-sessions`,
    `${roomPath(roomIdentifier)}/reasoning`,
  ]

  for (const path of paths) {
    try {
      const data = await apiFetch(path)
      const sessions = Array.isArray(data.sessions)
        ? data.sessions
        : Array.isArray(data.reasoning_sessions)
          ? data.reasoning_sessions
          : []
      return sortReasoningSessions(sessions)
    } catch {
      continue
    }
  }

  return []
}
