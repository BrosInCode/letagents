<template>
  <div class="board-panel">
    <div v-if="presence.length > 0" class="presence-panel">
      <div class="presence-panel-header">
        <h3>Agent Presence</h3>
        <span>{{ presence.length }} tracked</span>
      </div>
      <div class="presence-grid">
        <article
          v-for="agent in presence"
          :key="`${agent.room_id}:${agent.actor_label}`"
          class="presence-card"
          :data-status="agent.status"
          :data-freshness="agent.freshness"
        >
          <div class="presence-card-header">
            <div>
              <div class="presence-name">{{ agent.display_name }}</div>
              <div class="presence-meta-line">
                {{ agent.owner_label || agent.ide_label || 'Agent' }}
              </div>
            </div>
            <span class="presence-freshness-badge" :data-freshness="agent.freshness">
              {{ agent.freshness }}
            </span>
          </div>
          <div class="presence-status-row">
            <span class="presence-status-dot" :data-status="agent.status" />
            <span class="presence-status-text">{{ PRESENCE_STATUS_LABELS[agent.status] || agent.status }}</span>
            <span class="presence-heartbeat">{{ formatHeartbeat(agent.last_heartbeat_at) }}</span>
          </div>
          <p v-if="agent.status_text" class="presence-description">{{ agent.status_text }}</p>
        </article>
      </div>
    </div>

    <div class="add-task-form">
      <input
        class="input"
        type="text"
        placeholder="New task title..."
        v-model="newTaskTitle"
        @keydown.enter="handleAdd"
      />
      <button class="btn btn-primary" type="button" @click="handleAdd">Add</button>
    </div>

    <div v-if="groupedTasks.length === 0" class="board-empty">
      <div>
        <h3>No tasks yet</h3>
        <p>Add a task or use the <code>add_task</code> MCP tool.</p>
      </div>
    </div>

    <div v-for="group in groupedTasks" :key="group.status" class="board-group">
      <h3
        class="board-group-title"
        @click="toggleGroup(group.status)"
      >
        <span class="board-group-chevron" :class="{ collapsed: collapsedGroups.has(group.status) }">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
        {{ group.label }}
        <span class="board-group-count">{{ group.tasks.length }}</span>
      </h3>
      <template v-if="!collapsedGroups.has(group.status)">
        <div v-for="task in group.tasks" :key="task.id" class="task-card">
          <div class="task-card-header">
            <h4 class="task-card-title">{{ task.title }}</h4>
            <span class="task-status-badge" :data-status="task.status">
              {{ STATUS_LABELS[task.status] || task.status }}
            </span>
          </div>
          <div class="task-meta">
            <!-- Assignee chip -->
            <TaskPersonChip v-if="task.assignee" :sender="task.assignee" role="Assignee" />
            <!-- Created by chip -->
            <TaskPersonChip v-if="task.created_by" :sender="task.created_by" role="Created by" />
            <!-- Date -->
            <span>{{ formatTimestamp(task.created_at) }}</span>
          </div>
          <p v-if="task.description" class="task-description">{{ task.description }}</p>
          <div
            v-for="workflowRef in getTaskWorkflowRefs(task)"
            :key="workflowRef.url"
            class="task-pr-link"
          >
            <a :href="workflowRef.url" target="_blank">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              View {{ workflowRef.label }}
            </a>
          </div>
          <!-- GitHub Artifact Status -->
          <div v-if="getGithubStatus(task.id)" class="gh-status-section">
            <div class="gh-status-header">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" class="gh-status-icon">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span class="gh-status-label">GitHub Status</span>
            </div>
            <div v-if="getGithubStatus(task.id)!.pr_state" class="gh-pr-state">
              <span class="gh-pr-badge" :data-state="getGithubStatus(task.id)!.pr_state">
                {{ prStateLabel(getGithubStatus(task.id)!.pr_state!) }}
              </span>
              <span v-if="getGithubStatus(task.id)!.pr_number" class="gh-pr-number">
                PR #{{ getGithubStatus(task.id)!.pr_number }}
              </span>
            </div>
            <div v-if="getGithubStatus(task.id)!.checks.length > 0" class="gh-checks-row">
              <span class="gh-checks-summary">
                <span v-if="getGithubStatus(task.id)!.check_summary.success > 0" class="gh-check-count success">
                  ✓ {{ getGithubStatus(task.id)!.check_summary.success }}
                </span>
                <span v-if="getGithubStatus(task.id)!.check_summary.failure > 0" class="gh-check-count failure">
                  ✗ {{ getGithubStatus(task.id)!.check_summary.failure }}
                </span>
                <span v-if="getGithubStatus(task.id)!.check_summary.pending > 0" class="gh-check-count pending">
                  ◷ {{ getGithubStatus(task.id)!.check_summary.pending }}
                </span>
                <span class="gh-checks-label">checks</span>
              </span>
            </div>
            <div v-if="getGithubStatus(task.id)!.reviews.length > 0" class="gh-reviews-row">
              <span v-for="(review, idx) in getGithubStatus(task.id)!.reviews" :key="idx" class="gh-review-chip" :data-state="review.state?.toLowerCase()">
                {{ review.actor || 'reviewer' }}: {{ reviewStateLabel(review.state) }}
              </span>
            </div>
          </div>
          <div v-if="getTaskActions(task).length" class="task-actions">
            <button
              v-for="action in getTaskActions(task)"
              :key="action.status"
              :class="['task-action-btn', action.cls]"
              :disabled="updatingTask === task.id"
              @click="handleUpdateStatus(task.id, action.status)"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { type RoomAgentPresence, type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import TaskPersonChip from './TaskPersonChip.vue'

const props = defineProps<{
  tasks: readonly RoomTask[]
  presence: readonly RoomAgentPresence[]
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

const emit = defineEmits<{
  addTask: [title: string]
  updateTask: [taskId: string, updates: { status: string }]
}>()

const newTaskTitle = ref('')
const updatingTask = ref<string | null>(null)
const collapsedGroups = ref(new Set<string>())

function toggleGroup(status: string) {
  const s = collapsedGroups.value
  if (s.has(status)) {
    s.delete(status)
  } else {
    s.add(status)
  }
  // Trigger reactivity
  collapsedGroups.value = new Set(s)
}

function handleAdd() {
  const title = newTaskTitle.value.trim()
  if (!title) return
  emit('addTask', title)
  newTaskTitle.value = ''
}

async function handleUpdateStatus(taskId: string, status: string) {
  updatingTask.value = taskId
  emit('updateTask', taskId, { status })
  // Reset after a brief delay (parent will refresh)
  setTimeout(() => { updatingTask.value = null }, 1000)
}

const STATUS_ORDER = ['proposed', 'accepted', 'assigned', 'in_progress', 'blocked', 'in_review', 'merged', 'done', 'cancelled']
const STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  in_review: 'In Review',
  merged: 'Merged',
  done: 'Done',
  cancelled: 'Cancelled',
}

const PRESENCE_STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  working: 'Working',
  reviewing: 'Reviewing',
  blocked: 'Blocked',
}

