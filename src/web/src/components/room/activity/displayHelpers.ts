import type {
  RoomReasoningSession,
  TaskGitHubArtifactStatus,
} from '../../../composables/room/types'
import { describeAgentReachability } from '../reachability'
import { ACTIVITY_STATE_LABELS } from './labels'
import { formatLastSeen } from './time'
import type {
  ActivityParticipant,
  ActivityTaskListItem,
  HistoryParticipant,
} from './types'

export function participantMeta(participant: ActivityParticipant | HistoryParticipant): string {
  if (participant.kind === 'human') {
    return 'Human participant'
  }

  return participant.ownerLabel || 'Agent'
}

export function participantNote(participant: ActivityParticipant | HistoryParticipant): string {
  if (participant.kind === 'agent') {
    return describeAgentReachability({
      activityState: participant.activityState,
      hasCanonicalPresence: participant.hasCanonicalPresence,
      statusText: participant.statusText,
    })
  }

  if (participant.statusText) {
    return participant.statusText
  }

  return participant.messageCount > 0
    ? 'Seen via browser room activity'
    : 'Known from task history'
}

export function historyLastSeenLabel(value: string | null): string {
  const relative = formatLastSeen(value)
  return relative === 'unknown' ? 'Last in room unknown' : `Last in room ${relative}`
}

export function historyParticipantNote(participant: HistoryParticipant): string {
  if (participant.kind === 'human') {
    return 'Seen via browser room history'
  }

  if (!participant.firstSeenAt) {
    return 'Recorded in room history'
  }

  return `First joined ${formatLastSeen(participant.firstSeenAt)}`
}

export function historyDetailNote(participant: HistoryParticipant): string {
  if (participant.kind === 'human') {
    return 'History stays focused on room participation and linked work. Use the Live tab for current browser activity.'
  }

  return 'History stays focused on room participation and linked work. Use the Live tab to inspect current reachability and work signals.'
}

export function reasoningCardTitle(session: RoomReasoningSession): string {
  return session.title || session.summary || session.goal || 'Reasoning stream'
}

export function reasoningCardSummary(session: RoomReasoningSession): string {
  return session.latest_payload?.checking
    || session.latest_payload?.next_action
    || session.latest_payload?.hypothesis
    || session.checking
    || session.next_action
    || session.hypothesis
    || session.summary
    || 'No summary published yet.'
}

export function reasoningStatusLabel(session: RoomReasoningSession): string {
  if (session.closed_at) return 'Closed'
  const normalized = String(session.status || 'active').trim()
  if (!normalized) return 'Active'
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function livenessCapabilityLabel(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'codex_app_server_runtime_stream') return 'Codex app-server stream'
  if (normalized === 'session_activity') return 'Session activity'
  if (normalized === 'process_observed') return 'Process observed'
  if (normalized === 'tool_bridge_only') return 'Tool bridge'
  return 'Liveness signal'
}

export function connectionLabel(participant: ActivityParticipant | HistoryParticipant | null): string {
  if (!participant || participant.kind !== 'agent') return 'Human'
  return participant.activityState ? ACTIVITY_STATE_LABELS[participant.activityState] : 'History'
}

export function getActivityTaskLink(
  task: ActivityTaskListItem,
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>,
): { label: string; url: string } | null {
  const gh = taskGithubStatus[task.id]
  if (gh?.pr_url) {
    return {
      label: gh.pr_number ? `PR #${gh.pr_number}` : 'Pull request',
      url: gh.pr_url,
    }
  }

  const firstWorkflowRef = task.workflow_refs[0]
  if (firstWorkflowRef) {
    return {
      label: firstWorkflowRef.label,
      url: firstWorkflowRef.url,
    }
  }

  return null
}
