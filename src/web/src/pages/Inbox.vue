<template>
  <div class="web-inbox">
    <WorkspaceNav />
    <InboxLayout v-if="accountId" ref="layout" v-model:section="section" v-model:query="query"
      :counts="counts" :loading="loading" :updates-loaded="Boolean(snapshot)" :items="items" :selected-key="selectedKey"
      :rooms="snapshot?.rooms || []" :selected-rooms="rooms" @update:rooms="rooms = $event" @select="selectItem" @refresh="refresh">
      <template #notices>
        <p v-if="error" class="web-inbox-notice" role="alert">{{ error }} <button @click="refresh">Try again</button></p>
        <details v-if="failures.length || snapshot?.limited" class="web-inbox-notice">
          <summary>{{ failures.length ? 'Some inbox updates couldn’t be loaded' : 'About this view' }}</summary>
          <p v-if="failures.length">Showing what loaded. <button @click="refresh">Retry sources</button></p>
          <ul v-if="failures.length"><li v-for="failure in failures" :key="failure.label">{{ failure.label }}</li></ul>
          <p v-if="snapshot?.limited">Showing recent activity from up to 100 rooms and their focus rooms. Open a room for its full history.</p>
        </details>
        <p v-if="lastRead.length" class="web-inbox-notice" role="status">{{ lastRead.length }} {{ lastRead.length === 1 ? 'update' : 'updates' }} marked read in this inbox. <button @click="undoUpdatesRead">Undo</button></p>
        <p v-if="actionError" class="web-inbox-notice web-inbox-error" role="alert">{{ actionError }}</p>
        <p v-if="outcome" class="web-inbox-notice" role="status">{{ outcome }}</p>
      </template>
      <template #item-avatar="{ item }"><ChatAvatar :name="item.actor" :agent="avatar(item.key)?.agent" :agent-key="avatar(item.key)?.agentKey" :provider="avatar(item.key)?.provider" :avatar-url="avatar(item.key)?.avatarUrl" /></template>
      <template #empty><div class="web-inbox-empty"><h2>{{ emptyTitle }}</h2><p>{{ loading ? 'Gathering requests and updates from your rooms.' : query || rooms.length ? 'Try another search or choose all rooms.' : section === 'answered' ? 'Your answers will be saved here.' : 'Questions and updates will appear as work moves forward.' }}</p><button v-if="rooms.length" @click="rooms = []">Show all rooms</button></div></template>
      <template #detail>
        <article v-if="selected" :key="selected.key" class="web-inbox-detail" aria-labelledby="web-inbox-request-title">
          <div class="inbox-detail-top"><span>{{ selected.category }}</span><time :datetime="selected.timestamp" :title="date(selected.timestamp)">{{ age(selected.timestamp) }}</time></div>
          <div class="inbox-detail-content"><h2 id="web-inbox-request-title" ref="requestHeading" tabindex="-1">{{ selected.title }}</h2>
          <div class="inbox-detail-byline"><ChatAvatar :name="selected.actor" :agent="selected.agent" :agent-key="selected.agentKey" :provider="selected.provider" :avatar-url="selected.avatarUrl" /><span>{{ selected.actor }}</span><span aria-hidden="true">·</span><button class="inbox-text-button" @click="openRoom(selected, 'room')">{{ selected.roomName }} <span aria-hidden="true">↗</span></button></div>
          <p class="inbox-detail-body">{{ selected.body || 'Open the original work for more context.' }}</p>
          <div v-if="selected.record?.response" class="inbox-answer" role="status"><strong>{{ selected.record.response.closed ? 'Closed' : 'Answer recorded' }}</strong><p>{{ selected.record.response.body }}</p><small>{{ selected.record.response.actor.label }} · {{ date(selected.record.response.at) }}</small></div>
          <InboxResponse v-else-if="selected.record" :id="`web-response-${selected.record.id}`" :model-value="drafts[selected.key]" :suggestion="selected.record.recommendation || undefined" :disabled="sending" :recipient="selected.actor" @update:model-value="drafts[selected!.key] = $event" @submit="respond()" @close="respond(true)" />
          <div v-else class="inbox-actions"><a v-if="safeExternalUrl(selected.url)" :href="safeExternalUrl(selected.url)" target="_blank" rel="noopener noreferrer" class="inbox-button inbox-primary">Open on GitHub ↗</a><button v-else class="inbox-button inbox-primary" @click="openRoom(selected)">{{ selected.taskId ? 'Open task' : selected.messageId ? 'Open thread' : 'Open room' }} <span aria-hidden="true">↗</span></button><button class="inbox-button" @click="markUpdatesRead([selected])">Mark read</button></div>
          <details v-if="selected.record && (selected.record.unblocks || selected.record.source_message_id || safeExternalUrl(selected.record.source_url))" class="inbox-supporting"><summary>Supporting details</summary><p v-if="selected.record.unblocks"><strong>Your answer unblocks</strong><br />{{ selected.record.unblocks }}</p><div class="inbox-actions"><a v-if="safeExternalUrl(selected.record.source_url)" :href="safeExternalUrl(selected.record.source_url)" target="_blank" rel="noopener noreferrer">View source ↗</a><button v-if="selected.record.source_message_id" @click="openRoom(selected, 'source')">Original message ↗</button></div></details>
          <details v-if="selected.history?.length" class="inbox-supporting"><summary>History <span>{{ selected.history.length }}</span></summary><ol class="web-inbox-history"><li v-for="entry in selected.history" :key="entry.id"><strong>{{ entry.label }}</strong><p>{{ entry.body }}</p><time :datetime="entry.timestamp">{{ date(entry.timestamp) }}</time></li></ol></details>
          </div>
        </article>
      </template>
      <template #queue-footer><button v-if="section === 'updates'" class="web-inbox-mark-all" :disabled="loading || !items.length" @click="markUpdatesRead(items)">Mark all read</button></template>
      <template #footer><div v-if="section === 'updates' && moreThreads.length" class="web-inbox-pagination"><button v-for="room in moreThreads" :key="room.id" :disabled="loadingOlder" @click="loadOlder(room.id)">{{ loadingOlder ? 'Loading…' : `More replies · ${room.label}` }}</button></div></template>
    </InboxLayout>
    <div v-else class="web-inbox-signin"><h1>Inbox</h1><p>Sign in to answer requests and follow updates across your rooms.</p><button :disabled="isSigningIn" @click="signIn('/inbox')">{{ isSigningIn ? 'Opening…' : 'Sign in with GitHub' }}</button></div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import WorkspaceNav from '../components/layout/WorkspaceNav.vue'
