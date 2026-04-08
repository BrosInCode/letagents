<template>
  <div class="activity-panel">
    <div class="activity-summary">
      <article class="summary-card">
        <strong>{{ onlineAgents.length }}</strong>
        <span>Agents online</span>
      </article>
      <article class="summary-card">
        <strong>{{ disconnectedAgents.length }}</strong>
        <span>Agents disconnected</span>
      </article>
      <article class="summary-card">
        <strong>{{ humans.length }}</strong>
        <span>Humans seen</span>
      </article>
      <article class="summary-card">
        <strong>{{ participants.length }}</strong>
        <span>Known participants</span>
      </article>
    </div>

    <div v-if="participants.length === 0" class="activity-empty">
      <h3>No room participants yet</h3>
      <p>Agents and humans will appear here once they join, post status, or send messages.</p>
    </div>

    <div v-else class="activity-layout">
      <div class="activity-groups">
        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Agents online</h3>
              <p>Fresh heartbeats from this room.</p>
            </div>
            <span class="activity-group-count">{{ onlineAgents.length }}</span>
          </div>

          <div v-if="onlineAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in onlineAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.connection"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-connection-pill" :data-connection="participant.connection">
                  {{ connectionLabel(participant) }}
                </span>
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No agents are online right now.
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Agents disconnected</h3>
              <p>Ever seen in this room, but not currently live.</p>
            </div>
            <span class="activity-group-count">{{ disconnectedAgents.length }}</span>
          </div>

          <div v-if="disconnectedAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in disconnectedAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.connection"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-connection-pill" :data-connection="participant.connection">
                  {{ connectionLabel(participant) }}
                </span>
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No disconnected agents have been seen yet.
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Humans seen in room</h3>
              <p>People detected from browser-side room activity.</p>
            </div>
            <span class="activity-group-count">{{ humans.length }}</span>
          </div>

          <div v-if="humans.length > 0" class="activity-roster">
            <button
              v-for="participant in humans"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-kind-pill">Human</span>
              </div>
              <div class="activity-roster-status">
                <span>{{ participantNote(participant) }}</span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No human browser activity has been seen yet.
          </div>
        </section>
      </div>

      <aside v-if="selectedParticipant" class="activity-detail" :data-kind="selectedParticipant.kind">
        <div class="activity-detail-header">
          <div>
            <div class="activity-detail-kicker">
              {{ selectedParticipant.kind === 'agent' ? 'Agent detail' : 'Human detail' }}
            </div>
            <h3>{{ selectedParticipant.label }}</h3>
            <p>{{ participantMeta(selectedParticipant) }}</p>
          </div>

          <div class="activity-detail-badges">
            <span
              v-if="selectedParticipant.kind === 'agent'"
              class="activity-connection-pill"
              :data-connection="selectedParticipant.connection"
            >
              {{ connectionLabel(selectedParticipant) }}
            </span>
            <span
              v-if="selectedParticipant.status"
              class="activity-status-pill"
              :data-status="selectedParticipant.status"
            >
              {{ STATUS_LABELS[selectedParticipant.status] }}
            </span>
          </div>
        </div>

        <div class="activity-detail-stats">
          <article class="detail-stat">
            <strong>{{ selectedParticipant.messageCount }}</strong>
            <span>Messages</span>
          </article>
          <article class="detail-stat">
            <strong>{{ selectedParticipant.currentTasks.length }}</strong>
            <span>Current work</span>
          </article>
          <article class="detail-stat">
            <strong>{{ selectedParticipant.completedTasks.length }}</strong>
            <span>Completed</span>
          </article>
          <article class="detail-stat">
            <strong>{{ formatLastSeen(selectedParticipant.lastSeenAt) }}</strong>
            <span>Last seen</span>
          </article>
        </div>

        <p v-if="selectedParticipant.statusText" class="activity-detail-description">
          {{ selectedParticipant.statusText }}
        </p>

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Current work</h4>
            <span>{{ selectedParticipant.currentTasks.length }}</span>
          </div>

          <div v-if="selectedParticipant.currentTasks.length === 0" class="activity-detail-empty">
            No open tasks linked to this participant right now.
          </div>

          <div v-else class="activity-task-list">
            <article
              v-for="task in selectedParticipant.currentTasks"
              :key="task.id"
              class="activity-task-card"
            >
              <div class="activity-task-copy">
                <strong>{{ task.title }}</strong>
                <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
              </div>
              <a
                v-if="getTaskLink(task)"
                class="activity-task-link"
                :href="getTaskLink(task)!.url"
                target="_blank"
              >
                {{ getTaskLink(task)!.label }}
              </a>
            </article>
          </div>
        </section>

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Recent completed work</h4>
            <span>{{ selectedParticipant.completedTasks.length }}</span>
          </div>

          <div v-if="selectedParticipant.completedTasks.length === 0" class="activity-detail-empty">
            No completed or merged tasks tracked yet.
          </div>

          <div v-else class="activity-task-list">
            <article
              v-for="task in selectedParticipant.completedTasks"
              :key="task.id"
              class="activity-task-card"
            >
              <div class="activity-task-copy">
                <strong>{{ task.title }}</strong>
                <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
              </div>
              <a
                v-if="getTaskLink(task)"
                class="activity-task-link"
                :href="getTaskLink(task)!.url"
                target="_blank"
              >
                {{ getTaskLink(task)!.label }}
              </a>
            </article>
          </div>
        </section>

        <section v-if="selectedParticipant.createdTasks.length > 0" class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Tasks created</h4>
            <span>{{ selectedParticipant.createdTasks.length }}</span>
          </div>

          <div class="activity-task-list">
            <article
              v-for="task in selectedParticipant.createdTasks"
              :key="task.id"
              class="activity-task-card"
            >
              <div class="activity-task-copy">
                <strong>{{ task.title }}</strong>
                <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
              </div>
              <a
                v-if="getTaskLink(task)"
                class="activity-task-link"
                :href="getTaskLink(task)!.url"
                target="_blank"
              >
                {{ getTaskLink(task)!.label }}
              </a>
            </article>
          </div>
        </section>

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Recent room messages</h4>
            <span>{{ selectedParticipant.recentMessages.length }}</span>
          </div>

          <div v-if="selectedParticipant.recentMessages.length === 0" class="activity-detail-empty">
            No recent room messages from this participant.
          </div>

          <div v-else class="activity-message-list">
            <article
              v-for="message in selectedParticipant.recentMessages"
              :key="message.id"
              class="activity-message-card"
            >
              <div class="activity-message-meta">
                <span>{{ message.source === 'browser' ? 'Browser' : 'Agent message' }}</span>
                <span>{{ formatLastSeen(message.timestamp) }}</span>
              </div>
              <p>{{ previewMessage(message.text) }}</p>
            </article>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  isHumanSender,
  parseAgentIdentity,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomTask,
  type TaskGitHubArtifactStatus,
} from '@/composables/useRoom'

