import type {
  FocusActivityScope,
  FocusGitHubEventRouting,
  FocusParentVisibility,
  FocusRoomConclusionDetails,
} from './focus'
import type { RoomKind } from './shared'

export interface RoomInfo {
  projectId: string
  identifier: string
  code: string
  name: string
  displayName: string
  role: string
  authenticated: boolean
  kind: RoomKind
  attachmentsEnabled: boolean
  parentRoomId: string | null
  focusKey: string | null
  sourceTaskId: string | null
  focusStatus: 'active' | 'concluded' | null
  focusParentVisibility: FocusParentVisibility | null
  focusActivityScope: FocusActivityScope | null
  focusGitHubEventRouting: FocusGitHubEventRouting | null
  concludedAt: string | null
  conclusionSummary: string | null
  conclusionDetails: FocusRoomConclusionDetails | null
}

export type RoomAgentPromptKind = 'join' | 'inline' | 'auto'

export interface RoomJoinError {
  status: number | null
  code: string | null
  message: string
  roomId: string | null
  deviceFlowUrl: string | null
}
