<template>
  <section class="knowledge-page needs-you-page" aria-labelledby="needs-you-title" data-testid="needs-you-view">
    <header class="knowledge-header">
      <div><span class="knowledge-eyebrow">Across your rooms</span><h1 id="needs-you-title">Needs you<span class="knowledge-total">{{ pendingCount }}</span></h1><p>A clear next step for the work waiting on you.</p></div>
      <button class="knowledge-button" :disabled="loading" @click="emit('refresh')"><RefreshCw :size="14" :class="{ 'knowledge-spin': loading }" />Refresh</button>
    </header>
    <div class="knowledge-filters">
      <div class="knowledge-segments" aria-label="Request status"><button :aria-pressed="!answered" @click="answered = false">Waiting on you <span>{{ pendingCount }}</span></button><button :aria-pressed="answered" @click="answered = true">Answered</button></div>
      <label class="knowledge-room-filter"><span class="sr-only">Filter by room</span><select v-model="roomFilter"><option value="">All rooms</option><option v-for="room in sortedRooms" :key="room.roomIdentifier" :value="room.roomIdentifier">{{ room.displayName }}</option></select></label>
    </div>
    <p v-if="sendError" class="knowledge-notice" role="alert">{{ sendError }}</p>
    <p v-if="error" class="knowledge-notice" role="alert">{{ error }} <button @click="emit('refresh')">Try again</button></p>
    <p v-if="data?.failures.length" class="knowledge-notice" role="status">Couldn’t check {{ data.failures.map(room => room.displayName).join(', ') }}. Showing the rooms that loaded. <button @click="emit('refresh')">Retry</button></p>
    <p v-if="data?.cloudUnavailable" class="knowledge-notice">Shared rooms are unavailable. Local requests are still available. <button @click="emit('refresh')">Retry</button></p>
    <p v-if="data?.signedOut" class="knowledge-notice">Showing local rooms. Sign in to include your shared rooms.</p>
    <p v-if="data?.limited || data?.rooms.some(room => room.truncated)" class="knowledge-notice">Showing up to 100 recent rooms and 200 requests per room, with unanswered requests first. Open a room for more context.</p>
    <div v-if="loading && !data" class="knowledge-empty" role="status"><LoaderCircle class="knowledge-spin" :size="24" /><h2>Checking your rooms</h2><p>Gathering requests and work ready for your attention.</p></div>
    <div v-else-if="!items.length" class="knowledge-empty"><CircleCheck :size="30" /><h2>{{ answered ? 'No answers here yet' : error || data?.failures.length || data?.cloudUnavailable ? 'Some rooms still need checking' : 'You’re clear for now' }}</h2><p>{{ answered ? 'Your responses stay here, and in the room where the request began.' : 'Agent questions, decisions, approvals and review requests will appear here.' }}</p><p class="knowledge-hint">Agents can ask through <code>request_human_input</code>.</p></div>
    <div v-else class="knowledge-workspace">
      <nav class="knowledge-queue" aria-label="Work needing attention">
        <TransitionGroup name="knowledge-list">
          <button v-for="item in items" :key="item.key" class="knowledge-queue-item" :data-selected="selected?.key === item.key" :aria-current="selected?.key === item.key ? 'true' : undefined" @click="selectedKey = item.key">
            <span class="knowledge-queue-top"><span class="knowledge-category" :data-kind="item.category">{{ label(item.category) }}</span><span>{{ relative(item.timestamp) }}</span></span>
            <strong>{{ item.title }}</strong><span class="knowledge-queue-preview">{{ item.body }}</span><span class="knowledge-room-name"><span class="knowledge-room-dot"></span>{{ item.room.displayName }}<ChevronRight :size="13" /></span>
          </button>
        </TransitionGroup>
      </nav>
      <article v-if="selected" :key="selected.key" class="knowledge-detail knowledge-enter" aria-labelledby="request-title">
        <div class="knowledge-detail-top"><span class="knowledge-category" :data-kind="selected.category">{{ label(selected.category) }}</span><button class="knowledge-text-button" @click="openRoom(selected)">Open room <ArrowUpRight :size="14" /></button></div>
        <h2 id="request-title">{{ selected.title }}</h2>
        <p class="knowledge-byline">{{ selected.record?.author.label || 'Task board' }} · {{ selected.room.displayName }}</p>
        <div class="knowledge-prose">{{ selected.body || 'Open the room’s board to review this work.' }}</div>
        <div v-if="selected.record?.recommendation" class="knowledge-recommendation"><span><Sparkles :size="14" />Recommendation</span><p>{{ selected.record.recommendation }}</p></div>
        <div v-if="selected.record?.unblocks" class="knowledge-unblocks"><ArrowRight :size="15" /><p><strong>Your answer unblocks</strong>{{ selected.record.unblocks }}</p></div>
        <div v-if="selected.record?.source_url || selected.record?.source_message_id" class="knowledge-source-row"><button v-if="selected.record.source_url" class="knowledge-button" @click="openSource(selected.record.source_url)"><Link2 :size="14" />View source</button><button v-if="selected.record.source_message_id" class="knowledge-button" @click="openRoom(selected, true)"><MessageSquare :size="14" />Original message</button></div>
        <div v-if="selected.record?.response" class="knowledge-answer" role="status"><span><CircleCheck :size="16" /> Answer recorded</span><p>{{ selected.record.response.body }}</p><small>{{ selected.record.response.actor.label }} · {{ new Date(selected.record.response.at).toLocaleString() }}</small></div>
        <form v-else-if="selected.record" class="knowledge-response" @submit.prevent="respond">
          <label :for="`response-${selected.record.id}`">Your response</label><textarea :id="`response-${selected.record.id}`" v-model="drafts[selected.key]" rows="4" maxlength="8000" placeholder="Give the agent a clear decision or next step…" :disabled="sending" required></textarea>
          <div class="knowledge-response-footer"><small>Sent to the room and saved with this request.</small><button class="knowledge-button knowledge-primary" :disabled="sending || !drafts[selected.key]?.trim()"><LoaderCircle v-if="sending" :size="14" class="knowledge-spin" /><Send v-else :size="14" />{{ sending ? 'Sending…' : 'Send response' }}</button></div>
        </form>
        <div v-else class="knowledge-task-action"><p>{{ selected.category === 'blocked' ? 'Review the blocker and give the agent direction in the room.' : 'Review the deliverable and its checks before approving the work.' }}</p><button class="knowledge-button knowledge-primary" @click="openRoom(selected)">Open task board <ArrowUpRight :size="14" /></button></div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ArrowRight, ArrowUpRight, ChevronRight, CircleCheck, Link2, LoaderCircle, MessageSquare, RefreshCw, Send, Sparkles } from '@lucide/vue';
