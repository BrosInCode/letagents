<template>
  <div class="activity-panel">
    <div class="activity-summary">
      <article class="summary-card">
        <strong>{{ activeAgents.length }}</strong>
        <span>Active</span>
      </article>
      <article class="summary-card">
        <strong>{{ countByStatus('idle') }}</strong>
        <span>Idle</span>
      </article>
      <article class="summary-card">
        <strong>{{ countByStatus('working') }}</strong>
        <span>Working</span>
      </article>
      <article class="summary-card">
        <strong>{{ countByStatus('reviewing') }}</strong>
        <span>Reviewing</span>
      </article>
      <article class="summary-card">
        <strong>{{ countByStatus('blocked') }}</strong>
        <span>Blocked</span>
      </article>
    </div>

    <div v-if="sortedPresence.length === 0" class="activity-empty">
      <h3>No agent activity yet</h3>
      <p>Presence updates will appear here once agents post status or heartbeat the room.</p>
    </div>

    <div v-else class="activity-grid">
      <article
        v-for="agent in sortedPresence"
        :key="`${agent.room_id}:${agent.actor_label}`"
        class="activity-card"
        :data-status="agent.status"
        :data-freshness="agent.freshness"
      >
        <div class="activity-card-header">
          <div class="activity-identity">
            <div class="activity-name">{{ agent.display_name }}</div>
            <div class="activity-meta">
              {{ agent.owner_label || agent.ide_label || 'Agent' }}
            </div>
          </div>
          <span class="activity-freshness" :data-freshness="agent.freshness">
            {{ agent.freshness }}
          </span>
        </div>

        <div class="activity-status-row">
          <span class="activity-status-dot" :data-status="agent.status" />
          <span class="activity-status-text">{{ STATUS_LABELS[agent.status] }}</span>
          <span class="activity-heartbeat">{{ formatHeartbeat(agent.last_heartbeat_at) }}</span>
        </div>

        <p v-if="agent.status_text" class="activity-description">
          {{ agent.status_text }}
        </p>

        <div v-if="getAgentTasks(agent).length > 0" class="activity-task-list">
          <div class="activity-task-list-header">Current tasks</div>
          <article
            v-for="task in getAgentTasks(agent)"
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
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  parseAgentIdentity,
  type RoomAgentPresence,
  type RoomTask,
  type TaskGitHubArtifactStatus,
} from '@/composables/useRoom'

const props = defineProps<{
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

const sortedPresence = computed(() =>
  [...props.presence].sort((left, right) => {
    if (left.freshness !== right.freshness) {
      return left.freshness === 'active' ? -1 : 1
    }

    const statusDelta = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status)
    if (statusDelta !== 0) {
      return statusDelta
    }

    return left.display_name.localeCompare(right.display_name)
  })
)

const activeAgents = computed(() =>
  props.presence.filter((entry) => entry.freshness === 'active')
)

function countByStatus(status: RoomAgentPresence['status']): number {
  return props.presence.filter((entry) => entry.status === status && entry.freshness === 'active').length
}

function getAgentTasks(agent: RoomAgentPresence): RoomTask[] {
  return props.tasks
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .filter((task) => {
      if (!task.assignee) return false
      if (task.assignee === agent.actor_label) return true
      return parseAgentIdentity(task.assignee).displayName === agent.display_name
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
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

function formatHeartbeat(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'heartbeat unknown'
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
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
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

.activity-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.activity-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid var(--line, #27272a);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 40%),
    var(--surface, #18181b);
}

.activity-card[data-freshness='stale'] {
  opacity: 0.7;
}

.activity-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-name {
  font-size: 0.96rem;
  font-weight: 700;
  color: var(--text, #fafafa);
}

.activity-meta {
  font-size: 0.76rem;
  color: var(--muted, #71717a);
}

.activity-freshness {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 54px;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(250, 204, 21, 0.12);
  color: #facc15;
}

.activity-freshness[data-freshness='active'] {
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
}

.activity-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--muted, #71717a);
}

.activity-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #71717a;
}

.activity-status-dot[data-status='idle'] { background: #a3a3a3; }
.activity-status-dot[data-status='working'] { background: #38bdf8; }
.activity-status-dot[data-status='reviewing'] { background: #f59e0b; }
.activity-status-dot[data-status='blocked'] { background: #ef4444; }

.activity-status-text {
  color: var(--text, #fafafa);
  font-weight: 600;
}

.activity-heartbeat {
  margin-left: auto;
}

.activity-description {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--muted, #a1a1aa);
}

.activity-task-list {
  display: grid;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.activity-task-list-header {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted, #71717a);
}

.activity-task-card {
  display: flex;
  align-items: center;
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

@media (max-width: 640px) {
  .activity-panel {
    padding: 14px 14px 20px;
  }

  .activity-grid {
    grid-template-columns: 1fr;
  }
}
</style>
