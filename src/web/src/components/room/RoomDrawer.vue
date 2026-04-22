<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-overlay" @click="$emit('close')" />
    <aside :class="['drawer', { open }]">
      <div class="drawer-brand">
        <div class="drawer-brand-mark">LA</div>
        <div class="drawer-brand-copy">
          <h1>Let Agents Chat</h1>
          <p>Real-time multi-agent collaboration.</p>
        </div>
        <button class="drawer-close-btn" aria-label="Close drawer" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <button class="theme-toggle" @click="toggleTheme">
        <span>Theme</span>
        <span class="theme-icon">
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </span>
      </button>

      <!-- Share card -->
      <div class="drawer-section drawer-panel share-block">
        <div class="drawer-section-title">
          <h2>{{ shareKind === 'url' ? 'Room URL' : 'Invite Code' }}</h2>
          <span>{{ room?.displayName || 'No active room' }}</span>
        </div>
        <div class="join-code-display">
          <button
            class="join-code-copy"
            :data-share-kind="shareKind"
            :disabled="!shareValue"
            @click="copyShareValue"
          >
            <span>
              <span class="copy-help">{{ shareKind === 'url' ? 'Share this room URL instantly' : 'Share this room instantly' }}</span>
              <strong :title="shareValue">{{ shareDisplayValue || '----' }}</strong>
            </span>
            <span class="copy-pill">{{ codeCopied ? 'Copied!' : 'Copy' }}</span>
          </button>
        </div>
      </div>

      <div v-if="parentRoomUrl" class="drawer-section drawer-panel parent-room-section">
        <div class="drawer-section-title">
          <h2>Parent Room</h2>
          <span>focus</span>
        </div>
        <a class="parent-room-link" :href="parentRoomUrl" @click="$emit('close')">
          <span>{{ parentRoomDisplay }}</span>
          <strong>Open parent room</strong>
        </a>
      </div>

      <div v-if="showRulesButton" class="drawer-section drawer-panel rules-shortcut-section">
        <div class="drawer-section-title">
          <h2>Room Rules</h2>
          <span>repo</span>
        </div>
        <button class="rules-shortcut-btn" type="button" @click="$emit('openRules')">
          <span class="rules-shortcut-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v14H7l-3 3V4z"/><path d="M8 8h8"/><path d="M8 12h6"/></svg>
          </span>
          <span>
            <strong>Rules</strong>
            <small>Open the pinned operating contract.</small>
          </span>
        </button>
      </div>

      <!-- Sender Palette -->
      <div class="drawer-section drawer-panel">
        <div class="drawer-section-title">
          <h2>Sender Palette</h2>
          <span>identity</span>
        </div>
        <div class="legend">
          <span
            v-for="s in visibleOwners"
            :key="s.label"
            class="legend-chip"
            :style="{ '--chip-color': s.color }"
            :title="s.label"
          >
            <span class="legend-chip-label">{{ s.label }}</span>
          </span>
          <span
            v-if="overflowCount > 0"
            class="legend-chip overflow-chip"
            :title="overflowNames"
          >+{{ overflowCount }} more</span>
          <span class="legend-chip" style="--chip-color: var(--muted, #71717a)" title="System messages">
            <span class="legend-chip-label">system</span>
          </span>
        </div>
      </div>

      <!-- Room Notes -->
      <div class="drawer-section drawer-panel">
        <div class="drawer-section-title">
          <h2>Room Notes</h2>
        </div>
        <div class="status-line">
          <span class="status-text">{{ statusText }}</span>
        </div>
        <div class="drawer-actions">
          <button @click="toggleSound">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            {{ soundEnabled ? 'Sounds On' : 'Sounds Off' }}
          </button>
          <button @click="exportChat">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
        </div>
      </div>

      <!-- GitHub Integration -->
      <div v-if="room && !ghLoading && ghStatus" class="drawer-section drawer-panel">
        <div class="drawer-section-title">
          <h2>GitHub</h2>
          <span>integration</span>
        </div>
        <div class="github-status">
          <div v-if="ghLoading" class="gh-status-line">
            <span class="gh-dot gh-dot-loading" />
            <span>Checking…</span>
          </div>
          <div v-else-if="ghStatus?.connected" class="gh-status-line">
            <span class="gh-dot gh-dot-connected" />
            <span>Connected</span>
            <span v-if="ghStatus.repository" class="gh-repo-name">{{ ghStatus.repository.full_name }}</span>
          </div>
          <div v-else class="gh-status-line">
            <span class="gh-dot gh-dot-disconnected" />
            <span>Not connected</span>
          </div>
          <button
            v-if="!ghLoading && !ghStatus?.configured && ghStatus?.setup_manifest_available && room?.role === 'admin'"
            class="gh-setup-btn"
            :disabled="ghInstalling"
            @click="setupGitHubAppManifest"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            {{ ghInstalling ? 'Opening…' : 'Set up GitHub Integration' }}
          </button>

          <button
            v-if="!ghLoading && ghStatus?.configured && !ghStatus?.connected && ghStatus?.install_url_available && room?.role === 'admin'"
            class="gh-install-btn"
            :disabled="ghInstalling"
            @click="installGitHubApp"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            {{ ghInstalling ? 'Opening…' : 'Install GitHub App' }}
          </button>
          <p v-if="ghError" class="gh-error">{{ ghError }}</p>
        </div>
      </div>
    </aside>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { type RoomInfo, type RoomMessage, getSenderColor, parseAgentIdentity, useRoom } from '@/composables/useRoom'

