import { ref, readonly, onUnmounted, computed } from 'vue'
import {
  isRepoBackedRoomId,
  mapGitHubEventsFetchError,
  toAvailableGitHubEventsResult,
  type RoomGitHubEventsError,
} from './roomGitHubEvents'

/** ── Types ── */
export type FocusParentVisibility = 'summary_only' | 'major_activity' | 'all_activity' | 'silent'
export type FocusActivityScope = 'task_and_branch' | 'task_only' | 'room'
export type FocusGitHubEventRouting = 'task_and_branch' | 'focus_owned_only' | 'task_only' | 'all_parent_repo' | 'off'

export interface FocusRoomSettings {
  parent_visibility: FocusParentVisibility
  activity_scope: FocusActivityScope
  github_event_routing: FocusGitHubEventRouting
}

export type FocusRoomSettingsPatch = Partial<FocusRoomSettings>

export const DEFAULT_FOCUS_ROOM_SETTINGS: FocusRoomSettings = {
  parent_visibility: 'summary_only',
  activity_scope: 'task_and_branch',
  github_event_routing: 'task_and_branch',
}

export function focusRoomSettingsFrom(value: {
  focus_settings?: FocusRoomSettings | null
  focus_parent_visibility?: FocusParentVisibility | null
  focus_activity_scope?: FocusActivityScope | null
  focus_github_event_routing?: FocusGitHubEventRouting | null
} | null | undefined): FocusRoomSettings {
  return {
    parent_visibility: value?.focus_settings?.parent_visibility
      || value?.focus_parent_visibility
      || DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
    activity_scope: value?.focus_settings?.activity_scope
      || value?.focus_activity_scope
      || DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
    github_event_routing: value?.focus_settings?.github_event_routing
      || value?.focus_github_event_routing
      || DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
  }
}

export interface MessageReplyReference {
  id: string
  sender: string
  text: string
  source: string | null
  timestamp: string
}

export interface RoomMessageAttachment {
  id?: string | null
  name?: string | null
  file_name?: string | null
  filename?: string | null
  mime_type?: string | null
  content_type?: string | null
  size_bytes?: number | null
  byte_size?: number | null
  url?: string | null
  download_url?: string | null
  data_url?: string | null
  content_base64?: string | null
}

export interface OutgoingMessageAttachment {
  file_name: string
  mime_type: string
  size_bytes: number
  file?: File | null
  upload_id?: string | null
}

export interface StagedMessageAttachment {
  upload_id: string
}

interface AttachmentUploadTarget {
  upload_id?: string
  attachment_id?: string
  id?: string
  upload_url?: string
  url?: string
  method?: string
  headers?: Record<string, string>
  attachment?: {
    upload_id?: string
    attachment_id?: string
    id?: string
  }
}

export interface RoomMessage {
  id: string
  sender: string
  text: string
  attachments?: readonly RoomMessageAttachment[]
  agent_prompt_kind?: string | null
  source: string | null
  timestamp: string
  reply_to?: MessageReplyReference | null
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
  assignee_agent_key: string | null
  created_by: string | null
  pr_url: string | null
  workflow_artifacts: ReadonlyArray<{
    provider: string
    kind: string
    id?: string | null
    number?: number | null
    title?: string | null
    url?: string | null
    ref?: string | null
    state?: string | null
  }>
  workflow_refs: ReadonlyArray<{
    provider: string
    kind: string
    label: string
    url: string
  }>
  stale_prompt_state?: {
    is_stale: boolean
    reason: string | null
    stale_for_ms: number | null
    muted: boolean
    muted_by: string | null
    muted_at: string | null
  } | null
  created_at: string
  updated_at: string
  active_leases?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string
    kind: "work" | "review" | "coordination"
    status: "active" | "released" | "revoked" | "expired"
    agent_key: string
    agent_instance_id: string | null
    agent_session_id: string | null
    actor_label: string
    branch_ref: string | null
    pr_url: string | null
    output_intent: string | null
  }>
  active_locks?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string | null
    scope: "room" | "task"
    reason: string | null
    message: string | null
    created_by: string
    cleared_at: string | null
  }>
}

export interface TaskLeaseActionInput {
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
}

export interface StalePromptTaskState {
  isStale: boolean
  muted: boolean
  taskUpdatedAt: string
}

export interface TaskGitHubArtifactStatus {
  task_id: string
  pr_state: string | null
  pr_title: string | null
  pr_url: string | null
  pr_number: string | null
  pr_actor: string | null
  checks: ReadonlyArray<{
    name: string
    conclusion: string | null
    state: string | null
    actor: string | null
  }>
  reviews: ReadonlyArray<{
    actor: string | null
    state: string | null
  }>
  check_summary: {
    total: number
    success: number
    failure: number
    pending: number
  }
  review_summary: {
    total: number
    approved: number
    changes_requested: number
  }
}

export interface RoomInfo {
  projectId: string
  identifier: string
  code: string
  name: string
  displayName: string
  role: string
  authenticated: boolean
  kind: 'main' | 'focus'
  attachmentsEnabled: boolean
  parentRoomId: string | null
  focusKey: string | null
  sourceTaskId: string | null
  focusStatus: 'active' | 'concluded' | null
  focusParentVisibility: FocusParentVisibility | null
  focusActivityScope: FocusActivityScope | null
  focusGitHubEventRouting: FocusGitHubEventRouting | null
  concludedAt: string | null
  conclusionSummary: string | null
  conclusionDetails: FocusRoomConclusionDetails | null
}

export type FocusRoomReviewState = 'reviewed' | 'needs_review' | 'not_required'
export type FocusRoomBlockerState = 'none' | 'resolved' | 'blocked'
export type FocusRoomParentTaskNextAction =
  | 'keep_open'
  | 'move_to_review'
  | 'mark_blocked'
  | 'mark_done'
  | 'follow_up'

export interface FocusRoomConclusionDetails {
  artifact: string
  review_state: FocusRoomReviewState
  blocker_state: FocusRoomBlockerState
  parent_task_next: FocusRoomParentTaskNextAction
  next_owner: string
}

export interface FocusRoomInfo {
  room_id: string
  name: string | null
  display_name: string
  code: string | null
  kind: 'main' | 'focus'
  attachments_enabled?: boolean
  parent_room_id: string | null
  focus_key: string | null
  source_task_id: string | null
  focus_status: 'active' | 'concluded' | null
  focus_parent_visibility: FocusParentVisibility | null
  focus_activity_scope: FocusActivityScope | null
  focus_github_event_routing: FocusGitHubEventRouting | null
  focus_settings?: FocusRoomSettings | null
  concluded_at: string | null
  conclusion_summary: string | null
  conclusion_details: FocusRoomConclusionDetails | null
  created_at: string
  role?: string
  authenticated?: boolean
}