type ParticipantKind = 'agent' | 'human'
type ParticipantConnection = 'online' | 'disconnected'

interface ActivityParticipant {
  key: string
  kind: ParticipantKind
  label: string
  actorLabel: string
  ownerLabel: string | null
  ideLabel: string | null
  connection: ParticipantConnection | null
  status: RoomAgentPresence['status'] | null
  statusText: string | null
  lastSeenAt: string | null
  messageCount: number
  currentTasks: RoomTask[]
  completedTasks: RoomTask[]
  createdTasks: RoomTask[]
  recentMessages: RoomMessage[]
}

const props = defineProps<{
  messages: readonly RoomMessage[]
  presence: readonly RoomAgentPresence[]
  tasks: readonly RoomTask[]
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

const STATUS_ORDER = ['working', 'reviewing', 'blocked', 'idle'] as const
const STATUS_LABELS: Record<RoomAgentPresence['status'], string> = {
  idle: 'Idle',
  working: 'Working',
  reviewing: 'Reviewing',
  blocked: 'Blocked',
}
const TASK_STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  assigned: 'Assigned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  merged: 'Merged',
  done: 'Done',
  cancelled: 'Cancelled',
}
const COMPLETED_TASK_STATUSES = new Set(['merged', 'done'])
const OPEN_TASK_STATUSES = new Set(['proposed', 'accepted', 'assigned', 'in_progress', 'blocked', 'in_review'])

