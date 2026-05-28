import type {
  RoomReasoningEntry,
  RoomReasoningSession,
  RoomReasoningSnapshot,
  RoomReasoningUpdate,
} from '../../../composables/useRoom'

export interface ReasoningTimelineEntry extends RoomReasoningEntry {
  current?: boolean
}

export type ReasoningStreamState = 'blocked' | 'live' | 'recent' | 'snapshot'

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

  if (session.latest_payload) {
    return session.latest_payload
  }

  if (
    session.goal
    || session.checking
    || session.hypothesis
    || session.blocker
    || session.next_action
    || session.milestone
    || typeof session.confidence === 'number'
    || session.status
  ) {
    return {
      summary: session.summary || '',
      goal: session.goal,
      checking: session.checking,
      hypothesis: session.hypothesis,
      blocker: session.blocker,
      next_action: session.next_action,
      milestone: session.milestone,
      confidence: session.confidence,
      status: session.status,
    }
  }

  return session.summary ? { summary: session.summary } : null
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

  const detailEntries = Array.isArray(session.entries) && session.entries.length > 0
    ? session.entries
    : Array.isArray(session.updates) && session.updates.length > 0
      ? session.updates.map((update: RoomReasoningUpdate) => ({
        id: update.id,
        label: update.milestone ? 'Milestone' : update.status || 'Update',
        text: update.summary,
        timestamp: update.created_at,
      }))
      : []

  if (detailEntries.length > 0) {
    return compactTimelineEntries([...detailEntries, ...currentLiveTimelineEntry])
      .filter((entry) => Boolean(entry?.id && entry?.text))
      .sort(compareTimelineEntries)
  }

  const synthesized = [
    ['summary', 'Summary', snapshot?.summary || session.summary],
    ['goal', 'Goal', snapshot?.goal],
    ['checking', 'Checking', snapshot?.checking],
    ['hypothesis', 'Hypothesis', snapshot?.hypothesis],
    ['blocker', 'Blocker', snapshot?.blocker],
    ['next-action', 'Next action', snapshot?.next_action],
    ['milestone', 'Milestone', snapshot?.milestone],
  ] as const

  const timestamp = session.updated_at || session.created_at || new Date().toISOString()

  return synthesized
    .filter(([, , text]) => Boolean(String(text || '').trim()))
    .map(([id, label, text]) => ({
      id: `${session.id}-${id}`,
      label,
      text: String(text),
      timestamp,
    }))
}

export function buildCurrentLiveTimelineEntry(
  session: RoomReasoningSession | null,
  snapshot: RoomReasoningSnapshot | null,
  currentSummary: string,
): ReasoningTimelineEntry[] {
  const text = currentSummary.trim()
  if (!session || !text) return []
  return [{
    id: `${session.id}-current-live`,
    label: session.status || snapshot?.status || 'working',
    text,
    timestamp: session.updated_at || session.created_at || new Date().toISOString(),
    current: true,
  }]
}

export function resolveStreamState(
  session: RoomReasoningSession | null,
  snapshot: RoomReasoningSnapshot | null,
  isCodexReasoningSummary: boolean,
  isCodexSnapshot: boolean,
): ReasoningStreamState {
  const status = String(snapshot?.status || session?.status || '').toLowerCase()
  if (isCodexReasoningSummary) return 'live'
  if (isCodexSnapshot) return 'snapshot'
  if (status === 'working' || status === 'reviewing') return 'live'
  if (status === 'blocked') return 'blocked'
  return 'recent'
}

export function isCodexReasoningSummarySnapshot(snapshot: RoomReasoningSnapshot | null): boolean {
  const text = [
    snapshot?.summary,
    snapshot?.checking,
    snapshot?.next_action,
  ].join(' ').toLowerCase()
  return text.includes('readable reasoning') || text.includes('reasoning summary')
}

export function isCodexSnapshotPayload(snapshot: RoomReasoningSnapshot | null): boolean {
  if (isCodexReasoningSummarySnapshot(snapshot)) return false
  const text = [
    snapshot?.summary,
    snapshot?.checking,
    snapshot?.next_action,
  ].join(' ').toLowerCase()
  return text.includes('codex_app_server') || text.includes('app-server snapshot') || text.includes('snapshot-derived')
}

export function entryLabel(entry: RoomReasoningEntry): string {
  const label = String(entry.label || entry.kind || '').trim()
  if (!label) return 'Update'
  return label
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function compactTimelineEntries(entries: ReasoningTimelineEntry[]): ReasoningTimelineEntry[] {
  const compacted: ReasoningTimelineEntry[] = []
  for (const entry of entries) {
    const previous = compacted[compacted.length - 1]
    if (
      previous
      && previous.label === entry.label
      && normalizeTimelineText(previous.text) === normalizeTimelineText(entry.text)
    ) {
      compacted[compacted.length - 1] = {
        ...previous,
        id: entry.id,
        timestamp: entry.timestamp || previous.timestamp,
        current: Boolean(previous.current || entry.current),
      }
      continue
    }
    compacted.push(entry)
  }
  return compacted
}

export function normalizeTimelineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
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

function compareTimelineEntries(left: ReasoningTimelineEntry, right: ReasoningTimelineEntry): number {
  const leftTime = Date.parse(left.timestamp || '')
  const rightTime = Date.parse(right.timestamp || '')
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  return String(left.id).localeCompare(String(right.id))
}
