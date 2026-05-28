import {
  parseAgentIdentity,
} from '../../../composables/room/identity'
import type {
  FocusRoomInfo,
  RoomActivityHistoryEntry,
  RoomInfo,
} from '../../../composables/room/types'
import type { HistoryParticipant, HistoryRoomOption } from './types'

export function buildHistoryRoomOptions(input: {
  currentRoom: RoomInfo | null
  currentRoomIdentifier: string
  focusRooms: readonly FocusRoomInfo[]
}): HistoryRoomOption[] {
  const options: HistoryRoomOption[] = []
  const seen = new Set<string>()

  const pushOption = (option: HistoryRoomOption | null) => {
    if (!option?.id || seen.has(option.id)) return
    seen.add(option.id)
    options.push(option)
  }

  pushOption(input.currentRoomIdentifier
    ? {
      id: input.currentRoomIdentifier,
      label: input.currentRoom?.displayName || input.currentRoomIdentifier,
      kind: input.currentRoom?.kind || 'main',
      sourceTaskId: input.currentRoom?.sourceTaskId || null,
    }
    : null)

  if (input.currentRoom?.kind === 'main') {
    for (const focusRoom of input.focusRooms) {
      pushOption({
        id: focusRoom.room_id,
        label: focusRoom.display_name,
        kind: focusRoom.kind,
        sourceTaskId: focusRoom.source_task_id || null,
      })
    }
  }

  return options
}

export function resolveHistoryRoomOption(input: {
  selectedRoomId: string
  options: readonly HistoryRoomOption[]
  firstHistoryEntry: RoomActivityHistoryEntry | null
}): HistoryRoomOption | null {
  const selected = input.options.find((option) => option.id === input.selectedRoomId)
  if (selected) {
    return selected
  }

  const historyRoom = input.firstHistoryEntry?.room
  if (historyRoom) {
    return {
      id: historyRoom.id,
      label: historyRoom.display_name,
      kind: historyRoom.kind,
      sourceTaskId: historyRoom.source_task_id,
    }
  }

  if (!input.selectedRoomId) {
    return null
  }

  return {
    id: input.selectedRoomId,
    label: input.selectedRoomId,
    kind: 'main',
    sourceTaskId: null,
  }
}

export function buildHistoryParticipant(entry: RoomActivityHistoryEntry): HistoryParticipant {
  const actorLabel = String(entry.participant.actor_label || entry.participant.display_name || '').trim()
  const parsed = parseAgentIdentity(actorLabel)
  const label = entry.participant.display_name
    || parsed.displayName
    || actorLabel
    || 'Unknown participant'
  const ownerLabel = entry.participant.owner_label
    || parsed.ownerAttribution
    || null
  const ideLabel = entry.participant.ide_label
    || parsed.ideLabel
    || null

  return {
    key: entry.id,
    roomId: entry.room.id,
    kind: entry.participant.kind,
    label,
    actorLabel: entry.participant.kind === 'human'
      ? (entry.participant.github_login || label)
      : actorLabel,
    ownerLabel,
    ideLabel,
    activityState: null,
    hasCanonicalPresence: false,
    status: null,
    statusText: null,
    livenessObservation: null,
    workSignal: null,
    firstSeenAt: entry.first_seen_at,
    lastSeenAt: entry.last_seen_at,
    messageCount: 0,
    currentTasks: entry.current_tasks,
    completedTasks: entry.completed_tasks,
    createdTasks: entry.created_tasks,
    recentMessages: [],
    thinkingSnapshot: null,
    thinkingTimeline: [],
  }
}

export function countHistoryOpenTasks(entries: readonly RoomActivityHistoryEntry[]): number {
  return entries.reduce((total, entry) => total + entry.current_tasks.length, 0)
}