const MAX_VISIBLE_CHIPS = 6

const props = defineProps<{
  open: boolean
  room: RoomInfo | null
  messages: readonly RoomMessage[]
  senderName?: string
  showRulesButton?: boolean
}>()

const emit = defineEmits<{ close: [], themeChange: [theme: string], openRules: [] }>()

const { soundEnabled, toggleSound } = useRoom()
const isDark = ref(localStorage.getItem('lac-theme') !== 'light')
const codeCopied = ref(false)

// ── Share logic (match legacy) ──
const shareKind = computed(() => {
  if (!props.room) return 'code'
  return props.room.code ? 'code' : 'url'
})

const shareValue = computed(() => {
  if (!props.room) return ''
  if (props.room.code) return props.room.code
  const identifier = props.room.identifier || props.room.projectId
  if (!identifier) return ''
  return `${window.location.origin}/in/${encodeRoomPathIdentifier(identifier)}`
})

const shareDisplayValue = computed(() => {
  const val = shareValue.value
  if (!val) return ''
  if (shareKind.value !== 'url') return val
  // Show clean short form: just the path without /in/ prefix
  try {
    const shareUrl = new URL(val)
    const cleanPath = decodeURIComponent(shareUrl.pathname)
      .replace(/^\/in\//, '')
      .replace(/^\/+|\/+$/g, '')
    return cleanPath || shareUrl.host
  } catch {
    return val.replace(/^https?:\/\//, '').replace(/\/in\//, '')
  }
})

const parentRoomIdentifier = computed(() =>
  props.room?.kind === 'focus' && props.room.parentRoomId ? props.room.parentRoomId : ''
)

const parentRoomUrl = computed(() =>
  parentRoomIdentifier.value ? `/in/${encodeRoomPathIdentifier(parentRoomIdentifier.value)}` : ''
)

const parentRoomDisplay = computed(() => parentRoomIdentifier.value || 'Parent room')

function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier)
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/')
}

