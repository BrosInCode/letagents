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
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown.esc="$emit('close')"
      >
        <header class="reasoning-header">
          <div>
            <p class="reasoning-eyebrow">Agent reasoning stream</p>
            <h2 :id="titleId">{{ heading }}</h2>
            <p class="reasoning-subtitle">{{ subtitle }}</p>
          </div>
          <button class="reasoning-close" type="button" @click="$emit('close')">
            Close
          </button>
        </header>

        <div class="reasoning-body">
          <section v-if="activeSession.summary" class="reasoning-summary">
            <h3>Current summary</h3>
            <p>{{ activeSession.summary }}</p>
          </section>

          <dl v-if="highlights.length > 0" class="reasoning-highlights">
            <div v-for="item in highlights" :key="item.label" class="reasoning-highlight">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </div>
          </dl>

          <section class="reasoning-timeline-section">
            <div class="reasoning-section-header">
              <h3>Timeline</h3>
              <span>{{ timelineEntries.length }}</span>
            </div>

            <p v-if="isLoadingDetail" class="reasoning-empty">
              Loading the latest reasoning details...
            </p>

            <p v-else-if="timelineEntries.length === 0" class="reasoning-empty">
              No detailed reasoning updates have been exposed for this session yet.
            </p>

            <ol v-else class="reasoning-timeline">
              <li
                v-for="entry in timelineEntries"
                :key="entry.id"
                class="reasoning-entry"
              >
                <div class="reasoning-entry-meta">
                  <span>{{ entryLabel(entry) }}</span>
                  <time>{{ formatTimestamp(entry.timestamp) }}</time>
                </div>
                <p>{{ entry.text }}</p>
              </li>
            </ol>
          </section>
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
import {
  parseAgentIdentity,
  type RoomReasoningEntry,
  type RoomReasoningSession,
  type RoomReasoningSnapshot,
  type RoomReasoningUpdate,
} from '@/composables/useRoom'

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

function sortReasoningUpdates(updates: readonly RoomReasoningUpdate[]): RoomReasoningUpdate[] {
  return [...updates].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '')
    const rightTime = Date.parse(right.created_at || '')
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime
    }
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

function mergeReasoningUpdates(
  existing: readonly RoomReasoningUpdate[] | null | undefined,
  incoming: readonly RoomReasoningUpdate[] | null | undefined,
): RoomReasoningUpdate[] {
  const merged = new Map<string, RoomReasoningUpdate>()
  for (const update of existing || []) {
    if (update?.id) merged.set(update.id, update)
  }
  for (const update of incoming || []) {
    if (update?.id) merged.set(update.id, update)
  }
  return sortReasoningUpdates([...merged.values()])
}

function mergeReasoningSessionDetail(
  existing: RoomReasoningSession,
  incoming: RoomReasoningSession,
): RoomReasoningSession {
  const mergedUpdates = mergeReasoningUpdates(existing.updates, incoming.updates)
  const mergedEntries = Array.isArray(incoming.entries) && incoming.entries.length > 0
    ? incoming.entries
    : Array.isArray(existing.entries) && existing.entries.length > 0
      ? existing.entries
      : incoming.entries ?? existing.entries

  return {
    ...existing,
    ...incoming,
    ...(mergedEntries !== undefined ? { entries: mergedEntries } : {}),
    ...(mergedUpdates.length > 0 ? { updates: mergedUpdates } : {}),
  }
}

const activeSession = computed(() => sessionDetail.value || props.session)

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

const currentSnapshot = computed<RoomReasoningSnapshot | null>(() => {
  const session = activeSession.value
  if (!session) return null

  if (session.latest_payload) {
    return session.latest_payload
  }

  if (
    session.goal
    || session.checking
    || session.hypothesis
    || session.blocker
    || session.next_action
    || session.milestone
    || typeof session.confidence === 'number'
    || session.status
  ) {
    return {
      summary: session.summary || '',
      goal: session.goal,
      checking: session.checking,
      hypothesis: session.hypothesis,
      blocker: session.blocker,
      next_action: session.next_action,
      milestone: session.milestone,
      confidence: session.confidence,
      status: session.status,
    }
  }

  return session.summary ? { summary: session.summary } : null
})

const highlights = computed(() => {
  const session = activeSession.value
  const snapshot = currentSnapshot.value
  if (!session || !snapshot) return []

  const values: Array<[string, string | null | undefined]> = [
    ['Goal', snapshot.goal],
    ['Checking', snapshot.checking],
    ['Hypothesis', snapshot.hypothesis],
    ['Blocker', snapshot.blocker],
    ['Next action', snapshot.next_action],
    ['Milestone', snapshot.milestone],
    ['Visibility', session.visibility],
  ]

  if (typeof snapshot.confidence === 'number') {
    values.push(['Confidence', `${Math.round(snapshot.confidence * 100)}%`])
  }

  return values
    .filter(([, value]) => Boolean(String(value || '').trim()))
    .map(([label, value]) => ({ label, value: String(value) }))
})

