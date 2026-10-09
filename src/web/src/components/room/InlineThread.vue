<template>
  <section class="web-inline-thread" :data-thread-root-id="parent.id" aria-label="Message thread" @keydown.escape="onEscape">
    <div ref="body" class="inline-replies-scroll" tabindex="0" aria-label="Thread replies" @scroll="onScroll">
      <div v-if="loading || error || hasOlder" class="inline-thread-history" role="status">
        <span>{{ loading ? 'Loading replies…' : error }}</span>
        <button v-if="!loading" type="button" @click="loadReplies(error ? retryOlder : hasOlder)">{{ error ? 'Retry' : 'Load earlier replies' }}</button>
      </div>
      <ChatMessage v-for="reply in replies" :key="reply.id" :message="reply" :inline-reply="true"
        :reasoning-session="reasoningByAnchorMessage?.get(reply.id) || null" :stale-prompt-task-states="stalePromptTaskStates"
        :room-identifier="roomIdentifier" :agent-names="agentNames" :task-reference-ids="taskReferenceIds"
        :class="{ 'search-match': searchQuery && reply.text.toLowerCase().includes(searchQuery.toLowerCase()) }"
        @toggle-stale-prompt-mute="emit('toggleStalePromptMute', $event)"
        @reply="quote = $event" @info="emit('info', $event)" @scroll-to-reply="reveal"
        @open-image-viewer="emit('openImageViewer', $event)" @open-task="emit('openTask', $event)" />
      <p v-if="!loading && !replies.length" class="inline-thread-empty">No replies yet.</p>
    </div>
    <button v-if="scrolledUp" type="button" class="inline-thread-latest" @click="latest">Latest replies ↓</button>
    <slot name="composer" :parent="parent" :quote="quote" :clear-quote="clearQuote" :sent="sent" />
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RoomMessage, RoomReasoningSession, StalePromptTaskState } from '@/composables/useRoom'
import { apiFetch, roomPath } from '@/composables/room/api'
import { isVisibleRoomMessage } from '@/composables/room/identity'
import { messageThreadParentId, type MessageThreadSummary } from './messageThreading'
import ChatMessage from './ChatMessage.vue'

