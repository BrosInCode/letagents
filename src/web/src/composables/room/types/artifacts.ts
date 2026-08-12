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

// Structured per-artifact detail (mirrors the API). Discriminated on type/version;
// only change_summary today. For change summaries: file paths + counts, never code.
export interface RoomSharedArtifactChangedFile {
  path: string
  previousPath: string | null
  status: string
  additions: number
  deletions: number
  binary: boolean
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface RoomSharedArtifactChangeSummaryDetail {
  type: 'change_summary'
  version: 1
  changedFileCount: number
  additions: number
  deletions: number
  stagedFileCount: number
  unstagedFileCount: number
  untrackedFileCount: number
  hiddenFileCount: number
  files: readonly RoomSharedArtifactChangedFile[]
}

export type RoomSharedArtifactDetail = RoomSharedArtifactChangeSummaryDetail

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
  detail: RoomSharedArtifactDetail | null
  source: RoomSharedArtifactSource
  first_seen_at: string
  updated_at: string
  linked_task_ids: readonly string[]
}