export type RoomAgentPromptKind = 'join' | 'inline' | 'auto'

export interface RoomJoinError {
  status: number | null
  code: string | null
  message: string
  roomId: string | null
  deviceFlowUrl: string | null
}

export type RoomGitHubEventType =
  | 'pull_request'
  | 'issue'
  | 'issue_comment'
  | 'pull_request_review'
  | 'check_run'
  | 'installation'
  | 'installation_repositories'
  | 'repository'

export interface RoomGitHubEvent {
  id: string
  event_type: RoomGitHubEventType
  action: string
  github_object_id: string | null
  github_object_url: string | null
  title: string | null
  state: string | null
  actor_login: string | null
  metadata: Record<string, unknown> | null
  linked_task_id: string | null
  created_at: string
}

export interface RoomAgentPresence {
  room_id: string
  actor_label: string
  agent_key: string | null
  agent_instance_id: string | null
  agent_session_id: string | null
  session_kind: 'controller' | 'worker'
  runtime: string
  display_name: string
  owner_label: string | null
  ide_label: string | null
  status: 'idle' | 'working' | 'reviewing' | 'blocked'
  status_text: string | null
  last_heartbeat_at: string
  created_at: string
  updated_at: string
  freshness: 'active' | 'stale'
  activity_state: 'active' | 'away' | 'offline'
  source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
}

export interface RoomParticipant {
  room_id: string
  participant_key: string
  kind: 'human' | 'agent'
  actor_label: string | null
  agent_key: string | null
  github_login: string | null
  display_name: string
  owner_label: string | null
  ide_label: string | null
  hidden_at: string | null
  hidden_by: string | null
  last_seen_at: string
  last_room_activity_at: string | null
  last_live_heartbeat_at: string | null
  activity_state: 'active' | 'away' | 'offline' | null
  source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  created_at: string
  updated_at: string
}

export type RoomActivityHistoryKind = 'all' | 'agent' | 'human'

export interface RoomActivityHistoryTaskSummary {
  id: string
  title: string
  status: string
  updated_at: string
  workflow_refs: ReadonlyArray<{
    provider: string
    kind: string
    label: string
    url: string
  }>
}

export interface RoomActivityHistoryEntry {
  id: string
  room: {
    id: string
    display_name: string
    kind: 'main' | 'focus'
    focus_status: 'active' | 'concluded' | null
    source_task_id: string | null
  }
  participant: {
    participant_key: string
    kind: 'human' | 'agent'
    actor_label: string | null
    agent_key: string | null
    github_login: string | null
    display_name: string
    owner_label: string | null
    ide_label: string | null
    hidden_at: string | null
    hidden_by: string | null
    last_live_heartbeat_at: string | null
    activity_state: 'active' | 'away' | 'offline' | null
    source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  }
  first_seen_at: string
  last_seen_at: string
  last_room_activity_at: string
  current_tasks: ReadonlyArray<RoomActivityHistoryTaskSummary>
  completed_tasks: ReadonlyArray<RoomActivityHistoryTaskSummary>
  created_tasks: ReadonlyArray<RoomActivityHistoryTaskSummary>
}

export interface RoomActivityHistoryPage {
  room_id: string
  root_room_id: string
  selected_room_id: string
  hidden_count: number
  entries: ReadonlyArray<RoomActivityHistoryEntry>
  page: number
  page_size: number
  page_count: number
  total: number
}

interface RoomParticipantsPage {
  participants: RoomParticipant[]
  hidden_count: number
}

export interface RoomReasoningSnapshot {
  summary: string
  goal?: string | null
  checking?: string | null
  hypothesis?: string | null
  blocker?: string | null
  next_action?: string | null
  milestone?: string | null
  status?: string | null
  confidence?: number | null
}

export interface RoomReasoningEntry {
  id: string
  kind?: string | null
  label?: string | null
  text: string
  timestamp: string
}

export interface RoomReasoningUpdate {
  id: string
  actor_label?: string | null
  status?: string | null
  summary: string
  milestone?: string | null
  payload?: RoomReasoningSnapshot | null
  created_at: string
}

export interface RoomReasoningSession {
  id: string
  room_id?: string | null
  actor_label?: string | null
  agent_key?: string | null
  anchor_message_id?: string | null
  task_id?: string | null
  title?: string | null
  status?: string | null
  visibility?: string | null
  summary?: string | null
  latest_payload?: RoomReasoningSnapshot | null
  goal?: string | null
  checking?: string | null
  hypothesis?: string | null
  blocker?: string | null
  next_action?: string | null
  milestone?: string | null
  confidence?: number | null
  entries?: ReadonlyArray<RoomReasoningEntry> | null
  updates?: ReadonlyArray<RoomReasoningUpdate> | null
  closed_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

/** ── State ── */
const messages = ref<RoomMessage[]>([])
const messagesHasOlder = ref(false)
const isLoadingOlderMessages = ref(false)
const presence = ref<RoomAgentPresence[]>([])
const boardHandoffPresence = ref<RoomAgentPresence[]>([])
const participants = ref<RoomParticipant[]>([])
const participantHiddenCount = ref(0)
const activityHistory = ref<RoomActivityHistoryPage | null>(null)
const activityHistoryLoading = ref(false)
const activityHistoryError = ref('')
const reasoningSessions = ref<RoomReasoningSession[]>([])
const taskGithubStatus = ref<Record<string, TaskGitHubArtifactStatus>>({})
const tasks = ref<RoomTask[]>([])
const focusRooms = ref<FocusRoomInfo[]>([])
const githubEvents = ref<RoomGitHubEvent[]>([])
const githubEventsAvailable = ref(false)
const githubEventsHasMore = ref(false)
const githubEventsError = ref<RoomGitHubEventsError | null>(null)
const githubEventsLoading = ref(false)
const boardLoading = ref(false)
const activityLoading = ref(false)
const focusRoomsLoading = ref(false)
const room = ref<RoomInfo | null>(null)
const lastSendError = ref('')
const isConnected = ref(false)
const isStreaming = ref(false)
const connectionState = ref<'idle' | 'connecting' | 'live' | 'error'>('idle')
const joinError = ref<RoomJoinError | null>(null)

const MAX_LIVE_REASONING_UPDATES = 200

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1200
let githubEventsRefreshTimer: ReturnType<typeof setTimeout> | null = null
let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null
let presenceRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
let participantRefreshTimer: ReturnType<typeof setInterval> | null = null
let participantRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
let lastActivityHistoryRequest: {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
} = {}
let activityHistoryRequestSequence = 0
const PRESENCE_REFRESH_INTERVAL_MS = 30000
const MESSAGE_HISTORY_PAGE_SIZE = 150
const HANDOFF_PRESENCE_PAGE_SIZE = 500

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
    const rawBody = await res.text().catch(() => '')
    let payload: any = null
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody)
      } catch {
        payload = null
      }
    }
    const error = new Error(
      payload?.message ||
      payload?.error ||
      rawBody ||
      `HTTP ${res.status}`
    ) as Error & {
      status?: number
      code?: string | null
      payload?: any
    }
    error.status = res.status
    error.code = payload?.code || payload?.error || null
    error.payload = payload
    throw error
  }
  return res.json()
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

