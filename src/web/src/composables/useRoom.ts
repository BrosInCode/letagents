import { ref, readonly, onUnmounted } from 'vue'

/** ── Types ── */
export interface RoomMessage {
  id: string
  sender: string
  text: string
  source: string | null
  timestamp: string
  agent_identity?: {
    name: string
    display_name: string
    owner_label: string
    owner_attribution: string
    ide_label: string
    actor_label: string
  } | null
}

export interface RoomTask {
  id: string
  title: string
  description: string
  status: string
  assignee: string | null
  created_by: string | null
  pr_url: string | null
  created_at: string
  updated_at: string
}

export interface RoomInfo {
  projectId: string
  code: string
  identifier: string
  name: string
  displayName: string
  role: string
  authenticated: boolean
}

/** ── State ── */
const messages = ref<RoomMessage[]>([])
const tasks = ref<RoomTask[]>([])
const room = ref<RoomInfo | null>(null)
const isConnected = ref(false)
const isStreaming = ref(false)
const connectionState = ref<'idle' | 'connecting' | 'live' | 'error'>('idle')
const soundEnabled = ref(localStorage.getItem('lac-sound') !== 'off')

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1200

/** ── Color Palette (matches legacy 12 colors) ── */
const OWNER_COLORS = [
  '#a855f7', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6',
  '#10b981', '#6366f1',
]
const colorCache = new Map<string, string>()

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  }
  return hash
}

export function getSenderColor(sender: string, source: string | null): string {
  const owner = getOwnerFromSender(sender, source)
  if (!owner) return 'var(--sender-default)'
  const ownerKey = owner.toLowerCase()
  if (colorCache.has(ownerKey)) return colorCache.get(ownerKey)!
  const color = OWNER_COLORS[hashString(ownerKey) % OWNER_COLORS.length]
  colorCache.set(ownerKey, color)
  return color
}

/** ── Identity Parsing ── */
export interface ParsedIdentity {
  raw: string
  displayName: string
  ownerAttribution: string | null
  ideLabel: string | null
  structured: boolean
}

export function parseAgentIdentity(sender: string): ParsedIdentity {
  const raw = (sender || '').trim()
  if (!raw) return { raw, displayName: raw, ownerAttribution: null, ideLabel: null, structured: false }

  const parts = raw.split(' | ').map(p => p.trim()).filter(Boolean)
  if (parts.length === 3 && /agent$/i.test(parts[1])) {
    return {
      raw,
      displayName: parts[0],
      ownerAttribution: parts[1],
      ideLabel: normalizeIdeLabel(parts[2]),
      structured: true,
    }
  }

  const legacy = raw.match(/^(.*?)\s*\(([^)]+agent)\)$/i)
  if (legacy) {
    return {
      raw,
      displayName: (legacy[1] || '').trim() || raw,
      ownerAttribution: (legacy[2] || '').trim() || null,
      ideLabel: inferIdeLabel((legacy[1] || '').trim()),
      structured: false,
    }
  }

  return { raw, displayName: raw, ownerAttribution: null, ideLabel: inferIdeLabel(raw), structured: false }
}

function normalizeIdeLabel(label: string): string | null {
  const n = (label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!n) return null
  const known: Record<string, string> = {
    codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude',
    cursor: 'Cursor', orchestrator: 'Orchestrator', agent: 'Agent',
  }
  return known[n] || n.split('-').filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(' ')
}

function inferIdeLabel(value: string): string | null {
  const n = (value || '').trim().toLowerCase()
  if (!n) return null
  if (n === 'codex' || n.startsWith('codex-')) return 'Codex'
  if (n === 'antigravity' || n.startsWith('antigravity-')) return 'Antigravity'
  if (n === 'claude' || n.startsWith('claude-')) return 'Claude'
  if (n === 'cursor' || n.startsWith('cursor-')) return 'Cursor'
  if (n === 'orchestrator' || n.startsWith('orchestrator-')) return 'Orchestrator'
  return null
}

