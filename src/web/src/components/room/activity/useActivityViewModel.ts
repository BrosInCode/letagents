import { computed, onUnmounted, ref, watch } from 'vue'
import type { RoomActivityHistoryKind } from '../../../composables/room/types'
import { buildAgentReachabilitySources } from '../reachability'
import {
  buildHistoryParticipant,
  buildHistoryRoomOptions,
  countHistoryOpenTasks,
  resolveHistoryRoomOption,
} from './historyModel'
import {
  buildAgentParticipant,
  buildHumanParticipant,
  compareParticipants,
  groupAgentMessagesByActor,
} from './liveParticipants'
import type {
  ActivityViewProps,
  HistoryRoomOption,
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

  const agentMessagesByActor = computed(() => groupAgentMessagesByActor(props.messages))

  const agentParticipants = computed(() => {
    return buildAgentReachabilitySources({
      participants: props.participants,
      presence: props.presence,
    })
      .map((source) => buildAgentParticipant({
        source,
        messagesByActor: agentMessagesByActor.value,
        reasoningSessions: props.reasoningSessions,
        tasks: props.tasks,
      }))
      .sort(compareParticipants)
  })

  const humanParticipants = computed(() => {
    return props.participants
      .filter((participant) => participant.kind === 'human')
      .map((participant) => buildHumanParticipant({
        participant,
        messages: props.messages,
        tasks: props.tasks,
      }))
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
  const historyRoomOptions = computed<HistoryRoomOption[]>(() =>
    buildHistoryRoomOptions({
      currentRoom: props.currentRoom,
      currentRoomIdentifier: currentRoomIdentifier.value,
      focusRooms: props.focusRooms,
    })
  )
  const selectedHistoryRoomId = computed(() =>
    props.activityHistory?.selected_room_id
    || historyRoomId.value
    || currentRoomIdentifier.value
  )
  const selectedHistoryRoomOption = computed<HistoryRoomOption | null>(() =>
    resolveHistoryRoomOption({
      selectedRoomId: selectedHistoryRoomId.value,
      options: historyRoomOptions.value,
      firstHistoryEntry: historyEntries.value[0] || null,
    })
  )
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
  const historyOpenTaskCount = computed(() => countHistoryOpenTasks(historyEntries.value))

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
    changeHistoryPage,
    handleClearDisconnected,
  }
}
