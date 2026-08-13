import {
  isRepoBackedRoomId,
  type RoomGitHubEventsError,
} from '../roomGitHubEvents'
import { apiFetch, roomPath } from './api'
import {
  fetchActivityHistory,
  fetchFocusRooms,
  fetchGitHubEvents,
  fetchMessages,
  fetchParticipants,
  fetchPresence,
  fetchRoomArtifacts,
  fetchTaskGithubStatus,
  fetchTasks,
  getGitHubEventsIdentifier,
  getGitHubSupportIdentifier,
} from './data'
import { fetchReasoningSessions } from './reasoning'
import type {
  MessagePage,
  RoomActivityHistoryKind,
  RoomActivityHistoryPage,
  RoomAgentPresence,
  RoomGitHubEvent,
  RoomInfo,
  RoomParticipantsPage,
  RoomReasoningSession,
  RoomSharedArtifact,
  RoomTask,
  FocusRoomInfo,
  TaskGitHubArtifactStatus,
} from './types'

type ActivityHistoryRequest = {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
}

interface RoomJoinResponse {
  room_id?: string
  code?: string
  name?: string
  display_name?: string
  role?: string
  authenticated?: boolean
  kind?: RoomInfo['kind']
  attachments_enabled?: boolean
  parent_room_id?: string | null
  focus_key?: string | null
  source_task_id?: string | null
  focus_status?: RoomInfo['focusStatus']
  focus_parent_visibility?: RoomInfo['focusParentVisibility']
  focus_activity_scope?: RoomInfo['focusActivityScope']
  focus_github_event_routing?: RoomInfo['focusGitHubEventRouting']
  focus_settings?: {
    parent_visibility?: RoomInfo['focusParentVisibility']
    activity_scope?: RoomInfo['focusActivityScope']
    github_event_routing?: RoomInfo['focusGitHubEventRouting']
  } | null
  concluded_at?: string | null
  conclusion_summary?: string | null
  conclusion_details?: RoomInfo['conclusionDetails']
  git_room?: RoomInfo['gitRoom']
}

export interface RoomBootstrap {
  messagePage: MessagePage
  tasks: RoomTask[]
  focusRooms: FocusRoomInfo[]
  presence: RoomAgentPresence[]
  participantsPage: RoomParticipantsPage
  activityHistory: RoomActivityHistoryPage | null
  reasoningSessions: RoomReasoningSession[]
  githubEvents: {
    events: RoomGitHubEvent[]
    available: boolean
    hasMore: boolean
    error: RoomGitHubEventsError | null
  }
  taskGithubStatus: Record<string, TaskGitHubArtifactStatus>
  roomArtifacts: RoomSharedArtifact[]
}

export async function joinRoomSession(
  roomIdentifier: string,
): Promise<RoomInfo> {
  const project = (await apiFetch(`${roomPath(roomIdentifier)}/join`, {
    method: 'POST',
  })) as RoomJoinResponse

  const canonicalIdentifier = project.room_id || roomIdentifier

  return {
    projectId: canonicalIdentifier,
    identifier: canonicalIdentifier,
    code: project.code || '',
    name: project.name || canonicalIdentifier,
    displayName: project.display_name || project.name || canonicalIdentifier,
    role: project.role || 'participant',
    authenticated: !!project.authenticated,
    kind: project.kind || 'main',
    attachmentsEnabled: project.attachments_enabled !== false,
    parentRoomId: project.parent_room_id || null,
    focusKey: project.focus_key || null,
    sourceTaskId: project.source_task_id || null,
    focusStatus: project.focus_status || null,
    focusParentVisibility:
      project.focus_parent_visibility ||
      project.focus_settings?.parent_visibility ||
      null,
    focusActivityScope:
      project.focus_activity_scope ||
      project.focus_settings?.activity_scope ||
      null,
    focusGitHubEventRouting:
      project.focus_github_event_routing ||
      project.focus_settings?.github_event_routing ||
      null,
    concludedAt: project.concluded_at || null,
    conclusionSummary: project.conclusion_summary || null,
    conclusionDetails: project.conclusion_details || null,
    gitRoom: project.git_room || null,
  }
}

export async function loadRoomBootstrap(
  joinedRoom: RoomInfo,
  activityHistoryRequest: ActivityHistoryRequest,
): Promise<RoomBootstrap> {
  const roomIdentifier = joinedRoom.identifier
  const githubEventsIdentifier = getGitHubEventsIdentifier(joinedRoom)
  const supportsGitHubEvents = isRepoBackedRoomId(
    getGitHubSupportIdentifier(joinedRoom),
  )
  const [
    messagePage,
    tasks,
    focusRooms,
    presence,
    participantsPage,
    activityHistory,
    reasoningSessions,
    githubEvents,
    taskGithubStatus,
    roomArtifacts,
  ] = await Promise.all([
    fetchMessages(roomIdentifier),
    fetchTasks(roomIdentifier),
    fetchFocusRooms(roomIdentifier),
    fetchPresence(roomIdentifier),
    fetchParticipants(roomIdentifier),
    fetchActivityHistory(roomIdentifier, activityHistoryRequest),
    fetchReasoningSessions(roomIdentifier),
    supportsGitHubEvents
      ? fetchGitHubEvents(githubEventsIdentifier)
      : Promise.resolve({
          events: [],
          available: false,
          hasMore: false,
          error: null,
        }),
    fetchTaskGithubStatus(roomIdentifier),
    fetchRoomArtifacts(roomIdentifier),
  ])

  return {
    messagePage,
    tasks,
    focusRooms,
    presence,
    participantsPage,
    activityHistory,
    reasoningSessions,
    githubEvents,
    taskGithubStatus,
    roomArtifacts,
  }
}
