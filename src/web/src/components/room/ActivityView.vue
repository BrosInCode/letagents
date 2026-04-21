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

        <section
          v-if="selectedParticipant.kind === 'agent' && selectedParticipant.thinkingSnapshot"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Reasoning snapshot</h4>
            <span>Live</span>
          </div>

          <AgentThinkingCard
            :card="selectedParticipant.thinkingSnapshot"
            kicker="Latest visible reasoning"
            :timestampLabel="formatLastSeen(selectedParticipant.lastSeenAt)"
          />
        </section>

        <p
          v-else-if="selectedParticipant.statusText"
          class="activity-detail-description"
        >
          {{ selectedParticipant.statusText }}
        </p>

        <section
          v-if="selectedParticipant.kind === 'agent' && selectedParticipant.thinkingTimeline.length > 0"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Reasoning trail</h4>
            <span>{{ selectedParticipant.thinkingTimeline.length }}</span>
          </div>

          <div class="activity-thinking-list">
            <AgentThinkingCard
              v-for="entry in selectedParticipant.thinkingTimeline"
              :key="entry.id"
              :card="entry"
              compact
              :timestampLabel="formatLastSeen(entry.timestamp)"
            />
          </div>
        </section>

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
import AgentThinkingCard from './AgentThinkingCard.vue'
import {
  isHumanSender,
  parseAgentIdentity,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomParticipant,
  type RoomTask,
  type TaskGitHubArtifactStatus,
} from '@/composables/useRoom'
import {
  buildAgentThinkingSnapshot,
  buildAgentThinkingTimeline,
  extractStatusText,
  type AgentThinkingCardData,
  type AgentThinkingTimelineEntry,
} from './agentThinking'

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
  thinkingSnapshot: AgentThinkingCardData | null
  thinkingTimeline: AgentThinkingTimelineEntry[]
}

const props = defineProps<{
  messages: readonly RoomMessage[]
  participants: readonly RoomParticipant[]
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

const presenceByActor = computed(() =>
  new Map(props.presence.map((entry) => [entry.actor_label, entry]))
)

function participantMatchesHuman(participant: RoomParticipant, value: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return false

  const githubLogin = String(participant.github_login || '').trim().toLowerCase()
  const displayName = String(participant.display_name || '').trim().toLowerCase()
  return normalized === githubLogin || normalized === displayName
}

function participantMatchesActor(participant: ActivityParticipant, value: string | null): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized === participant.actorLabel) return true

  if (participant.kind === 'agent' && isAgentIdentityValue(normalized)) {
    return parseAgentIdentity(normalized).displayName === participant.label
  }

  return false
}

