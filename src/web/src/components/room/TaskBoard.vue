<template>
  <div class="board-panel">
    <div class="add-task-form">
      <input
        class="input"
        type="text"
        placeholder="New task title..."
        v-model="newTaskTitle"
        @keydown.enter="handleAdd"
      />
      <AppButton
        class="add-task-button"
        variant="secondary"
        size="sm"
        type="button"
        @click="handleAdd"
      >
        Add
      </AppButton>
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
            <div class="task-heading">
              <span
                class="task-id-badge"
                :title="`Task ${formatTaskShortId(task.id)}`"
                :aria-label="`Task ${formatTaskShortId(task.id)}`"
              >
                {{ formatTaskShortId(task.id) }}
              </span>
              <h4 class="task-card-title">{{ task.title }}</h4>
            </div>
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

          <TaskLeaseAuthority
            v-if="shouldShowAuthority(task)"
            :task="task"
            :presence="presence"
            :canManageLeases="canManageLeases"
            :updating="updatingLeaseTask === task.id"
            @leaseAction="handleLeaseAction"
          />

          <!-- Leases and Locks Coordination Data -->
          <div v-if="getSecondaryLeases(task).length || task.active_locks?.length" class="task-coordination">
            <div v-for="lease in getSecondaryLeases(task)" :key="lease.id" class="coordination-badge lease">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              <span>{{ lease.kind }} lease: {{ formatActorName(lease.actor_label) }}</span>
            </div>
            <div v-for="lock in task.active_locks" :key="lock.id" class="coordination-badge lock">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              <span>{{ lock.scope }} lock: {{ lock.reason }}{{ lock.message ? ' - ' + lock.message : '' }}</span>
            </div>
          </div>
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
          <div v-if="canFocusTask(task)" class="task-focus-row">
            <button
              class="task-focus-btn"
              type="button"
              @click="emit('focusTask', task.id)"
            >
              Focus on this
            </button>
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
import AppButton from '@/components/ui/AppButton.vue'
import TaskLeaseAuthority from './TaskLeaseAuthority.vue'
import TaskPersonChip from './TaskPersonChip.vue'

const props = defineProps<{
  tasks: readonly RoomTask[]
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
}>()

const emit = defineEmits<{
  addTask: [title: string]
  updateTask: [taskId: string, updates: { status: string }]
  leaseAction: [payload: {
    taskId: string
    action: 'release' | 'handoff'
    lease_id?: string | null
    target_actor_key?: string | null
    target_actor_instance_id?: string | null
    target_agent_session_id?: string | null
    reason?: string | null
    onSettled?: () => void
  }]
  focusTask: [taskId: string]
}>()

const newTaskTitle = ref('')
const updatingTask = ref<string | null>(null)
const updatingLeaseTask = ref<string | null>(null)
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

interface TaskAction {
  label: string
  cls: string
  status: string
}

type TaskLease = NonNullable<RoomTask['active_leases']>[number]

const LEASE_AUTHORITY_STATUSES = new Set(['assigned', 'in_progress', 'blocked', 'in_review'])

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

function canFocusTask(task: RoomTask): boolean {
  return !['done', 'cancelled'].includes(task.status)
}

function formatActorName(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const parts = normalized.split('|').map(part => part.trim()).filter(Boolean)
  return parts[0] || normalized
}

function getWorkLease(task: RoomTask): TaskLease | null {
  return task.active_leases?.find(lease => lease.kind === 'work') ?? null
}

function getSecondaryLeases(task: RoomTask): TaskLease[] {
  return (task.active_leases ?? []).filter(lease => lease.kind !== 'work')
}

function shouldShowAuthority(task: RoomTask): boolean {
  return Boolean(getWorkLease(task) || task.assignee || LEASE_AUTHORITY_STATUSES.has(task.status))
}

function settleLeaseBusy(taskId: string) {
  if (updatingLeaseTask.value === taskId) {
    updatingLeaseTask.value = null
  }
}

function handleLeaseAction(payload: {
  taskId: string
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}) {
  updatingLeaseTask.value = payload.taskId
  emit('leaseAction', {
    ...payload,
    onSettled: () => {
      settleLeaseBusy(payload.taskId)
      payload.onSettled?.()
    },
  })
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

function formatTaskShortId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim())
  if (match) return `T${match[1]}`
  return taskId.replace(/^task_/i, 'T')
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
.board-panel { height: 100%; overflow-y: auto; padding: var(--space-xl) var(--space-lg); }

