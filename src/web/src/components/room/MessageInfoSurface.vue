<template>
  <Teleport to="body">
    <div v-if="open" class="message-info-backdrop" @click="close">
      <div class="message-info-surface" @click.stop>
        <!-- Header -->
        <div class="message-info-header">
          <div class="header-main">
            <h3>Message info</h3>
            <span v-if="infoData?.message?.timestamp" class="sent-time">
              Sent {{ formattedSentTime }}
            </span>
          </div>
          <button type="button" class="close-btn" aria-label="Close message info" @click="close">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- Preview -->
        <div v-if="infoData?.message" class="message-preview-box">
          <div class="preview-sender">{{ infoData.message.sender }}</div>
          <div class="preview-text">{{ infoData.message.text_preview }}</div>
        </div>

        <!-- Loading / Error -->
        <div v-if="loading" class="state-container loading">
          <div class="spinner" />
          <span>Loading info...</span>
        </div>
        <div v-else-if="error" class="state-container error">
          <span>{{ error }}</span>
          <button type="button" class="retry-btn" @click="fetchInfo">Retry</button>
        </div>

        <div v-else-if="infoData" class="message-info-content">
          <!-- Compact Summary -->
          <div class="summary-line">
            <span>Seen by {{ infoData.summary_counts.seen_count }} {{ infoData.summary_counts.seen_count === 1 ? 'person' : 'people' }}</span>
            <span class="dot">·</span>
            <span>{{ infoData.summary_counts.asked_count }} {{ infoData.summary_counts.asked_count === 1 ? 'agent' : 'agents' }} asked</span>
            <span v-if="infoData.summary_counts.reply_count > 0" class="dot">·</span>
            <span v-if="infoData.summary_counts.reply_count > 0">
              {{ infoData.summary_counts.reply_count }} {{ infoData.summary_counts.reply_count === 1 ? 'reply' : 'replies' }}
            </span>
          </div>

          <!-- Section: Agents Asked -->
          <div v-if="infoData.agents_asked.length > 0" class="info-section">
            <h4 class="section-title">Agents asked</h4>
            <div class="agent-list">
              <div v-for="agent in infoData.agents_asked" :key="agent.receipt_id" class="agent-row">
                <div class="agent-avatar">{{ agent.actor_label.charAt(0).toUpperCase() }}</div>
                <div class="agent-info">
                  <div class="agent-name">{{ agent.actor_label }}</div>
                  <div class="agent-status-line">
                    <span class="status-badge" :class="agent.receipt_state">
                      {{ formatReceiptStatus(agent.receipt_state, agent.observed) }}
                    </span>
                    <span class="reason-label">· {{ agent.activation_reason_label }}</span>
                  </div>
                </div>
                <button
                  v-if="agent.receipt_state === 'replied' && agent.reply_message_id"
                  type="button"
                  class="action-btn view-reply"
                  @click="emit('viewReply', agent.reply_message_id)"
                >
                  View reply
                </button>
              </div>
            </div>
          </div>
          <div v-else class="empty-section">
            <span>No agents were asked to respond.</span>
          </div>

          <!-- Section: Seen by People -->
          <div v-if="infoData.seen_by_people.length > 0" class="info-section">
            <h4 class="section-title">Seen by people</h4>
            <div class="people-list">
              <div v-for="person in infoData.seen_by_people" :key="`${person.name}:${person.seen_at}`" class="person-row">
                <img
                  v-if="person.avatar_url"
                  :src="person.avatar_url"
                  :alt="person.name"
                  class="person-avatar"
                />
                <div v-else class="person-avatar fallback">{{ person.name.charAt(0).toUpperCase() }}</div>
                <div class="person-info">
                  <span class="person-name">{{ person.name }}</span>
                  <span class="seen-time">Seen {{ formatRelativeTime(person.seen_at) }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty-section">
            <span>No one has seen this yet.</span>
          </div>

          <!-- Section: Also Observed -->
          <div v-if="infoData.also_observed.length > 0" class="disclosure-section">
            <details>
              <summary>
                Also observed by {{ infoData.also_observed.length }} {{ infoData.also_observed.length === 1 ? 'agent' : 'agents' }} · no response requested
              </summary>
              <div class="quiet-agents-list">
                <div v-for="agent in infoData.also_observed" :key="agent.agent_key" class="quiet-agent-row">
                  <span class="quiet-agent-key">{{ agent.display_name || agent.agent_key }}</span>
                  <span class="quiet-status">Observed · No response requested</span>
                </div>
              </div>
            </details>
          </div>

          <!-- Section: Details (progressive disclosure) -->
          <div class="disclosure-section">
            <details>
              <summary>Details</summary>
              <div class="details-list">
                <div class="details-row">
                  <span class="details-label">Message ID</span>
                  <button type="button" class="details-copy" :title="copiedMessageId ? 'Copied' : 'Copy message ID'" @click="copyMessageId">
                    {{ infoData.message.id }}{{ copiedMessageId ? ' · Copied' : '' }}
                  </button>
                </div>
                <div v-if="infoData.message.thread_root_id !== infoData.message.id" class="details-row">
                  <span class="details-label">Thread</span>
                  <span>Reply in thread {{ infoData.message.thread_root_id }}</span>
                </div>
                <div v-else-if="infoData.message.reply_to_id" class="details-row">
                  <span class="details-label">Replies to</span>
                  <span>{{ infoData.message.reply_to_id }}</span>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  invalidationCoversMessage,
  lastMessageInfoInvalidation,
} from './messageInfoInvalidation'

