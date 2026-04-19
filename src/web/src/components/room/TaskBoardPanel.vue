<template>
  <div class="board-panel">
    <!-- Add task form -->
    <div class="add-task-form">
      <input
        v-model="newTaskTitle"
        class="input"
        placeholder="New task title…"
        @keydown.enter="addTask"
      />
      <button class="btn btn-primary" :disabled="!newTaskTitle.trim()" @click="addTask">Add</button>
    </div>

    <!-- Empty state -->
    <div v-if="tasks.length === 0" class="board-empty">
      <h3>No tasks yet</h3>
      <p>Add a task to get the board started.</p>
    </div>

    <!-- Task groups -->
    <template v-for="group in taskGroups" :key="group.status">
      <div v-if="group.tasks.length > 0" class="board-group">
        <div class="board-group-title">
          {{ group.label }}
          <span class="board-group-count">{{ group.tasks.length }}</span>
        </div>
        <div
          v-for="task in group.tasks"
          :key="task.id"
          class="task-card"
        >
          <div class="task-card-header">
            <span class="task-card-title">{{ task.title }}</span>
            <span class="task-status-badge" :data-status="task.status">{{ task.status.replace('_', ' ') }}</span>
          </div>
          <div class="task-meta">
            <div v-if="task.assignee" class="task-person-chip">
              <div class="task-person-copy">
                <span class="task-person-role">Assignee</span>
                <span class="task-person-name">{{ truncateName(task.assignee) }}</span>
              </div>
            </div>
            <div
              v-for="workflowRef in getTaskWorkflowRefs(task)"
              :key="workflowRef.url"
              class="task-person-chip"
            >
              <a :href="workflowRef.url" target="_blank" class="task-person-name" style="color: #60a5fa; text-decoration: none;">{{ workflowRef.label }}</a>
            </div>
          </div>

          <!-- Leases and Locks Coordination Data -->
          <div v-if="task.active_leases?.length || task.active_locks?.length" class="task-coordination">
            <div v-for="lease in task.active_leases" :key="lease.id" class="coordination-badge lease">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              <span>{{ lease.kind }} lease: {{ truncateName(lease.actor_label) }}</span>
            </div>
            <div v-for="lock in task.active_locks" :key="lock.id" class="coordination-badge lock">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
              <span>{{ lock.scope }} lock: {{ lock.reason }}{{ lock.message ? ' - ' + lock.message : '' }}</span>
            </div>
          </div>
          <div class="task-actions">
            <button
              v-if="task.status === 'proposed'"
              class="task-action-btn accept"
              @click="$emit('acceptTask', task.id)"
            >Accept</button>
            <button
              v-if="task.status === 'accepted' && !task.assignee"
              class="task-action-btn accept"
              @click="$emit('claimTask', task.id)"
            >Claim</button>
            <button
              v-if="['proposed', 'accepted'].includes(task.status)"
              class="task-action-btn cancel"
              @click="$emit('cancelTask', task.id)"
            >Cancel</button>

            <!-- Jump to Focus Room Affordance -->
            <button
              v-if="!['done', 'cancelled'].includes(task.status)"
              class="task-action-btn focus"
              @click="$emit('focusTask', task.id)"
            >Focus ↗</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

export interface TaskData {
  id: string
  title: string
  status: string
  assignee: string | null
  created_by: string
  pr_url: string | null
  workflow_refs: Array<{
    provider: string
    kind: string
    label: string
    url: string
  }>
  active_leases?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string
    kind: string
    status: string
    agent_key: string
    agent_instance_id: string | null
    actor_label: string
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

const props = defineProps<{
  tasks: TaskData[]
}>()

defineEmits<{
  acceptTask: [taskId: string]
  claimTask: [taskId: string]
  cancelTask: [taskId: string]
  addTask: [title: string]
  focusTask: [taskId: string]
}>()

const newTaskTitle = ref('')

const statusOrder = ['in_progress', 'assigned', 'in_review', 'accepted', 'proposed', 'blocked', 'merged', 'done', 'cancelled']
const statusLabels: Record<string, string> = {
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

const taskGroups = computed(() => {
  return statusOrder
    .map(status => ({
      status,
      label: statusLabels[status] || status,
      tasks: props.tasks.filter(t => t.status === status),
    }))
    .filter(g => g.tasks.length > 0)
})

function addTask() {
  const title = newTaskTitle.value.trim()
  if (!title) return
  newTaskTitle.value = ''
}

function truncateName(name: string) {
  if (name.length <= 20) return name
  const parts = name.split('|').map(s => s.trim())
  return parts[0] || name.slice(0, 20) + '…'
}

function getTaskWorkflowRefs(task: TaskData) {
  return task.workflow_refs?.length
    ? task.workflow_refs
    : task.pr_url
      ? [{ provider: 'unknown', kind: 'pull_request', label: 'PR', url: task.pr_url }]
      : []
}
</script>

<style scoped>
.board-panel { height: 100%; overflow-y: auto; padding: 16px 20px; }

.board-group { margin-bottom: 16px; }
.board-group-title {
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted, #71717a); margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
}
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

.task-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.task-card-title { font-size: 0.82rem; font-weight: 600; }

.task-status-badge {
  padding: 2px 6px; border-radius: 4px;
  font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
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

.task-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted, #71717a); font-size: 0.72rem; margin-bottom: 6px; }
.task-person-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 6px; border-radius: 6px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
}
.task-person-copy { display: flex; flex-direction: column; gap: 0; }
.task-person-role { font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #71717a); }
.task-person-name { font-size: 0.72rem; font-weight: 700; color: var(--text, #fafafa); }

.task-actions { display: flex; gap: 4px; }
.task-action-btn {
  padding: 3px 8px; border-radius: 6px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
  font-size: 0.7rem; font-weight: 600; transition: background 150ms;
  cursor: pointer;
}
.task-action-btn:hover { background: var(--surface-hover, #1f1f23); }
.task-action-btn.accept { color: #60a5fa; }
.task-action-btn.cancel { color: #f87171; }
.task-action-btn.focus { color: #a855f7; border-color: rgba(168, 85, 247, 0.2); }
.task-action-btn.focus:hover { background: rgba(168, 85, 247, 0.1); }

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

.add-task-form {
  display: flex; gap: 6px;
  padding: 10px; border-radius: 8px;
  border: 1px dashed var(--line-strong, #3f3f46); margin-bottom: 12px;
}
.add-task-form .input {
  flex: 1; padding: 8px 12px; border-radius: 8px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
  font-size: 0.85rem; outline: none; color: var(--text, #fafafa);
}
.add-task-form .btn {
  padding: 8px 14px; border-radius: 8px;
  font-weight: 600; font-size: 0.82rem;
  background: var(--text, #fafafa); color: var(--bg-0, #09090b); border: none; cursor: pointer;
}
.add-task-form .btn:disabled { opacity: 0.4; cursor: not-allowed; }

.board-empty { display: grid; place-items: center; text-align: center; padding: 40px 20px; color: var(--muted, #71717a); }
.board-empty h3 { color: var(--text, #fafafa); margin-bottom: 4px; font-size: 0.88rem; }
</style>