export function getReplyPreviewText(reply: Pick<MessageReplyReference, 'text'> | null | undefined): string {
  const text = String(reply?.text || '').replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/** ── API ── */
function roomPath(identifier: string): string {
  return `/rooms/${encodeURIComponent(identifier)}`
}

function getGitHubEventsIdentifier(roomInfo: RoomInfo | null): string {
  if (!roomInfo) return ''
  return roomInfo.identifier || roomInfo.name || roomInfo.projectId
}

function getGitHubSupportIdentifier(roomInfo: RoomInfo | null): string {
  if (!roomInfo) return ''
  if (roomInfo.kind === 'focus' && roomInfo.parentRoomId) {
    return roomInfo.parentRoomId
  }
  return getGitHubEventsIdentifier(roomInfo)
}

const githubEventsSupported = computed(() =>
  isRepoBackedRoomId(getGitHubSupportIdentifier(room.value))
)

interface MessagePage {
  messages: RoomMessage[]
  hasOlder: boolean
}

async function fetchMessages(roomIdentifier: string, before: string = 'latest'): Promise<MessagePage> {
  const params = new URLSearchParams({
    limit: String(MESSAGE_HISTORY_PAGE_SIZE),
    before,
  })

  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/messages?${params.toString()}`)
    return {
      messages: data.messages || [],
      hasOlder: Boolean(data.has_older ?? data.has_more),
    }
  } catch {
    return { messages: [], hasOlder: false }
  }
}

function mergeMessages(current: readonly RoomMessage[], incoming: readonly RoomMessage[]): RoomMessage[] {
  const byId = new Map<string, RoomMessage>()
  for (const msg of current) byId.set(msg.id, msg)
  for (const msg of incoming) {
    if (!isPromptOnlyRoomMessage(msg)) {
      byId.set(msg.id, msg)
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const aNum = Number(/^msg_(\d+)$/.exec(a.id)?.[1] || 0)
    const bNum = Number(/^msg_(\d+)$/.exec(b.id)?.[1] || 0)
    if (aNum && bNum && aNum !== bNum) return aNum - bNum
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  })
}

async function fetchPresence(
  roomIdentifier: string,
  limit: number = HANDOFF_PRESENCE_PAGE_SIZE
): Promise<RoomAgentPresence[]> {
  try {
    const params = new URLSearchParams()
    if (limit) {
      params.set('limit', String(limit))
    }
    const query = params.toString()
    const data = await apiFetch(`${roomPath(roomIdentifier)}/presence${query ? `?${query}` : ''}`)
    return data.presence || []
  } catch {
    return []
  }
}

async function fetchParticipants(roomIdentifier: string): Promise<RoomParticipantsPage> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/participants`)
    return {
      participants: data.participants || [],
      hidden_count: Number(data.hidden_count || 0),
    }
  } catch {
    return {
      participants: [],
      hidden_count: 0,
    }
  }
}

function reasoningSortValue(session: RoomReasoningSession): number {
  const detailEntries = session.entries || session.updates
  const latestEntry = detailEntries?.[detailEntries.length - 1]
  const latestTimestamp = latestEntry
    ? 'timestamp' in latestEntry
      ? latestEntry.timestamp
      : latestEntry.created_at
    : null
  const timestamp = session.updated_at || session.created_at || latestTimestamp || ''
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : -1
}

function sortReasoningSessions(sessions: readonly RoomReasoningSession[]): RoomReasoningSession[] {
  return [...sessions].sort((left, right) => {
    const byTime = reasoningSortValue(right) - reasoningSortValue(left)
    if (byTime !== 0) return byTime
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

function sortReasoningUpdates(updates: readonly RoomReasoningUpdate[]): RoomReasoningUpdate[] {
  return [...updates].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '')
    const rightTime = Date.parse(right.created_at || '')
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime
    }
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

function mergeReasoningUpdates(
  existing: readonly RoomReasoningUpdate[] | null | undefined,
  incoming: readonly RoomReasoningUpdate[] | null | undefined,
  appended: RoomReasoningUpdate | null | undefined,
): RoomReasoningUpdate[] {
  const merged = new Map<string, RoomReasoningUpdate>()

  for (const update of existing || []) {
    if (update?.id) merged.set(update.id, update)
  }
  for (const update of incoming || []) {
    if (update?.id) merged.set(update.id, update)
  }
  if (appended?.id) {
    merged.set(appended.id, appended)
  }

  const sorted = sortReasoningUpdates([...merged.values()])
  if (sorted.length <= MAX_LIVE_REASONING_UPDATES) {
    return sorted
  }
  return sorted.slice(-MAX_LIVE_REASONING_UPDATES)
}

function mergeReasoningSession(
  existing: RoomReasoningSession,
  incoming: RoomReasoningSession,
  appendedUpdate?: RoomReasoningUpdate | null,
): RoomReasoningSession {
  const mergedUpdates = mergeReasoningUpdates(existing.updates, incoming.updates, appendedUpdate)
  const mergedEntries = Array.isArray(incoming.entries) && incoming.entries.length > 0
    ? incoming.entries
    : Array.isArray(existing.entries) && existing.entries.length > 0
      ? existing.entries
      : incoming.entries ?? existing.entries

  return {
    ...existing,
    ...incoming,
    ...(mergedEntries !== undefined ? { entries: mergedEntries } : {}),
    ...(mergedUpdates.length > 0 ? { updates: mergedUpdates } : {}),
  }
}

async function fetchReasoningSessions(roomIdentifier: string): Promise<RoomReasoningSession[]> {
  const paths = [
    `${roomPath(roomIdentifier)}/reasoning-sessions`,
    `${roomPath(roomIdentifier)}/reasoning`,
  ]

  for (const path of paths) {
    try {
      const data = await apiFetch(path)
      const sessions = Array.isArray(data.sessions)
        ? data.sessions
        : Array.isArray(data.reasoning_sessions)
          ? data.reasoning_sessions
          : []
      return sortReasoningSessions(sessions)
    } catch {
      continue
    }
  }

  return []
}

function upsertReasoningSession(
  session: RoomReasoningSession | null | undefined,
  appendedUpdate?: RoomReasoningUpdate | null,
) {
  if (!session?.id) return
  const idx = reasoningSessions.value.findIndex((item) => item.id === session.id)
  if (idx >= 0) {
    const updated = [...reasoningSessions.value]
    updated[idx] = mergeReasoningSession(updated[idx], session, appendedUpdate)
    reasoningSessions.value = sortReasoningSessions(updated)
    return
  }
  const nextSession = appendedUpdate?.id
    ? mergeReasoningSession(session, session, appendedUpdate)
    : session
  reasoningSessions.value = sortReasoningSessions([...reasoningSessions.value, nextSession])
}

function removeReasoningSession(sessionId: string) {
  reasoningSessions.value = reasoningSessions.value.filter((session) => session.id !== sessionId)
}

async function fetchActivityHistory(
  roomIdentifier: string,
  options?: {
    query?: string
    page?: number
    pageSize?: number
    kind?: RoomActivityHistoryKind
    roomId?: string
  }
): Promise<RoomActivityHistoryPage | null> {
  const params = new URLSearchParams()
  if (options?.query?.trim()) params.set('query', options.query.trim())
  if (options?.page) params.set('page', String(options.page))
  if (options?.pageSize) params.set('page_size', String(options.pageSize))
  if (options?.kind && options.kind !== 'all') params.set('kind', options.kind)
  if (options?.roomId?.trim()) params.set('room_id', options.roomId.trim())

  try {
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return await apiFetch(`${roomPath(roomIdentifier)}/activity-history${suffix}`)
  } catch {
    return null
  }
}

async function fetchTasks(roomIdentifier: string): Promise<RoomTask[]> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/tasks`)
    return data.tasks || []
  } catch {
    return []
  }
}

async function fetchFocusRooms(roomIdentifier: string): Promise<FocusRoomInfo[]> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/focus-rooms`)
    return data.focus_rooms || []
  } catch {
    return []
  }
}

