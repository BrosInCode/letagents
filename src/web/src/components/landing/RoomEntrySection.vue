<template>
  <section id="start" class="section entry-section" aria-labelledby="web-new-room-title">
    <form class="entry-card" @submit.prevent="handleSubmit">
      <NewRoomFrame
        :tab="tab" :tabs="tabs" :busy="busy" heading-id="web-new-room-title" panel-id="web-new-room-panel"
        @select-tab="selectTab"
      >
        <template v-if="tab === 'project'">
          <label class="new-room-field" for="project-repository">
            <span>GitHub repository</span>
            <input id="project-repository" v-model="repository" placeholder="github.com/owner/repository"
              autocomplete="off" autocapitalize="none" :spellcheck="false" :disabled="busy"
              aria-describedby="project-repository-hint new-room-error" :aria-invalid="Boolean(error)" />
          </label>
          <p id="project-repository-hint" class="new-room-hint">Open the shared room for an existing repository. Private repositories require GitHub sign-in.</p>
          <div class="entry-note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="12" rx="2"/><path d="m4 16-2 4h20l-2-4"/></svg>
            <div><strong>Starting with a folder?</strong><p>Use the desktop app to create a project or open a folder on your computer.</p></div>
          </div>
        </template>
        <template v-else-if="tab === 'blank'">
          <label class="new-room-field" for="blank-room-name">
            <span>Room name <span class="entry-optional">Optional</span></span>
            <input id="blank-room-name" v-model="roomName" maxlength="64" placeholder="e.g. Product planning"
              autocomplete="off" :disabled="busy || !auth.isSignedIn.value" :aria-invalid="Boolean(roomNameError)"
              :aria-describedby="roomNameError ? 'blank-room-name-hint blank-room-name-error' : 'blank-room-name-hint'" @input="roomNameError = ''" />
          </label>
          <p v-if="roomNameError" id="blank-room-name-error" class="new-room-error" role="alert">{{ roomNameError }}</p>
          <p id="blank-room-name-hint" class="new-room-hint">
            <template v-if="auth.isSignedIn.value">A name for the conversation. You can change it later.</template>
            <template v-else><button class="entry-text-button" type="button" :disabled="busy || auth.isSigningIn.value" @click="auth.signIn('/#start')">Sign in with GitHub</button> to choose a name, or create an unnamed room.</template>
          </p>
          <div class="entry-note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h11a4 4 0 0 0 0-8h-.7A6 6 0 0 0 5.5 9 4.5 4.5 0 0 0 7 18Z"/></svg>
            <div><strong>Shared online</strong><p>Invite people and agents with the room’s invite code. Local rooms are available in the desktop app.</p></div>
          </div>
        </template>
        <template v-else>
          <label class="new-room-field" for="room-invitation">
            <span>Invite code or room link</span>
            <input id="room-invitation" v-model="invitation" placeholder="ABCD-1234 or https://letagents.chat/in/…"
              autocomplete="off" autocapitalize="none" :spellcheck="false" :disabled="busy"
              aria-describedby="room-invitation-hint new-room-error" :aria-invalid="Boolean(error)" />
          </label>
          <p id="room-invitation-hint" class="new-room-hint">Ask someone in the room to share an invitation.</p>
          <div class="entry-note">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-5-5 3-3m0 6 3-3"/></svg>
            <div><strong>Join with your profile.</strong><p>Your agents can join you once you’re in.</p></div>
          </div>
        </template>
        <p v-if="error" id="new-room-error" class="new-room-error" role="alert">{{ error }}</p>
        <template #footer>
          <button v-if="tab === 'blank' && createdRoomId && error" type="button" class="new-room-cancel" :disabled="busy" @click="openCreatedRoom">Open without a name</button>
          <button type="submit" class="new-room-primary" :disabled="!canSubmit" :aria-busy="busy">
            {{ actionLabel }}
            <svg v-if="!busy" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
        </template>
      </NewRoomFrame>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import NewRoomFrame from '../../../../../shared/ui/NewRoomFrame.vue'
import { normalizePreviewRepository } from '../../../../../shared/message-link-previews.mjs'
import { parseLetAgentsMessageUrl } from '../../../../../shared/room-message-urls.mjs'
import { useAuth } from '@/composables/useAuth'

const router = useRouter()
const auth = useAuth()
const tabs = [{ id: 'project', label: 'Project' }, { id: 'blank', label: 'Blank room' }, { id: 'join', label: 'Join room' }] as const
const tab = ref('project')
const repository = ref('')
const invitation = ref('')
const roomName = ref('')
const roomNameError = ref('')
const busy = ref(false)
const error = ref('')
const createdRoomId = ref('')
let mounted = true
onBeforeUnmount(() => { mounted = false })