const props = defineProps<{
  reasoningByAnchorMessage?: ReadonlyMap<string, RoomReasoningSession>
  stalePromptTaskStates?: Readonly<Record<string, StalePromptTaskState>>
  parent: RoomMessage
  messages: readonly RoomMessage[]
  roomIdentifier: string
  active: boolean
  agentNames?: ReadonlyMap<string, string>
  taskReferenceIds?: ReadonlySet<string>
  searchQuery?: string
  revealMessageId?: string | null
}>()
const emit = defineEmits<{
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
  close: []
  info: [message: RoomMessage]
  openImageViewer: [imageId: string]
  openTask: [taskId: string]
  jump: [messageId: string]
  rowsChanged: []
  summary: [summary: MessageThreadSummary]
  messages: [messages: RoomMessage[]]
}>()
const body = ref<HTMLElement | null>(null)
const fetched = ref<RoomMessage[]>([])
const hasOlder = ref(false)
const loading = ref(false)
const error = ref('')
const quote = ref<RoomMessage | null>(null)
const scrolledUp = ref(false)
let disposed = false
let revision = 0
let totalCount = 0
let highlightTimer: ReturnType<typeof setTimeout> | null = null
let retryOlder = false
function onEscape(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}
const replies = computed(() => {
  const merged = new Map([...fetched.value, ...props.messages]
    .filter(message => messageThreadParentId(message) === props.parent.id && isVisibleRoomMessage(message))
    .map(message => [message.id, message]))
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || Number(a.id.slice(4)) - Number(b.id.slice(4)))
})
function onScroll() {
  revision++
  const el = body.value
  scrolledUp.value = Boolean(el && el.scrollHeight - el.clientHeight - el.scrollTop > 80)
}
function latest() {
  const el = body.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  scrolledUp.value = false
}
function clearQuote() { quote.value = null }
function sent(submittedQuoteId: string | null = null) {
  if ((quote.value?.id ?? null) === submittedQuoteId) clearQuote()
  void nextTick(latest)
}
function reveal(id: string) {
  const el = body.value
  const target = el?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`)
  if (!el || !target) { emit('jump', id); return }
  revision++
  el.scrollTo({ top: el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12, behavior: 'instant' })
  body.value?.querySelectorAll('.jump-target').forEach(row => row.classList.remove('jump-target'))
  target.classList.add('jump-target')
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => target.classList.remove('jump-target'), 1600)
}
async function loadReplies(older = false) {
  if (loading.value || !props.roomIdentifier) return
  loading.value = true
  retryOlder = older
  error.value = ''
  try {
    const before = older && replies.value[0]?.id
    const page = await apiFetch(`${roomPath(props.roomIdentifier)}/messages/${encodeURIComponent(props.parent.id)}/thread${before ? `?before=${encodeURIComponent(before)}` : ''}`)
    if (disposed) return
    fetched.value = older ? [...page.replies, ...fetched.value] : page.replies
    hasOlder.value = Boolean(page.has_older)
    totalCount = Number(page.summary?.reply_count ?? page.summary?.replyCount ?? 0)
  } catch {
    if (!disposed) error.value = 'Replies could not be loaded.'
  } finally { if (!disposed) loading.value = false }
}
watch(replies, async (next, previous) => {
  const el = body.value
  const top = el?.scrollTop ?? 0
  const height = el?.scrollHeight ?? 0
  const rev = revision
  const atLatest = !el || el.scrollHeight - el.clientHeight - top < 80
  const prepended = previous[0] && next.findIndex(message => message.id === previous[0].id) > 0
  emit('summary', { count: Math.max(totalCount, next.length), latest: next.at(-1) ?? null })
  emit('messages', next)
  await nextTick()
  if (el && props.active && rev === revision && top === el.scrollTop) {
    if (prepended) el.scrollTop = top + el.scrollHeight - height
    else if (atLatest) latest()
  }
  emit('rowsChanged')
})
watch(() => [props.revealMessageId, props.active, Boolean(props.revealMessageId && replies.value.some(message => message.id === props.revealMessageId))] as const, async ([id, active, found]) => {
  if (id && active && found) { await nextTick(); reveal(id) }
})
watch(() => props.active, async () => { await nextTick(); emit('rowsChanged') })
onMounted(() => { latest(); void loadReplies() })
onBeforeUnmount(() => { disposed = true; if (highlightTimer) clearTimeout(highlightTimer) })
</script>
<style scoped>
.web-inline-thread { position: relative; min-width: 0; margin-top: 12px; }
.inline-replies-scroll {
  height: clamp(230px, 34dvh, 360px); padding: 16px 6px 16px 0;
  overflow-y: auto; overscroll-behavior: contain; overflow-anchor: none;
  border-top: 1px solid var(--line, #27272a); scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted, #a1a1aa) 40%, transparent) transparent;
  outline-offset: -2px;
}
.inline-thread-history { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0 12px; color: var(--muted); font-size: .78rem; }
.inline-thread-history button { background: transparent; border: 0; color: var(--text); cursor: pointer; }
.inline-thread-empty { color: var(--muted); font-size: .85rem; padding: 16px 0; }
.inline-thread-latest { position: absolute; right: 10px; bottom: 66px; z-index: 2; padding: 5px 10px; border: 1px solid var(--line, #27272a); border-radius: 999px; background: var(--bg-1, #181818); color: var(--muted, #a1a1aa); font: inherit; font-size: .72rem; cursor: pointer; }
.web-inline-thread :deep(.message.is-inline-reply) { width: 100%; max-width: none; padding: 8px 0 22px; gap: 9px; }
.web-inline-thread :deep(.is-inline-reply > .message-avatar) { width: 10px; flex-basis: 10px; padding-top: 6px; }
.web-inline-thread :deep(.is-inline-reply > .message-avatar::before) { width: 6px; height: 6px; box-shadow: none; }
.web-inline-thread :deep(.is-inline-reply > .message-body) { width: 100%; max-width: 100%; min-width: 0; flex: 1; }
.web-inline-thread :deep(.is-inline-reply .message-bubble) { display: block; width: 100%; max-width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.web-inline-thread :deep(.is-inline-reply .message-bubble::before) { display: none; }
.web-inline-thread :deep(.is-inline-reply .md-content) { font-size: .875rem; line-height: 1.65; }
.web-inline-thread :deep(.reply-preview) { display: flex; flex-direction: row; align-items: baseline; gap: 6px; padding: 0; margin-bottom: 8px; border: 0; background: transparent; }
.web-inline-thread :deep(.reply-preview-label) { flex: 0 0 auto; font-weight: 500; }
.web-inline-thread :deep(.reply-preview-text) { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: .72rem; }
@media (max-width: 600px) { .inline-replies-scroll { height: clamp(220px, 31dvh, 280px); } }
</style>