import type { DesktopAttentionRoom, DesktopNeedsYou } from '../../../../../electron/ipc-types/knowledge.js';
import type { KnowledgeRecord } from '../../../../../../../shared/room-knowledge.mjs';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../../../ipc/index.js';
import './room-knowledge.css';

const props = defineProps<{ data: DesktopNeedsYou | null; loading: boolean; error: string }>();
const emit = defineEmits<{ refresh: []; openRoom: [room: string, messageId?: string, taskId?: string] }>();
const answered = ref(false); const roomFilter = ref(''); const selectedKey = ref('');
const drafts = reactive<Record<string, string>>({}); const sending = ref(false); const sendError = ref('');
type Item = { key: string; title: string; body: string; timestamp: string; category: string; room: DesktopAttentionRoom; record?: KnowledgeRecord; taskId?: string };
const sortedRooms = computed(() => [...(props.data?.rooms ?? [])].sort((a,b) => a.displayName.localeCompare(b.displayName)));
const pendingCount = computed(() => props.data?.rooms.reduce((sum, room) => sum + room.records.filter(record => !record.response).length + room.tasks.length, 0) ?? 0);
const items = computed<Item[]>(() => (props.data?.rooms ?? []).filter(room => !roomFilter.value || room.roomIdentifier === roomFilter.value).flatMap(room => [
  ...room.records.filter(record => Boolean(record.response) === answered.value).map(record => ({ key: `${room.roomIdentifier}:${record.id}`, room, record, title: record.title, body: record.body, category: record.category, timestamp: record.created_at })),
  ...(answered.value ? [] : room.tasks.map(task => ({ key: `${room.roomIdentifier}:${task.id}`, room, taskId: task.id, title: task.title, body: task.description ?? '', category: task.status, timestamp: task.updated_at }))),
]).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
const selected = computed(() => items.value.find(item => item.key === selectedKey.value) ?? items.value[0]);
watch(() => selected.value?.key, () => { sendError.value = ''; });
function label(category: string) { return ({ question: 'Question', decision: 'Decision', approval: 'Approval', review: 'Review', blocked: 'Blocked task', in_review: 'Task review' } as Record<string,string>)[category] || category; }
function relative(time: string) { if (!Number.isFinite(Date.parse(time))) return ''; const hours = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 3600000)); return hours < 1 ? 'Just now' : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`; }
function openRoom(item: Item, source = false) { emit('openRoom', item.room.roomIdentifier, source ? item.record?.source_message_id : undefined, item.taskId); }
async function openSource(url: string) { try { await desktopIpc.app.openExternalUrl(url); } catch (error) { sendError.value = String(error); } }
async function respond() {
  const item = selected.value; if (!item?.record || sending.value) return;
  sending.value = true; sendError.value = '';
  try {
    if (!desktopIpc.room.reviseKnowledge) throw new Error(desktopBridgeUpgradeMessage());
    await desktopIpc.room.reviseKnowledge(item.room.roomIdentifier, 'attention', item.record.id, { expected_version: item.record.version, response: drafts[item.key] });
    delete drafts[item.key]; answered.value = true; selectedKey.value = item.key; emit('refresh');
  } catch (error) { sendError.value = error instanceof Error ? error.message : 'Unable to send your response.'; }
  finally { sending.value = false; }
}
</script>