async function fetchGitHubEvents(roomIdentifier: string): Promise<{
  events: RoomGitHubEvent[]
  available: boolean
  hasMore: boolean
  error: RoomGitHubEventsError | null
}> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/events?limit=100`)
    return toAvailableGitHubEventsResult<RoomGitHubEvent>(data)
  } catch (error) {
    return mapGitHubEventsFetchError<RoomGitHubEvent>(error as { status?: number; message?: string })
  }
}

async function refreshPresence(roomIdentifier: string) {
  const nextPresence = await fetchPresence(roomIdentifier)
  presence.value = nextPresence
  boardHandoffPresence.value = nextPresence
}

async function refreshParticipants(roomIdentifier: string) {
  const next = await fetchParticipants(roomIdentifier)
  participants.value = next.participants
  participantHiddenCount.value = next.hidden_count
}

async function loadActivityHistory(options?: {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
}): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const nextRequest = {
    query: options?.query ?? lastActivityHistoryRequest.query,
    page: options?.page ?? lastActivityHistoryRequest.page ?? 1,
    pageSize: options?.pageSize ?? lastActivityHistoryRequest.pageSize ?? 20,
    kind: options?.kind ?? lastActivityHistoryRequest.kind ?? 'all',
    roomId: options?.roomId ?? lastActivityHistoryRequest.roomId ?? roomIdentifier,
  }
  lastActivityHistoryRequest = nextRequest
  const requestId = ++activityHistoryRequestSequence

  activityHistoryLoading.value = true
  activityHistoryError.value = ''
  try {
    const next = await fetchActivityHistory(roomIdentifier, nextRequest)
    if (requestId !== activityHistoryRequestSequence || room.value?.identifier !== roomIdentifier) {
      return false
    }
    if (!next) {
      activityHistoryError.value = 'Could not load room activity history.'
      return false
    }
    activityHistory.value = next
    return true
  } finally {
    if (requestId === activityHistoryRequestSequence) {
      activityHistoryLoading.value = false
    }
  }
}

async function clearDisconnectedParticipants(): Promise<number> {
  if (!room.value) return 0

  try {
    const response = await apiFetch(`${roomPath(room.value.identifier)}/participants/clear-disconnected`, {
      method: 'POST',
    })
    await Promise.all([
      refreshParticipants(room.value.identifier),
      refreshPresence(room.value.identifier),
    ])
    if ((activityHistory.value?.selected_room_id || lastActivityHistoryRequest.roomId || room.value.identifier) === room.value.identifier) {
      await loadActivityHistory({
        ...lastActivityHistoryRequest,
        roomId: room.value.identifier,
      })
    }
    return Number(response.cleared_count || response.suppressed_count || response.participant_hidden_count || 0)
  } catch {
    return 0
  }
}

async function refreshRoomPresence(): Promise<boolean> {
  if (!room.value) return false
  await refreshPresence(room.value.identifier)
  return true
}

async function refreshRoomReachability(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const [nextPresence, nextParticipantsPage] = await Promise.all([
    fetchPresence(roomIdentifier),
    fetchParticipants(roomIdentifier),
  ])
  if (room.value?.identifier !== roomIdentifier) return false
  presence.value = nextPresence
  boardHandoffPresence.value = nextPresence
  participants.value = nextParticipantsPage.participants
  participantHiddenCount.value = nextParticipantsPage.hidden_count
  return true
}

async function refreshRoomMessages(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const page = await fetchMessages(roomIdentifier)
  if (room.value?.identifier !== roomIdentifier) return false
  messages.value = mergeMessages(messages.value, page.messages)
  messagesHasOlder.value = page.hasOlder || messagesHasOlder.value
  return true
}

function schedulePresenceRefresh(roomIdentifier: string) {
  if (presenceRefreshDebounceTimer) return
  presenceRefreshDebounceTimer = setTimeout(() => {
    presenceRefreshDebounceTimer = null
    void refreshPresence(roomIdentifier)
  }, 350)
}

function scheduleParticipantRefresh(roomIdentifier: string) {
  if (participantRefreshDebounceTimer) return
  participantRefreshDebounceTimer = setTimeout(() => {
    participantRefreshDebounceTimer = null
    void refreshParticipants(roomIdentifier)
  }, 350)
}

function startPresenceRefreshLoop(roomIdentifier: string) {
  stopPresenceRefreshLoop()
  presenceRefreshTimer = setInterval(() => {
    void refreshPresence(roomIdentifier)
  }, PRESENCE_REFRESH_INTERVAL_MS)
}

function startParticipantRefreshLoop(roomIdentifier: string) {
  stopParticipantRefreshLoop()
  participantRefreshTimer = setInterval(() => {
    void refreshParticipants(roomIdentifier)
  }, PRESENCE_REFRESH_INTERVAL_MS)
}

function stopPresenceRefreshLoop() {
  if (presenceRefreshTimer) {
    clearInterval(presenceRefreshTimer)
    presenceRefreshTimer = null
  }
  if (presenceRefreshDebounceTimer) {
    clearTimeout(presenceRefreshDebounceTimer)
    presenceRefreshDebounceTimer = null
  }
}

function stopParticipantRefreshLoop() {
  if (participantRefreshTimer) {
    clearInterval(participantRefreshTimer)
    participantRefreshTimer = null
  }
  if (participantRefreshDebounceTimer) {
    clearTimeout(participantRefreshDebounceTimer)
    participantRefreshDebounceTimer = null
  }
}

async function refreshGitHubEvents(
  roomIdentifier: string,
  supported = isRepoBackedRoomId(roomIdentifier),
) {
  if (!supported) {
    githubEvents.value = []
    githubEventsAvailable.value = false
    githubEventsHasMore.value = false
    githubEventsError.value = null
    githubEventsLoading.value = false
    return
  }

  githubEventsLoading.value = true
  try {
    const next = await fetchGitHubEvents(roomIdentifier)
    githubEvents.value = next.events
    githubEventsAvailable.value = next.available
    githubEventsHasMore.value = next.hasMore
    githubEventsError.value = next.error
  } finally {
    githubEventsLoading.value = false
  }
}

async function refreshRoomGitHubEvents(): Promise<boolean> {
  if (!room.value) return false
  await refreshGitHubEvents(getGitHubEventsIdentifier(room.value), githubEventsSupported.value)
  return true
}

function scheduleGitHubEventsRefresh(roomIdentifier: string, supported = isRepoBackedRoomId(roomIdentifier)) {
  if (githubEventsRefreshTimer) return
  githubEventsRefreshTimer = setTimeout(() => {
    githubEventsRefreshTimer = null
    void refreshGitHubEvents(roomIdentifier, supported)
  }, 350)
}

async function fetchTaskGithubStatus(roomIdentifier: string): Promise<Record<string, TaskGitHubArtifactStatus>> {
  try {
    const data = await apiFetch(`${roomPath(roomIdentifier)}/tasks/github-status`)
    return (data as { statuses?: Record<string, TaskGitHubArtifactStatus> }).statuses ?? {}
  } catch {
    return {}
  }
}

async function refreshTaskGithubStatus(): Promise<boolean> {
  if (!room.value) return false
  taskGithubStatus.value = await fetchTaskGithubStatus(room.value.identifier)
  return true
}

async function refreshReasoningSessions(): Promise<boolean> {
  if (!room.value) return false
  reasoningSessions.value = await fetchReasoningSessions(room.value.identifier)
  return true
}

async function refreshFocusRooms(): Promise<boolean> {
  if (!room.value) return false
  focusRooms.value = await fetchFocusRooms(room.value.identifier)
  return true
}

async function refreshRoomBoard(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  boardLoading.value = true
  try {
    const [nextTasks, nextGithubStatus, nextPresence] = await Promise.all([
      fetchTasks(roomIdentifier),
      fetchTaskGithubStatus(roomIdentifier),
      fetchPresence(roomIdentifier, HANDOFF_PRESENCE_PAGE_SIZE),
    ])
    if (room.value?.identifier !== roomIdentifier) return false
    tasks.value = nextTasks
    taskGithubStatus.value = nextGithubStatus
    boardHandoffPresence.value = nextPresence
    return true
  } finally {
    boardLoading.value = false
  }
}

async function refreshRoomActivity(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const historyRequest = {
    ...lastActivityHistoryRequest,
    roomId: lastActivityHistoryRequest.roomId ?? roomIdentifier,
  }
  activityLoading.value = true
  try {
    const [
      messagePage,
      nextPresence,
      nextParticipantsPage,
      nextReasoningSessions,
      nextActivityHistory,
      nextTasks,
      nextGithubStatus,
    ] = await Promise.all([
      fetchMessages(roomIdentifier),
      fetchPresence(roomIdentifier),
      fetchParticipants(roomIdentifier),
      fetchReasoningSessions(roomIdentifier),
      fetchActivityHistory(roomIdentifier, historyRequest),
      fetchTasks(roomIdentifier),
      fetchTaskGithubStatus(roomIdentifier),
    ])
    if (room.value?.identifier !== roomIdentifier) return false
    messages.value = mergeMessages(messages.value, messagePage.messages)
    messagesHasOlder.value = messagePage.hasOlder || messagesHasOlder.value
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
    participants.value = nextParticipantsPage.participants
    participantHiddenCount.value = nextParticipantsPage.hidden_count
    reasoningSessions.value = nextReasoningSessions
    if (nextActivityHistory) {
      activityHistory.value = nextActivityHistory
      activityHistoryError.value = ''
    }
    tasks.value = nextTasks
    taskGithubStatus.value = nextGithubStatus
    return true
  } finally {
    activityLoading.value = false
  }
}

async function refreshRoomFocusRooms(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  focusRoomsLoading.value = true
  try {
    const [nextFocusRooms, nextTasks] = await Promise.all([
      fetchFocusRooms(roomIdentifier),
      fetchTasks(roomIdentifier),
    ])
    if (room.value?.identifier !== roomIdentifier) return false
    focusRooms.value = nextFocusRooms
    tasks.value = nextTasks
    return true
  } finally {
    focusRoomsLoading.value = false
  }
}

function upsertFocusRoom(focusRoom: FocusRoomInfo) {
  const idx = focusRooms.value.findIndex(item => item.room_id === focusRoom.room_id)
  if (idx >= 0) {
    const updated = [...focusRooms.value]
    updated[idx] = focusRoom
    focusRooms.value = updated
  } else {
    focusRooms.value = [...focusRooms.value, focusRoom]
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
      if (isPromptOnlyRoomMessage(msg)) {
        return
      }
      const exists = messages.value.some(m => m.id === msg.id)
      if (!exists) {
        messages.value = [...messages.value, msg]
        playNotificationSound()

        if ((msg.source || '').toLowerCase() === 'github' || (msg.sender || '').toLowerCase() === 'github') {
          if (room.value && githubEventsSupported.value) {
            scheduleGitHubEventsRefresh(getGitHubEventsIdentifier(room.value), githubEventsSupported.value)
          }
          // Also refresh task github status when new github events arrive
          if (room.value) {
            void refreshTaskGithubStatus()
          }
        }

        // Auto-refresh board when task lifecycle messages arrive
        if (msg.sender === 'letagents' && msg.text?.includes('task_')) {
          if (room.value) {
            fetchTasks(room.value.identifier).then(t => { tasks.value = t })
          }
        }

        if (room.value && ((msg.source || '').toLowerCase() === 'agent' || msg.sender === 'letagents')) {
          schedulePresenceRefresh(room.value.identifier)
        }

        if (room.value && ((msg.source || '').toLowerCase() === 'agent' || (msg.source || '').toLowerCase() === 'browser')) {
          scheduleParticipantRefresh(room.value.identifier)
        }
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

  eventSource.addEventListener('reasoning_update', (e) => {
    try {
      const payload = JSON.parse(e.data)
      const session = payload?.session || payload
      const update = payload?.update && typeof payload.update.id === 'string'
        ? payload.update as RoomReasoningUpdate
        : null
      if (session?.id) {
        upsertReasoningSession(session, update)
      }
    } catch { /* ignore */ }
  })

  eventSource.addEventListener('reasoning_remove', (e) => {
    try {
      const payload = JSON.parse(e.data)
      const sessionId = typeof payload?.session_id === 'string'
        ? payload.session_id
        : typeof payload?.id === 'string'
          ? payload.id
          : ''
      if (sessionId) {
        removeReasoningSession(sessionId)
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
  if (githubEventsRefreshTimer) {
    clearTimeout(githubEventsRefreshTimer)
    githubEventsRefreshTimer = null
  }
  stopPresenceRefreshLoop()
  stopParticipantRefreshLoop()
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
async function sendMessage(
  text: string,
  sender?: string,
  agentPromptKind?: string | null,
  replyTo?: string | null,
  attachments: OutgoingMessageAttachment[] = []
): Promise<boolean> {
  if (!room.value) return false
  lastSendError.value = ''
  try {
    const preparedAttachments = attachments.length
      ? await prepareMessageAttachments(room.value.identifier, attachments)
      : []
    const body: Record<string, unknown> = { text, sender: sender || 'anonymous' }
    if (agentPromptKind) {
      body.agent_prompt_kind = agentPromptKind
    }
    if (replyTo) {
      body.reply_to = replyTo
    }
    if (preparedAttachments.length) {
      body.attachments = preparedAttachments
    }
    const msg = await apiFetch(`${roomPath(room.value.identifier)}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    // Optimistic add if SSE hasn't delivered it yet — skip prompt-only auto messages
    if (msg?.id && !isPromptOnlyRoomMessage(msg) && !messages.value.some(m => m.id === msg.id)) {
      messages.value = [...messages.value, msg]
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    lastSendError.value = /attachment object storage is not configured/i.test(message)
      ? 'Attachments are unavailable right now.'
      : message || 'Message could not be sent.'
    return false
  }
}

