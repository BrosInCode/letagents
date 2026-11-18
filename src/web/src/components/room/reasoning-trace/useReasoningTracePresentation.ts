import { computed, getCurrentInstance, onMounted, onScopeDispose, ref, watch, type ComputedRef } from 'vue'
import {
  parseAgentIdentity,
  type RoomReasoningSession,
} from '../../../composables/useRoom'
import {
  buildCurrentLiveTimelineEntry,
  buildCurrentSnapshot,
  buildHighlights,
  buildTimelineEntries,
  classifyReasoningStream,
  formatTimestamp,
} from './reasoningTrace'

/** How often the open modal re-checks whether a live stream has gone stale. */
const STALE_CHECK_INTERVAL_MS = 30_000

export function useReasoningTracePresentation(
  activeSession: ComputedRef<RoomReasoningSession | null>,
  open: () => boolean = () => true,
) {
  // A clock that runs only while the modal is open, so a live stream that went
  // silent decays to "Stale" instead of reading as live forever.
  const now = ref(Date.now())
  let clock: ReturnType<typeof setInterval> | null = null
  const stopClock = () => {
    if (clock) clearInterval(clock)
    clock = null
  }
  const watchOpen = () => watch(open, (isOpen) => {
    stopClock()
    if (!isOpen) return
    now.value = Date.now()
    clock = setInterval(() => { now.value = Date.now() }, STALE_CHECK_INTERVAL_MS)
  }, { immediate: true })
  // Only a mounted component runs the clock: a server render or a plain call
  // (a test) never mounts, so it must not leave a timer running.
  if (getCurrentInstance()) {
    onMounted(watchOpen)
    onScopeDispose(stopClock)
  }

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
    || `${actorDisplayName.value} work log`
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

  const streamClassification = computed(() => {
    const snapshot = currentSnapshot.value
    return classifyReasoningStream({
      status: snapshot?.status || activeSession.value?.status,
      summary: snapshot?.summary,
      checking: snapshot?.checking,
      nextAction: snapshot?.next_action,
      updatedAt: activeSession.value?.updated_at || activeSession.value?.created_at,
      now: now.value,
    })
  })
  const streamState = computed(() => streamClassification.value.state)
  const streamLabel = computed(() => streamClassification.value.label)
  const streamDescription = computed(() => streamClassification.value.description)

  return {
    currentSummary,
    heading,
    highlights,
    streamDescription,
    streamLabel,
    streamState,
    subtitle,
    timelineEntries,
    titleId,
  }
}