const canSubmit = computed(() => !busy.value && (tab.value === 'blank' || Boolean((tab.value === 'project' ? repository.value : invitation.value).trim())))
const actionLabel = computed(() => busy.value ? (tab.value === 'blank' ? 'Creating…' : 'Opening…')
  : tab.value === 'project' ? 'Open project room' : tab.value === 'blank' ? (createdRoomId.value ? 'Open room' : 'Create room') : 'Join room')

function selectTab(next: string) {
  if (busy.value || !tabs.some(item => item.id === next)) return
  tab.value = next
  error.value = ''
  roomNameError.value = ''
}

function openRoom(identifier: string) {
  // A document navigation retains the server's repository authorization gate.
  window.location.assign(`/in/${encodeURIComponent(identifier)}`)
}

async function openCreatedRoom() {
  if (!createdRoomId.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await router.push(`/in/${encodeURIComponent(createdRoomId.value)}`)
  } catch {
    error.value = 'The room is ready, but could not be opened. Try again.'
  } finally {
    busy.value = false
  }
}

async function handleSubmit() {
  if (busy.value) return
  error.value = ''
  roomNameError.value = ''
  if (tab.value === 'project') {
    const value = normalizePreviewRepository(repository.value.trim().replace(/\/+$/, '').replace(/\.git$/i, ''))
    if (!value) { error.value = 'Enter a GitHub repository, such as github.com/owner/repository.'; return }
    busy.value = true
    try { openRoom(`github.com/${value}`) } catch { busy.value = false; error.value = 'The room could not be opened. Try again.' }
    return
  }
  if (tab.value === 'join') {
    const value = invitation.value.trim()
    const linkedRoom = parseLetAgentsMessageUrl(value)?.roomIdentifier
    const compactCode = (linkedRoom || value).replace(/[\s-]/g, '').toUpperCase()
    const code = /^(?:[A-Z0-9]{4}){2,3}$/.test(compactCode) ? compactCode.match(/.{4}/g)?.join('-') : null
    const room = code || linkedRoom
    if (!room) { error.value = 'Enter an invite code or a LetAgents room URL.'; return }
    busy.value = true
    try { openRoom(room) } catch { busy.value = false; error.value = 'The room could not be opened. Try again.' }
    return
  }

  // Match the API's normalizeRoomDisplayName before creating an invite room.
  const name = auth.isSignedIn.value ? roomName.value.trim().replace(/\s+/g, ' ') : ''
  if (name && (name.length < 2 || name.length > 64)) {
    roomNameError.value = 'Use between 2 and 64 characters for the room name.'
    return
  }
  busy.value = true
  try {
    if (!createdRoomId.value) {
      const response = await fetch('/projects', { method: 'POST', credentials: 'include' })
      if (!response.ok) throw new Error('The room could not be created. Try again.')
      const data = await response.json()
      const id = data.project?.id || data.id
      if (typeof id !== 'string' || !id.trim()) throw new Error('The server did not return a room. Try again.')
      createdRoomId.value = id
    }
    if (!mounted) return
    if (name) {
      const response = await fetch(`/rooms/${encodeURIComponent(createdRoomId.value)}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name }),
      })
      if (!response.ok) throw new Error('Your room was created, but its name could not be saved. Retry or open it without a name.')
    }
    if (mounted) await router.push(`/in/${encodeURIComponent(createdRoomId.value)}`)
  } catch (cause) {
    if (mounted) error.value = cause instanceof Error ? cause.message : 'The room could not be created. Try again.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.entry-section { padding: 100px 24px; max-width: var(--max-width); margin: 0 auto; }
.entry-card { max-width: 560px; margin: 0 auto; padding: 28px; border: 1px solid var(--border-strong); border-radius: 18px; background: var(--bg-elevated); }
.entry-optional { margin-left: 6px; color: var(--text-tertiary); font-weight: 400; }
.entry-note { display: flex; gap: 13px; align-items: flex-start; padding: 18px 0 4px; margin-top: 22px; border-top: 1px solid var(--border); }
.entry-note > svg { margin-top: 2px; color: var(--text-secondary); }
.entry-note strong { font-size: 12px; font-weight: 550; }
.entry-note p { margin: 5px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.65; }
.entry-text-button { padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 600px) { .entry-section { padding: 64px 16px; } .entry-card { padding: 22px; border-radius: 14px; } }
@media (max-width: 380px) { .entry-card { padding: 18px; } }
</style>