async function prepareMessageAttachments(
  roomIdentifier: string,
  attachments: OutgoingMessageAttachment[]
): Promise<StagedMessageAttachment[]> {
  const prepared: StagedMessageAttachment[] = []
  for (const attachment of attachments) {
    if (attachment.upload_id) {
      prepared.push({ upload_id: attachment.upload_id })
      continue
    }

    prepared.push(await stageAttachmentUpload(roomIdentifier, attachment))
  }
  return prepared
}

function resolveAttachmentUploadTarget(target: AttachmentUploadTarget): {
  uploadId: string
  uploadUrl: string
} {
  const uploadId = target.upload_id
    || target.attachment?.upload_id
    || target.attachment_id
    || target.attachment?.attachment_id
    || target.id
    || target.attachment?.id
  const uploadUrl = target.upload_url || target.url
  if (!uploadId || !uploadUrl) {
    throw new Error('Attachment upload target is incomplete.')
  }
  return { uploadId, uploadUrl }
}

async function stageAttachmentUpload(
  roomIdentifier: string,
  attachment: OutgoingMessageAttachment,
  signal?: AbortSignal
): Promise<StagedMessageAttachment> {
  if (!attachment.file) {
    throw new Error('Attachment file is missing.')
  }

  let uploadId: string | null = null
  try {
    const target = await apiFetch(`${roomPath(roomIdentifier)}/attachments/uploads`, {
      method: 'POST',
      body: JSON.stringify({
        file_name: attachment.file_name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
      }),
      signal,
    }) as AttachmentUploadTarget

    const resolved = resolveAttachmentUploadTarget(target)
    uploadId = resolved.uploadId

    const headers: Record<string, string> = {
      ...(target.headers || {}),
    }
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = attachment.mime_type || 'application/octet-stream'
    }

    const uploadRes = await fetch(resolved.uploadUrl, {
      method: target.method || 'PUT',
      headers,
      body: attachment.file,
      signal,
    })
    if (!uploadRes.ok) {
      throw new Error(`Attachment upload failed with HTTP ${uploadRes.status}.`)
    }

    return { upload_id: resolved.uploadId }
  } catch (error) {
    if (uploadId) {
      void discardAttachmentUpload(roomIdentifier, uploadId).catch(() => {})
    }
    throw error
  }
}

