import {
  mapGitHubEventsFetchError,
  toAvailableGitHubEventsResult,
  type RoomGitHubEventsError,
} from '../roomGitHubEvents'
import { apiFetch, roomPath } from './api'
import {
  HANDOFF_PRESENCE_PAGE_SIZE,
  MESSAGE_HISTORY_PAGE_SIZE,
} from './constants'
import { isVisibleRoomMessage } from './identity'
import type {
  FocusRoomInfo,
  MessagePage,
  RoomActivityHistoryKind,
  RoomActivityHistoryPage,
  RoomAgentPresence,
  RoomGitHubEvent,
  RoomInfo,
  RoomMessage,
  RoomParticipantsPage,
  RoomTask,
  RoomSharedArtifact,
  TaskGitHubArtifactStatus,
} from './types'

export function getGitHubEventsIdentifier(roomInfo: RoomInfo | null): string {
  if (!roomInfo) return ''
  return roomInfo.identifier || roomInfo.name || roomInfo.projectId
}

export function getGitHubSupportIdentifier(roomInfo: RoomInfo | null): string {
  if (!roomInfo) return ''
  if (roomInfo.gitRoom?.provider === 'github') {
    return `${roomInfo.gitRoom.host}/${roomInfo.gitRoom.repository.full_name}`
  }
  if (roomInfo.kind === 'focus' && roomInfo.parentRoomId) {
    return roomInfo.parentRoomId
  }
  return getGitHubEventsIdentifier(roomInfo)
}

export async function fetchMessages(
  roomIdentifier: string,
  before: string = 'latest',
): Promise<MessagePage> {
  const params = new URLSearchParams({
    limit: String(MESSAGE_HISTORY_PAGE_SIZE),
    before,
  })

  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/messages?${params.toString()}`,
  )
  return {
    messages: data.messages || [],
    hasOlder: Boolean(data.has_older ?? data.has_more),
  }
}

export async function fetchMessagesAfter(
  roomIdentifier: string,
  after: string,
): Promise<{ messages: RoomMessage[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    limit: String(MESSAGE_HISTORY_PAGE_SIZE),
    after,
  })
  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/messages?${params.toString()}`,
  )
  return {
    messages: data.messages || [],
    hasMore: Boolean(data.has_more),
  }
}

export function mergeMessages(
  current: readonly RoomMessage[],
  incoming: readonly RoomMessage[],
): RoomMessage[] {
  const byId = new Map<string, RoomMessage>()
  for (const msg of current) byId.set(msg.id, msg)
  for (const msg of incoming) {
    if (isVisibleRoomMessage(msg)) {
      byId.set(msg.id, msg)
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const aNum = Number(/^msg_(\d+)$/.exec(a.id)?.[1] || 0)
    const bNum = Number(/^msg_(\d+)$/.exec(b.id)?.[1] || 0)
    if (aNum && bNum && aNum !== bNum) return aNum - bNum
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  })
}

export async function fetchPresence(
  roomIdentifier: string,
  limit: number = HANDOFF_PRESENCE_PAGE_SIZE,
): Promise<RoomAgentPresence[]> {
  try {
    const params = new URLSearchParams()
    if (limit) {
      params.set('limit', String(limit))
    }
    const query = params.toString()
    const data = await apiFetch(
      `${roomPath(roomIdentifier)}/presence${query ? `?${query}` : ''}`,
    )
    return data.presence || []
  } catch {
    return []
  }
}

export async function fetchParticipants(
  roomIdentifier: string,
): Promise<RoomParticipantsPage> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/participants`)
    return {
      participants: data.participants || [],
      hidden_count: Number(data.hidden_count || 0),
    }
  } catch {
    return {
      participants: [],
      hidden_count: 0,
    }
  }
}

export async function fetchActivityHistory(
  roomIdentifier: string,
  options?: {
    query?: string
    page?: number
    pageSize?: number
    kind?: RoomActivityHistoryKind
    roomId?: string
  },
): Promise<RoomActivityHistoryPage | null> {
  const params = new URLSearchParams()
  if (options?.query?.trim()) params.set('query', options.query.trim())
  if (options?.page) params.set('page', String(options.page))
  if (options?.pageSize) params.set('page_size', String(options.pageSize))
  if (options?.kind && options.kind !== 'all') params.set('kind', options.kind)
  if (options?.roomId?.trim()) params.set('room_id', options.roomId.trim())

  try {
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return await apiFetch(
      `${roomPath(roomIdentifier)}/activity-history${suffix}`,
    )
  } catch {
    return null
  }
}

export async function fetchTasks(roomIdentifier: string): Promise<RoomTask[]> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/tasks`)
    return data.tasks || []
  } catch {
    return []
  }
}

export async function fetchRoomArtifacts(
  roomIdentifier: string,
): Promise<RoomSharedArtifact[]> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/artifacts`)
    return data.artifacts || []
  } catch {
    return []
  }
}

export async function fetchFocusRooms(
  roomIdentifier: string,
): Promise<FocusRoomInfo[]> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/focus-rooms`)
    return data.focus_rooms || []
  } catch {
    return []
  }
}

export async function fetchGitHubEvents(roomIdentifier: string): Promise<{
  events: RoomGitHubEvent[]
  available: boolean
  hasMore: boolean
  error: RoomGitHubEventsError | null
}> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/events?limit=100`)
    return toAvailableGitHubEventsResult<RoomGitHubEvent>(data)
  } catch (error) {
    return mapGitHubEventsFetchError<RoomGitHubEvent>(
      error as { status?: number; message?: string },
    )
  }
}

export async function fetchTaskGithubStatus(
  roomIdentifier: string,
): Promise<Record<string, TaskGitHubArtifactStatus>> {
  try {
    const data = await apiFetch(
      `${roomPath(roomIdentifier)}/tasks/github-status`,
    )
    return (
      (data as { statuses?: Record<string, TaskGitHubArtifactStatus> })
        .statuses ?? {}
    )
  } catch {
    return {}
  }
}
