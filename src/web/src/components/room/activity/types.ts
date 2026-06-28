import type {
  FocusRoomInfo,
  RoomActivityHistoryEntry,
  RoomActivityHistoryKind,
  RoomActivityHistoryPage,
  RoomAgentPresence,
  RoomInfo,
  RoomMessage,
  RoomParticipant,
  RoomReasoningSession,
  RoomSharedArtifact,
  RoomTask,
  TaskGitHubArtifactStatus,
} from '@/composables/useRoom'
import type {
  AgentThinkingCardData,
  AgentThinkingTimelineEntry,
} from '../agentThinking'

export type ParticipantKind = 'agent' | 'human'
export type ParticipantActivityState = 'active' | 'away' | 'offline'
export type ParticipantWorkState =
  | 'working'
  | 'reviewing'
  | 'blocked'
  | 'responding'
export type ActivityViewMode = 'live' | 'history'

export interface ActivitySummaryCard {
  value: number
  label: string
}

export interface ParticipantWorkSignal {
  state: ParticipantWorkState
  label: string
  detail: string | null
}

export interface ActivityParticipant {
  key: string
  kind: ParticipantKind
  label: string
  actorLabel: string
  ownerLabel: string | null
  ideLabel: string | null
  repoBranch: string | null
  activityState: ParticipantActivityState | null
  hasCanonicalPresence: boolean
  status: RoomAgentPresence['status'] | null
  statusText: string | null
  livenessObservation: RoomAgentPresence['liveness_observation']
  workSignal: ParticipantWorkSignal | null
  lastSeenAt: string | null
  messageCount: number
  activeReasoning: RoomReasoningSession[]
  currentTasks: RoomTask[]
  completedTasks: RoomTask[]
  createdTasks: RoomTask[]
  recentMessages: RoomMessage[]
  thinkingSnapshot: AgentThinkingCardData | null
  thinkingTimeline: AgentThinkingTimelineEntry[]
}

export interface HistoryParticipant {
  key: string
  roomId: string
  kind: ParticipantKind
  label: string
  actorLabel: string
  ownerLabel: string | null
  ideLabel: string | null
  repoBranch: string | null
  activityState: ParticipantActivityState | null
  hasCanonicalPresence: boolean
  status: RoomAgentPresence['status'] | null
  statusText: string | null
  livenessObservation: RoomAgentPresence['liveness_observation']
  workSignal: ParticipantWorkSignal | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  messageCount: number
  currentTasks: ReadonlyArray<RoomActivityHistoryEntry['current_tasks'][number]>
  completedTasks: ReadonlyArray<
    RoomActivityHistoryEntry['completed_tasks'][number]
  >
  createdTasks: ReadonlyArray<RoomActivityHistoryEntry['created_tasks'][number]>
  recentMessages: RoomMessage[]
  thinkingSnapshot: AgentThinkingCardData | null
  thinkingTimeline: AgentThinkingTimelineEntry[]
}

export interface HistoryRoomOption {
  id: string
  label: string
  kind: 'main' | 'focus'
  sourceTaskId: string | null
}

export interface ActivityTaskListItem {
  id: string
  title: string
  status: string
  workflow_refs: ReadonlyArray<{ label: string; url: string }>
}

export type ActivityRosterParticipant = ActivityParticipant | HistoryParticipant

export interface ActivityViewProps {
  roomIdentifier: string
  currentRoom: RoomInfo | null
  focusRooms: readonly FocusRoomInfo[]
  messages: readonly RoomMessage[]
  participants: readonly RoomParticipant[]
  liveClearedCount: number
  presence: readonly RoomAgentPresence[]
  reasoningSessions: readonly RoomReasoningSession[]
  tasks: readonly RoomTask[]
  activityHistory: RoomActivityHistoryPage | null
  activityHistoryLoading: boolean
  activityHistoryError: string
  roomArtifacts: readonly RoomSharedArtifact[]
  canManageParticipants: boolean
  loadActivityHistory?: (options?: {
    query?: string
    page?: number
    pageSize?: number
    kind?: RoomActivityHistoryKind
    roomId?: string
  }) => Promise<boolean>
  clearDisconnectedParticipants?: () => Promise<number>
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  isLoading?: boolean
}
