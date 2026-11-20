import { activityStateLabel, eventTime, githubUrl, groupActivity, type ActivityEvent, type ActivityGroup } from './model'

/**
 * One inbox row for GitHub work that needs a person: an open pull request with
 * changes requested, or a failed build on its current head. Both inboxes build
 * their rows from this, so desktop and web list the same GitHub items.
 */
export interface GitHubAttentionItem {
  /** The Activity group key, so the row opens the same group in Activity. */
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
  /** The newest event in the group, for opening the group in Activity. */
  latestEventId: string
  /** Changes when the group gains an event, so a read row comes back. */
  fingerprint: string
  /** Oldest first. */
  history: Array<{ id: string; label: string; body: string; timestamp: string }>
}

function names(values: readonly string[]): string {
  return values.length > 3 ? `${values.slice(0, 3).join(', ')} and ${values.length - 3} more` : values.join(', ')
}

function attentionBody(group: ActivityGroup): string {
  const reasons = [
    group.changesRequestedBy.length ? `Changes requested by ${names(group.changesRequestedBy)}` : '',
    group.failedChecks.length ? `Build failed: ${names(group.failedChecks)}` : '',
  ].filter(Boolean)
  return reasons.join(' · ') || `${group.status} · ${group.summary || group.title}`
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

export function githubAttentionItems(events: readonly ActivityEvent[]): GitHubAttentionItem[] {
  return groupActivity(events).filter(group => group.attention).map(group => ({
    id: group.id,
    title: group.title,
    body: attentionBody(group),
    actor: group.actor || 'GitHub',
    status: group.status,
    timestamp: group.time,
    firstSeen: group.firstReceived,
    url: githubUrl(group.url),
    taskId: group.taskIds[0] ?? null,
    latestEventId: group.events[group.events.length - 1]!.id,
    fingerprint: group.events.map(event => event.id).sort().join(':'),
    history: group.events.map(event => ({ id: event.id, ...historyEntry(event), timestamp: eventTime(event) })),
  }))
}