export function isHumanSender(sender: string, source: string | null): boolean {
  const n = (sender || '').trim().toLowerCase()
  if (n === 'letagents' || n === 'system') return false
  if (source === 'browser') return true
  if (source === 'agent') return false
  if (n === 'human' || n === 'anonymous') return true
  const parsed = parseAgentIdentity(sender)
  return !(parsed.structured || parsed.ownerAttribution || parsed.ideLabel) && source === 'browser'
}

export function getSenderProvenance(sender: string, source: string | null): 'human' | 'agent' | 'system' {
  const n = (sender || '').trim().toLowerCase()
  if (n === 'letagents' || n === 'system') return 'system'
  if (source === 'browser') return 'human'
  if (source === 'agent') return 'agent'
  if (isHumanSender(sender, source)) return 'human'
  return 'agent'
}

export function getOwnerFromSender(sender: string, source: string | null): string | null {
  const raw = (sender || '').trim()
  if (!raw) return null
  const n = raw.toLowerCase()
  if (n === 'letagents' || n === 'system') return null
  if (source === 'browser') return raw
  const parsed = parseAgentIdentity(sender)
  if (parsed.ownerAttribution) {
    const ownerMatch = parsed.ownerAttribution.match(/^(.+?)(?:'s?\s+agent)$/i)
    if (ownerMatch) return ownerMatch[1].trim()
    return parsed.ownerAttribution
  }
  return null
}

function isInviteCode(str: string): boolean {
  return /^[A-Z0-9]{4}(-[A-Z0-9]{4}){1,2}$/.test(String(str).toUpperCase())
}

function normalizeRoomCode(code: string): string {
  return isInviteCode(code) ? String(code).toUpperCase() : String(code)
}

function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier).split('/').map(s => encodeURIComponent(s)).join('/')
}

/** ── API Helper ── */
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  let payload = null
  try { payload = await res.json() } catch { payload = null }
  if (!res.ok) {
    throw new Error(payload?.error || `Request failed (${res.status})`)
  }
  return payload
}

/** ── Session Persistence ── */
function persistSession() {
  if (!room.value) return
  const payload = JSON.stringify({
    id: room.value.projectId,
    code: room.value.code,
    roomName: room.value.name || '',
    displayName: room.value.displayName || '',
  })
  localStorage.setItem('letagents:web:session', payload)
}

/** ── SSE Streaming ── */
function startStreaming(roomIdentifier: string) {
  stopStreaming()
  connectionState.value = 'connecting'

  const url = `/rooms/${encodeURIComponent(roomIdentifier)}/messages/stream`
  eventSource = new EventSource(url)

  eventSource.onopen = () => {
    connectionState.value = 'live'
    isStreaming.value = true
    reconnectDelay = 1200
  }

  eventSource.onmessage = (e) => {
    try {
      const msg: RoomMessage = JSON.parse(e.data)
      const exists = messages.value.some(m => m.id === msg.id)
      if (!exists) {
        messages.value = [...messages.value, msg]
      }
    } catch { /* ignore parse errors */ }
  }

  eventSource.onerror = () => {
    connectionState.value = 'error'
    isStreaming.value = false
    eventSource?.close()
    eventSource = null

    if (!room.value) return

    const delay = Math.min(reconnectDelay, 8000)
    reconnectTimer = setTimeout(() => {
      if (room.value) startStreaming(room.value.identifier)
    }, delay)
    reconnectDelay = Math.min(delay * 1.8, 8000)
  }
}

