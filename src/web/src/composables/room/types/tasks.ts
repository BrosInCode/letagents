export interface RoomTask {
  id: string
  title: string
  description: string
  status: string
  assignee: string | null
  assignee_agent_key: string | null
  created_by: string | null
  pr_url: string | null
  workflow_artifacts: ReadonlyArray<{
    provider: string
    kind: string
    id?: string | null
    number?: number | null
    title?: string | null
    url?: string | null
    ref?: string | null
    state?: string | null
  }>
  workflow_refs: ReadonlyArray<{
    provider: string
    kind: string
    label: string
    url: string
  }>
  stale_prompt_state?: {
    is_stale: boolean
    reason: string | null
    stale_for_ms: number | null
    muted: boolean
    muted_by: string | null
    muted_at: string | null
  } | null
  created_at: string
  updated_at: string
  active_leases?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string
    kind: 'work' | 'review' | 'coordination'
    status: 'active' | 'released' | 'revoked' | 'expired'
    agent_key: string
    agent_instance_id: string | null
    agent_session_id: string | null
    actor_label: string
    branch_ref: string | null
    pr_url: string | null
    output_intent: string | null
  }>
  active_locks?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string | null
    scope: 'room' | 'task'
    reason: string | null
    message: string | null
    created_by: string
    cleared_at: string | null
  }>
}

export interface TaskLeaseActionInput {
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
}

export interface TaskReviewLeaseActionInput {
  action: 'assign' | 'claim' | 'release'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
}

export interface StalePromptTaskState {
  isStale: boolean
  muted: boolean
  taskUpdatedAt: string
}

export interface TaskGitHubArtifactStatus {
  task_id: string
  pr_state: string | null
  pr_title: string | null
  pr_url: string | null
  pr_number: string | null
  pr_author: string | null
  pr_actor: string | null
  pr_draft: boolean | null
  pr_merged: boolean | null
  checks: ReadonlyArray<{
    name: string
    conclusion: string | null
    state: string | null
    actor: string | null
  }>
  reviews: ReadonlyArray<{
    actor: string | null
    state: string | null
  }>
  check_summary: {
    total: number
    success: number
    failure: number
    pending: number
  }
  review_summary: {
    total: number
    approved: number
    changes_requested: number
  }
}
