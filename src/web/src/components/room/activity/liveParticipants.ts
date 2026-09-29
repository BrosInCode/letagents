import {
  isHumanSender,
  parseAgentIdentity,
} from '../../../composables/room/identity'
import type {
  RoomAgentPresence,
  RoomMessage,
  RoomParticipant,
  RoomReasoningSession,
  RoomTask,
} from '../../../composables/room/types'
import {
  buildAgentThinkingFromReasoningSession,
  buildAgentThinkingSnapshot,
  buildAgentThinkingTimeline,
  extractStatusText,
  type AgentThinkingTimelineEntry,
} from '../agentThinking'
import type { AgentReachabilitySource } from '../reachability'
import {
  COMPLETED_TASK_STATUSES,
  INACTIVE_REASONING_STATUSES,
  OPEN_TASK_STATUSES,
  STATUS_ORDER,
} from './labels'
import {
  latestTaskTimestamp,
  latestTimestamp,
  previewMessage,
  reasoningTimestamp,
  sortReasoningSessions,
  sortTasksByUpdated,
  timestampValue,
} from './time'
import type {
  ActivityParticipant,
  HistoryParticipant,
  ParticipantKind,
  ParticipantWorkSignal,
} from './types'

interface ActorMatchTarget {
  kind: ParticipantKind
  actorLabel: string
  label: string
}

export function groupAgentMessagesByActor(messages: readonly RoomMessage[]): Map<string, RoomMessage[]> {
  const grouped = new Map<string, RoomMessage[]>()
  for (const message of messages) {
    const sender = String(message.sender || '').trim()
    if (!sender || isHumanSender(sender, message.source)) continue
    const key = message.agent_identity?.actor_label || sender
    pushMapValue(grouped, key, message)
  }
  return grouped
}

export function participantMatchesHuman(participant: RoomParticipant, value: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return false

  const githubLogin = String(participant.github_login || '').trim().toLowerCase()
  const displayName = String(participant.display_name || '').trim().toLowerCase()
  return normalized === githubLogin || normalized === displayName
}

export function participantMatchesActor(participant: ActorMatchTarget, value: string | null): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized === participant.actorLabel) return true

  if (participant.kind === 'agent' && isAgentIdentityValue(normalized)) {
    return parseAgentIdentity(normalized).displayName === participant.label
  }

  return false
}

export function sessionMatchesAgent(
  participant: Pick<ActorMatchTarget, 'actorLabel' | 'label'>,
  session: RoomReasoningSession,
): boolean {
  const actorLabel = String(session.actor_label || '').trim()
  if (actorLabel && actorLabel === participant.actorLabel) return true

  const agentDisplayName = actorLabel ? parseAgentIdentity(actorLabel).displayName : ''
  return Boolean(agentDisplayName && agentDisplayName === participant.label)
}

export function isActiveReasoningSession(session: RoomReasoningSession): boolean {
  if (session.closed_at) return false
  return !INACTIVE_REASONING_STATUSES.has(String(session.status || '').toLowerCase())
}

export function buildWorkSignal(input: {
  status: RoomAgentPresence['status'] | null
  statusText: string | null
  currentTasks: ReadonlyArray<unknown>
  activeReasoning: ReadonlyArray<unknown>
}): ParticipantWorkSignal | null {
  if (input.status === 'blocked') {
    return { state: 'blocked', label: 'Blocked', detail: input.statusText }
  }

  if (input.status === 'reviewing') {
    return { state: 'reviewing', label: 'Reviewing', detail: input.statusText }
  }

  if (input.status === 'working') {
    return { state: 'working', label: 'Working', detail: input.statusText }
  }

  if (input.activeReasoning.length > 0) {
    return { state: 'responding', label: 'Responding', detail: 'Live work stream active' }
  }

  if (input.currentTasks.length > 0) {
    return {
      state: 'working',
      label: 'Working',
      detail: `${input.currentTasks.length} open task${input.currentTasks.length === 1 ? '' : 's'} assigned`,
    }
  }

  return null
}

