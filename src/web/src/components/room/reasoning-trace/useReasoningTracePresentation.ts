import { computed, type ComputedRef } from 'vue'
import {
  parseAgentIdentity,
  type RoomReasoningSession,
} from '../../../composables/useRoom'
import {
  buildCurrentLiveTimelineEntry,
  buildCurrentSnapshot,
  buildHighlights,
  buildTimelineEntries,
  entryLabel,
  formatTimestamp,
  isCodexReasoningSummarySnapshot,
  isCodexSnapshotPayload,
  resolveStreamState,
} from './reasoningTrace'

export function useReasoningTracePresentation(
  activeSession: ComputedRef<RoomReasoningSession | null>,
) {
  const titleId = computed(() => {
    const raw = String(activeSession.value?.id || 'reasoning').replace(/[^A-Za-z0-9_-]/g, '-')
    return `reasoning-modal-title-${raw || 'session'}`
  })

  const actorDisplayName = computed(() => {
    const actor = String(activeSession.value?.actor_label || '').trim()
    if (!actor) return 'Agent'
    return parseAgentIdentity(actor).displayName || actor
  })

  const heading = computed(() =>
    activeSession.value?.title
    || activeSession.value?.summary
    || `${actorDisplayName.value} reasoning`
  )

  const subtitle = computed(() => {
    const bits = [actorDisplayName.value]

    if (activeSession.value?.task_id) {
      bits.push(activeSession.value.task_id)
    }

    const updatedAt = formatTimestamp(activeSession.value?.updated_at || activeSession.value?.created_at || null)
    if (updatedAt !== 'unknown') {
      bits.push(`Updated ${updatedAt}`)
    }

    return bits.join(' · ')
  })

  const currentSnapshot = computed(() => buildCurrentSnapshot(activeSession.value))

  const currentSummary = computed(() =>
    currentSnapshot.value?.summary
    || activeSession.value?.summary
    || ''
  )

  const highlights = computed(() => buildHighlights(activeSession.value, currentSnapshot.value))

  const currentLiveTimelineEntry = computed(() =>
    buildCurrentLiveTimelineEntry(activeSession.value, currentSnapshot.value, currentSummary.value)
  )

  const timelineEntries = computed(() =>
    buildTimelineEntries(activeSession.value, currentSnapshot.value, currentLiveTimelineEntry.value)
  )

  const isCodexReasoningSummary = computed(() =>
    isCodexReasoningSummarySnapshot(currentSnapshot.value)
  )

  const isCodexSnapshot = computed(() =>
    isCodexSnapshotPayload(currentSnapshot.value)
  )

  const streamState = computed(() =>
    resolveStreamState(
      activeSession.value,
      currentSnapshot.value,
      isCodexReasoningSummary.value,
      isCodexSnapshot.value,
    )
  )

  const streamLabel = computed(() => {
    if (isCodexReasoningSummary.value) return 'Live thinking'
    if (isCodexSnapshot.value) return 'Snapshot'
    const status = String(currentSnapshot.value?.status || activeSession.value?.status || '').trim()
    return status ? entryLabel({ id: 'status', text: status, timestamp: '', label: status }) : 'Reasoning'
  })

  return {
    currentSummary,
    heading,
    highlights,
    streamLabel,
    streamState,
    subtitle,
    timelineEntries,
    titleId,
  }
}
