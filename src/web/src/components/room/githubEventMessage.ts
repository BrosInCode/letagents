export type GitHubEventKind =
  | 'pull-request'
  | 'issue'
  | 'review'
  | 'comment'
  | 'check'
  | 'repository'
  | 'generic'

export type GitHubEventTone = 'violet' | 'amber' | 'emerald' | 'rose' | 'sky' | 'slate'

export interface GitHubEventPresentation {
  kind: GitHubEventKind
  tone: GitHubEventTone
  kindLabel: string
  statusLabel: string | null
  headline: string
  detail: string | null
  repository: string | null
  taskId: string | null
  url: string | null
  urlLabel: string
}

export interface GitHubMessageLike {
  text?: string | null
  source?: string | null
  sender?: string | null
}

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

const TRAILING_URL_RE = /\s(https?:\/\/\S+)$/i

function splitTrailingUrl(value: string): { body: string; url: string | null } {
  const match = value.match(TRAILING_URL_RE)
  if (!match) {
    return { body: value.trim(), url: null }
  }

  return {
    body: value.slice(0, match.index).trim(),
    url: match[1],
  }
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

function summarizeArtifactAction(actionText: string): string | null {
  const action = actionText.trim().toLowerCase()

  if (action.includes('ready for review')) return 'ready'
  if (action.includes('merged')) return 'merged'
  if (action.includes('closed')) return 'closed'
  if (action.includes('reopened')) return 'reopened'
  if (action.includes('opened')) return 'opened'
  if (action.includes('converted to draft')) return 'draft'
  if (action.includes('received new commits')) return 'updated'

  return null
}

function artifactTone(kind: 'pull-request' | 'issue', actionText: string): GitHubEventTone {
  const action = actionText.trim().toLowerCase()

  if (action.includes('merged')) return 'emerald'
  if (action.includes('closed')) return 'slate'
  if (action.includes('converted to draft')) return 'amber'
  if (kind === 'issue') return 'amber'
  return 'violet'
}

function reviewTone(actionText: string): GitHubEventTone {
  const action = actionText.trim().toLowerCase()
  if (action === 'approved') return 'emerald'
  if (action === 'requested changes on') return 'rose'
  return 'sky'
}

function checkTone(conclusion: string): GitHubEventTone {
  const normalized = conclusion.trim().toLowerCase()
  if (normalized === 'failure' || normalized === 'timed_out' || normalized === 'cancelled') return 'rose'
  if (normalized === 'action_required' || normalized === 'neutral') return 'amber'
  return 'sky'
}

function parsePullRequestOrIssueEvent(body: string, url: string | null): GitHubEventPresentation | null {
  const match = /^(PR #\d+|Issue #\d+)\s+(.+?)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?:\s+([\s\S]+)$/i.exec(body)
  if (!match) return null

  const artifact = match[1]
  const actionText = match[2].trim()
  const repository = match[3]
  const taskId = match[4] || null
  const detail = match[5].trim()
  const kind: 'pull-request' | 'issue' = artifact.startsWith('PR ') ? 'pull-request' : 'issue'

  return {
    kind,
    tone: artifactTone(kind, actionText),
    kindLabel: kind === 'pull-request' ? 'Pull request' : 'Issue',
    statusLabel: summarizeArtifactAction(actionText),
    headline: `${artifact} ${actionText}`,
    detail,
    repository,
    taskId,
    url,
    urlLabel: kind === 'pull-request' ? 'Open pull request' : 'Open issue',
  }
}

function parseReviewEvent(body: string, url: string | null): GitHubEventPresentation | null {
  const match = /^(.+?)\s+(approved|requested changes on|reviewed)\s+(PR #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i.exec(body)
  if (!match) return null

  const actor = match[1].trim()
  const actionText = match[2].trim()
  const artifact = match[3]
  const repository = match[4]
  const taskId = match[5] || null

  return {
    kind: 'review',
    tone: reviewTone(actionText),
    kindLabel: 'Review',
    statusLabel: actionText === 'requested changes on' ? 'changes requested' : actionText,
    headline: `${actor} ${actionText} ${artifact}`,
    detail: null,
    repository,
    taskId,
    url,
    urlLabel: 'Open review',
  }
}

function parseCommentEvent(body: string, url: string | null): GitHubEventPresentation | null {
  const match = /^(.+?)\s+commented on\s+(PR #\d+|Issue #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?:\s+"([\s\S]*)"$/i.exec(body)
  if (!match) return null

  const actor = match[1].trim()
  const artifact = match[2]
  const repository = match[3]
  const taskId = match[4] || null
  const detail = match[5].trim()

  return {
    kind: 'comment',
    tone: 'sky',
    kindLabel: 'Comment',
    statusLabel: 'new comment',
    headline: `${actor} commented on ${artifact}`,
    detail,
    repository,
    taskId,
    url,
    urlLabel: 'Open thread',
  }
}

function parseCheckEvent(body: string, url: string | null): GitHubEventPresentation | null {
  const match = /^Check "([^"]+)"(?: \(([^)]+)\))?\s+([a-z_]+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i.exec(body)
  if (!match) return null

  const name = match[1].trim()
  const appName = match[2]?.trim() || null
  const conclusion = match[3].trim()
  const repository = match[4]
  const taskId = match[5] || null
  const conclusionLabel = toTitleCase(conclusion)

  return {
    kind: 'check',
    tone: checkTone(conclusion),
    kindLabel: 'Check run',
    statusLabel: conclusionLabel,
    headline: `Check ${name} ${conclusionLabel.toLowerCase()}`,
    detail: appName ? `Reported by ${appName}` : null,
    repository,
    taskId,
    url,
    urlLabel: 'Open check',
  }
}

function parseRepositoryEvent(body: string, url: string | null): GitHubEventPresentation | null {
  if (!/^Repository\b/i.test(body)) return null

  const statusLabel = /\brenamed\b/i.test(body)
    ? 'renamed'
    : /\btransferred\b/i.test(body)
      ? 'transferred'
      : null

  return {
    kind: 'repository',
    tone: 'sky',
    kindLabel: 'Repository',
    statusLabel,
    headline: body,
    detail: null,
    repository: null,
    taskId: null,
    url,
    urlLabel: 'Open repository',
  }
}

export function parseGitHubEventPresentation(message: GitHubMessageLike): GitHubEventPresentation | null {
  const source = (message.source || '').trim().toLowerCase()
  const sender = (message.sender || '').trim().toLowerCase()
  if (source !== 'github' && sender !== 'github') return null

  const text = (message.text || '').trim()
  if (!text) return null

  const { body, url } = splitTrailingUrl(text)

  return (
    parseReviewEvent(body, url) ||
    parseCommentEvent(body, url) ||
    parseCheckEvent(body, url) ||
    parsePullRequestOrIssueEvent(body, url) ||
    parseRepositoryEvent(body, url) || {
      kind: 'generic',
      tone: 'slate',
      kindLabel: 'GitHub event',
      statusLabel: null,
      headline: body,
      detail: null,
      repository: null,
      taskId: null,
      url,
      urlLabel: 'Open on GitHub',
    }
  )
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
