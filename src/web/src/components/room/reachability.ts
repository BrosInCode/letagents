import {
  parseAgentIdentity,
  type RoomAgentPresence,
  type RoomParticipant,
} from '../../composables/useRoom'

export interface MentionCandidate {
  key: string
  label: string
  mention: string
  meta: string
  search: string
  priority: number
}

export interface AgentReachabilitySource {
  key: string
  actorLabel: string
  participant: RoomParticipant | null
  presence: RoomAgentPresence | null
  activityState: 'active' | 'away' | 'offline'
}

export function isLivePresenceEntry(entry: RoomAgentPresence | null | undefined): boolean {
  return entry?.freshness === 'active' && entry.source_flags.includes('delivery')
}

function normalizeRoomActivityStateValue(
  value: string | null | undefined,
): AgentReachabilitySource['activityState'] | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'online') return 'active'
  if (normalized === 'stale' || normalized === 'historical') return 'offline'
  if (normalized === 'active' || normalized === 'away' || normalized === 'offline') {
    return normalized
  }
  return null
}

export function resolveAgentActivityState(input: {
  participant?: Pick<RoomParticipant, 'activity_state' | 'hidden_at' | 'source_flags'> | null
  presence?: Pick<RoomAgentPresence, 'freshness' | 'activity_state' | 'source_flags' | 'status'> | null
}): AgentReachabilitySource['activityState'] {
  const hasCurrentDelivery = Boolean(
    input.presence?.source_flags?.includes('delivery')
  )
  if (input.participant?.hidden_at) return 'offline'
  if (hasCurrentDelivery && input.presence?.freshness === 'active') {
    return input.presence?.status === 'idle' ? 'away' : 'active'
  }
  if (hasCurrentDelivery) {
    return normalizeRoomActivityStateValue(input.presence?.activity_state)
      || 'offline'
  }
  return 'offline'
}

export function describeAgentReachability(input: {
  activityState: AgentReachabilitySource['activityState'] | null
  hasCanonicalPresence: boolean
  statusText?: string | null
}): string {
  if (input.activityState === 'offline') {
    return input.hasCanonicalPresence
      ? 'Delivery session expired'
      : 'Recorded in room history'
  }

  const statusText = String(input.statusText || '').trim()
  if (statusText) {
    return statusText
  }

  if (input.activityState === 'away') {
    return 'Away but still reachable'
  }

  return 'Active in room right now'
}

export function normalizeMentionToken(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
}

function pushMentionCandidate(
  target: MentionCandidate[],
  seen: Set<string>,
  rawMention: string,
  label: string,
  meta: string,
  priority: number,
  searchParts: Array<string | null | undefined>,
) {
  const mention = normalizeMentionToken(rawMention)
  if (!mention) return
  const key = mention.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  target.push({
    key,
    label: `@${mention}`,
    mention,
    meta,
    priority,
    search: [mention, label, meta, ...searchParts]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
  })
}

export function buildMentionCandidates(input: {
  participants: readonly RoomParticipant[]
  presence: readonly RoomAgentPresence[]
  senderName?: string
}): MentionCandidate[] {
  const seen = new Set<string>()
  const candidates: MentionCandidate[] = []
  const reachablePresenceByActor = new Map(
    input.presence
      .filter((entry) => isLivePresenceEntry(entry))
      .map((entry) => [String(entry.actor_label || '').trim(), entry] as const)
      .filter(([actorLabel]) => Boolean(actorLabel))
  )

  for (const participant of input.participants) {
    if (participant.hidden_at) continue

    if (participant.kind === 'agent') {
      const actorLabel = String(participant.actor_label || '').trim()
      const presenceEntry = actorLabel ? (reachablePresenceByActor.get(actorLabel) || null) : null
      const activityState = resolveAgentActivityState({ participant, presence: presenceEntry })
      if (!actorLabel || !presenceEntry || (activityState !== 'active' && activityState !== 'away')) continue

      const label = participant.display_name
        || presenceEntry.display_name
        || parseAgentIdentity(participant.actor_label || '').displayName
      const meta = [
        participant.owner_label || presenceEntry.owner_label,
        participant.ide_label || presenceEntry.ide_label,
        activityState === 'active' ? 'Active in room' : 'Away but reachable',
      ]
        .filter(Boolean)
        .join(' · ')
      pushMentionCandidate(candidates, seen, label, label, meta, activityState === 'active' ? 0 : 1, [
        participant.actor_label,
        participant.owner_label,
        participant.ide_label,
        participant.agent_key,
        presenceEntry.status,
      ])
      continue
    }

    const label = participant.display_name || participant.github_login || ''
    if (!label || label === input.senderName) continue
    pushMentionCandidate(candidates, seen, label, label, 'User', 2, [participant.github_login])
  }

  return candidates.sort((left, right) =>
    left.priority - right.priority || left.label.localeCompare(right.label)
  )
}

function getParticipantActorLabel(participant: RoomParticipant): string {
  return String(participant.actor_label || participant.display_name || '').trim()
}

export function buildAgentReachabilitySources(input: {
  participants: readonly RoomParticipant[]
  presence: readonly RoomAgentPresence[]
}): AgentReachabilitySource[] {
  const next: AgentReachabilitySource[] = []
  const presenceByActor = new Map(input.presence.map((entry) => [entry.actor_label, entry]))
  const seenActors = new Set<string>()
  const hiddenActors = new Set<string>()

  for (const participant of input.participants) {
    if (participant.kind !== 'agent') continue
    const actorLabel = getParticipantActorLabel(participant)
    if (participant.hidden_at) {
      if (actorLabel) hiddenActors.add(actorLabel)
      continue
    }

    const presence = actorLabel ? (presenceByActor.get(actorLabel) || null) : null
    if (!presence?.source_flags.includes('delivery')) continue
    next.push({
      key: participant.participant_key,
      actorLabel,
      participant,
      presence,
      activityState: resolveAgentActivityState({ participant, presence }),
    })
    if (actorLabel) {
      seenActors.add(actorLabel)
    }
  }

  for (const presence of input.presence) {
    const activityState = resolveAgentActivityState({ presence })
    if (activityState === 'offline' && !presence.source_flags.includes('delivery')) continue
    const actorLabel = String(presence.actor_label || '').trim()
    if (!actorLabel || seenActors.has(actorLabel) || hiddenActors.has(actorLabel)) continue
    next.push({
      key: `agent:${actorLabel.toLowerCase()}`,
      actorLabel,
      participant: null,
      presence,
      activityState,
    })
  }

  return next
}
