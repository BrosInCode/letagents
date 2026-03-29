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
      <button class="btn btn-primary" type="button" @click="handleAdd">Add</button>
    </div>

    <div v-if="groupedTasks.length === 0" class="board-empty">
      <div>
        <h3>No tasks yet</h3>
        <p>Add a task or use the <code>add_task</code> MCP tool.</p>
      </div>
    </div>

    <div v-for="group in groupedTasks" :key="group.status" class="board-group">
      <h3 class="board-group-title">
        {{ group.label }}
        <span class="board-group-count">{{ group.tasks.length }}</span>
      </h3>
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
        <div v-if="task.pr_url" class="task-pr-link">
          <a :href="task.pr_url" target="_blank">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View PR
          </a>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { type RoomTask } from '@/composables/useRoom'
import TaskPersonChip from './TaskPersonChip.vue'

const props = defineProps<{
  tasks: readonly RoomTask[]
}>()

const emit = defineEmits<{
  addTask: [title: string]
  updateTask: [taskId: string, updates: { status: string }]
}>()

const newTaskTitle = ref('')
const updatingTask = ref<string | null>(null)

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
