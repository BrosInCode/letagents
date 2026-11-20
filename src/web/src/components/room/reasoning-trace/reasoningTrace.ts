import type {
  RoomReasoningSession,
  RoomReasoningSnapshot,
  RoomReasoningUpdate,
} from '../../../composables/useRoom'
import {
  buildReasoningSnapshot,
  currentReasoningEntry,
  orderTimelineEntries,
  reasoningLabel,
  reasoningUpdateEntry,
  snapshotTimelineEntries,
  type ReasoningTimelineEntry,
} from '../../../../../../shared/ui/reasoning/reasoning-trace'

export {
  classifyReasoningStream,
  type ReasoningStreamState,
  type ReasoningTimelineEntry,
} from '../../../../../../shared/ui/reasoning/reasoning-trace'

export interface ReasoningHighlight {
  label: string
  value: string
}

export function sortReasoningUpdates(updates: readonly RoomReasoningUpdate[]): RoomReasoningUpdate[] {
  return [...updates].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '')
    const rightTime = Date.parse(right.created_at || '')
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime
    }
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

export function mergeReasoningUpdates(
  existing: readonly RoomReasoningUpdate[] | null | undefined,
  incoming: readonly RoomReasoningUpdate[] | null | undefined,
): RoomReasoningUpdate[] {
  const merged = new Map<string, RoomReasoningUpdate>()
  for (const update of existing || []) {
    if (update?.id) merged.set(update.id, update)
  }
  for (const update of incoming || []) {
    if (update?.id) merged.set(update.id, update)
  }
  return sortReasoningUpdates([...merged.values()])
}

export function mergeReasoningSessionDetail(
  existing: RoomReasoningSession,
  incoming: RoomReasoningSession,
): RoomReasoningSession {
  const mergedUpdates = mergeReasoningUpdates(existing.updates, incoming.updates)
  const mergedEntries = Array.isArray(incoming.entries) && incoming.entries.length > 0
    ? incoming.entries
    : Array.isArray(existing.entries) && existing.entries.length > 0
      ? existing.entries
      : incoming.entries ?? existing.entries

  return {
    ...existing,
    ...incoming,
    ...(mergedEntries !== undefined ? { entries: mergedEntries } : {}),
    ...(mergedUpdates.length > 0 ? { updates: mergedUpdates } : {}),
  }
}

export function buildCurrentSnapshot(session: RoomReasoningSession | null): RoomReasoningSnapshot | null {
  if (!session) return null
  return buildReasoningSnapshot<RoomReasoningSnapshot>({
    ...session,
    latestPayload: session.latest_payload,
    nextAction: session.next_action,
  }) as RoomReasoningSnapshot | null
}

export function buildHighlights(
  session: RoomReasoningSession | null,
  snapshot: RoomReasoningSnapshot | null,
): ReasoningHighlight[] {
  if (!session || !snapshot) return []

  const values: Array<[string, string | null | undefined]> = [
    ['Goal', snapshot.goal],
    ['Checking', snapshot.checking],
    ['Hypothesis', snapshot.hypothesis],
    ['Blocker', snapshot.blocker],
    ['Next action', snapshot.next_action],
    ['Milestone', snapshot.milestone],
    ['Visibility', session.visibility],
  ]

  if (typeof snapshot.confidence === 'number') {
    values.push(['Confidence', `${Math.round(snapshot.confidence * 100)}%`])
  }

  return values
    .filter(([, value]) => Boolean(String(value || '').trim()))
    .map(([label, value]) => ({ label, value: String(value) }))
}

export function buildTimelineEntries(
  session: RoomReasoningSession | null,
  snapshot: RoomReasoningSnapshot | null,
  currentLiveTimelineEntry: readonly ReasoningTimelineEntry[],
): ReasoningTimelineEntry[] {
  if (!session) return []

  const detailEntries: ReasoningTimelineEntry[] = Array.isArray(session.entries) && session.entries.length > 0
    ? session.entries.map((entry) => ({
      id: entry.id,
      label: reasoningLabel(entry.label || entry.kind),
      text: entry.text || '',
      timestamp: entry.timestamp,
    }))
    : (session.updates || []).map((update: RoomReasoningUpdate) => reasoningUpdateEntry({
      ...update,
      payloadSummary: update.payload?.summary,
      createdAt: update.created_at,
    }))
  const usable = detailEntries.filter((entry) => Boolean(entry.id && entry.text.trim()))

  if (usable.length > 0) {
    return orderTimelineEntries([...usable, ...currentLiveTimelineEntry])
  }

  return snapshotTimelineEntries(
    session.id,
    snapshot,
    session.summary,
    session.updated_at || session.created_at || new Date().toISOString(),
  )
}

export function buildCurrentLiveTimelineEntry(
  session: RoomReasoningSession | null,
  snapshot: RoomReasoningSnapshot | null,
  currentSummary: string,
): ReasoningTimelineEntry[] {
  if (!session) return []
  return currentReasoningEntry(
    session.id,
    snapshot?.status || session.status,
    currentSummary,
    session.updated_at || session.created_at || new Date().toISOString(),
  )
}

export function formatTimestamp(value: string | null | undefined): string {
  const timestamp = String(value || '').trim()
  if (!timestamp) return 'unknown'

  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return 'unknown'

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