async function discardAttachmentUpload(roomIdentifier: string, uploadId: string): Promise<void> {
  await apiFetch(`${roomPath(roomIdentifier)}/attachments/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
  })
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

async function createFocusRoom(taskId: string): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  try {
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/focus-room`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    )
    const focusRoom = data.focus_room as FocusRoomInfo | undefined
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)

    return focusRoom
  } catch {
    return null
  }
}

async function createAdHocFocusRoom(title: string): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  const trimmedTitle = title.trim()
  if (!trimmedTitle) return null

  try {
    const data = await apiFetch(`${roomPath(room.value.identifier)}/focus-rooms`, {
      method: 'POST',
      body: JSON.stringify({ title: trimmedTitle }),
    })
    const focusRoom = data.focus_room as FocusRoomInfo | undefined
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)

    return focusRoom
  } catch {
    return null
  }
}

async function shareFocusRoomResult(
  summary: string,
  conclusionDetails: FocusRoomConclusionDetails | null = null
): Promise<{ focusRoom: FocusRoomInfo; parentMessagePosted: boolean } | null> {
  if (!room.value || room.value.kind !== 'focus') return null
  const trimmedSummary = summary.trim()
  const parentRoomId = room.value.parentRoomId
  const focusKey = room.value.focusKey || room.value.sourceTaskId
  if (!trimmedSummary || !parentRoomId || !focusKey) return null

  try {
    const data = await apiFetch(
      `${roomPath(parentRoomId)}/focus/${encodeURIComponent(focusKey)}/conclude`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: trimmedSummary,
          conclusion_details: conclusionDetails,
        }),
      }
    )
    const focusRoom = (data.focus_room || data.room) as FocusRoomInfo | undefined
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)
    room.value = {
      ...room.value,
      displayName: focusRoom.display_name || room.value.displayName,
      attachmentsEnabled: focusRoom.attachments_enabled ?? room.value.attachmentsEnabled,
      focusStatus: focusRoom.focus_status || room.value.focusStatus,
      focusParentVisibility: focusRoom.focus_parent_visibility || room.value.focusParentVisibility,
      focusActivityScope: focusRoom.focus_activity_scope || room.value.focusActivityScope,
      focusGitHubEventRouting: focusRoom.focus_github_event_routing || room.value.focusGitHubEventRouting,
      concludedAt: focusRoom.concluded_at || room.value.concludedAt,
      conclusionSummary: focusRoom.conclusion_summary || trimmedSummary,
      conclusionDetails: focusRoom.conclusion_details || conclusionDetails,
    }

    return {
      focusRoom,
      parentMessagePosted: Boolean(data.message),
    }
  } catch {
    return null
  }
}