const timelineEntries = computed<RoomReasoningEntry[]>(() => {
  const session = activeSession.value
  if (!session) return []

  const detailEntries = Array.isArray(session.entries) && session.entries.length > 0
    ? session.entries
    : Array.isArray(session.updates) && session.updates.length > 0
      ? session.updates.map((update: RoomReasoningUpdate) => ({
        id: update.id,
        label: update.milestone ? 'Milestone' : update.status || 'Update',
        text: update.summary,
        timestamp: update.created_at,
      }))
      : []

  if (detailEntries.length > 0) {
    return [...detailEntries]
      .filter((entry) => Boolean(entry?.id && entry?.text))
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp || '')
        const rightTime = Date.parse(right.timestamp || '')
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime
        }
        return String(left.id).localeCompare(String(right.id))
      })
  }

  const synthesized = [
    ['summary', 'Summary', currentSnapshot.value?.summary || session.summary],
    ['goal', 'Goal', currentSnapshot.value?.goal],
    ['checking', 'Checking', currentSnapshot.value?.checking],
    ['hypothesis', 'Hypothesis', currentSnapshot.value?.hypothesis],
    ['blocker', 'Blocker', currentSnapshot.value?.blocker],
    ['next-action', 'Next action', currentSnapshot.value?.next_action],
    ['milestone', 'Milestone', currentSnapshot.value?.milestone],
  ] as const

  const timestamp = session.updated_at || session.created_at || new Date().toISOString()

  return synthesized
    .filter(([, , text]) => Boolean(String(text || '').trim()))
    .map(([id, label, text]) => ({
      id: `${session.id}-${id}`,
      label,
      text: String(text),
      timestamp,
    }))
})

watch(() => props.open, (next) => {
  if (!next) {
    sessionDetail.value = null
    isLoadingDetail.value = false
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

function entryLabel(entry: RoomReasoningEntry): string {
  const label = String(entry.label || entry.kind || '').trim()
  if (!label) return 'Update'
  return label
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatTimestamp(value: string | null | undefined): string {
  const timestamp = String(value || '').trim()
  if (!timestamp) return 'unknown'

  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return 'unknown'

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<style scoped>
.reasoning-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(2, 6, 23, 0.72);
}

.reasoning-dialog {
  display: flex;
  flex-direction: column;
  width: min(920px, 100%);
  max-height: min(88vh, 940px);
  overflow: hidden;
  border: 1px solid rgba(96, 165, 250, 0.18);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(9, 9, 11, 0.98));
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.45);
}

.reasoning-dialog:focus {
  outline: none;
}

.reasoning-header,
.reasoning-footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}

.reasoning-footer {
  align-items: center;
  justify-content: flex-end;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
  border-bottom: none;
}

.reasoning-eyebrow {
  margin: 0 0 6px;
  color: #93c5fd;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.reasoning-header h2 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1.12rem;
  line-height: 1.25;
}

.reasoning-subtitle {
  margin: 8px 0 0;
  color: var(--muted, #a1a1aa);
  font-size: 0.8rem;
  line-height: 1.4;
}

.reasoning-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
  padding: 20px;
}

.reasoning-summary,
.reasoning-timeline-section {
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.48);
  padding: 16px;
}

.reasoning-summary h3,
.reasoning-section-header h3 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.92rem;
}

.reasoning-summary p {
  margin: 10px 0 0;
  color: var(--text, #fafafa);
  font-size: 0.92rem;
  line-height: 1.65;
  white-space: pre-wrap;
}

.reasoning-highlights {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin: 0;
}

.reasoning-highlight {
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.38);
}

.reasoning-highlight dt {
  margin: 0 0 6px;
  color: #93c5fd;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.reasoning-highlight dd {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.88rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.reasoning-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.reasoning-section-header span {
  color: var(--muted, #a1a1aa);
  font-size: 0.74rem;
  font-weight: 700;
}

.reasoning-empty {
  margin: 0;
  color: var(--muted, #a1a1aa);
  font-size: 0.84rem;
}

.reasoning-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.reasoning-entry {
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.12);
  border-radius: 14px;
  background: rgba(2, 6, 23, 0.44);
}

.reasoning-entry-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  font-weight: 700;
}

.reasoning-entry p {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.88rem;
  line-height: 1.6;
  white-space: pre-wrap;
}

.reasoning-close,
.reasoning-action {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.72);
  color: var(--text, #fafafa);
  cursor: pointer;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 700;
  line-height: 1;
  padding: 10px 14px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.reasoning-close:hover,
.reasoning-close:focus-visible,
.reasoning-action:hover,
.reasoning-action:focus-visible {
  background: rgba(30, 41, 59, 0.96);
  border-color: rgba(191, 219, 254, 0.32);
  outline: none;
}

@media (max-width: 720px) {
  .reasoning-backdrop {
    padding: 10px;
  }

  .reasoning-dialog {
    max-height: calc(100vh - 20px);
  }

  .reasoning-header,
  .reasoning-footer,
  .reasoning-body {
    padding: 14px;
  }

  .reasoning-header {
    flex-direction: column;
  }

  .reasoning-close,
  .reasoning-action {
    width: 100%;
  }
}
</style>