function buildAgentParticipant(participant: RoomParticipant): ActivityParticipant {
  const actorLabel = String(participant.actor_label || participant.display_name || '').trim()
  const presenceEntry = actorLabel ? (presenceByActor.value.get(actorLabel) || null) : null
  const messages = actorLabel ? (agentMessagesByActor.value.get(actorLabel) || []) : []
  const latestMessage = messages[messages.length - 1] || null
  const latestStatusMessage = [...messages].reverse().find((message) =>
    /^\[status\]\s*/i.test(String(message.text || ''))
  ) || null
  const parsed = parseAgentIdentity(actorLabel)
  const label = participant.display_name || presenceEntry?.display_name || latestMessage?.agent_identity?.display_name || parsed.displayName || actorLabel
  const ownerLabel = participant.owner_label
    || presenceEntry?.owner_label
    || latestMessage?.agent_identity?.owner_label
    || parsed.ownerAttribution
    || null
  const ideLabel = participant.ide_label || presenceEntry?.ide_label || latestMessage?.agent_identity?.ide_label || parsed.ideLabel || null

  const assignedTasks = props.tasks.filter((task) => participantMatchesActor({
    key: participant.participant_key,
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
    thinkingSnapshot: null,
    thinkingTimeline: [],
  }, task.assignee))
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const createdTasks = sortTasksByUpdated(
    props.tasks.filter((task) => participantMatchesActor({
      key: participant.participant_key,
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
      thinkingSnapshot: null,
      thinkingTimeline: [],
    }, task.created_by))
  ).slice(0, 8)
  const statusText = presenceEntry?.status_text || (latestStatusMessage ? extractStatusText(latestStatusMessage.text || '') : null) || null
  const thinkingSnapshot = buildAgentThinkingSnapshot({
    messages,
    status: presenceEntry?.status || null,
    statusText,
  })
  const thinkingTimeline = buildAgentThinkingTimeline(messages)

  return {
    key: participant.participant_key,
    kind: 'agent',
    label,
    actorLabel,
    ownerLabel,
    ideLabel,
    connection: presenceEntry?.freshness === 'active' ? 'online' : 'disconnected',
    status: presenceEntry?.status || null,
    statusText,
    lastSeenAt: latestTimestamp(
      participant.last_seen_at,
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
    thinkingSnapshot,
    thinkingTimeline,
  }
}

function buildHumanParticipant(participant: RoomParticipant): ActivityParticipant {
  const label = participant.display_name || participant.github_login || 'Unknown human'
  const messages = props.messages.filter((message) =>
    isHumanSender(message.sender, message.source) && participantMatchesHuman(participant, message.sender)
  )
  const assignedTasks = props.tasks.filter((task) => participantMatchesHuman(participant, task.assignee))
  const createdTasks = sortTasksByUpdated(
    props.tasks.filter((task) => participantMatchesHuman(participant, task.created_by))
  ).slice(0, 8)
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const latestMessage = messages[messages.length - 1] || null

  return {
    key: participant.participant_key,
    kind: 'human',
    label,
    actorLabel: participant.github_login || label,
    ownerLabel: null,
    ideLabel: null,
    connection: null,
    status: null,
    statusText: latestMessage ? previewMessage(latestMessage.text) : null,
    lastSeenAt: latestTimestamp(
      participant.last_seen_at,
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
    thinkingSnapshot: null,
    thinkingTimeline: [],
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
  return props.participants
    .filter((participant) => participant.kind === 'agent')
    .map((participant) => buildAgentParticipant(participant))
    .sort(compareParticipants)
})

const humanParticipants = computed(() => {
  return props.participants
    .filter((participant) => participant.kind === 'human')
    .map((participant) => buildHumanParticipant(participant))
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
  --activity-border: var(--border, rgba(255, 255, 255, 0.06));
  --activity-border-strong: var(--border-strong, rgba(255, 255, 255, 0.12));
  --activity-surface: var(--bg-card, #141414);
  --activity-surface-soft: var(--accent-dim, rgba(255, 255, 255, 0.04));
  --activity-surface-hover: var(--accent-hover, rgba(255, 255, 255, 0.08));
  --activity-text-secondary: var(--text-secondary, #a1a1aa);
  --activity-text-tertiary: var(--text-tertiary, #71717a);
  --activity-blue: var(--blue, #3b82f6);
  --activity-blue-dim: var(--blue-dim, rgba(59, 130, 246, 0.1));
  --activity-green: var(--green, #22c55e);
  --activity-green-dim: var(--green-dim, rgba(34, 197, 94, 0.1));
  --activity-amber: var(--amber, #f59e0b);
  --activity-amber-dim: var(--amber-dim, rgba(245, 158, 11, 0.1));
  --activity-red: var(--red, #ef4444);
  --activity-red-dim: var(--red-dim, rgba(239, 68, 68, 0.1));
  height: 100%;
  overflow-y: auto;
  padding: var(--space-lg, 24px);
}

.activity-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-sm, 8px);
  margin-bottom: var(--space-lg, 24px);
}

.summary-card {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
}

.summary-card strong {
  font-size: 1.08rem;
  color: var(--text, #fafafa);
  line-height: 1.2;
}

.summary-card span {
  font-size: 0.76rem;
  color: var(--activity-text-tertiary);
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
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.76fr);
  gap: var(--space-lg, 24px);
  align-items: start;
}

.activity-groups {
  display: grid;
  gap: var(--space-lg, 24px);
}

.activity-group {
  display: grid;
  gap: 10px;
}

.activity-detail {
  display: grid;
  gap: 12px;
  padding: var(--space-md, 16px);
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface);
}

.activity-group-header,
.activity-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-group-header {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--activity-border);
}

.activity-group-header h3,
.activity-detail-header h3 {
  margin: 0;
  font-size: 0.92rem;
  color: var(--text, #fafafa);
}

.activity-group-header p,
.activity-detail-header p {
  margin: 4px 0 0;
  font-size: 0.78rem;
  color: var(--activity-text-tertiary);
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
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0;
}

.activity-group-count,
.activity-kind-pill {
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
  color: var(--activity-text-secondary);
}

.activity-connection-pill[data-connection='online'] {
  background: var(--activity-green-dim);
  color: var(--activity-green);
}

.activity-connection-pill[data-connection='disconnected'] {
  background: var(--activity-red-dim);
  color: var(--activity-red);
}

.activity-status-pill[data-status='idle'] { background: var(--activity-surface-hover); color: var(--activity-text-secondary); }
.activity-status-pill[data-status='working'] { background: var(--activity-blue-dim); color: var(--activity-blue); }
.activity-status-pill[data-status='reviewing'] { background: var(--activity-amber-dim); color: var(--activity-amber); }
.activity-status-pill[data-status='blocked'] { background: var(--activity-red-dim); color: var(--activity-red); }

.activity-roster {
  display: grid;
  gap: var(--space-sm, 8px);
}

.activity-roster-item {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, transform 150ms ease, background 150ms ease;
}

.activity-roster-item:hover,
.activity-roster-item[data-selected='true'] {
  border-color: color-mix(in srgb, var(--activity-blue) 42%, transparent);
  background: var(--activity-blue-dim);
  transform: translateY(-1px);
}

.activity-roster-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-roster-name {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text, #fafafa);
  line-height: 1.35;
}

.activity-roster-meta {
  margin-top: 3px;
  font-size: 0.74rem;
  color: var(--activity-text-tertiary);
}

.activity-roster-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--activity-text-secondary);
}

.activity-roster-status span:first-of-type:not(.activity-status-dot) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-roster-seen {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--activity-text-tertiary);
}

.activity-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #71717a;
  flex-shrink: 0;
}

.activity-status-dot[data-status='idle'] { background: var(--activity-text-tertiary); }
.activity-status-dot[data-status='working'] { background: var(--activity-blue); }
.activity-status-dot[data-status='reviewing'] { background: var(--activity-amber); }
.activity-status-dot[data-status='blocked'] { background: var(--activity-red); }

.activity-group-empty,
.activity-detail-empty {
  padding: 12px;
  border-radius: 8px;
  border: 1px dashed var(--activity-border-strong);
  color: var(--activity-text-tertiary);
  font-size: 0.8rem;
}

.activity-detail-kicker {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--activity-blue);
}

.activity-detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.activity-detail-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: var(--space-sm, 8px);
}

.detail-stat {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-radius: 8px;
  background: var(--activity-surface-soft);
  border: 1px solid var(--activity-border);
}

.detail-stat strong {
  font-size: 0.96rem;
  color: var(--text, #fafafa);
}

.detail-stat span {
  font-size: 0.72rem;
  color: var(--activity-text-tertiary);
}

.activity-detail-description {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--activity-text-secondary);
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
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--activity-text-tertiary);
}

.activity-detail-section-header span {
  font-size: 0.74rem;
  color: var(--activity-text-tertiary);
}

.activity-task-list,
.activity-message-list,
.activity-thinking-list {
  display: grid;
  gap: var(--space-sm, 8px);
}

.activity-task-card,
.activity-message-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
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
  color: var(--activity-text-tertiary);
}

.activity-task-link {
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--activity-blue);
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
  color: var(--activity-text-tertiary);
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
    margin-bottom: var(--space-md, 16px);
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
