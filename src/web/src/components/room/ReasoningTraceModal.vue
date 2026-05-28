<template>
  <Teleport to="body">
    <div
      v-if="open && activeSession"
      class="reasoning-backdrop"
      @click.self="$emit('close')"
    >
      <section
        ref="dialogRef"
        class="reasoning-dialog"
        :data-live="streamState === 'live'"
        :data-updating="recentlyUpdated"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown.esc="$emit('close')"
      >
        <ReasoningTraceHeader
          :heading="heading"
          :stream-label="streamLabel"
          :stream-state="streamState"
          :subtitle="subtitle"
          :title-id="titleId"
          @close="$emit('close')"
        />

        <div class="reasoning-body">
          <ReasoningSummarySection
            :live="streamState === 'live'"
            :recently-updated="recentlyUpdated"
            :summary="currentSummary"
          />
          <ReasoningHighlights :items="highlights" />
          <ReasoningTimeline
            :entries="timelineEntries"
            :loading="isLoadingDetail"
            :recently-updated="recentlyUpdated"
          />
        </div>

        <footer class="reasoning-footer">
          <button class="reasoning-action" type="button" @click="$emit('close')">
            Done
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { RoomReasoningSession } from '@/composables/useRoom'
import ReasoningHighlights from './reasoning-trace/ReasoningHighlights.vue'
import ReasoningSummarySection from './reasoning-trace/ReasoningSummarySection.vue'
import ReasoningTimeline from './reasoning-trace/ReasoningTimeline.vue'
import ReasoningTraceHeader from './reasoning-trace/ReasoningTraceHeader.vue'
import { mergeReasoningSessionDetail } from './reasoning-trace/reasoningTrace'
import { useReasoningTracePresentation } from './reasoning-trace/useReasoningTracePresentation'

const props = defineProps<{
  open: boolean
  roomIdentifier?: string
  session: RoomReasoningSession | null
}>()

defineEmits<{
  close: []
}>()

const dialogRef = ref<HTMLElement | null>(null)
const sessionDetail = ref<RoomReasoningSession | null>(null)
const isLoadingDetail = ref(false)
const recentlyUpdated = ref(false)
let livePulseTimer: ReturnType<typeof setTimeout> | null = null

const activeSession = computed(() => sessionDetail.value || props.session)
const {
  currentSummary,
  heading,
  highlights,
  streamLabel,
  streamState,
  subtitle,
  timelineEntries,
  titleId,
} = useReasoningTracePresentation(activeSession)

watch(() => props.open, (next) => {
  if (!next) {
    sessionDetail.value = null
    isLoadingDetail.value = false
    recentlyUpdated.value = false
    if (livePulseTimer) {
      clearTimeout(livePulseTimer)
      livePulseTimer = null
    }
    return
  }
  nextTick(() => dialogRef.value?.focus())
})

watch(
  () => props.session,
  (nextSession) => {
    if (!props.open || !nextSession?.id) return
    if (sessionDetail.value?.id === nextSession.id) {
      sessionDetail.value = mergeReasoningSessionDetail(sessionDetail.value, nextSession)
    }
  }
)

watch(
  () => [
    props.session?.id,
    props.session?.updated_at,
    props.session?.summary,
    props.session?.latest_payload?.summary,
    props.session?.latest_payload?.checking,
    props.session?.latest_payload?.next_action,
  ].join('|'),
  () => {
    if (!props.open || !props.session) return
    recentlyUpdated.value = true
    if (livePulseTimer) clearTimeout(livePulseTimer)
    livePulseTimer = setTimeout(() => {
      recentlyUpdated.value = false
      livePulseTimer = null
    }, 1000)
  }
)

watch(
  () => [props.open, props.roomIdentifier, props.session?.id] as const,
  async ([isOpen, roomIdentifier, sessionId]) => {
    if (!isOpen || !roomIdentifier || !sessionId) return
    if (sessionDetail.value?.id && sessionDetail.value.id !== sessionId) {
      sessionDetail.value = null
    }
    if (sessionDetail.value?.id === sessionId && Array.isArray(sessionDetail.value.updates)) {
      return
    }

    isLoadingDetail.value = true
    sessionDetail.value = null
    try {
      const response = await fetch(
        `/rooms/${encodeURIComponent(roomIdentifier)}/reasoning-sessions/${encodeURIComponent(sessionId)}`,
        {
          credentials: 'same-origin',
        }
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      const session = (data.session || data.reasoning_session || data) as RoomReasoningSession
      const fetchedDetail: RoomReasoningSession = {
        ...session,
        updates: Array.isArray(data.updates) ? data.updates : session.updates,
      }
      sessionDetail.value = props.session?.id === session.id
        ? mergeReasoningSessionDetail(fetchedDetail, props.session)
        : fetchedDetail
    } catch {
      sessionDetail.value = props.session
    } finally {
      isLoadingDetail.value = false
    }
  },
  { immediate: true }
)
</script>

<style src="./reasoning-trace/ReasoningTraceModal.css"></style>
