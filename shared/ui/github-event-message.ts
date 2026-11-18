/**
 * Chat messages the GitHub integration posts ("PR #12 merged in owner/repo
 * linked to task_3 https://...") parsed into one card shape. Shared by the web
 * and desktop chat; each app styles the card itself.
 */
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


const LOW_SIGNAL_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const CHECK_MESSAGE_RE = /^Check "([^"]+)"(?: \(([^)]+)\))?\s+([a-z_]+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$/i
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

export function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

export function summarizeArtifactAction(actionText: string): string | null {
  const action = actionText.trim().toLowerCase()

  if (action.includes('ready for review')) return 'ready'
  if (action.includes('merged')) return 'merged'
  if (action.includes('closed')) return 'closed'
  if (action.includes('reopened')) return 'reopened'
  if (action.includes('opened')) return 'opened'
  if (action.includes('draft')) return 'draft'
  if (action.includes('commits')) return 'updated'

  return null
}

export function artifactTone(kind: 'pull-request' | 'issue', actionText: string): GitHubEventTone {
  const action = actionText.trim().toLowerCase()

  if (action.includes('merged')) return 'emerald'
  if (action.includes('closed')) return 'slate'
  if (action.includes('draft')) return 'amber'
  if (action.includes('received new commits')) return 'sky'
  if (kind === 'issue') return 'amber'
  return 'violet'
}

export function reviewTone(actionText: string): GitHubEventTone {
  const action = actionText.trim().toLowerCase()
  if (action === 'approved') return 'emerald'
  if (action === 'requested changes on') return 'rose'
  return 'sky'
}

export function checkTone(conclusion: string): GitHubEventTone {
  const normalized = conclusion.trim().toLowerCase()
  if (normalized === 'success') return 'emerald'
  if (normalized === 'failure' || normalized === 'timed_out' || normalized === 'cancelled') return 'rose'
  if (normalized === 'action_required' || normalized === 'neutral') return 'amber'
  return 'sky'
}

function parsePullRequestOrIssueEvent(body: string, url: string | null): GitHubEventPresentation | null {
  const match = /^(PR #\d+|Issue #\d+)\s+(.+?)\s+in\s+([^\s:]+)(?:\s+linked to\s+(task_\d+))?(?::\s*([\s\S]*))?$/i.exec(body)
  if (!match) return null

  const artifact = match[1]
  const actionText = match[2].trim()
  const repository = match[3]
  const taskId = match[4] || null
  const detail = match[5]?.trim() || null
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
  const match = CHECK_MESSAGE_RE.exec(body)
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

/** A message the GitHub integration posted (by source, or by the "github" sender of older messages). */
export function isGitHubRoomMessage(message: GitHubMessageLike): boolean {
  const source = (message.source || '').trim().toLowerCase()
  const sender = (message.sender || '').trim().toLowerCase()
  return source === 'github' || sender === 'github'
}

/** A passing, skipped or neutral check run: noise in the chat, so the apps hide it. */
export function isLowSignalGitHubCheckMessage(message: GitHubMessageLike): boolean {
  if (!isGitHubRoomMessage(message)) return false
  const { body } = splitTrailingUrl((message.text || '').trim())
  const match = CHECK_MESSAGE_RE.exec(body)
  return Boolean(match && LOW_SIGNAL_CHECK_CONCLUSIONS.has(match[3].trim().toLowerCase()))
}

export function parseGitHubEventPresentation(message: GitHubMessageLike): GitHubEventPresentation | null {
  if (!isGitHubRoomMessage(message)) return null

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