const props = defineProps<{
  open: boolean
  roomId: string
  messageId: string
}>()

const emit = defineEmits<{
  close: []
  viewReply: [replyId: string]
}>()

interface SeenPerson {
  name: string
  avatar_url: string | null
  seen_at: string
}

interface AgentAsked {
  receipt_id: string
  agent_key: string
  agent_session_id: string
  actor_label: string
  activation_reason: string
  activation_reason_label: string
  receipt_state: string
  observed?: boolean
  reply_message_id?: string | null
  created_at: string
  updated_at: string
}

interface QuietObserved {
  agent_key: string
  agent_session_id: string
  display_name?: string
}

interface MessageInfoResponse {
  message: {
    id: string
    room_id: string
    number: number
    sender: string
    text_preview: string
    timestamp: string
    thread_root_id: string
    reply_to_id: string | null
  }
  seen_by_people: SeenPerson[]
  agents_asked: AgentAsked[]
  also_observed: QuietObserved[]
  summary_counts: {
    seen_count: number
    asked_count: number
    reply_count: number
    observed_count: number
  }
}

const loading = ref(false)
const error = ref<string | null>(null)
const infoData = ref<MessageInfoResponse | null>(null)
let refreshTimer: number | null = null
let fetchInFlight = false
let refetchQueued = false

const formattedSentTime = computed(() => {
  if (!infoData.value?.message?.timestamp) return ''
  return new Date(infoData.value.message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})

function formatReceiptStatus(state: string, observed?: boolean): string {
  switch (state) {
    // Span evidence, not a guess — and agents observe, humans read: an asked
    // agent that durably observed the message reads differently from one
    // that never received it.
    case 'queued': return observed ? 'Observed · awaiting reply' : 'Asked to respond · Not yet observed'
    case 'responding': return 'Responding'
    case 'replied': return 'Replied'
    case 'no_reply': return 'Chose not to reply'
    case 'retrying': return 'Retrying delivery'
    case 'blocked': return 'Needs attention'
    case 'cancelled': return 'Cancelled'
    case 'unavailable': return 'Unavailable'
    default: return state
  }
}

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const copiedMessageId = ref(false)

async function copyMessageId() {
  const id = infoData.value?.message?.id
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    copiedMessageId.value = true
    window.setTimeout(() => { copiedMessageId.value = false }, 1500)
  } catch {
    // Clipboard may be unavailable; the ID is still visible to select.
  }
}