const selectedParticipantKey = ref<string | null>(null)

function isAgentIdentityValue(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized.toLowerCase() === 'letagents' || normalized.toLowerCase() === 'system') return false
  const parsed = parseAgentIdentity(normalized)
  return Boolean(parsed.structured || parsed.ownerAttribution || parsed.ideLabel)
}

function pushMapValue<T>(target: Map<string, T[]>, key: string, value: T) {
  const existing = target.get(key)
  if (existing) {
    existing.push(value)
    return
  }
  target.set(key, [value])
}

function extractStatusText(text: string | null | undefined): string | null {
  const normalized = String(text || '').trim().replace(/^\[status\]\s*/i, '').trim()
  return normalized || null
}

function previewMessage(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'No message body'
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : -1
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  let bestValue = -1
  for (const value of values) {
    const current = timestampValue(value)
    if (current > bestValue) {
      best = value || null
      bestValue = current
    }
  }
  return best
}

function sortTasksByUpdated(tasks: readonly RoomTask[]): RoomTask[] {
  return [...tasks].sort((left, right) => right.updated_at.localeCompare(left.updated_at))
}

function latestTaskTimestamp(tasks: readonly RoomTask[]): string | null {
  return sortTasksByUpdated(tasks)[0]?.updated_at || null
}

const agentMessagesByActor = computed(() => {
  const grouped = new Map<string, RoomMessage[]>()
  for (const message of props.messages) {
    const sender = String(message.sender || '').trim()
    if (!sender || isHumanSender(sender, message.source)) continue
    const key = message.agent_identity?.actor_label || sender
    pushMapValue(grouped, key, message)
  }
  return grouped
})

const humanMessagesBySender = computed(() => {
  const grouped = new Map<string, RoomMessage[]>()
  for (const message of props.messages) {
    const sender = String(message.sender || '').trim()
    if (!sender || !isHumanSender(sender, message.source)) continue
    pushMapValue(grouped, sender, message)
  }
  return grouped
})

const presenceByActor = computed(() =>
  new Map(props.presence.map((entry) => [entry.actor_label, entry]))
)

function participantMatchesActor(participant: ActivityParticipant, value: string | null): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized === participant.actorLabel) return true

  if (participant.kind === 'agent' && isAgentIdentityValue(normalized)) {
    return parseAgentIdentity(normalized).displayName === participant.label
  }

  return false
}