async function updateFocusRoomSettings(
  focusKey: string,
  settings: FocusRoomSettingsPatch
): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  const parentRoomId = room.value.kind === 'focus'
    ? room.value.parentRoomId
    : room.value.identifier
  if (!parentRoomId || !focusKey) return null

  try {
    const data = await apiFetch(
      `${roomPath(parentRoomId)}/focus/${encodeURIComponent(focusKey)}/settings`,
      {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }
    )
    const focusRoom = data.focus_room as FocusRoomInfo | undefined
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)
    if (room.value.kind === 'focus' && room.value.projectId === focusRoom.room_id) {
      room.value = {
        ...room.value,
        attachmentsEnabled: focusRoom.attachments_enabled ?? room.value.attachmentsEnabled,
        focusParentVisibility: focusRoom.focus_parent_visibility,
        focusActivityScope: focusRoom.focus_activity_scope,
        focusGitHubEventRouting: focusRoom.focus_github_event_routing,
      }
    }

    return focusRoom
  } catch {
    return null
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
    // Server returns the updated task at top level (not nested under .task)
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex(t => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
    // Re-fetch to stay in sync (like legacy refreshBoard)
    const [nextTasks, nextPresence] = await Promise.all([
      fetchTasks(room.value.identifier),
      fetchPresence(room.value.identifier),
    ])
    tasks.value = nextTasks
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
    return true
  } catch {
    return false
  }
}

