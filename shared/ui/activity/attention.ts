import { activityStateLabel, compareActivityEvents, eventTime, githubUrl, groupActivity, type ActivityEvent, type ActivityGroup } from './model'

/**
 * One inbox row for GitHub work that needs a person: an open pull request with
 * changes requested, or a build that failed and has not passed since. Both
 * inboxes build their rows from this, so desktop and web list the same items.
 */
export interface GitHubAttentionItem {
  /** A pull request URL, or the check or workflow lane, so a row keeps its key across runs. */
  id: string
  title: string
  /** Why the row needs a person: "Changes requested by alice", "Build failed: lint". */
  body: string
  actor: string
  status: string
  timestamp: string
  firstSeen: string
  url: string | null
  taskId: string | null
  /** The newest event of the row's own group (the pull request, or the newest run), for opening it in Activity. */
  latestEventId: string
  /** Changes when the row gains a newer event or a new reason, so a read row comes back. */
  fingerprint: string
  /** Oldest first. */
  history: Array<{ id: string; label: string; body: string; timestamp: string }>
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const stamp = (value: string) => Date.parse(value) || 0
const latestOf = (group: ActivityGroup) => group.events[group.events.length - 1]!

function repositoryOf(url: string | null): string | null {
  const match = githubUrl(url)?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\//)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/**
 * The run of checks a group belongs to. GitHub stores every check run and every
 * push workflow run as its own object, so only the newest run of a lane says
 * whether the build is still failing.
 */
function laneOf(group: ActivityGroup): { key: string; pullRequest: string | null } | null {
  if (group.kind === 'pr') return null
  const latest = latestOf(group)
  const meta = latest.metadata || {}
  if (latest.event_type === 'check_run') {
    const repository = repositoryOf(latest.github_object_url)
    if (!repository) return null
    const name = latest.title || 'Check'
    const numbers = Array.isArray(meta.same_repo_pull_request_numbers) ? meta.same_repo_pull_request_numbers.filter(Number.isInteger) : []
    if (numbers.length === 1) {
      const pullRequest = `https://github.com/${repository}/pull/${numbers[0]}`
      return { key: `${pullRequest}|check|${name}`, pullRequest }
    }
    const branch = text(meta.head_branch)
    return branch ? { key: `${repository}|${branch}|check|${name}`, pullRequest: null } : null
  }
  if (group.kind === 'workflow') {
    const repository = text(meta.repository)?.toLowerCase()
    const branch = text(meta.head_ref)
    const workflow = group.runs[0]?.workflowId
    return repository && branch && workflow ? { key: `${repository}|${branch}|workflow|${workflow}`, pullRequest: null } : null
  }
  return null
}

function names(values: readonly string[]): string {
  return values.length > 3 ? `${values.slice(0, 3).join(', ')} and ${values.length - 3} more` : values.join(', ')
}

const PULL_REQUEST_ACTIONS: Record<string, string> = {
  opened: 'Pull request opened', reopened: 'Pull request reopened', synchronize: 'New commits pushed',
  ready_for_review: 'Marked ready for review', converted_to_draft: 'Converted to draft', edited: 'Pull request edited',
  review_requested: 'Review requested', review_request_removed: 'Review request removed', assigned: 'Assigned', unassigned: 'Unassigned',
}
const REVIEW_STATES: Record<string, string> = { approved: 'Approved', changes_requested: 'Changes requested', commented: 'Reviewed', dismissed: 'Review dismissed' }

/** A readable line for one event: what happened, and who or what reported it. */
function historyEntry(event: ActivityEvent): { label: string; body: string } {
  const actor = event.actor_login || 'GitHub'
  const state = (event.state || '').toLowerCase()
  switch (event.event_type) {
    case 'pull_request': {
      const merged = state === 'merged' || event.metadata?.merged === true
      const label = event.action === 'closed' ? (merged ? 'Pull request merged' : 'Pull request closed') : PULL_REQUEST_ACTIONS[event.action] || 'Pull request updated'
      return { label, body: actor }
    }
    case 'pull_request_review':
      return { label: event.action === 'dismissed' ? 'Review dismissed' : REVIEW_STATES[state] || 'Reviewed', body: actor }
    case 'pull_request_review_comment':
    case 'issue_comment':
      return { label: event.action === 'deleted' ? 'Comment removed' : event.action === 'edited' ? 'Comment edited' : 'Comment', body: actor }
    case 'pull_request_review_thread':
      return { label: event.metadata?.resolved === true ? 'Discussion resolved' : 'Discussion reopened', body: actor }
    default:
      return { label: event.title || event.event_type.replace(/_/g, ' '), body: activityStateLabel(event) }
  }
}

function row(id: string, lead: ActivityGroup, groups: readonly ActivityGroup[], changesBy: readonly string[], failed: readonly string[]): GitHubAttentionItem {
  const events = [...new Map(groups.flatMap(group => group.events).map(event => [event.id, event])).values()].sort(compareActivityEvents)
  const latest = events[events.length - 1]!
  const body = [changesBy.length ? `Changes requested by ${names(changesBy)}` : '', failed.length ? `Build failed: ${names(failed)}` : '']
    .filter(Boolean).join(' · ') || `${lead.status} · ${lead.summary || lead.title}`
  return {
    id,
    title: lead.title,
    body,
    actor: lead.actor || 'GitHub',
    status: changesBy.length ? 'Changes requested' : failed.length ? 'Build failed' : lead.status,
    timestamp: eventTime(latest),
    firstSeen: [...events].sort((a, b) => stamp(a.created_at) - stamp(b.created_at))[0]!.created_at,
    url: githubUrl(lead.url),
    taskId: groups.flatMap(group => group.taskIds)[0] ?? null,
    latestEventId: latestOf(lead).id,
    fingerprint: `${latest.id}|${body}`,
    history: events.map(event => ({ id: event.id, ...historyEntry(event), timestamp: eventTime(event) })),
  }
}

export function githubAttentionItems(events: readonly ActivityEvent[]): GitHubAttentionItem[] {
  const groups = groupActivity(events)
  const pullRequests = new Map(groups.filter(group => group.kind === 'pr').map(group => [group.id, group]))
  const closed = (group: ActivityGroup) => group.merged || group.status === 'Closed'
  const lanes = new Map<string, { pullRequest: string | null; groups: ActivityGroup[] }>()
  const items: GitHubAttentionItem[] = []
  // GitHub Actions sends a check run for each job, at the job's own page. The job
  // already counts through its workflow, so its check run would only repeat it.
  const jobPages = new Set(events.filter(event => event.event_type === 'workflow_job').map(event => githubUrl(event.github_object_url)).filter(Boolean))
  for (const group of groups) {
    const latest = latestOf(group)
    if (latest.event_type === 'check_run' && jobPages.has(githubUrl(latest.github_object_url))) continue
    const lane = laneOf(group)
    if (lane) {
      const entry = lanes.get(lane.key) || { pullRequest: lane.pullRequest, groups: [] }
      entry.groups.push(group)
      lanes.set(lane.key, entry)
    } else if (group.kind !== 'pr' && group.attention) {
      items.push(row(group.id, group, [group], group.changesRequestedBy, group.failedChecks))
    }
  }
  // A pull request's checks count on its row, and only for its current commit.
  const checksByPullRequest = new Map<string, { failed: string[]; groups: ActivityGroup[] }>()
  for (const [key, lane] of lanes) {
    const ordered = [...lane.groups].sort((a, b) => compareActivityEvents(latestOf(a), latestOf(b)))
    const newest = ordered[ordered.length - 1]!
    if (!newest.attention) continue
    const pullRequest = lane.pullRequest ? pullRequests.get(lane.pullRequest) : undefined
    if (pullRequest) {
      const latest = latestOf(newest)
      const sha = latest.head_sha || text(latest.metadata?.head_sha)
      if (closed(pullRequest) || pullRequest.head && sha && sha !== pullRequest.head) continue
      const entry = checksByPullRequest.get(pullRequest.id) || { failed: [], groups: [] }
      entry.failed.push(...newest.failedChecks)
      entry.groups.push(...ordered)
      checksByPullRequest.set(pullRequest.id, entry)
      continue
    }
    items.push(row(`lane:${key}`, newest, ordered, [], newest.failedChecks))
  }
  for (const group of pullRequests.values()) {
    const checks = checksByPullRequest.get(group.id)
    if (!group.attention && !(checks && !closed(group))) continue
    const failed = [...new Set([...group.failedChecks, ...(checks?.failed || [])])]
    items.push(row(group.id, group, [group, ...(checks?.groups || [])], group.changesRequestedBy, failed))
  }
  return items.sort((a, b) => stamp(b.timestamp) - stamp(a.timestamp) || a.id.localeCompare(b.id))
}
