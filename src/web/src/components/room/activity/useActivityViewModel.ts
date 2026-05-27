import { computed, onUnmounted, ref, watch } from 'vue'
import {
  isHumanSender,
  parseAgentIdentity,
  type RoomActivityHistoryEntry,
  type RoomActivityHistoryKind,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomParticipant,
  type RoomReasoningSession,
} from '@/composables/useRoom'
import {
  buildAgentReachabilitySources,
  describeAgentReachability,
  type AgentReachabilitySource,
} from '../reachability'
import {
  buildAgentThinkingFromReasoningSession,
  buildAgentThinkingSnapshot,
  buildAgentThinkingTimeline,
  extractStatusText,
  type AgentThinkingTimelineEntry,
} from '../agentThinking'
import {
  ACTIVITY_STATE_LABELS,
  COMPLETED_TASK_STATUSES,
  INACTIVE_REASONING_STATUSES,
  OPEN_TASK_STATUSES,
  STATUS_ORDER,
  TASK_STATUS_LABELS,
} from './labels'
import {
  formatLastSeen,
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
  ActivityTaskListItem,
  ActivityViewProps,
  HistoryParticipant,
  HistoryRoomOption,
  ParticipantWorkSignal,
} from './types'

export function useActivityViewModel(props: ActivityViewProps) {
  const activeView = ref<'live' | 'history'>('live')
  const selectedParticipantKey = ref<string | null>(null)
  const selectedHistoryParticipantKey = ref<string | null>(null)
  const selectedReasoningId = ref<string | null>(null)
  const historyQuery = ref('')
  const historyKind = ref<RoomActivityHistoryKind>('all')
  const historyRoomId = ref('')
  const clearBusy = ref(false)
  let historySearchTimer: ReturnType<typeof setTimeout> | null = null

  function isAgentIdentityValue(value: string | null | undefined): boolean {
    const normalized = String(value || '').trim()
    if (!normalized) return false
    if (normalized.toLowerCase() === 'letagents' || normalized.toLowerCase() === 'system') return false
    const parsed = parseAgentIdentity(normalized)
    return Boolean(parsed.structured || parsed.ownerAttribution || parsed.ideLabel)
  }

  function pushMapValue<T>(target: Map<string, T[]>, key: string, value: T) {
    const existing = target.get(key)
    if (existing) {
      existing.push(value)
      return
    }
    target.set(key, [value])
  }

  const agentMessagesByActor = computed(() => {
    const grouped = new Map<string, RoomMessage[]>()
    for (const message of props.messages) {
      const sender = String(message.sender || '').trim()
      if (!sender || isHumanSender(sender, message.source)) continue
      const key = message.agent_identity?.actor_label || sender
      pushMapValue(grouped, key, message)
    }
    return grouped
  })

  function participantMatchesHuman(participant: RoomParticipant, value: string | null): boolean {
    const normalized = String(value || '').trim().toLowerCase()
    if (!normalized) return false

    const githubLogin = String(participant.github_login || '').trim().toLowerCase()
    const displayName = String(participant.display_name || '').trim().toLowerCase()
    return normalized === githubLogin || normalized === displayName
  }

  function participantMatchesActor(participant: ActivityParticipant, value: string | null): boolean {
    const normalized = String(value || '').trim()
    if (!normalized) return false
    if (normalized === participant.actorLabel) return true

    if (participant.kind === 'agent' && isAgentIdentityValue(normalized)) {
      return parseAgentIdentity(normalized).displayName === participant.label
    }

    return false
  }

  function sessionMatchesAgent(participant: {
    actorLabel: string
    label: string
  }, session: RoomReasoningSession): boolean {
    const actorLabel = String(session.actor_label || '').trim()
    if (actorLabel && actorLabel === participant.actorLabel) return true

    const agentDisplayName = actorLabel ? parseAgentIdentity(actorLabel).displayName : ''
    return Boolean(agentDisplayName && agentDisplayName === participant.label)
  }

  function isActiveReasoningSession(session: RoomReasoningSession): boolean {
    if (session.closed_at) return false
    return !INACTIVE_REASONING_STATUSES.has(String(session.status || '').toLowerCase())
  }

  function buildWorkSignal(input: {
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
      return { state: 'responding', label: 'Responding', detail: 'Visible reasoning stream active' }
    }

    if (input.currentTasks.length > 0) {
      return { state: 'working', label: 'Working', detail: `${input.currentTasks.length} open task${input.currentTasks.length === 1 ? '' : 's'} assigned` }
    }

    return null
  }

  function livenessCapabilityLabel(value: string | null | undefined): string {
    const normalized = String(value || '').trim().toLowerCase()
    if (normalized === 'codex_app_server_runtime_stream') return 'Codex app-server stream'
    if (normalized === 'session_activity') return 'Session activity'
    if (normalized === 'process_observed') return 'Process observed'
    if (normalized === 'tool_bridge_only') return 'Tool bridge'
    return 'Liveness signal'
  }

  function buildAgentParticipant(source: AgentReachabilitySource): ActivityParticipant {
    const { actorLabel, key, participant, presence: presenceEntry, activityState } = source
    const messages = actorLabel ? (agentMessagesByActor.value.get(actorLabel) || []) : []
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
    const activeReasoning = sortReasoningSessions(
      props.reasoningSessions.filter((session) =>
        isActiveReasoningSession(session)
        && sessionMatchesAgent({ actorLabel, label }, session)
      )
    )

    const assignedTasks = props.tasks.filter((task) => participantMatchesActor({
      key,
      kind: 'agent',
      label,
      actorLabel,
      ownerLabel,
      ideLabel,
      activityState: null,
      hasCanonicalPresence: false,
      status: null,
      statusText: null,
      livenessObservation: null,
      workSignal: null,
      lastSeenAt: null,
      messageCount: messages.length,
      activeReasoning: [],
      currentTasks: [],
      completedTasks: [],
      createdTasks: [],
      recentMessages: [],
      thinkingSnapshot: null,
      thinkingTimeline: [],
    }, task.assignee))
    const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
    const completedTasks = sortTasksByUpdated(
      assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
    ).slice(0, 8)
    const createdTasks = sortTasksByUpdated(
      props.tasks.filter((task) => participantMatchesActor({
        key,
        kind: 'agent',
        label,
        actorLabel,
        ownerLabel,
        ideLabel,
        activityState: null,
        hasCanonicalPresence: false,
        status: null,
        statusText: null,
        livenessObservation: null,
        workSignal: null,
        lastSeenAt: null,
        messageCount: messages.length,
        activeReasoning: [],
        currentTasks: [],
        completedTasks: [],
        createdTasks: [],
        recentMessages: [],
        thinkingSnapshot: null,
        thinkingTimeline: [],
      }, task.created_by))
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
      activityState,
      hasCanonicalPresence: Boolean(
        presenceEntry?.source_flags?.includes('delivery')
      ),
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

  function buildHumanParticipant(participant: RoomParticipant): ActivityParticipant {
    const label = participant.display_name || participant.github_login || 'Unknown human'
    const messages = props.messages.filter((message) =>
      isHumanSender(message.sender, message.source) && participantMatchesHuman(participant, message.sender)
    )
    const assignedTasks = props.tasks.filter((task) => participantMatchesHuman(participant, task.assignee))
    const createdTasks = sortTasksByUpdated(
      props.tasks.filter((task) => participantMatchesHuman(participant, task.created_by))
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

  function compareParticipants(left: ActivityParticipant | HistoryParticipant, right: ActivityParticipant | HistoryParticipant): number {
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

  const agentParticipants = computed(() => {
    return buildAgentReachabilitySources({
      participants: props.participants,
      presence: props.presence,
    })
      .map((source) => buildAgentParticipant(source))
      .sort(compareParticipants)
  })

  const humanParticipants = computed(() => {
    return props.participants
      .filter((participant) => participant.kind === 'human')
      .map((participant) => buildHumanParticipant(participant))
      .sort(compareParticipants)
  })

  const connectedAgents = computed(() =>
    agentParticipants.value.filter((participant) =>
      participant.activityState === 'active' || participant.activityState === 'away'
    )
  )

  const workingAgents = computed(() =>
    connectedAgents.value.filter((participant) => Boolean(participant.workSignal))
  )

  const recentlyDisconnectedAgents = computed(() =>
    agentParticipants.value.filter((participant) =>
      participant.activityState === 'offline' && participant.hasCanonicalPresence
    )
  )

  const activeReasoningSessions = computed(() =>
    agentParticipants.value.flatMap((participant) => participant.activeReasoning)
  )

  const humans = computed(() => humanParticipants.value)

  const participants = computed(() => [
    ...connectedAgents.value,
    ...recentlyDisconnectedAgents.value,
    ...humans.value,
  ])

  const currentRoomIdentifier = computed(() => props.currentRoom?.identifier || props.roomIdentifier)
  const historyEntries = computed(() => props.activityHistory?.entries || [])
  const clearedLiveCount = computed(() => props.liveClearedCount || 0)
  const historyRoomOptions = computed<HistoryRoomOption[]>(() => {
    const options: HistoryRoomOption[] = []
    const seen = new Set<string>()

    const pushOption = (option: HistoryRoomOption | null) => {
      if (!option?.id || seen.has(option.id)) return
      seen.add(option.id)
      options.push(option)
    }

    pushOption(currentRoomIdentifier.value
      ? {
        id: currentRoomIdentifier.value,
        label: props.currentRoom?.displayName || currentRoomIdentifier.value,
        kind: props.currentRoom?.kind || 'main',
        sourceTaskId: props.currentRoom?.sourceTaskId || null,
      }
      : null)

    if (props.currentRoom?.kind === 'main') {
      for (const focusRoom of props.focusRooms) {
        pushOption({
          id: focusRoom.room_id,
          label: focusRoom.display_name,
          kind: focusRoom.kind,
          sourceTaskId: focusRoom.source_task_id || null,
        })
      }
    }

    return options
  })
  const selectedHistoryRoomId = computed(() =>
    props.activityHistory?.selected_room_id
    || historyRoomId.value
    || currentRoomIdentifier.value
  )
  const selectedHistoryRoomOption = computed<HistoryRoomOption | null>(() => {
    const selected = historyRoomOptions.value.find((option) => option.id === selectedHistoryRoomId.value)
    if (selected) {
      return selected
    }

    const historyRoom = historyEntries.value[0]?.room
    if (historyRoom) {
      return {
        id: historyRoom.id,
        label: historyRoom.display_name,
        kind: historyRoom.kind,
        sourceTaskId: historyRoom.source_task_id,
      }
    }

    if (!selectedHistoryRoomId.value) {
      return null
    }

    return {
      id: selectedHistoryRoomId.value,
      label: selectedHistoryRoomId.value,
      kind: 'main',
      sourceTaskId: null,
    }
  })
  const historyCountLabel = computed(() => {
    const total = props.activityHistory?.total || 0
    const roomLabel = selectedHistoryRoomOption.value?.label || 'selected room'
    return total === 1
      ? `1 participant in ${roomLabel}`
      : `${total} participants in ${roomLabel}`
  })
  const historyPageLabel = computed(() => {
    if (!props.activityHistory) return ''
    return `Page ${props.activityHistory.page} of ${props.activityHistory.page_count}`
  })
  const historyOpenTaskCount = computed(() =>
    historyEntries.value.reduce((total, entry) => total + entry.current_tasks.length, 0)
  )

  function buildHistoryParticipant(entry: RoomActivityHistoryEntry): HistoryParticipant {
    const actorLabel = String(entry.participant.actor_label || entry.participant.display_name || '').trim()
    const parsed = parseAgentIdentity(actorLabel)
    const label = entry.participant.display_name
      || parsed.displayName
      || actorLabel
      || 'Unknown participant'
    const ownerLabel = entry.participant.owner_label
      || parsed.ownerAttribution
      || null
    const ideLabel = entry.participant.ide_label
      || parsed.ideLabel
      || null

    return {
      key: entry.id,
      roomId: entry.room.id,
      kind: entry.participant.kind,
      label,
      actorLabel: entry.participant.kind === 'human'
        ? (entry.participant.github_login || label)
        : actorLabel,
      ownerLabel,
      ideLabel,
      activityState: null,
      hasCanonicalPresence: false,
      status: null,
      statusText: null,
      livenessObservation: null,
      workSignal: null,
      firstSeenAt: entry.first_seen_at,
      lastSeenAt: entry.last_seen_at,
      messageCount: 0,
      currentTasks: entry.current_tasks,
      completedTasks: entry.completed_tasks,
      createdTasks: entry.created_tasks,
      recentMessages: [],
      thinkingSnapshot: null,
      thinkingTimeline: [],
    }
  }

  const historyParticipants = computed(() =>
    historyEntries.value
      .map((entry) => buildHistoryParticipant(entry))
      .sort(compareParticipants)
  )
  const historyAgents = computed(() =>
    historyParticipants.value.filter((participant) => participant.kind === 'agent')
  )
  const historyHumans = computed(() =>
    historyParticipants.value.filter((participant) => participant.kind === 'human')
  )
  const showHistoryAgentSection = computed(() => historyKind.value !== 'human')
  const showHistoryHumanSection = computed(() => historyKind.value !== 'agent')
  const historySummaryCards = computed(() => [
    {
      value: historyAgents.value.length,
      label: 'Agents in history',
    },
    {
      value: historyHumans.value.length,
      label: 'Humans in history',
    },
    {
      value: historyOpenTaskCount.value,
      label: 'Open tasks linked',
    },
  ])

  const selectedParticipant = computed(() =>
    participants.value.find((participant) => participant.key === selectedParticipantKey.value)
    || participants.value[0]
    || null
  )
  const selectedReasoningSession = computed(() => {
    const selectedId = selectedReasoningId.value
    if (!selectedId) return null
    return props.reasoningSessions.find((session) => session.id === selectedId) || null
  })
  const selectedHistoryParticipant = computed(() =>
    historyParticipants.value.find((participant) => participant.key === selectedHistoryParticipantKey.value)
    || historyParticipants.value[0]
    || null
  )

  watch(participants, (next) => {
    if (!next.length) {
      selectedParticipantKey.value = null
      return
    }

    if (!selectedParticipantKey.value || !next.some((participant) => participant.key === selectedParticipantKey.value)) {
      selectedParticipantKey.value = next[0].key
    }
  }, { immediate: true })

  watch(historyParticipants, (next) => {
    if (!next.length) {
      selectedHistoryParticipantKey.value = null
      return
    }

    if (!selectedHistoryParticipantKey.value || !next.some((participant) => participant.key === selectedHistoryParticipantKey.value)) {
      selectedHistoryParticipantKey.value = next[0].key
    }
  }, { immediate: true })

  async function requestHistory(page = props.activityHistory?.page || 1): Promise<void> {
    if (!props.roomIdentifier || !props.loadActivityHistory) return
    await props.loadActivityHistory({
      query: historyQuery.value,
      page,
      pageSize: props.activityHistory?.page_size || 20,
      kind: historyKind.value,
      roomId: historyRoomId.value || currentRoomIdentifier.value,
    })
  }

  function queueHistoryReload(): void {
    if (historySearchTimer) {
      clearTimeout(historySearchTimer)
    }
    historySearchTimer = setTimeout(() => {
      if (activeView.value === 'history') {
        void requestHistory(1)
      }
    }, 220)
  }

  watch(() => activeView.value, (next) => {
    if (next === 'history' && !props.activityHistoryLoading) {
      if (!historyRoomId.value) {
        historyRoomId.value = currentRoomIdentifier.value || ''
      }
      void requestHistory(props.activityHistory?.page || 1)
    }
  })

  watch(currentRoomIdentifier, (next) => {
    if (next && !historyRoomId.value) {
      historyRoomId.value = next
    }
    if (activeView.value === 'history') {
      void requestHistory(1)
    }
  }, { immediate: true })

  watch(() => props.activityHistory?.selected_room_id, (next) => {
    if (next && next !== historyRoomId.value) {
      historyRoomId.value = next
    }
  })

  watch(() => historyRoomId.value, (next, previous) => {
    if (!next || next === previous || activeView.value !== 'history') {
      return
    }
    void requestHistory(1)
  })

  watch(() => historyKind.value, () => {
    if (activeView.value === 'history') {
      void requestHistory(1)
    }
  })

  watch(() => historyQuery.value, () => {
    queueHistoryReload()
  })

  onUnmounted(() => {
    if (historySearchTimer) {
      clearTimeout(historySearchTimer)
      historySearchTimer = null
    }
  })

  function participantMeta(participant: ActivityParticipant | HistoryParticipant): string {
    if (participant.kind === 'human') {
      return 'Human participant'
    }

    return participant.ownerLabel || 'Agent'
  }

  function participantNote(participant: ActivityParticipant | HistoryParticipant): string {
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

  function historyLastSeenLabel(value: string | null): string {
    const relative = formatLastSeen(value)
    return relative === 'unknown' ? 'Last in room unknown' : `Last in room ${relative}`
  }

  function historyParticipantNote(participant: HistoryParticipant): string {
    if (participant.kind === 'human') {
      return 'Seen via browser room history'
    }

    if (!participant.firstSeenAt) {
      return 'Recorded in room history'
    }

    return `First joined ${formatLastSeen(participant.firstSeenAt)}`
  }

  function historyDetailNote(participant: HistoryParticipant): string {
    if (participant.kind === 'human') {
      return 'History stays focused on room participation and linked work. Use the Live tab for current browser activity.'
    }

    return 'History stays focused on room participation and linked work. Use the Live tab to inspect current reachability and work signals.'
  }

  function reasoningCardTitle(session: RoomReasoningSession): string {
    return session.title || session.summary || session.goal || 'Reasoning stream'
  }

  function reasoningCardSummary(session: RoomReasoningSession): string {
    return session.latest_payload?.checking
      || session.latest_payload?.next_action
      || session.latest_payload?.hypothesis
      || session.checking
      || session.next_action
      || session.hypothesis
      || session.summary
      || 'No summary published yet.'
  }

  function reasoningStatusLabel(session: RoomReasoningSession): string {
    if (session.closed_at) return 'Closed'
    const normalized = String(session.status || 'active').trim()
    if (!normalized) return 'Active'
    return normalized
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }

  function connectionLabel(participant: ActivityParticipant | HistoryParticipant | null): string {
    if (!participant || participant.kind !== 'agent') return 'Human'
    return participant.activityState ? ACTIVITY_STATE_LABELS[participant.activityState] : 'History'
  }

  function getTaskLink(
    task: ActivityTaskListItem,
  ): { label: string; url: string } | null {
    const gh = props.taskGithubStatus[task.id]
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

  function changeHistoryPage(page: number): void {
    void requestHistory(page)
  }

  async function handleClearDisconnected(): Promise<void> {
    if (!props.clearDisconnectedParticipants || clearBusy.value) return
    clearBusy.value = true
    try {
      await props.clearDisconnectedParticipants()
      if (activeView.value === 'history') {
        await requestHistory(props.activityHistory?.page || 1)
      }
    } finally {
      clearBusy.value = false
    }
  }

  return {
    activeView,
    selectedParticipantKey,
    selectedHistoryParticipantKey,
    selectedReasoningId,
    historyQuery,
    historyKind,
    historyRoomId,
    clearBusy,
    TASK_STATUS_LABELS,
    connectedAgents,
    workingAgents,
    recentlyDisconnectedAgents,
    activeReasoningSessions,
    humans,
    participants,
    historyEntries,
    clearedLiveCount,
    historyRoomOptions,
    selectedHistoryRoomId,
    selectedHistoryRoomOption,
    historyCountLabel,
    historyPageLabel,
    historyAgents,
    historyHumans,
    showHistoryAgentSection,
    showHistoryHumanSection,
    historySummaryCards,
    selectedParticipant,
    selectedReasoningSession,
    selectedHistoryParticipant,
    participantMeta,
    participantNote,
    historyLastSeenLabel,
    historyParticipantNote,
    historyDetailNote,
    reasoningCardTitle,
    reasoningCardSummary,
    reasoningStatusLabel,
    connectionLabel,
    getTaskLink,
    changeHistoryPage,
    handleClearDisconnected,
    formatLastSeen,
  }
}
