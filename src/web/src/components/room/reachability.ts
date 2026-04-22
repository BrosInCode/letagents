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
  activityState: 'online' | 'stale' | 'historical' | 'archived'
}

export function isLivePresenceEntry(entry: RoomAgentPresence | null | undefined): boolean {
  return entry?.activity_state === 'online' || entry?.freshness === 'active'
}

export function resolveAgentActivityState(input: {
  participant?: Pick<RoomParticipant, 'activity_state' | 'hidden_at'> | null
  presence?: Pick<RoomAgentPresence, 'freshness' | 'activity_state' | 'source_flags'> | null
}): AgentReachabilitySource['activityState'] {
  const hasCanonicalPresence = input.presence?.source_flags?.includes('presence') || false
  if (input.participant?.hidden_at) return 'archived'
  if (hasCanonicalPresence && input.presence?.freshness === 'active') return 'online'
  if (hasCanonicalPresence && input.presence?.freshness === 'stale') return 'stale'
  return input.participant?.activity_state || input.presence?.activity_state || 'historical'
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
  const onlinePresenceByActor = new Map(
    input.presence
      .filter((entry) => isLivePresenceEntry(entry))
      .map((entry) => [String(entry.actor_label || '').trim(), entry] as const)
      .filter(([actorLabel]) => Boolean(actorLabel))
  )

  for (const participant of input.participants) {
    if (participant.hidden_at) continue

    if (participant.kind === 'agent') {
      const actorLabel = String(participant.actor_label || '').trim()
      const presenceEntry = actorLabel ? (onlinePresenceByActor.get(actorLabel) || null) : null
      if (
        !actorLabel
        || !presenceEntry
        || resolveAgentActivityState({ participant, presence: presenceEntry }) !== 'online'
      ) continue

      const label = participant.display_name
        || presenceEntry.display_name
        || parseAgentIdentity(participant.actor_label || '').displayName
      const meta = [participant.owner_label || presenceEntry.owner_label, participant.ide_label || presenceEntry.ide_label, 'Online now']
        .filter(Boolean)
        .join(' · ')
      pushMentionCandidate(candidates, seen, label, label, meta, 0, [
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
    if (activityState === 'historical' || activityState === 'archived') continue
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