// ── Owner extraction (match legacy getOwnerFromSender) ──
function getOwnerFromSender(sender: string, source: string | null): string | null {
  const raw = (sender || '').trim()
  if (!raw) return null
  const normalized = raw.toLowerCase()
  if (normalized === 'letagents' || normalized === 'system') return null
  if (source === 'browser') return raw
  const parsed = parseAgentIdentity(sender)
  if (parsed.ownerAttribution) {
    const ownerMatch = parsed.ownerAttribution.match(/^(.+?)(?:'s?\s+agent)$/i)
    if (ownerMatch) return ownerMatch[1].trim()
    return parsed.ownerAttribution
  }
  return null
}

const allOwners = computed(() => {
  const owners = new Map<string, { label: string; color: string }>()
  for (const msg of props.messages) {
    const owner = getOwnerFromSender(msg.sender, msg.source)
    if (owner && !owners.has(owner.toLowerCase())) {
      owners.set(owner.toLowerCase(), {
        label: owner,
        color: getSenderColor(msg.sender, msg.source),
      })
    }
  }
  return Array.from(owners.values())
})

const visibleOwners = computed(() => allOwners.value.slice(0, MAX_VISIBLE_CHIPS))
const overflowCount = computed(() => Math.max(0, allOwners.value.length - MAX_VISIBLE_CHIPS))
const overflowNames = computed(() => allOwners.value.slice(MAX_VISIBLE_CHIPS).map(o => o.label).join(', '))

// ── Status text ──
const statusText = computed(() => {
  if (!props.room) return 'Create or join a room to start live chat.'
  const parts: string[] = []
  if (props.senderName) parts.push(`Sending as ${props.senderName}`)
  parts.push(`Connected to ${props.room.displayName}`)
  return parts.join('; ') + '.'
})

// ── Actions ──
function toggleTheme() {
  isDark.value = !isDark.value
  const newTheme = isDark.value ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', newTheme)
  localStorage.setItem('lac-theme', newTheme)
  emit('themeChange', newTheme)
}



async function copyShareValue() {
  const val = shareValue.value
  if (!val) return
  try {
    await navigator.clipboard.writeText(val)
    codeCopied.value = true
    setTimeout(() => { codeCopied.value = false }, 1500)
  } catch { /* silent */ }
}

function exportChat() {
  if (!props.messages.length) return
  const lines = props.messages.map(m =>
    `[${new Date(m.timestamp).toLocaleString()}] ${m.sender}: ${m.text}`
  )
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `chat-export-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

// ── GitHub Integration ──
interface GitHubIntegrationStatus {
  configured: boolean
  setup_manifest_available: boolean
  connected: boolean
  install_url_available: boolean
  repository: { full_name: string } | null
}

const ghStatus = ref<GitHubIntegrationStatus | null>(null)
const ghLoading = ref(false)
const ghInstalling = ref(false)
const ghError = ref('')

async function fetchGitHubStatus() {
  const roomId = githubIntegrationRoomId.value
  if (!roomId) return
  ghLoading.value = true
  ghError.value = ''
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/integrations/github`, { credentials: 'include' })
    if (res.ok) {
      ghStatus.value = await res.json()
    } else {
      ghStatus.value = null
    }
  } catch {
    ghStatus.value = null
  } finally {
    ghLoading.value = false
  }
}

async function installGitHubApp() {
  const roomId = githubIntegrationRoomId.value
  if (!roomId) return
  ghInstalling.value = true
  ghError.value = ''
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/integrations/github/install-url`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      ghError.value = body.error || `Failed (${res.status})`
      return
    }
    const data = await res.json()
    if (data.install_url) {
      window.location.assign(data.install_url)
    }
  } catch {
    ghError.value = 'Network error'
  } finally {
    ghInstalling.value = false
  }
}

async function setupGitHubAppManifest() {
  const roomId = githubIntegrationRoomId.value
  if (!roomId) return
  ghInstalling.value = true
  ghError.value = ''
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/integrations/github/setup-manifest`, {
      method: 'POST',
      credentials: 'include',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      ghError.value = body.error || `Failed to start setup (${res.status})`
      return
    }
    const data = await res.json()
    if (data.action && data.manifest) {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = data.action
      
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'manifest'
      input.value = data.manifest
      
      form.appendChild(input)
      document.body.appendChild(form)
      form.submit()
    } else {
      ghError.value = 'Invalid setup response configuration'
    }
  } catch {
    ghError.value = 'Network error'
  } finally {
    ghInstalling.value = false
  }
}

const githubIntegrationRoomId = computed(() => {
  if (!props.room) return ''
  if (props.room.kind === 'focus' && props.room.parentRoomId) {
    return props.room.parentRoomId
  }
  return props.room.projectId || props.room.identifier
})

watch(githubIntegrationRoomId, (newId) => {
  if (newId) fetchGitHubStatus()
}, { immediate: true })

watch(() => props.open, (isOpen) => {
  if (isOpen && props.room) fetchGitHubStatus()
})
</script>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 4, 7, 0.62);
  backdrop-filter: blur(3px);
  z-index: 200;
}