async function fetchInfo() {
  if (!props.roomId || !props.messageId) return
  if (fetchInFlight) {
    refetchQueued = true
    return
  }
  fetchInFlight = true
  // Only the very first load shows the skeleton; live refreshes update the
  // card in place so it never flickers or remounts.
  if (!infoData.value) loading.value = true
  error.value = null
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(props.roomId)}/messages/${encodeURIComponent(props.messageId)}/info`)
    if (!res.ok) {
      throw new Error('Failed to load message info')
    }
    infoData.value = await res.json()
  } catch (err: any) {
    error.value = err.message || 'Error loading message info'
  } finally {
    loading.value = false
    fetchInFlight = false
    if (refetchQueued) {
      refetchQueued = false
      void fetchInfo()
    }
  }
}

function scheduleInvalidationRefresh() {
  if (refreshTimer !== null) return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    if (props.open) void fetchInfo()
  }, 250)
}

// SSE invalidation while the card is open: repair through the GET endpoint,
// trailing-debounced and single-flight.
watch(lastMessageInfoInvalidation, (invalidation) => {
  if (!props.open || !props.roomId || !props.messageId) return
  if (invalidationCoversMessage(invalidation, props.roomId, props.messageId)) {
    scheduleInvalidationRefresh()
  }
})

function close() {
  emit('close')
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) {
    event.stopPropagation()
    close()
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown, true))
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer)
    refreshTimer = null
  }
})

watch(
  () => [props.open, props.messageId],
  ([isOpen]) => {
    if (isOpen) {
      fetchInfo()
    } else {
      infoData.value = null
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.message-info-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.message-info-surface {
  width: 400px;
  max-width: 90vw;
  max-height: 85vh;
  background: var(--surface, #18181b);
  border: 1px solid var(--border, #27272a);
  border-radius: 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text, #fafafa);
}

.message-info-header {
  padding: 16px;
  border-bottom: 1px solid var(--border, #27272a);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-main h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.sent-time {
  font-size: 0.75rem;
  color: var(--muted, #71717a);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--muted, #71717a);
  cursor: pointer;
  padding: 4px;
  display: inline-flex;
  border-radius: 6px;
}
.close-btn svg { width: 16px; height: 16px; }
.close-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }

.message-preview-box {
  padding: 12px 16px;
  background: color-mix(in srgb, var(--surface, #18181b) 80%, #000);
  border-bottom: 1px solid var(--border, #27272a);
  font-size: 0.82rem;
}

.preview-sender { font-weight: 600; margin-bottom: 2px; }
.preview-text { color: var(--muted, #a1a1aa); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.message-info-content {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.summary-line {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--muted, #a1a1aa);
  display: flex;
  align-items: center;
  gap: 6px;
}

.info-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted, #71717a);
  margin: 0;
}

.agent-list, .people-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-row, .person-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface, #18181b) 95%, #fff 5%);
}

.agent-avatar, .person-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #3f3f46;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  object-fit: cover;
}

.agent-info, .person-info {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.agent-name, .person-name { font-size: 0.82rem; font-weight: 600; }
.agent-status-line, .seen-time { font-size: 0.72rem; color: var(--muted, #a1a1aa); }

.status-badge.replied { color: #4ade80; }
.status-badge.queued { color: #facc15; }
.status-badge.failed { color: #f87171; }

.action-btn {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  background: #3b82f6;
  color: #fff;
  border: none;
  cursor: pointer;
}
.action-btn:hover { background: #2563eb; }

.empty-section {
  font-size: 0.8rem;
  color: var(--muted, #71717a);
  font-style: italic;
}

.disclosure-section details {
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
}
.disclosure-section summary { cursor: pointer; padding: 4px 0; }
.quiet-agents-list { padding-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.quiet-agent-row { display: flex; justify-content: space-between; font-size: 0.72rem; }

.details-list { padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.details-row { display: flex; justify-content: space-between; gap: 12px; font-size: 0.72rem; }
.details-label { color: var(--muted, #71717a); }
.details-copy {
  background: transparent;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-decoration: underline dotted;
}

.state-container {
  padding: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--muted, #71717a);
}
</style>
