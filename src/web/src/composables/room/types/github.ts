export type RoomGitHubEventType =
  | 'pull_request'
  | 'issue'
  | 'issue_comment'
  | 'pull_request_review'
  | 'check_run'
  | 'installation'
  | 'installation_repositories'
  | 'repository'
  | 'push'
  | 'create'
  | 'delete'

export interface RoomGitHubEvent {
  id: string
  event_type: RoomGitHubEventType
  action: string
  semantic_id?: string | null
  github_object_id: string | null
  github_object_url: string | null
  title: string | null
  state: string | null
  actor_login: string | null
  provider_event_at?: string | null
  provider_object_updated_at?: string | null
  event_order_at?: string | null
  ref?: string | null
  base_ref?: string | null
  head_ref?: string | null
  head_sha?: string | null
  metadata: Record<string, unknown> | null
  linked_task_id: string | null
  created_at: string
}