import InboxLayout from '../../../../shared/ui/inbox/InboxLayout.vue'
import InboxResponse from '../../../../shared/ui/inbox/InboxResponse.vue'
import ChatAvatar from '../../../../shared/ui/ChatAvatar.vue'
import { useAuth } from '../composables/useAuth'
import { useInbox } from '../composables/inbox/useInbox'
import { safeExternalUrl, type InboxItem } from '../composables/inbox/api'
const { isSignedIn, user, isSigningIn, signIn, checkSession } = useAuth()
const accountId = computed(() => isSignedIn.value ? user.value?.id || null : null)
const { snapshot, loading, error, actionError, outcome, section, rooms, query, selectedKey, drafts, sending, loadingOlder, lastRead, counts, items, selected, failures, moreThreads, selectItem, refresh, markRead, undoRead, answer, loadOlder } = useInbox(accountId)
const layout = ref<InstanceType<typeof InboxLayout> | null>(null)
const requestHeading = ref<HTMLElement | null>(null)
const router = useRouter()
function focusSelection() {
  if (requestHeading.value) requestHeading.value.focus({ preventScroll: true })
  else layout.value?.focusHeading()
}
async function respond(close = false) {
  const account = accountId.value
  const target = await answer(close)
  if (target === undefined) return
  await nextTick()
  if (accountId.value === account && selectedKey.value === target) focusSelection()
}
async function markUpdatesRead(list: InboxItem[]) {
  markRead(list); await nextTick(); focusSelection()
}
async function undoUpdatesRead() {
  undoRead(); await nextTick(); layout.value?.focusHeading()
}
const emptyTitle = computed(() => loading.value ? 'Checking your rooms' : error.value || failures.value.length ? 'Some inbox data is unavailable' : query.value || rooms.value.length ? 'No matching items' : section.value === 'answered' ? 'No answers yet' : section.value === 'updates' ? 'No unread updates' : 'You’re clear for now')
function avatar(key: string) { return items.value.find(item => item.key === key) }
function date(value: string) { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '' }
function age(value: string) { const at = Date.parse(value); if (!Number.isFinite(at)) return ''; const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000)); return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago` }
function openRoom(item: InboxItem, mode?: 'room' | 'source') {
  const message = mode === 'source' ? item.record?.source_message_id : mode === 'room' ? undefined : item.messageId
  void router.push({ name: 'room', params: { roomId: item.roomId }, query: { view: !mode && item.taskId ? 'board' : 'chat', ...(!mode && item.taskId ? { task: item.taskId } : {}), ...(message ? { message } : {}) } })
}
onMounted(checkSession)
</script>
<style scoped>
.web-inbox { height: 100dvh; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.web-inbox :deep(.inbox-layout) { flex: 1; min-height: 0; padding: 34px 40px 24px; }
.web-inbox-signin { margin: auto; padding: 24px; text-align: center; }
.web-inbox-signin h1 { font-size: 30px; }.web-inbox-signin p { margin: 16px 0 24px; color: var(--text-secondary); }
.web-inbox-signin button { min-height: 40px; padding: 9px 16px; border: 0; border-radius: 8px; background: var(--text); color: var(--bg); font: inherit; cursor: pointer; }
.web-inbox-notice { margin: 0 0 12px; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }.web-inbox-notice ul { margin: 8px 0; padding-left: 20px; }.web-inbox-notice button { color: var(--text); text-decoration: underline; background: none; border: 0; font: inherit; cursor: pointer; }.web-inbox-notice summary { cursor: pointer; }.web-inbox-error { color: var(--red-text); }
.web-inbox-empty { text-align: center; padding: 70px 20px; color: var(--text-secondary); }.web-inbox-empty h2 { font-size: 20px; color: var(--text); margin-bottom: 10px; }.web-inbox-empty button { margin-top: 16px; padding: 8px 12px; }
.web-inbox-detail { min-width: 0; overflow-wrap: anywhere; }
.inbox-detail-byline :deep(.chat-avatar) { width: 24px; height: 24px; flex-basis: 24px; align-self: center; }.inbox-detail-byline :deep(.chat-avatar img) { width: 20px; height: 20px; }
.inbox-supporting button { border: 0; background: none; color: var(--text); padding: 0; font: inherit; cursor: pointer; }.inbox-supporting a { color: var(--text); }
.web-inbox-history { list-style: none; padding: 0; margin: 10px 0 0; }.web-inbox-history li { border-bottom: 1px solid var(--border); padding: 16px 0; }.web-inbox-history strong { color: var(--text); font-weight: 500; }.web-inbox-history time { display: block; margin-top: 6px; font-size: 11px; }
.web-inbox-mark-all { border: 0; background: none; color: var(--text-secondary); padding: 0; font: inherit; cursor: pointer; }.web-inbox-mark-all:disabled { opacity: .45; cursor: default; }
.web-inbox-pagination { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 12px; }.web-inbox-pagination button { background: transparent; border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text-secondary); padding: 8px 10px; font: inherit; cursor: pointer; }
.web-inbox :is(button, a, summary):focus-visible { outline: 2px solid var(--blue-text); outline-offset: 3px; }
@media (max-width: 700px) { .web-inbox :deep(.inbox-layout) { padding: 24px 16px 16px; } }
</style>