function buildAgentParticipant(actorLabel: string): ActivityParticipant {
  const presenceEntry = presenceByActor.value.get(actorLabel) || null
  const messages = agentMessagesByActor.value.get(actorLabel) || []
  const latestMessage = messages[messages.length - 1] || null
  const latestStatusMessage = [...messages].reverse().find((message) => extractStatusText(message.text)) || null
  const parsed = parseAgentIdentity(actorLabel)
  const label = presenceEntry?.display_name || latestMessage?.agent_identity?.display_name || parsed.displayName || actorLabel
  const ownerLabel = presenceEntry?.owner_label
    || latestMessage?.agent_identity?.owner_label
    || parsed.ownerAttribution
    || null
  const ideLabel = presenceEntry?.ide_label || latestMessage?.agent_identity?.ide_label || parsed.ideLabel || null

  const assignedTasks = props.tasks.filter((task) => participantMatchesActor({
    key: `agent:${actorLabel}`,
    kind: 'agent',
    label,
    actorLabel,
    ownerLabel,
    ideLabel,
    connection: null,
    status: null,
    statusText: null,
    lastSeenAt: null,
    messageCount: messages.length,
    currentTasks: [],
    completedTasks: [],
    createdTasks: [],
    recentMessages: [],
  }, task.assignee))
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const createdTasks = sortTasksByUpdated(
    props.tasks.filter((task) => participantMatchesActor({
      key: `agent:${actorLabel}`,
      kind: 'agent',
      label,
      actorLabel,
      ownerLabel,
      ideLabel,
      connection: null,
      status: null,
      statusText: null,
      lastSeenAt: null,
      messageCount: messages.length,
      currentTasks: [],
      completedTasks: [],
      createdTasks: [],
      recentMessages: [],
    }, task.created_by))
  ).slice(0, 8)

  return {
    key: `agent:${actorLabel}`,
    kind: 'agent',
    label,
    actorLabel,
    ownerLabel,
    ideLabel,
    connection: presenceEntry?.freshness === 'active' ? 'online' : 'disconnected',
    status: presenceEntry?.status || null,
    statusText: presenceEntry?.status_text || extractStatusText(latestStatusMessage?.text) || null,
    lastSeenAt: latestTimestamp(
      presenceEntry?.last_heartbeat_at,
      latestMessage?.timestamp,
      latestTaskTimestamp(currentTasks),
      latestTaskTimestamp(completedTasks),
      latestTaskTimestamp(createdTasks)
    ),
    messageCount: messages.length,
    currentTasks,
    completedTasks,
    createdTasks,
    recentMessages: [...messages].slice(-4).reverse(),
  }
}

function buildHumanParticipant(sender: string): ActivityParticipant {
  const messages = humanMessagesBySender.value.get(sender) || []
  const assignedTasks = props.tasks.filter((task) => String(task.assignee || '').trim() === sender)
  const createdTasks = sortTasksByUpdated(
    props.tasks.filter((task) => String(task.created_by || '').trim() === sender)
  ).slice(0, 8)
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const latestMessage = messages[messages.length - 1] || null

  return {
    key: `human:${sender}`,
    kind: 'human',
    label: sender,
    actorLabel: sender,
    ownerLabel: null,
    ideLabel: null,
    connection: null,
    status: null,
    statusText: latestMessage ? previewMessage(latestMessage.text) : null,
    lastSeenAt: latestTimestamp(
      latestMessage?.timestamp,
      latestTaskTimestamp(currentTasks),
      latestTaskTimestamp(completedTasks),
      latestTaskTimestamp(createdTasks)
    ),
    messageCount: messages.length,
    currentTasks,
    completedTasks,
    createdTasks,
    recentMessages: [...messages].slice(-4).reverse(),
  }
}

function compareParticipants(left: ActivityParticipant, right: ActivityParticipant): number {
  const leftStatus = left.status ? STATUS_ORDER.indexOf(left.status) : STATUS_ORDER.length
  const rightStatus = right.status ? STATUS_ORDER.indexOf(right.status) : STATUS_ORDER.length
  if (leftStatus !== rightStatus) {
    return leftStatus - rightStatus
  }

  const timestampDelta = timestampValue(right.lastSeenAt) - timestampValue(left.lastSeenAt)
  if (timestampDelta !== 0) {
    return timestampDelta
  }

  return left.label.localeCompare(right.label)
}

const agentParticipants = computed(() => {
  const actors = new Set<string>()

  for (const entry of props.presence) {
    if (isAgentIdentityValue(entry.actor_label)) {
      actors.add(entry.actor_label)
    }
  }

  for (const actorLabel of agentMessagesByActor.value.keys()) {
    actors.add(actorLabel)
  }

  for (const task of props.tasks) {
    if (isAgentIdentityValue(task.assignee)) actors.add(String(task.assignee))
    if (isAgentIdentityValue(task.created_by)) actors.add(String(task.created_by))
  }

  return Array.from(actors)
    .map((actorLabel) => buildAgentParticipant(actorLabel))
    .sort(compareParticipants)
})

