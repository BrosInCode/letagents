import {
  artifactTone,
  checkTone,
  reviewTone,
  toTitleCase,
  type GitHubEventPresentation,
  type GitHubEventTone,
} from '../../../../../shared/ui/github-event-message'

export {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
  parseGitHubEventPresentation,
  type GitHubEventKind,
  type GitHubEventPresentation,
  type GitHubEventTone,
  type GitHubMessageLike,
} from '../../../../../shared/ui/github-event-message'

export interface GitHubRoomEventLike {
  event_type: string
  action: string
  github_object_id?: string | null
  github_object_url?: string | null
  title?: string | null
  state?: string | null
  actor_login?: string | null
  metadata?: Record<string, unknown> | null
  linked_task_id?: string | null
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataBoolean(metadata: Record<string, unknown> | null | undefined, key: string): boolean {
  return metadata?.[key] === true
}

function actionStatusLabel(action: string): string | null {
  switch ((action || '').trim().toLowerCase()) {
    case 'ready_for_review':
      return 'ready'
    case 'converted_to_draft':
      return 'draft'
    case 'synchronize':
      return 'updated'
    default:
      return action ? toTitleCase(action) : null
  }
}

function formatPullRequestStatus(event: GitHubRoomEventLike): string {
  if ((event.state || '').trim().toLowerCase() === 'merged') return 'merged'
  switch ((event.action || '').trim().toLowerCase()) {
    case 'ready_for_review':
      return 'ready'
    case 'converted_to_draft':
      return 'draft'
    case 'synchronize':
      return 'updated'
    case 'reopened':
      return 'reopened'
    case 'closed':
      return 'closed'
    default:
      return 'opened'
  }
}

function pullRequestToneFromEvent(event: GitHubRoomEventLike): GitHubEventTone {
  const status = formatPullRequestStatus(event)
  if (status === 'merged') return 'emerald'
  if (status === 'closed') return 'slate'
  if (status === 'draft') return 'amber'
  if (status === 'updated') return 'sky'
  return 'violet'
}

function reviewStatusLabel(state: string | null | undefined): string {
  switch ((state || '').trim().toLowerCase()) {
    case 'changes_requested':
      return 'changes requested'
    case 'approved':
      return 'approved'
    case 'commented':
      return 'commented'
    default:
      return state ? toTitleCase(state) : 'reviewed'
  }
}

function reviewHeadline(event: GitHubRoomEventLike): string {
  const actor = event.actor_login?.trim() || 'Someone'
  const prLabel = event.github_object_id ? `PR #${event.github_object_id}` : 'pull request'
  const state = (event.state || '').trim().toLowerCase()

  switch (state) {
    case 'approved':
      return `${actor} approved ${prLabel}`
    case 'changes_requested':
      return `${actor} requested changes on ${prLabel}`
    default:
      return `${actor} reviewed ${prLabel}`
  }
}

function eventHeadlinePrefix(event: GitHubRoomEventLike, noun: string): string {
  const suffix = event.github_object_id ? ` #${event.github_object_id}` : ''
  const status = actionStatusLabel(event.action) || noun
  return `${noun}${suffix} ${status}`.trim()
}

export function presentGitHubRoomEvent(
  event: GitHubRoomEventLike,
  options?: { repository?: string | null }
): GitHubEventPresentation {
  const repository = options?.repository?.trim() || null
  const metadata = event.metadata || null

  switch (event.event_type) {
    case 'pull_request': {
      const status = formatPullRequestStatus(event)
      return {
        kind: 'pull-request',
        tone: pullRequestToneFromEvent(event),
        kindLabel: 'Pull request',
        statusLabel: status,
        headline: event.github_object_id ? `PR #${event.github_object_id} ${status}` : `Pull request ${status}`,
        detail: event.title || metadataString(metadata, 'body'),
        repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open pull request',
      }
    }
    case 'issue': {
      return {
        kind: 'issue',
        tone: artifactTone('issue', event.action || event.state || ''),
        kindLabel: 'Issue',
        statusLabel: actionStatusLabel(event.action),
        headline: event.github_object_id ? `Issue #${event.github_object_id} ${actionStatusLabel(event.action) || 'updated'}` : eventHeadlinePrefix(event, 'Issue'),
        detail: event.title || null,
        repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open issue',
      }
    }
    case 'issue_comment': {
      const isPullRequest = metadataBoolean(metadata, 'is_pull_request')
      const artifact = `${isPullRequest ? 'PR' : 'Issue'}${event.github_object_id ? ` #${event.github_object_id}` : ''}`
      const actor = event.actor_login?.trim() || 'Someone'
      return {
        kind: 'comment',
        tone: 'sky',
        kindLabel: 'Comment',
        statusLabel: 'commented',
        headline: `${actor} commented on ${artifact}`,
        detail: metadataString(metadata, 'body') || event.title || null,
        repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open thread',
      }
    }
    case 'pull_request_review': {
      return {
        kind: 'review',
        tone: reviewTone(event.state || ''),
        kindLabel: 'Review',
        statusLabel: reviewStatusLabel(event.state),
        headline: reviewHeadline(event),
        detail: metadataString(metadata, 'body') || event.title || null,
        repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open review',
      }
    }
    case 'check_run': {
      const conclusion = (event.state || metadataString(metadata, 'conclusion') || 'unknown').trim()
      const label = toTitleCase(conclusion)
      return {
        kind: 'check',
        tone: checkTone(conclusion),
        kindLabel: 'Check run',
        statusLabel: label,
        headline: `Check ${event.title || event.github_object_id || 'run'} ${label.toLowerCase()}`,
        detail: metadataString(metadata, 'app_name')
          ? `Reported by ${metadataString(metadata, 'app_name')}`
          : null,
        repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open check',
      }
    }
    case 'repository': {
      const oldFullName = metadataString(metadata, 'old_full_name')
      const statusLabel = actionStatusLabel(event.action)
      return {
        kind: 'repository',
        tone: 'sky',
        kindLabel: 'Repository',
        statusLabel,
        headline: `Repository ${statusLabel || 'updated'}`,
        detail: oldFullName && event.title ? `${oldFullName} -> ${event.title}` : event.title || oldFullName,
        repository: event.title || repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open repository',
      }
    }
    default:
      return {
        kind: 'generic',
        tone: 'slate',
        kindLabel: toTitleCase(event.event_type || 'github event'),
        statusLabel: actionStatusLabel(event.action),
        headline: event.title || `${toTitleCase(event.event_type || 'event')} ${actionStatusLabel(event.action) || ''}`.trim(),
        detail: metadataString(metadata, 'body'),
        repository,
        taskId: event.linked_task_id || null,
        url: event.github_object_url || null,
        urlLabel: 'Open on GitHub',
      }
  }
}