function stopStreaming() {
  eventSource?.close()
  eventSource = null
  isStreaming.value = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

/** ── Fetch with cursor pagination ── */
async function fetchAllMessages(roomIdentifier: string): Promise<RoomMessage[]> {
  const allMessages: RoomMessage[] = []
  let afterCursor = ''

  for (;;) {
    const qs = afterCursor ? `?after=${encodeURIComponent(afterCursor)}` : ''
    const payload = await apiFetch(
      `/rooms/${encodeURIComponent(roomIdentifier)}/messages${qs}`,
      { method: 'GET' }
    )
    const msgs = payload.messages || []
    allMessages.push(...msgs)
    if (!payload.has_more || msgs.length === 0) break
    afterCursor = msgs[msgs.length - 1].id
  }

  return allMessages
}

async function fetchAllTasks(roomIdentifier: string): Promise<RoomTask[]> {
  const allTasks: RoomTask[] = []
  let afterCursor = ''

  for (;;) {
    const qs = afterCursor
      ? `?open=true&after=${encodeURIComponent(afterCursor)}`
      : '?open=true'
    const payload = await apiFetch(
      `/rooms/${encodeURIComponent(roomIdentifier)}/tasks${qs}`,
    )
    const tsks = payload.tasks || []
    allTasks.push(...tsks)
    if (!payload.has_more || tsks.length === 0) break
    afterCursor = tsks[tsks.length - 1].id
  }

  return allTasks
}

/** ── Actions ── */
async function sendMessage(text: string, sender?: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const msg = await apiFetch(`/rooms/${encodeURIComponent(room.value.identifier)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, sender: sender || 'anonymous' }),
    })
    // Upsert locally in case SSE hasn't delivered it yet
    if (msg && msg.id && !messages.value.some(m => m.id === msg.id)) {
      messages.value = [...messages.value, msg]
    }
    return true
  } catch {
    return false
  }
}

async function addTask(title: string): Promise<boolean> {
  if (!room.value) return false
  try {
    await apiFetch(`/rooms/${encodeURIComponent(room.value.identifier)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title, created_by: 'human' }),
    })
    // Refresh the full task list
    await refreshTasks()
    return true
  } catch {
    return false
  }
}

async function updateTask(taskId: string, newStatus: string): Promise<boolean> {
  if (!room.value) return false
  try {
    await apiFetch(`/rooms/${encodeURIComponent(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    })
    await refreshTasks()
    return true
  } catch {
    return false
  }
}

async function refreshTasks() {
  if (!room.value) return
  try {
    tasks.value = await fetchAllTasks(room.value.identifier)
  } catch { /* silent */ }
}

async function renameRoom(newDisplayName: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const result = await apiFetch(`/rooms/${encodeURIComponent(room.value.identifier)}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: newDisplayName }),
    })
    room.value = {
      ...room.value,
      displayName: result.display_name || newDisplayName,
      role: result.role || room.value.role,
      authenticated: result.authenticated ?? room.value.authenticated,
    }
    persistSession()
    return true
  } catch {
    return false
  }
}

/** ── Join Room ── */
async function joinRoom(roomIdentifier: string) {
  connectionState.value = 'connecting'
  try {
    const project = await apiFetch(`/rooms/${encodeURIComponent(roomIdentifier)}/join`, {
      method: 'POST',
    })

    room.value = {
      projectId: project.room_id || roomIdentifier,
      code: normalizeRoomCode(project.code || ''),
      identifier: project.room_id || project.code || roomIdentifier,
      name: project.name || '',
      displayName: project.display_name || project.name || project.code || roomIdentifier,
      role: project.role || 'participant',
      authenticated: !!project.authenticated,
    }

    isConnected.value = true
    persistSession()

    // Load existing data
    const [msgs, tsks] = await Promise.all([
      fetchAllMessages(room.value.identifier),
      fetchAllTasks(room.value.identifier),
    ])
    messages.value = msgs
    tasks.value = tsks

    // Start real-time streaming
    startStreaming(room.value.identifier)
    return true
  } catch (error) {
    connectionState.value = 'error'
    return false
  }
}