const humanParticipants = computed(() => {
  const humans = new Set<string>()

  for (const sender of humanMessagesBySender.value.keys()) {
    humans.add(sender)
  }

  for (const task of props.tasks) {
    const assignee = String(task.assignee || '').trim()
    const creator = String(task.created_by || '').trim()
    if (assignee && !isAgentIdentityValue(assignee)) humans.add(assignee)
    if (creator && !isAgentIdentityValue(creator)) humans.add(creator)
  }

  return Array.from(humans)
    .map((sender) => buildHumanParticipant(sender))
    .sort(compareParticipants)
})

const onlineAgents = computed(() =>
  agentParticipants.value.filter((participant) => participant.connection === 'online')
)

const disconnectedAgents = computed(() =>
  agentParticipants.value.filter((participant) => participant.connection !== 'online')
)

const humans = computed(() => humanParticipants.value)

const participants = computed(() => [
  ...onlineAgents.value,
  ...disconnectedAgents.value,
  ...humans.value,
])

const selectedParticipant = computed(() =>
  participants.value.find((participant) => participant.key === selectedParticipantKey.value)
  || participants.value[0]
  || null
)

watch(participants, (next) => {
  if (!next.length) {
    selectedParticipantKey.value = null
    return
  }

  if (!selectedParticipantKey.value || !next.some((participant) => participant.key === selectedParticipantKey.value)) {
    selectedParticipantKey.value = next[0].key
  }
}, { immediate: true })

function participantMeta(participant: ActivityParticipant): string {
  if (participant.kind === 'human') {
    return 'Human participant'
  }

  const bits = [participant.ownerLabel, participant.ideLabel].filter(Boolean)
  return bits.join(' · ') || 'Agent'
}

function participantNote(participant: ActivityParticipant): string {
  if (participant.statusText) {
    return participant.statusText
  }

  if (participant.kind === 'agent') {
    return participant.connection === 'online'
      ? 'No live status text'
      : 'Disconnected from the room'
  }

  return participant.messageCount > 0
    ? 'Seen via browser room activity'
    : 'Known from task history'
}

function connectionLabel(participant: ActivityParticipant | null): string {
  if (!participant || participant.kind !== 'agent') return 'Human'
  return participant.connection === 'online' ? 'Online' : 'Disconnected'
}

function getTaskLink(task: RoomTask): { label: string; url: string } | null {
  const gh = props.taskGithubStatus[task.id]
  if (gh?.pr_url) {
    return {
      label: gh.pr_number ? `PR #${gh.pr_number}` : 'Pull request',
      url: gh.pr_url,
    }
  }

  const firstWorkflowRef = task.workflow_refs[0]
  if (firstWorkflowRef) {
    return {
      label: firstWorkflowRef.label,
      url: firstWorkflowRef.url,
    }
  }

  return null
}

function formatLastSeen(value: string | null): string {
  if (!value) return 'unknown'
  const diffMs = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'unknown'
  }

  const diffMinutes = Math.round(diffMs / 60_000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}
</script>

<style scoped>
.activity-panel {
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 24px;
}