interface TaskAction {
  label: string
  cls: string
  status: string
}

function getTaskActions(task: RoomTask): TaskAction[] {
  const actions: TaskAction[] = []
  switch (task.status) {
    case 'proposed':
      actions.push({ label: 'Accept', cls: 'accept', status: 'accepted' })
      actions.push({ label: 'Cancel', cls: 'cancel', status: 'cancelled' })
      break
    case 'in_review':
      actions.push({ label: 'Mark Merged', cls: 'merge', status: 'merged' })
      actions.push({ label: 'Needs Work', cls: 'cancel', status: 'in_progress' })
      break
    case 'merged':
      actions.push({ label: 'Mark Done', cls: 'merge', status: 'done' })
      break
    case 'accepted':
      actions.push({ label: 'Cancel', cls: 'cancel', status: 'cancelled' })
      break
  }
  return actions
}

function formatTimestamp(timestamp: string): string {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatHeartbeat(timestamp: string): string {
  if (!timestamp) return 'unknown'
  const d = new Date(timestamp)
  const diff = Date.now() - d.getTime()
  const secs = Math.max(0, Math.floor(diff / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getTaskWorkflowRefs(task: RoomTask) {
  return task.workflow_refs?.length
    ? task.workflow_refs
    : task.pr_url
      ? [{ provider: 'unknown', kind: 'pull_request', label: 'PR', url: task.pr_url }]
      : []
}

function getGithubStatus(taskId: string): TaskGitHubArtifactStatus | null {
  return props.taskGithubStatus[taskId] ?? null
}

function prStateLabel(state: string): string {
  switch (state.toLowerCase()) {
    case 'open': return '⬤ Open'
    case 'closed': return '⬤ Closed'
    case 'merged': return '⬤ Merged'
    default: return state
  }
}

function reviewStateLabel(state: string | null): string {
  if (!state) return 'Pending'
  switch (state.toLowerCase()) {
    case 'approved': return 'Approved'
    case 'changes_requested': return 'Changes Requested'
    case 'commented': return 'Commented'
    case 'dismissed': return 'Dismissed'
    default: return state
  }
}

const groupedTasks = computed(() => {
  const groups = new Map<string, RoomTask[]>()
  for (const task of props.tasks) {
    const status = task.status || 'proposed'
    if (!groups.has(status)) groups.set(status, [])
    groups.get(status)!.push(task as RoomTask)
  }
  return STATUS_ORDER
    .filter(s => groups.has(s))
    .map(s => ({
      status: s,
      label: STATUS_LABELS[s] || s,
      tasks: groups.get(s)!,
    }))
})
</script>

<style scoped>
.board-panel { height: 100%; overflow-y: auto; padding: 16px 20px; }

.presence-panel {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--line, #27272a);
  background:
    linear-gradient(180deg, rgba(24, 24, 27, 0.96), rgba(15, 15, 17, 0.96));
  margin-bottom: 12px;
}

.presence-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.presence-panel-header h3 {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.presence-panel-header span {
  color: var(--muted, #71717a);
  font-size: 0.72rem;
}

.presence-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}

.presence-card {
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--line, #27272a);
  background: rgba(9, 9, 11, 0.72);
}

.presence-card[data-freshness="stale"] {
  opacity: 0.78;
}

.presence-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.presence-name {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text, #fafafa);
}

.presence-meta-line {
  color: var(--muted, #71717a);
  font-size: 0.68rem;
}

.presence-freshness-badge {
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.presence-freshness-badge[data-freshness="active"] {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
}

.presence-freshness-badge[data-freshness="stale"] {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.presence-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
  margin-bottom: 6px;
}

.presence-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #71717a;
}

.presence-status-dot[data-status="idle"] { background: #60a5fa; }
.presence-status-dot[data-status="working"] { background: #fbbf24; }
.presence-status-dot[data-status="reviewing"] { background: #38bdf8; }
.presence-status-dot[data-status="blocked"] { background: #f87171; }

.presence-status-text {
  font-weight: 600;
  color: var(--text, #fafafa);
}

.presence-heartbeat {
  margin-left: auto;
  color: var(--muted, #71717a);
  white-space: nowrap;
}

.presence-description {
  margin: 0;
  color: var(--muted, #a1a1aa);
  font-size: 0.75rem;
  line-height: 1.45;
}

.add-task-form {
  display: flex; gap: 6px;
  padding: 10px; border-radius: 8px;
  border: 1px dashed var(--line-strong, #3f3f46); margin-bottom: 12px;
}
.add-task-form .input {
  flex: 1; padding: 10px 12px; border-radius: 8px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
  font-size: 0.85rem; outline: none; color: var(--text, #fafafa);
  font-family: inherit;
}
.add-task-form .input::placeholder { color: var(--muted, #71717a); }
.btn {
  padding: 10px 14px; border-radius: 8px;
  font-weight: 600; font-size: 0.82rem;
  transition: background 150ms;
  border: none; cursor: pointer;
  font-family: inherit;
}
.btn-primary { background: var(--text, #fafafa); color: var(--bg-0, #09090b); }
.btn-primary:hover { opacity: 0.9; }

.board-group { margin-bottom: 16px; }
.board-group-title {
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted, #71717a); margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
  cursor: pointer; user-select: none;
  transition: color 150ms;
}
.board-group-title:hover { color: var(--text, #fafafa); }
.board-group-chevron {
  display: flex; align-items: center; justify-content: center;
  transition: transform 200ms ease;
}
.board-group-chevron.collapsed { transform: rotate(-90deg); }
.board-group-count {
  padding: 1px 6px; border-radius: 4px;
  background: var(--surface, #18181b); font-size: 0.66rem;
}

.task-card {
  padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--line, #27272a); background: var(--bg-1, #0f0f11);
  margin-bottom: 6px; transition: border-color 150ms;
}
.task-card:hover { border-color: var(--line-strong, #3f3f46); }
.task-card-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 8px; margin-bottom: 4px;
}
.task-card-title { font-size: 0.82rem; font-weight: 600; line-height: 1.4; }

.task-status-badge {
  padding: 2px 6px; border-radius: 4px;
  font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; white-space: nowrap; flex-shrink: 0;
}
.task-status-badge[data-status="proposed"] { background: rgba(113,113,122,0.15); color: #71717a; }
.task-status-badge[data-status="accepted"] { background: rgba(96,165,250,0.12); color: #60a5fa; }
.task-status-badge[data-status="assigned"] { background: rgba(168,85,247,0.12); color: #a855f7; }
.task-status-badge[data-status="in_progress"] { background: rgba(251,191,36,0.12); color: #fbbf24; }
.task-status-badge[data-status="blocked"] { background: rgba(248,113,113,0.12); color: #f87171; }
.task-status-badge[data-status="in_review"] { background: rgba(56,189,248,0.12); color: #38bdf8; }
.task-status-badge[data-status="merged"] { background: rgba(52,211,153,0.12); color: #34d399; }
.task-status-badge[data-status="done"] { background: rgba(34,197,94,0.12); color: #22c55e; }
.task-status-badge[data-status="cancelled"] { background: rgba(100,116,139,0.12); color: #64748b; }

.task-meta {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  color: var(--muted, #71717a); font-size: 0.72rem; margin-bottom: 6px;
}

.task-description {
  margin: 0 0 10px; color: var(--muted, #71717a); font-size: 0.82rem; line-height: 1.5;
}

.task-pr-link { margin-bottom: 8px; }
.task-pr-link a {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 0.72rem; font-weight: 600; color: #60a5fa;
  text-decoration: none; transition: color 150ms;
}
.task-pr-link a:hover { color: #93c5fd; }

/* — GitHub Artifact Status — */
.gh-status-section {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(96, 165, 250, 0.15);
  background: rgba(96, 165, 250, 0.04);
}

.gh-status-header {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 6px;
  color: var(--muted, #a1a1aa);
}

.gh-status-icon { opacity: 0.6; }

.gh-status-label {
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.gh-pr-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.gh-pr-badge {
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.66rem;
  font-weight: 700;
  white-space: nowrap;
}

.gh-pr-badge[data-state="open"] { color: #22c55e; background: rgba(34, 197, 94, 0.12); }
.gh-pr-badge[data-state="closed"] { color: #ef4444; background: rgba(239, 68, 68, 0.12); }
.gh-pr-badge[data-state="merged"] { color: #a855f7; background: rgba(168, 85, 247, 0.12); }

.gh-pr-number {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--muted, #a1a1aa);
}

.gh-checks-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.gh-checks-summary {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
}

.gh-check-count {
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 0.66rem;
}

.gh-check-count.success { color: #22c55e; background: rgba(34, 197, 94, 0.12); }
.gh-check-count.failure { color: #ef4444; background: rgba(239, 68, 68, 0.12); }
.gh-check-count.pending { color: #f59e0b; background: rgba(245, 158, 11, 0.12); }

.gh-checks-label {
  color: var(--muted, #71717a);
  font-size: 0.66rem;
}

.gh-reviews-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.gh-review-chip {
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 0.64rem;
  font-weight: 600;
  background: rgba(113, 113, 122, 0.12);
  color: var(--muted, #a1a1aa);
}

.gh-review-chip[data-state="approved"] { color: #22c55e; background: rgba(34, 197, 94, 0.1); }
.gh-review-chip[data-state="changes_requested"] { color: #f87171; background: rgba(248, 113, 113, 0.1); }
.gh-review-chip[data-state="commented"] { color: #60a5fa; background: rgba(96, 165, 250, 0.1); }

.task-actions { display: flex; gap: 4px; }
.task-action-btn {
  padding: 3px 8px; border-radius: 6px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
  font-size: 0.7rem; font-weight: 600; cursor: pointer;
  transition: background 150ms; color: var(--text, #fafafa);
  font-family: inherit;
}
.task-action-btn:hover { background: var(--surface-hover, #27272a); }
.task-action-btn:disabled { opacity: 0.4; cursor: wait; }
.task-action-btn.accept { color: #60a5fa; }
.task-action-btn.cancel { color: #f87171; }
.task-action-btn.merge { color: #34d399; }

.board-empty {
  display: grid; place-items: center; text-align: center;
  padding: 40px 20px; color: var(--muted, #71717a);
}
.board-empty h3 { color: var(--text, #fafafa); margin-bottom: 4px; font-size: 0.88rem; }
.board-empty p { font-size: 0.82rem; line-height: 1.5; }
.board-empty code {
  background: var(--surface, #18181b); padding: 1px 5px; border-radius: 4px; font-size: 0.78rem;
}
</style>
