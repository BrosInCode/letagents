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
  identifier: string
  code: string
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

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1200

/** ── Color Palette ── */
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
  if (!owner) return 'var(--sender-default, #71717a)'
  const ownerKey = owner.toLowerCase()
  if (colorCache.has(ownerKey)) return colorCache.get(ownerKey)!
  const color = OWNER_COLORS[hashString(ownerKey) % OWNER_COLORS.length]
  colorCache.set(ownerKey, color)
  return color
}

function getOwnerFromSender(sender: string, source: string | null): string | null {
  const parsed = parseAgentIdentity(sender)
  if (parsed.structured && parsed.ownerAttribution) {
    // Extract owner name from "Owner's agent"
    const match = parsed.ownerAttribution.match(/^(.+?)(?:'s?\s+agent)$/i)
    return match ? match[1] : parsed.ownerAttribution
  }
  if (isHumanSender(sender, source)) return sender || null
  return parsed.displayName || sender || null
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
  const known: Record<string, string> = { codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude', cursor: 'Cursor', agent: 'Agent' }
  return known[n] || n.split('-').filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join(' ')
}

function inferIdeLabel(value: string): string | null {
  const n = (value || '').trim().toLowerCase()
  if (n.startsWith('codex')) return 'Codex'
  if (n.startsWith('antigravity')) return 'Antigravity'
  if (n.startsWith('claude')) return 'Claude'
  if (n.startsWith('cursor')) return 'Cursor'
  return null
}

export function isHumanSender(sender: string, source: string | null): boolean {
  const n = (sender || '').trim().toLowerCase()
  if (n === 'letagents' || n === 'system') return false
  if (source === 'browser') return true
  if (source === 'agent') return false
  if (n === 'human' || n === 'anonymous') return true
  const parsed = parseAgentIdentity(sender)
  return !!(parsed.structured || parsed.ownerAttribution || parsed.ideLabel) ? false : source === 'browser'
}

/** ── API helper ── */
async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json()
}

/** ── API ── */
function roomPath(identifier: string): string {
  return `/rooms/${encodeURIComponent(identifier)}`
}

async function fetchMessages(roomIdentifier: string): Promise<RoomMessage[]> {
  const all: RoomMessage[] = []
  let afterCursor = ''

  for (;;) {
    const qs = afterCursor ? `?after=${encodeURIComponent(afterCursor)}` : ''
    try {
      const data = await apiFetch(`${roomPath(roomIdentifier)}/messages${qs}`)
      const msgs: RoomMessage[] = data.messages || []
      all.push(...msgs)
      if (!data.has_more || msgs.length === 0) break
      afterCursor = msgs[msgs.length - 1].id
    } catch {
      break
    }
  }

  return all
}

async function fetchTasks(roomIdentifier: string): Promise<RoomTask[]> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/tasks`)
    return data.tasks || []
  } catch {
    return []
  }
}

/** ── SSE Streaming ── */
function startStreaming(roomIdentifier: string) {
  stopStreaming()
  connectionState.value = 'connecting'

  const url = `${roomPath(roomIdentifier)}/messages/stream`
  eventSource = new EventSource(url)

  eventSource.onopen = () => {
    connectionState.value = 'live'
    isStreaming.value = true
    reconnectDelay = 1200
  }

  eventSource.addEventListener('message', (e) => {
    try {
      const msg: RoomMessage = JSON.parse(e.data)
      const exists = messages.value.some(m => m.id === msg.id)
      if (!exists) {
        messages.value = [...messages.value, msg]
      }
    } catch { /* ignore parse errors */ }
  })

  eventSource.addEventListener('task_update', (e) => {
    try {
      const task: RoomTask = JSON.parse(e.data)
      const idx = tasks.value.findIndex(t => t.id === task.id)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = task
        tasks.value = updated
      } else {
        tasks.value = [...tasks.value, task]
      }
    } catch { /* ignore */ }
  })

  eventSource.onerror = () => {
    connectionState.value = 'error'
    isStreaming.value = false
    eventSource?.close()
    eventSource = null

    reconnectTimer = setTimeout(() => {
      startStreaming(roomIdentifier)
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
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

/** ── Session Persistence ── */
const SESSION_KEY = 'lac-vue-session'

function persistSession() {
  if (!room.value) return
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    identifier: room.value.identifier,
    projectId: room.value.projectId,
    name: room.value.name,
    displayName: room.value.displayName,
    code: room.value.code,
  }))
}

function clearPersistedSession() {
  localStorage.removeItem(SESSION_KEY)
}

function loadPersistedSession(): { identifier: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    return data?.identifier ? data : null
  } catch {
    return null
  }
}

/** ── Actions ── */
async function sendMessage(text: string, sender?: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const msg = await apiFetch(`${roomPath(room.value.identifier)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, sender: sender || 'anonymous' }),
    })
    // Optimistic add if SSE hasn't delivered it yet
    if (msg?.id && !messages.value.some(m => m.id === msg.id)) {
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
    const data = await apiFetch(`${roomPath(room.value.identifier)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title, created_by: 'human' }),
    })
    if (data.task) tasks.value = [...tasks.value, data.task]
    return true
  } catch {
    return false
  }
}

async function updateTask(taskId: string, updates: Partial<RoomTask>): Promise<boolean> {
  if (!room.value) return false
  try {
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }
    )
    if (data.task) {
      const idx = tasks.value.findIndex(t => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = data.task
        tasks.value = updated
      }
    }
    return true
  } catch {
    return false
  }
}

/** ── Room Rename ── */
async function renameRoom(newName: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const result = await apiFetch(`${roomPath(room.value.identifier)}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: newName }),
    })
    if (result.display_name) {
      room.value = { ...room.value, displayName: result.display_name }
      persistSession()
    }
    return true
  } catch {
    return false
  }
}