.activity-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.summary-card {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--line, #27272a);
  background:
    radial-gradient(circle at top right, rgba(56, 189, 248, 0.12), transparent 45%),
    var(--surface, #18181b);
}

.summary-card strong {
  font-size: 1.2rem;
  color: var(--text, #fafafa);
}

.summary-card span {
  font-size: 0.76rem;
  color: var(--muted, #71717a);
}

.activity-empty {
  display: grid;
  place-items: center;
  min-height: 220px;
  text-align: center;
  color: var(--muted, #71717a);
}

.activity-empty h3 {
  margin-bottom: 6px;
  color: var(--text, #fafafa);
  font-size: 0.95rem;
}

.activity-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
  gap: 18px;
  align-items: start;
}

.activity-groups {
  display: grid;
  gap: 16px;
}

.activity-group,
.activity-detail {
  display: grid;
  gap: 14px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid var(--line, #27272a);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 40%),
    var(--surface, #18181b);
}

.activity-group-header,
.activity-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-group-header h3,
.activity-detail-header h3 {
  margin: 0;
  font-size: 0.96rem;
  color: var(--text, #fafafa);
}

.activity-group-header p,
.activity-detail-header p {
  margin: 4px 0 0;
  font-size: 0.78rem;
  color: var(--muted, #71717a);
  line-height: 1.45;
}

.activity-group-count,
.activity-kind-pill,
.activity-connection-pill,
.activity-status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 54px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.activity-group-count,
.activity-kind-pill {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text, #fafafa);
}

.activity-connection-pill[data-connection='online'] {
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
}

.activity-connection-pill[data-connection='disconnected'] {
  background: rgba(244, 63, 94, 0.12);
  color: #fb7185;
}

.activity-status-pill[data-status='idle'] { background: rgba(163, 163, 163, 0.16); color: #d4d4d8; }
.activity-status-pill[data-status='working'] { background: rgba(56, 189, 248, 0.16); color: #7dd3fc; }
.activity-status-pill[data-status='reviewing'] { background: rgba(245, 158, 11, 0.16); color: #fbbf24; }
.activity-status-pill[data-status='blocked'] { background: rgba(239, 68, 68, 0.16); color: #f87171; }

.activity-roster {
  display: grid;
  gap: 10px;
}

.activity-roster-item {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, transform 150ms ease, background 150ms ease;
}

.activity-roster-item:hover,
.activity-roster-item[data-selected='true'] {
  border-color: rgba(56, 189, 248, 0.35);
  background: rgba(56, 189, 248, 0.08);
  transform: translateY(-1px);
}

.activity-roster-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-roster-name {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text, #fafafa);
}

.activity-roster-meta {
  margin-top: 3px;
  font-size: 0.74rem;
  color: var(--muted, #71717a);
}

.activity-roster-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
}

.activity-roster-status span:first-of-type:not(.activity-status-dot) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-roster-seen {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--muted, #71717a);
}

.activity-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #71717a;
  flex-shrink: 0;
}

.activity-status-dot[data-status='idle'] { background: #a3a3a3; }
.activity-status-dot[data-status='working'] { background: #38bdf8; }
.activity-status-dot[data-status='reviewing'] { background: #f59e0b; }
.activity-status-dot[data-status='blocked'] { background: #ef4444; }

.activity-group-empty,
.activity-detail-empty {
  padding: 14px;
  border-radius: 12px;
  border: 1px dashed rgba(255, 255, 255, 0.08);
  color: var(--muted, #71717a);
  font-size: 0.8rem;
}

.activity-detail-kicker {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #7dd3fc;
}

.activity-detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.activity-detail-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
}

.detail-stat {
  display: grid;
  gap: 4px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.detail-stat strong {
  font-size: 0.96rem;
  color: var(--text, #fafafa);
}

.detail-stat span {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
}

.activity-detail-description {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--muted, #a1a1aa);
}

.activity-detail-section {
  display: grid;
  gap: 10px;
}

.activity-detail-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.activity-detail-section-header h4 {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted, #71717a);
}

.activity-detail-section-header span {
  font-size: 0.74rem;
  color: var(--muted, #71717a);
}

.activity-task-list,
.activity-message-list {
  display: grid;
  gap: 8px;
}

.activity-task-card,
.activity-message-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
}

.activity-task-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.activity-task-copy strong {
  font-size: 0.82rem;
  color: var(--text, #fafafa);
}

.activity-task-copy span {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
}

.activity-task-link {
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 600;
  color: #7dd3fc;
  text-decoration: none;
}

.activity-task-link:hover {
  text-decoration: underline;
}

.activity-message-card {
  display: grid;
  gap: 6px;
}

.activity-message-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 0.72rem;
  color: var(--muted, #71717a);
}

.activity-message-card p {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text, #fafafa);
}

@media (max-width: 960px) {
  .activity-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .activity-panel {
    padding: 14px 14px 20px;
  }

  .activity-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .activity-roster-header,
  .activity-group-header,
  .activity-detail-header,
  .activity-detail-section-header,
  .activity-message-meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .activity-roster-seen {
    margin-left: 0;
  }
}
</style>
