<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-overlay" @click="$emit('close')" />
    <aside :class="['drawer', { open }]">
      <div class="drawer-brand">
        <div class="drawer-brand-mark">LA</div>
        <div>
          <h1>Let Agents Chat</h1>
          <p>Real-time multi-agent collaboration.</p>
        </div>
      </div>

      <button class="theme-toggle" @click="toggleTheme">
        <span>Theme</span>
        <span class="theme-icon">
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </span>
      </button>

      <!-- Share card -->
      <div class="drawer-section share-block">
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

      <!-- Sender Palette -->
      <div class="drawer-section">
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
      <div class="drawer-section">
        <div class="drawer-section-title">
          <h2>Room Notes</h2>
        </div>
        <div class="status-line">
          <span class="status-text">{{ statusText }}</span>
        </div>
        <div class="drawer-actions">
          <button @click="toggleSound">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            {{ soundOn ? 'Sounds On' : 'Sounds Off' }}
          </button>
          <button @click="exportChat">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
        </div>
      </div>
    </aside>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { type RoomInfo, type RoomMessage, getSenderColor, parseAgentIdentity } from '@/composables/useRoom'

const MAX_VISIBLE_CHIPS = 6

const props = defineProps<{
  open: boolean
  room: RoomInfo | null
  messages: readonly RoomMessage[]
  senderName?: string
}>()

defineEmits<{ close: [] }>()

const isDark = ref(true)
const soundOn = ref(true)
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
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
  localStorage.setItem('lac-theme', isDark.value ? 'dark' : 'light')
}

function toggleSound() {
  soundOn.value = !soundOn.value
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
</script>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 200;
}

.drawer {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: 300px;
  background: var(--bg-0, #09090b);
  border-right: 1px solid var(--line, #27272a);
  z-index: 210;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  transform: translateX(-100%);
  transition: transform 250ms ease;
  overflow-y: auto;
}
.drawer.open { transform: translateX(0); }

.drawer-brand { display: flex; align-items: center; gap: 12px; }
.drawer-brand-mark {
  width: 36px; height: 36px; border-radius: 10px;
  background: linear-gradient(135deg, #e2e8f0, #94a3b8);
  display: grid; place-items: center;
  font-weight: 900; font-size: 0.7rem; color: #0f172a; flex-shrink: 0;
}
.drawer-brand h1 { font-size: 0.92rem; font-weight: 700; letter-spacing: -0.02em; }
.drawer-brand p { margin-top: 2px; color: var(--muted, #71717a); font-size: 0.78rem; }

.theme-toggle {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 8px 12px; border-radius: 8px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
  color: var(--text, #fafafa); cursor: pointer;
  font-size: 0.82rem; font-weight: 500; transition: background 150ms;
}
.theme-toggle:hover { background: var(--surface-hover, #27272a); }
.theme-icon { display: flex; align-items: center; opacity: 0.6; }

.drawer-section { display: flex; flex-direction: column; gap: 8px; }
.drawer-section-title {
  display: flex; align-items: center; justify-content: space-between;
}
.drawer-section-title h2 {
  font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted, #71717a);
}
.drawer-section-title span { font-size: 0.72rem; color: var(--muted, #71717a); }

/* ── Share card ── */
.share-block {
  padding: 12px; border-radius: 10px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
}
.join-code-display { display: flex; align-items: center; gap: 8px; }
.join-code-copy {
  width: 100%; display: flex; align-items: center;
  justify-content: space-between; gap: 8px;
  background: none; border: none; padding: 0;
  color: var(--text, #fafafa); cursor: pointer;
  text-align: left;
}
.join-code-copy:disabled { opacity: 0.5; cursor: default; }
.join-code-copy > span:first-child {
  flex: 1; min-width: 0; overflow: hidden;
}
.join-code-copy strong {
  display: block; font-size: 1.1rem; font-weight: 700; letter-spacing: 0.12em; margin-top: 2px;
}
/* URL mode: smaller, muted, truncated */
.join-code-copy[data-share-kind="url"] strong {
  font-size: 0.76rem; letter-spacing: 0; font-weight: 500;
  color: var(--muted, #71717a); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.copy-help { display: block; font-size: 0.72rem; color: var(--muted, #71717a); margin-top: 4px; }
.copy-pill {
  flex-shrink: 0; padding: 5px 12px; border-radius: 6px;
  background: var(--bg-0, #09090b); font-size: 0.72rem; font-weight: 600;
  color: var(--text, #fafafa); transition: background 150ms;
}
.join-code-copy:hover .copy-pill { background: var(--surface-hover, #27272a); }

/* ── Sender legend (compact dot chips) ── */
.legend { display: flex; flex-wrap: wrap; gap: 4px; }
.legend-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px; border-radius: 4px;
  background: var(--surface, #18181b);
  font-size: 0.65rem; color: var(--muted, #71717a);
  max-width: 120px; cursor: default;
}
.legend-chip-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.legend-chip::before {
  content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
  background: var(--chip-color, var(--muted, #71717a));
}
.overflow-chip {
  background: var(--line, #27272a); color: var(--text, #fafafa);
  font-weight: 600; max-width: none;
}
.overflow-chip::before { display: none; }

.status-line { font-size: 0.82rem; color: var(--muted, #71717a); line-height: 1.5; }
.drawer-actions { display: flex; gap: 6px; }
.drawer-actions button {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 8px;
  font-size: 0.78rem; font-weight: 600;
  background: var(--surface, #18181b);
  border: 1px solid var(--line, #27272a);
  color: var(--text, #fafafa); cursor: pointer;
  transition: background 150ms;
}
.drawer-actions button:hover { background: var(--surface-hover, #27272a); }
</style>