.add-task-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  margin-bottom: var(--space-lg);
}
.add-task-form .input {
  flex: 1; min-width: 0; padding: 10px 12px; border-radius: 9px;
  background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 0.85rem; outline: none; color: var(--text-primary, #ffffff);
  font-family: inherit; transition: border-color 150ms;
}
.add-task-form .input:focus { border-color: rgba(255, 255, 255, 0.2); }
.add-task-form .input::placeholder { color: var(--text-tertiary, #a1a1aa); }
.add-task-button {
  min-height: 40px;
  --btn-secondary-bg: rgba(255, 255, 255, 0.07);
  --btn-secondary-hover-bg: rgba(255, 255, 255, 0.12);
  --btn-secondary-border: rgba(255, 255, 255, 0.1);
  --btn-secondary-color: var(--text-secondary, #d4d4d8);
}

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
  padding: var(--space-md) var(--space-lg); border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06); background: var(--bg-card, #131316);
  margin-bottom: 6px; transition: border-color 150ms;
}
.task-card:hover { border-color: rgba(255, 255, 255, 0.12); }
.task-card-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 8px; margin-bottom: 4px;
}
.task-heading {
  display: flex; flex-wrap: wrap; align-items: flex-start;
  gap: 6px 8px; min-width: 0; flex: 1;
}
.task-id-badge {
  flex-shrink: 0; padding: 1px 6px; border-radius: 4px;
  border: 1px solid rgba(147, 197, 253, 0.42);
  color: #93c5fd; background: rgba(147, 197, 253, 0.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.68rem; font-weight: 700; line-height: 1.45;
}
.task-card-title {
  margin: 0; min-width: min(100%, 12rem); flex: 1;
  font-size: 0.82rem; font-weight: 600; line-height: 1.4;
  color: var(--text-primary, #ffffff); overflow-wrap: anywhere;
}

.task-status-badge {
  padding: 1px 6px; border-radius: 4px;
  font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; white-space: nowrap; flex-shrink: 0;
  border: 1px solid currentColor; background: transparent;
}
.task-status-badge[data-status="proposed"] { color: #71717a; border-color: rgba(113, 113, 122, 0.4); }
.task-status-badge[data-status="accepted"] { color: #60a5fa; border-color: rgba(96, 165, 250, 0.4); }
.task-status-badge[data-status="assigned"] { color: #a855f7; border-color: rgba(168, 85, 247, 0.4); }
.task-status-badge[data-status="in_progress"] { color: #fbbf24; border-color: rgba(251, 191, 36, 0.4); }
.task-status-badge[data-status="blocked"] { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
.task-status-badge[data-status="in_review"] { color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); }
.task-status-badge[data-status="merged"] { color: #34d399; border-color: rgba(52, 211, 153, 0.4); }
.task-status-badge[data-status="done"] { color: #22c55e; border-color: rgba(34, 197, 94, 0.4); }
.task-status-badge[data-status="cancelled"] { color: #64748b; border-color: rgba(100, 116, 139, 0.4); }

.task-meta {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  color: var(--text-tertiary, #a1a1aa); font-size: 0.72rem; margin-bottom: 6px;
}

.task-description {
  margin: 0 0 10px; color: var(--text-secondary, #d4d4d8); font-size: 0.82rem; line-height: 1.5;
}

.task-coordination {
  display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;
}
.coordination-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 6px;
  font-size: 0.68rem; font-weight: 600;
  border: 1px solid var(--line, #27272a);
}
.coordination-badge.lease {
  background: rgba(168, 85, 247, 0.08);
  border-color: rgba(168, 85, 247, 0.2);
  color: #c084fc;
}
.coordination-badge.lock {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.task-pr-link { margin-bottom: 8px; }
.task-pr-link a {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 0.72rem; font-weight: 600; color: var(--text-secondary, #d4d4d8);
  text-decoration: none; transition: color 150ms;
}
.task-pr-link a:hover { color: var(--text-primary, #ffffff); }

.task-focus-row { margin-bottom: 8px; }
.task-focus-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.7rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 150ms, border-color 150ms, color 150ms;
  font-family: inherit;
}
.task-focus-btn:hover {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary, #d4d4d8);
}

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

.task-actions { display: flex; gap: 4px; margin-top: 8px; }
.task-action-btn {
  padding: 3px 8px; border-radius: 6px;
  background: transparent; border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 0.7rem; font-weight: 600; cursor: pointer;
  transition: background 150ms, color 150ms, border-color 150ms;
  color: var(--text-tertiary, #a1a1aa);
  font-family: inherit;
}
.task-action-btn:hover { background: rgba(255, 255, 255, 0.05); color: var(--text-secondary, #d4d4d8); border-color: rgba(255, 255, 255, 0.2); }
.task-action-btn:disabled { opacity: 0.4; cursor: wait; }
.task-action-btn.accept { color: #60a5fa; border-color: rgba(96, 165, 250, 0.3); }
.task-action-btn.cancel { color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
.task-action-btn.merge { color: #34d399; border-color: rgba(52, 211, 153, 0.3); }

.board-empty {
  display: grid; place-items: center; text-align: center;
  padding: 40px 20px; color: var(--muted, #71717a);
}
.board-empty h3 { color: var(--text, #fafafa); margin-bottom: 4px; font-size: 0.88rem; }
.board-empty p { font-size: 0.82rem; line-height: 1.5; }
.board-empty code {
  background: var(--surface, #18181b); padding: 1px 5px; border-radius: 4px; font-size: 0.78rem;
}

@media (max-width: 768px) {
  .board-panel { padding: 12px 12px; }
  .add-task-form { flex-direction: column; gap: 8px; padding: 8px; }
  .add-task-button { width: 100%; }
  .add-task-form .input { font-size: 0.82rem; padding: 10px; }
  .task-card { padding: 10px; }
  .task-card-header { flex-direction: column; gap: 4px; }
  .task-heading { width: 100%; }
  .task-card-title { font-size: 0.8rem; }
  .task-meta { font-size: 0.68rem; gap: 6px; }
  .task-description { font-size: 0.78rem; }
  .task-actions { flex-wrap: wrap; }
  .task-action-btn { flex: 1; text-align: center; min-width: 60px; }
  .gh-status-section { padding: 6px 8px; }
  .gh-pr-state { flex-wrap: wrap; }
}
</style>