async function updateTaskLease(taskId: string, input: TaskLeaseActionInput): Promise<boolean> {
  if (!room.value) return false
  try {
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/lease-action`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    )
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex(t => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
    const [nextTasks, nextPresence] = await Promise.all([
      fetchTasks(room.value.identifier),
      fetchPresence(room.value.identifier),
    ])
    tasks.value = nextTasks
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
    return true
  } catch {
    return false
  }
}

async function setTaskStalePromptMute(
  taskId: string,
  muted: boolean,
  options?: { promptTimestamp?: string | null }
): Promise<boolean> {
  if (!room.value) return false
  try {
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/stale-prompt-mute`,
      {
        method: muted ? 'POST' : 'DELETE',
        body: JSON.stringify({
          prompt_timestamp: options?.promptTimestamp ?? null,
        }),
      }
    )
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex(t => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
    tasks.value = await fetchTasks(room.value.identifier)
    return true
  } catch (error) {
    tasks.value = await fetchTasks(room.value.identifier)
    if ((error as { code?: string | null }).code === 'STALE_PROMPT_OUTDATED') {
      return true
    }
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
  // Clear active room state before attempting new join to prevent
  // failed transitions from leaving stale room data that misdirects sends
  stopStreaming()
  activityHistoryRequestSequence += 1
  room.value = null
  messages.value = []
  messagesHasOlder.value = false
  isLoadingOlderMessages.value = false
  tasks.value = []
  focusRooms.value = []
  presence.value = []
  boardHandoffPresence.value = []
  participants.value = []
  participantHiddenCount.value = 0
  activityHistory.value = null
  activityHistoryLoading.value = true
  activityHistoryError.value = ''
  lastActivityHistoryRequest = { page: 1, pageSize: 20, kind: 'all', roomId: roomIdentifier }
  reasoningSessions.value = []
  githubEvents.value = []
  githubEventsAvailable.value = false
  githubEventsHasMore.value = false
  githubEventsError.value = null
  githubEventsLoading.value = true
  isConnected.value = false
  connectionState.value = 'connecting'
  joinError.value = null

  try {
    // Join via POST /rooms/:identifier/join
    const project = await apiFetch(`${roomPath(roomIdentifier)}/join`, {
      method: 'POST',
    })

    const joinedRoom: RoomInfo = {
      projectId: project.room_id || roomIdentifier,
      identifier: roomIdentifier,
      code: project.code || '',
      name: project.name || roomIdentifier,
      displayName: project.display_name || project.name || roomIdentifier,
      role: project.role || 'participant',
      authenticated: !!project.authenticated,
      kind: project.kind || 'main',
      attachmentsEnabled: project.attachments_enabled !== false,
      parentRoomId: project.parent_room_id || null,
      focusKey: project.focus_key || null,
      sourceTaskId: project.source_task_id || null,
      focusStatus: project.focus_status || null,
      focusParentVisibility: project.focus_parent_visibility || project.focus_settings?.parent_visibility || null,
      focusActivityScope: project.focus_activity_scope || project.focus_settings?.activity_scope || null,
      focusGitHubEventRouting: project.focus_github_event_routing || project.focus_settings?.github_event_routing || null,
      concludedAt: project.concluded_at || null,
      conclusionSummary: project.conclusion_summary || null,
      conclusionDetails: project.conclusion_details || null,
    }
    room.value = joinedRoom
    isConnected.value = true
    persistSession()
    const bootstrapActivityHistoryRequestId = activityHistoryRequestSequence

    // Load existing room state in parallel
    const githubEventsIdentifier = getGitHubEventsIdentifier(joinedRoom)
    const supportsGitHubEvents = isRepoBackedRoomId(getGitHubSupportIdentifier(joinedRoom))
    const [messagePage, tsks, focused, prs, roomParticipantsPage, history, reasoning, gh, ghStatus] = await Promise.all([
      fetchMessages(roomIdentifier),
      fetchTasks(roomIdentifier),
      fetchFocusRooms(roomIdentifier),
      fetchPresence(roomIdentifier),
      fetchParticipants(roomIdentifier),
      fetchActivityHistory(roomIdentifier, lastActivityHistoryRequest),
      fetchReasoningSessions(roomIdentifier),
      supportsGitHubEvents
        ? fetchGitHubEvents(githubEventsIdentifier)
        : Promise.resolve({ events: [], available: false, hasMore: false, error: null }),
      fetchTaskGithubStatus(roomIdentifier),
    ])
    messages.value = mergeMessages([], messagePage.messages)
    messagesHasOlder.value = messagePage.hasOlder
    tasks.value = tsks
    focusRooms.value = focused
    presence.value = prs
    boardHandoffPresence.value = prs
    participants.value = roomParticipantsPage.participants
    participantHiddenCount.value = roomParticipantsPage.hidden_count
    reasoningSessions.value = reasoning
    if (
      bootstrapActivityHistoryRequestId === activityHistoryRequestSequence
      && room.value?.identifier === roomIdentifier
    ) {
      activityHistory.value = history
      activityHistoryLoading.value = false
      activityHistoryError.value = history ? '' : 'Could not load room activity history.'
    }
    taskGithubStatus.value = ghStatus
    githubEvents.value = gh.events
    githubEventsAvailable.value = gh.available
    githubEventsHasMore.value = gh.hasMore
    githubEventsError.value = gh.error
    githubEventsLoading.value = false

    // Start real-time streaming
    startPresenceRefreshLoop(roomIdentifier)
    startParticipantRefreshLoop(roomIdentifier)
    startStreaming(roomIdentifier)
    connectionState.value = 'live'
    return true
  } catch (err) {
    connectionState.value = 'error'
    const error = err as Error & {
      status?: number
      code?: string | null
      payload?: {
        room_id?: string
        device_flow_url?: string
        message?: string
      } | null
    }
    joinError.value = {
      status: error.status ?? null,
      code: error.code ?? null,
      message: error.message || 'Could not connect to room.',
      roomId: error.payload?.room_id ?? roomIdentifier,
      deviceFlowUrl: error.payload?.device_flow_url ?? null,
    }
    console.error('[useRoom] joinRoom failed:', err)
    return false
  }
}

async function loadOlderMessages(): Promise<boolean> {
  if (!room.value || isLoadingOlderMessages.value || !messagesHasOlder.value) {
    return false
  }

  const firstMessageId = messages.value[0]?.id
  if (!firstMessageId) {
    return false
  }

  isLoadingOlderMessages.value = true
  try {
    const page = await fetchMessages(room.value.identifier, firstMessageId)
    messages.value = mergeMessages(messages.value, page.messages)
    messagesHasOlder.value = page.hasOlder
    return page.messages.length > 0
  } finally {
    isLoadingOlderMessages.value = false
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
  activityHistoryRequestSequence += 1
  room.value = null
  messages.value = []
  messagesHasOlder.value = false
  isLoadingOlderMessages.value = false
  tasks.value = []
  focusRooms.value = []
  presence.value = []
  boardHandoffPresence.value = []
  participants.value = []
  participantHiddenCount.value = 0
  activityHistory.value = null
  activityHistoryLoading.value = false
  activityHistoryError.value = ''
  lastActivityHistoryRequest = {}
  reasoningSessions.value = []
  githubEvents.value = []
  githubEventsAvailable.value = false
  githubEventsHasMore.value = false
  githubEventsError.value = null
  githubEventsLoading.value = false
  isConnected.value = false
  connectionState.value = 'idle'
  joinError.value = null
  clearPersistedSession()
}

/** ── Notification Sound (Web Audio API) ── */
const soundEnabled = ref(localStorage.getItem('lac-sound') !== 'off')
let audioCtx: AudioContext | null = null

function toggleSound() {
  soundEnabled.value = !soundEnabled.value
  localStorage.setItem('lac-sound', soundEnabled.value ? 'on' : 'off')
}

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
    messagesHasOlder: readonly(messagesHasOlder),
    isLoadingOlderMessages: readonly(isLoadingOlderMessages),
    tasks: readonly(tasks),
    focusRooms: readonly(focusRooms),
    presence: readonly(presence),
    boardHandoffPresence: readonly(boardHandoffPresence),
    participants: readonly(participants),
    participantHiddenCount: readonly(participantHiddenCount),
    activityHistory: readonly(activityHistory),
    activityHistoryLoading: readonly(activityHistoryLoading),
    activityHistoryError: readonly(activityHistoryError),
    reasoningSessions: readonly(reasoningSessions),
    taskGithubStatus: readonly(taskGithubStatus),
    githubEvents: readonly(githubEvents),
    githubEventsAvailable: readonly(githubEventsAvailable),
    githubEventsHasMore: readonly(githubEventsHasMore),
    githubEventsError: readonly(githubEventsError),
    githubEventsSupported,
    githubEventsLoading: readonly(githubEventsLoading),
    boardLoading: readonly(boardLoading),
    activityLoading: readonly(activityLoading),
    focusRoomsLoading: readonly(focusRoomsLoading),
    room: readonly(room),
    lastSendError: readonly(lastSendError),
    isConnected: readonly(isConnected),
    isStreaming: readonly(isStreaming),
    connectionState: readonly(connectionState),
    joinError: readonly(joinError),
    soundEnabled: readonly(soundEnabled),

    // Actions
    joinRoom,
    leaveRoom,
    sendMessage,
    stageAttachmentUpload,
    discardAttachmentUpload,
    addTask,
    updateTask,
    updateTaskLease,
    setTaskStalePromptMute,
    createFocusRoom,
    createAdHocFocusRoom,
    shareFocusRoomResult,
    updateFocusRoomSettings,
    refreshFocusRooms,
    refreshRoomMessages,
    refreshRoomPresence,
    refreshRoomReachability,
    loadActivityHistory,
    clearDisconnectedParticipants,
    refreshReasoningSessions,
    refreshRoomActivity,
    refreshRoomBoard,
    refreshRoomFocusRooms,
    refreshTaskGithubStatus,
    refreshRoomGitHubEvents,
    renameRoom,
    loadOlderMessages,
    restoreSession,
    toggleSound,

    // Utilities
    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
  }
}
