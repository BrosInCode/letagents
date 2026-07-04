export type RoomSharedArtifactProvider =
  | 'git'
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'unknown'

export type RoomSharedArtifactKind =
  | 'issue'
  | 'branch'
  | 'commit'
  | 'diff'
  | 'change_summary'
  | 'pull_request'
  | 'merge_request'
  | 'review'
  | 'check_run'
  | 'merge'

export type RoomSharedArtifactSource =
  | 'task_workflow_artifact'
  | 'github_event'
  | 'manual'

export interface RoomSharedArtifact {
  room_id: string
  identity_key: string
  provider: RoomSharedArtifactProvider
  kind: RoomSharedArtifactKind
  artifact_id: string | null
  artifact_number: number | null
  title: string | null
  url: string | null
  ref: string | null
  state: string | null
  source: RoomSharedArtifactSource
  first_seen_at: string
  updated_at: string
  linked_task_ids: readonly string[]
}