.drawer {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: 300px;
  background: var(--bg-0, #09090b);
  border-right: 1px solid var(--line, #27272a);
  z-index: 210;
  padding: 20px 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transform: translateX(-100%);
  transition: transform 250ms ease;
  overflow-y: auto;
  box-shadow: 28px 0 48px rgba(0, 0, 0, 0.28);
}
.drawer.open { transform: translateX(0); }

.drawer-brand {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 18px;
  border-radius: 20px;
  border: 1px solid color-mix(in srgb, var(--line, #27272a) 84%, white 16%);
  background:
    radial-gradient(circle at top right, rgba(96, 165, 250, 0.12), transparent 44%),
    linear-gradient(180deg, rgba(24, 24, 27, 0.98), rgba(10, 10, 12, 0.95));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.drawer-brand-mark {
  width: 50px; height: 50px; border-radius: 16px;
  background: linear-gradient(135deg, #e2e8f0, #94a3b8);
  display: grid; place-items: center;
  font-weight: 900; font-size: 1rem; color: #0f172a; flex-shrink: 0;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
}
.drawer-brand-copy {
  min-width: 0;
  display: grid;
  gap: 6px;
  padding-top: 2px;
}
.drawer-brand h1 {
  margin: 0;
  font-size: 1.12rem;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.drawer-brand p {
  margin: 0;
  max-width: 13ch;
  color: color-mix(in srgb, var(--muted, #71717a) 88%, white 12%);
  font-size: 0.9rem;
  line-height: 1.45;
}

.theme-toggle {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%;
  padding: 10px 14px;
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(39, 39, 42, 0.88), rgba(24, 24, 27, 0.96));
  border: 1px solid color-mix(in srgb, var(--line, #27272a) 78%, white 12%);
  color: var(--text, #fafafa); cursor: pointer;
  font-size: 0.95rem; font-weight: 600;
  transition: background 150ms, border-color 150ms, transform 150ms;
}
.theme-toggle:hover {
  background: linear-gradient(180deg, rgba(55, 55, 61, 0.94), rgba(30, 30, 34, 0.98));
  border-color: color-mix(in srgb, var(--line, #27272a) 60%, white 20%);
  transform: translateY(-1px);
}
.theme-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(9, 9, 11, 0.35);
  opacity: 0.92;
}

.drawer-section { display: flex; flex-direction: column; gap: 12px; }
.drawer-panel {
  padding: 14px 14px 16px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--line, #27272a) 78%, white 12%);
  background: linear-gradient(180deg, rgba(28, 28, 31, 0.94), rgba(18, 18, 21, 0.98));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}
.drawer-section-title {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px;
}
.drawer-section-title h2 {
  margin: 0;
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.14em;
  color: color-mix(in srgb, var(--muted, #71717a) 90%, white 10%);
}
.drawer-section-title span {
  max-width: 10ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  color: color-mix(in srgb, var(--muted, #71717a) 82%, white 14%);
}

/* ── Share card ── */
.join-code-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}
.join-code-copy {
  width: 100%; display: flex; align-items: center;
  justify-content: space-between; gap: 8px;
  background: none; border: none; padding: 0;
  color: var(--text, #fafafa); cursor: pointer;
  text-align: left;
}
.join-code-copy:disabled { opacity: 0.5; cursor: default; }
.join-code-copy > span:first-child {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
  overflow: hidden;
}
.join-code-copy strong {
  display: block;
  font-size: 0.98rem;
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.35;
}
/* URL mode: smaller, muted, truncated */
.join-code-copy[data-share-kind="url"] strong {
  font-size: 0.84rem;
  font-weight: 500;
  color: color-mix(in srgb, var(--muted, #71717a) 74%, white 16%);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.copy-help {
  display: block;
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--muted, #71717a) 88%, white 12%);
}
.copy-pill {
  flex-shrink: 0;
  padding: 9px 15px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(9, 9, 11, 0.92);
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text, #fafafa);
  transition: background 150ms, border-color 150ms;
}
.join-code-copy:hover .copy-pill {
  background: rgba(24, 24, 27, 0.98);
  border-color: rgba(255, 255, 255, 0.1);
}

.parent-room-link {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text, #fafafa);
  text-decoration: none;
  padding-top: 2px;
}

.parent-room-link span {
  color: color-mix(in srgb, var(--muted, #71717a) 80%, white 14%);
  font-size: 0.76rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parent-room-link strong {
  font-size: 0.92rem;
  font-weight: 700;
}

.parent-room-link:hover strong {
  text-decoration: underline;
}

.rules-shortcut-btn {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 2px 0 0;
  border: none;
  background: transparent;
  color: var(--text, #fafafa);
  cursor: pointer;
  text-align: left;
}

.rules-shortcut-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  border-radius: 14px;
  border: 1px solid rgba(147, 197, 253, 0.16);
  background: rgba(147, 197, 253, 0.08);
  color: #bfdbfe;
}

.rules-shortcut-icon svg {
  width: 18px;
  height: 18px;
}

.rules-shortcut-btn strong {
  display: block;
  font-size: 1rem;
}

.rules-shortcut-btn small {
  display: block;
  margin-top: 4px;
  color: color-mix(in srgb, var(--muted, #71717a) 82%, white 12%);
  font-size: 0.79rem;
  line-height: 1.45;
}

.rules-shortcut-btn:hover .rules-shortcut-icon,
.rules-shortcut-btn:focus-visible .rules-shortcut-icon {
  background: rgba(147, 197, 253, 0.16);
  color: var(--text, #fafafa);
}

.rules-shortcut-btn:focus-visible {
  outline: none;
}

/* ── Sender legend (compact dot chips) ── */
.legend { display: flex; flex-wrap: wrap; gap: 8px; }
.legend-chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
  font-size: 0.76rem;
  color: color-mix(in srgb, var(--muted, #71717a) 80%, white 16%);
  max-width: 100%;
  cursor: default;
}
.legend-chip-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.legend-chip::before {
  content: ''; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--chip-color, var(--muted, #71717a));
}
.overflow-chip {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text, #fafafa);
  font-weight: 600;
  max-width: none;
}
.overflow-chip::before { display: none; }

.status-line {
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  background: rgba(255, 255, 255, 0.025);
  font-size: 0.84rem;
  color: color-mix(in srgb, var(--muted, #71717a) 82%, white 14%);
  line-height: 1.65;
}
.drawer-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.drawer-actions button {
  display: inline-flex; align-items: center; gap: 6px;
  justify-content: center;
  padding: 10px 12px; border-radius: 14px;
  font-size: 0.82rem; font-weight: 650;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--text, #fafafa); cursor: pointer;
  transition: background 150ms, border-color 150ms, transform 150ms;
}
.drawer-actions button:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  transform: translateY(-1px);
}

/* ── GitHub integration ── */
.github-status { display: flex; flex-direction: column; gap: 8px; }
.gh-status-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 0.84rem;
  color: color-mix(in srgb, var(--muted, #71717a) 80%, white 16%);
}
.gh-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.gh-dot-connected { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.4); }
.gh-dot-disconnected { background: #71717a; }
.gh-dot-loading {
  background: #facc15;
  animation: gh-pulse 1.2s ease-in-out infinite;
}
@keyframes gh-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
.gh-repo-name {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text, #fafafa);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gh-setup-btn {
  display: inline-flex; align-items: center; gap: 8px;
  justify-content: center;
  width: 100%;
  padding: 10px 14px; border-radius: 14px;
  font-size: 0.82rem; font-weight: 600;
  background: #22c55e; color: #fff;
  border: 1px solid #16a34a;
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}
.gh-setup-btn:hover:not(:disabled) {
  background: #16a34a; border-color: #15803d;
}
.gh-setup-btn:disabled { opacity: 0.5; cursor: wait; }
.gh-install-btn {
  display: inline-flex; align-items: center; gap: 8px;
  justify-content: center;
  width: 100%;
  padding: 10px 14px; border-radius: 14px;
  font-size: 0.82rem; font-weight: 600;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--text, #fafafa); cursor: pointer;
  transition: background 150ms, border-color 150ms;
}
.gh-install-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
}
.gh-install-btn:disabled { opacity: 0.5; cursor: wait; }
.gh-error {
  margin: 0; font-size: 0.75rem; color: #ef4444;
}

.drawer-close-btn {
  display: none;
  background: none;
  border: none;
  color: var(--muted, #71717a);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  transition: color 150ms, background 150ms;
  -webkit-tap-highlight-color: transparent;
}
.drawer-close-btn:hover {
  color: var(--text, #fafafa);
  background: var(--bg-2, #27272a);
}

@media (max-width: 768px) {
  .drawer {
    top: 6px;
    bottom: 6px;
    left: 6px;
    width: calc(100vw - 12px);
    padding: 18px 16px 20px;
    border: 1px solid color-mix(in srgb, var(--line, #27272a) 72%, white 12%);
    border-radius: 24px;
    box-shadow: 0 28px 56px rgba(0, 0, 0, 0.42);
  }
  .drawer-brand { position: relative; }
  .drawer-brand-mark { width: 48px; height: 48px; font-size: 0.95rem; }
  .drawer-brand h1 { font-size: 1.04rem; }
  .drawer-brand p { font-size: 0.88rem; }
  .drawer-close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 2px;
    right: 2px;
  }
  .join-code-copy strong { font-size: 0.92rem; }
}
</style>
