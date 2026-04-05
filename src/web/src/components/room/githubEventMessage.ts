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