/** ── Join Room ── */
async function joinRoom(roomIdentifier: string) {
  connectionState.value = 'connecting'

  try {
    // Join via POST /rooms/:identifier/join
    const project = await apiFetch(`${roomPath(roomIdentifier)}/join`, {
      method: 'POST',
    })

    room.value = {
      projectId: project.room_id || roomIdentifier,
      identifier: roomIdentifier,
      code: project.code || '',
      name: project.name || roomIdentifier,
      displayName: project.display_name || project.name || roomIdentifier,
      role: project.role || 'participant',
      authenticated: !!project.authenticated,
    }
    isConnected.value = true
    persistSession()

    // Load existing messages and tasks in parallel
    const [msgs, tsks] = await Promise.all([
      fetchMessages(roomIdentifier),
      fetchTasks(roomIdentifier),
    ])
    messages.value = msgs
    tasks.value = tsks

    // Start real-time streaming
    startStreaming(roomIdentifier)
    connectionState.value = 'live'
    return true
  } catch (err) {
    connectionState.value = 'error'
    console.error('[useRoom] joinRoom failed:', err)
    return false
  }
}

/** ── Restore Session ── */
async function restoreSession(): Promise<boolean> {
  const saved = loadPersistedSession()
  if (!saved) return false
  return joinRoom(saved.identifier)
}

function leaveRoom() {
  stopStreaming()
  room.value = null
  messages.value = []
  tasks.value = []
  isConnected.value = false
  connectionState.value = 'idle'
  clearPersistedSession()
}

/** ── Cleanup ── */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopStreaming()
  })
}

/** ── Composable ── */
export function useRoom() {
  onUnmounted(() => {
    // Don't stop streaming on unmount — other components may need it
    // Only stopStreaming when explicitly leaving
  })

  return {
    // State
    messages: readonly(messages),
    tasks: readonly(tasks),
    room: readonly(room),
    isConnected: readonly(isConnected),
    isStreaming: readonly(isStreaming),
    connectionState: readonly(connectionState),

    // Actions
    joinRoom,
    leaveRoom,
    sendMessage,
    addTask,
    updateTask,
    renameRoom,
    restoreSession,

    // Utilities
    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
  }
}
