import { ref, readonly, computed, onUnmounted } from 'vue'

/** ── Types ── */
export interface RoomMessage {
  id: string
  sender: string
  text: string
  agent_prompt_kind?: string | null
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
  name: string
  displayName: string
  role: string
  authenticated: boolean
}

export type RoomAgentPromptKind = 'join' | 'inline' | 'auto'

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
  const key = getSenderIdentityKey(sender, source)
  if (colorCache.has(key)) return colorCache.get(key)!
  const color = OWNER_COLORS[hashString(key) % OWNER_COLORS.length]
  colorCache.set(key, color)
  return color
}

/** ── Identity Parsing ── */
export interface ParsedIdentity {
  displayName: string
  ownerAttribution: string | null
  ideLabel: string | null
  structured: boolean
}

export function parseAgentIdentity(sender: string): ParsedIdentity {
  const raw = (sender || '').trim()
  if (!raw) return { displayName: raw, ownerAttribution: null, ideLabel: null, structured: false }

  const parts = raw.split(' | ').map(p => p.trim()).filter(Boolean)
  if (parts.length === 3 && /agent$/i.test(parts[1])) {
    return {
      displayName: parts[0],
      ownerAttribution: parts[1],
      ideLabel: normalizeIdeLabel(parts[2]),
      structured: true,
    }
  }

  const legacy = raw.match(/^(.*?)\s*\(([^)]+agent)\)$/i)
  if (legacy) {
    return {
      displayName: (legacy[1] || '').trim() || raw,
      ownerAttribution: (legacy[2] || '').trim() || null,
      ideLabel: inferIdeLabel((legacy[1] || '').trim()),
      structured: false,
    }
  }

  return { displayName: raw, ownerAttribution: null, ideLabel: inferIdeLabel(raw), structured: false }
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

function getSenderIdentityKey(sender: string, source: string | null): string {
  if (isHumanSender(sender, source)) return (sender || '').trim().toLowerCase()
  const parsed = parseAgentIdentity(sender)
  return (parsed.ideLabel || parsed.displayName || sender || '').trim().toLowerCase()
}

// SYNC: src/shared/room-agent-prompts.ts
export function normalizeAgentPromptKind(value: unknown): RoomAgentPromptKind | null {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'join' || normalized === 'inline' || normalized === 'auto'
    ? normalized
    : null
}

export function isPromptOnlyRoomMessage(message: Pick<RoomMessage, 'text' | 'agent_prompt_kind'> | null | undefined): boolean {
  return normalizeAgentPromptKind(message?.agent_prompt_kind) === 'auto'
    && !String(message?.text || '').trim()
}

export function hasInlinePromptInjection(message: Pick<RoomMessage, 'agent_prompt_kind'> | null | undefined): boolean {
  return normalizeAgentPromptKind(message?.agent_prompt_kind) === 'inline'
}

/** ── API ── */
async function fetchRoom(roomId: string): Promise<RoomInfo | null> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`)
    if (!res.ok) return null
    const data = await res.json()
    return {
      projectId: data.id,
      code: data.code || '',
      name: data.name || data.id,
      displayName: data.display_name || data.name || data.id,
      role: data.role || 'participant',
      authenticated: !!data.authenticated,
    }
  } catch {
    return null
  }
}

async function fetchMessages(projectId: string): Promise<RoomMessage[]> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/messages`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.messages || []).filter((message: RoomMessage) => !isPromptOnlyRoomMessage(message))
  } catch {
    return []
  }
}

async function fetchTasks(projectId: string): Promise<RoomTask[]> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`)
    if (!res.ok) return []
    const data = await res.json()
    return data.tasks || []
  } catch {
    return []
  }
}

/** ── SSE Streaming ── */
function startStreaming(projectId: string) {
  stopStreaming()
  connectionState.value = 'connecting'

  const url = `/api/projects/${encodeURIComponent(projectId)}/messages/stream`
  eventSource = new EventSource(url)

  eventSource.onopen = () => {
    connectionState.value = 'live'
    isStreaming.value = true
    reconnectDelay = 1200
  }

  eventSource.addEventListener('message', (e) => {
    try {
      const msg: RoomMessage = JSON.parse(e.data)
      if (isPromptOnlyRoomMessage(msg)) {
        return
      }
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
      startStreaming(projectId)
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

/** ── Actions ── */
async function sendMessage(text: string, sender?: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const normalizedSender = String(sender || '').trim() || 'anonymous'
    const res = await fetch(`/api/projects/${encodeURIComponent(room.value.projectId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sender: normalizedSender, source: 'browser' }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function addTask(title: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(room.value.projectId)}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, created_by: 'human' }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.task) tasks.value = [...tasks.value, data.task]
    }
    return res.ok
  } catch {
    return false
  }
}

async function updateTask(taskId: string, updates: Partial<RoomTask>): Promise<boolean> {
  if (!room.value) return false
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(room.value.projectId)}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.task) {
        const idx = tasks.value.findIndex(t => t.id === taskId)
        if (idx >= 0) {
          const updated = [...tasks.value]
          updated[idx] = data.task
          tasks.value = updated
        }
      }
    }
    return res.ok
  } catch {
    return false
  }
}

/** ── Join Room ── */
async function joinRoom(roomIdentifier: string) {
  const info = await fetchRoom(roomIdentifier)
  if (!info) {
    connectionState.value = 'error'
    return false
  }

  room.value = info
  isConnected.value = true

  // Load existing messages and tasks
  const [msgs, tsks] = await Promise.all([
    fetchMessages(info.projectId),
    fetchTasks(info.projectId),
  ])
  messages.value = msgs
  tasks.value = tsks

  // Start real-time streaming
  startStreaming(info.projectId)
  return true
}

function leaveRoom() {
  stopStreaming()
  room.value = null
  messages.value = []
  tasks.value = []
  isConnected.value = false
  connectionState.value = 'idle'
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

    // Utilities
    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
  }
}