function leaveRoom() {
  stopStreaming()
  room.value = null
  messages.value = []
  tasks.value = []
  isConnected.value = false
  connectionState.value = 'idle'
}

/** ── Share Helpers ── */
function getRoomShareKind(): 'code' | 'url' {
  if (!room.value?.projectId || room.value.code) return 'code'
  return 'url'
}

function getRoomShareValue(): string {
  if (!room.value?.projectId) return ''
  if (room.value.code) return room.value.code
  const identifier = room.value.identifier || room.value.projectId
  if (!identifier) return ''
  return `${window.location.origin}/in/${encodeRoomPathIdentifier(identifier)}`
}

function getRoomShareDisplayValue(): string {
  const shareValue = getRoomShareValue()
  if (!shareValue) return ''
  if (getRoomShareKind() !== 'url') return shareValue
  try {
    const shareUrl = new URL(shareValue)
    const cleanPath = decodeURIComponent(shareUrl.pathname)
      .replace(/^\/in\//, '')
      .replace(/^\/+|\/+$/g, '')
    return cleanPath || shareUrl.host
  } catch {
    return shareValue.replace(/^https?:\/\//, '').replace(/\/in\//, '')
  }
}

/** ── Export chat ── */
function exportChat(): string | null {
  if (!messages.value.length) return null
  const sorted = [...messages.value].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  let md = `# Chat Export — ${room.value?.projectId || 'Room'}\n`
  md += `Exported: ${new Date().toISOString()}\n\n---\n\n`
  for (const m of sorted) {
    md += `**${m.sender}** _${formatTimestamp(m.timestamp)}_\n\n${m.text}\n\n---\n\n`
  }
  return md
}

function downloadExport() {
  const md = exportChat()
  if (!md) return
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `letagents-export-${room.value?.projectId || 'room'}-${Date.now()}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/** ── Sound ── */
let audioCtx: AudioContext | null = null

function playNotificationSound() {
  if (!soundEnabled.value) return
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const oscillator = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    oscillator.connect(gain)
    gain.connect(audioCtx.destination)
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime)
    oscillator.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2)
    oscillator.start(audioCtx.currentTime)
    oscillator.stop(audioCtx.currentTime + 0.2)
  } catch { /* audio not available */ }
}

function toggleSound() {
  soundEnabled.value = !soundEnabled.value
  localStorage.setItem('lac-sound', soundEnabled.value ? 'on' : 'off')
}

/** ── Formatting ── */
export function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

/** ── Owner list for legend ── */
function getOwnerLegend(): { label: string; color: string }[] {
  const owners = new Map<string, { label: string; color: string }>()
  for (const msg of messages.value) {
    const owner = getOwnerFromSender(msg.sender, msg.source)
    if (owner && !owners.has(owner.toLowerCase())) {
      owners.set(owner.toLowerCase(), {
        label: owner,
        color: getSenderColor(msg.sender, msg.source),
      })
    }
  }
  return Array.from(owners.values())
}

/** ── Composable ── */
export function useRoom() {
  // Clean up SSE on window unload
  const handleBeforeUnload = () => stopStreaming()
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }

  onUnmounted(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  })

  return {
    // State
    messages: readonly(messages),
    tasks: readonly(tasks),
    room: readonly(room),
    isConnected: readonly(isConnected),
    isStreaming: readonly(isStreaming),
    connectionState: readonly(connectionState),
    soundEnabled: readonly(soundEnabled),

    // Actions
    joinRoom,
    leaveRoom,
    sendMessage,
    addTask,
    updateTask,
    refreshTasks,
    renameRoom,
    downloadExport,

    // Share helpers
    getRoomShareKind,
    getRoomShareValue,
    getRoomShareDisplayValue,

    // Sound
    toggleSound,
    playNotificationSound,

    // Utilities
    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
    getSenderProvenance,
    getOwnerFromSender,
    getOwnerLegend,
    formatTimestamp,
  }
}