export function buildAgentParticipant(input: {
  source: AgentReachabilitySource
  messagesByActor: ReadonlyMap<string, RoomMessage[]>
  reasoningSessions: readonly RoomReasoningSession[]
  tasks: readonly RoomTask[]
}): ActivityParticipant {
  const { actorLabel, key, participant, presence: presenceEntry, activityState } = input.source
  const messages = actorLabel ? (input.messagesByActor.get(actorLabel) || []) : []
  const latestMessage = messages[messages.length - 1] || null
  const latestStatusMessage = [...messages].reverse().find((message) =>
    /^\[status\]\s*/i.test(String(message.text || ''))
  ) || null
  const parsed = parseAgentIdentity(actorLabel)
  const label = participant?.display_name || presenceEntry?.display_name || latestMessage?.agent_identity?.display_name || parsed.displayName || actorLabel
  const ownerLabel = participant?.owner_label
    || presenceEntry?.owner_label
    || latestMessage?.agent_identity?.owner_label
    || parsed.ownerAttribution
    || null
  const ideLabel = participant?.ide_label || presenceEntry?.ide_label || latestMessage?.agent_identity?.ide_label || parsed.ideLabel || null
  const actorTarget = { key, kind: 'agent' as const, label, actorLabel }
  const activeReasoning = sortReasoningSessions(
    input.reasoningSessions.filter((session) =>
      isActiveReasoningSession(session)
      && sessionMatchesAgent({ actorLabel, label }, session)
    )
  )

  const assignedTasks = input.tasks.filter((task) => participantMatchesActor(actorTarget, task.assignee))
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const createdTasks = sortTasksByUpdated(
    input.tasks.filter((task) => participantMatchesActor(actorTarget, task.created_by))
  ).slice(0, 8)
  const rawStatusText = presenceEntry?.status_text || (latestStatusMessage ? extractStatusText(latestStatusMessage.text || '') : null) || null
  const statusText = activityState === 'offline' ? null : rawStatusText
  const workSignal = buildWorkSignal({
    status: presenceEntry?.status || null,
    statusText,
    currentTasks,
    activeReasoning,
  })
  const activeReasoningThinking = activeReasoning
    .map((session) => buildAgentThinkingFromReasoningSession(session))
    .filter((entry): entry is AgentThinkingTimelineEntry => Boolean(entry))
  const thinkingSnapshot = activeReasoningThinking[0] || buildAgentThinkingSnapshot({
    messages,
    status: presenceEntry?.status || null,
    statusText,
  })
  const thinkingTimeline = [
    ...activeReasoningThinking,
    ...buildAgentThinkingTimeline(messages),
  ].slice(0, 5)

  return {
    key,
    kind: 'agent',
    label,
    actorLabel,
    ownerLabel,
    ideLabel,
    repoBranch: presenceEntry?.repo_branch || null,
    activityState,
    hasCanonicalPresence: Boolean(presenceEntry?.source_flags?.includes('delivery')),
    status: presenceEntry?.status || null,
    statusText,
    livenessObservation: presenceEntry?.liveness_observation ?? null,
    workSignal,
    lastSeenAt: latestTimestamp(
      participant?.last_room_activity_at,
      participant?.last_seen_at,
      latestMessage?.timestamp,
      presenceEntry?.last_heartbeat_at,
      reasoningTimestamp(activeReasoning[0] || {}),
      latestTaskTimestamp(currentTasks),
      latestTaskTimestamp(completedTasks),
      latestTaskTimestamp(createdTasks)
    ),
    messageCount: messages.length,
    activeReasoning,
    currentTasks,
    completedTasks,
    createdTasks,
    recentMessages: [...messages].slice(-4).reverse(),
    thinkingSnapshot,
    thinkingTimeline,
  }
}

export function buildHumanParticipant(input: {
  participant: RoomParticipant
  messages: readonly RoomMessage[]
  tasks: readonly RoomTask[]
}): ActivityParticipant {
  const { participant } = input
  const label = participant.display_name || participant.github_login || 'Unknown human'
  const messages = input.messages.filter((message) =>
    isHumanSender(message.sender, message.source) && participantMatchesHuman(participant, message.sender)
  )
  const assignedTasks = input.tasks.filter((task) => participantMatchesHuman(participant, task.assignee))
  const createdTasks = sortTasksByUpdated(
    input.tasks.filter((task) => participantMatchesHuman(participant, task.created_by))
  ).slice(0, 8)
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const latestMessage = messages[messages.length - 1] || null

  return {
    key: participant.participant_key,
    kind: 'human',
    label,
    actorLabel: participant.github_login || label,
    ownerLabel: null,
    ideLabel: null,
    repoBranch: null,
    activityState: null,
    hasCanonicalPresence: false,
    status: null,
    statusText: latestMessage ? previewMessage(latestMessage.text) : null,
    livenessObservation: null,
    workSignal: null,
    lastSeenAt: latestTimestamp(
      participant.last_room_activity_at,
      participant.last_seen_at,
      latestMessage?.timestamp
    ),
    messageCount: messages.length,
    activeReasoning: [],
    currentTasks,
    completedTasks,
    createdTasks,
    recentMessages: [...messages].slice(-4).reverse(),
    thinkingSnapshot: null,
    thinkingTimeline: [],
  }
}

export function compareParticipants(
  left: ActivityParticipant | HistoryParticipant,
  right: ActivityParticipant | HistoryParticipant,
): number {
  const leftStatus = left.status ? STATUS_ORDER.indexOf(left.status) : STATUS_ORDER.length
  const rightStatus = right.status ? STATUS_ORDER.indexOf(right.status) : STATUS_ORDER.length
  if (leftStatus !== rightStatus) {
    return leftStatus - rightStatus
  }

  const timestampDelta = timestampValue(right.lastSeenAt) - timestampValue(left.lastSeenAt)
  if (timestampDelta !== 0) {
    return timestampDelta
  }

  return left.label.localeCompare(right.label)
}

function isAgentIdentityValue(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized.toLowerCase() === 'letagents' || normalized.toLowerCase() === 'system') return false
  const parsed = parseAgentIdentity(normalized)
  return Boolean(parsed.structured || parsed.ownerAttribution || parsed.ideLabel)
}

function pushMapValue<T>(target: Map<string, T[]>, key: string, value: T): void {
  const existing = target.get(key)
  if (existing) {
    existing.push(value)
    return
  }
  target.set(key, [value])
}
