import type {
  FocusActivityScope,
  FocusGitHubEventRouting,
  FocusParentVisibility,
  FocusRoomConclusionDetails,
} from './focus'
import type { RoomParticipant } from './presence'
import type { RoomKind } from './shared'

export type GitRoomVisibility = 'public' | 'private' | 'unknown'
export type GitRoomRefType =
  | 'default_branch'
  | 'branch'
  | 'tag'
  | 'pull_request'

export interface GitRoomInfo {
  room_id: string
  provider: 'github'
  host: string
  repository: {
    id: string | null
    owner: string
    name: string
    full_name: string
  }
  ref: {
    type: GitRoomRefType
    name: string | null
    default_branch: string | null
    base_ref: string | null
    head_ref: string | null
    head_repository: {
      id: string | null
      owner: string
      name: string
      full_name: string
    } | null
    is_default: boolean
  }
  visibility: GitRoomVisibility
  access_mode: GitRoomVisibility
  source: 'github_repository' | 'webhook' | 'manual'
  updated_at: string | null
}

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
  gitRoom: GitRoomInfo | null
}

export type RoomAgentPromptKind = 'join' | 'inline' | 'auto'

export interface RoomJoinError {
  status: number | null
  code: string | null
  message: string
  roomId: string | null
  deviceFlowUrl: string | null
}

export interface RoomParticipantsPage {
  participants: RoomParticipant[]
  hidden_count: number
}
