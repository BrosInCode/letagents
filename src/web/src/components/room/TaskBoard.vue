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
        <p>Add a task to get started.</p>
      </div>
    </div>

    <div v-for="group in groupedTasks" :key="group.status" class="board-group">
      <div class="board-group-title">
        {{ group.label }}
        <span class="board-group-count">{{ group.tasks.length }}</span>
      </div>
      <div v-for="task in group.tasks" :key="task.id" class="task-card">
        <div class="task-card-header">
          <span class="task-card-title">{{ task.title }}</span>
          <span class="task-status-badge" :data-status="task.status">{{ formatStatus(task.status) }}</span>
        </div>
        <div class="task-meta">
          <div v-if="task.assignee" class="task-person-chip">
            <div class="task-person-copy">
              <span class="task-person-role">Assignee</span>
              <span class="task-person-name">{{ task.assignee }}</span>
            </div>
          </div>
          <div v-if="task.pr_url" style="font-size: 0.72rem;">
            <a :href="task.pr_url" target="_blank" style="color: #60a5fa;">PR ↗</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { type RoomTask } from '@/composables/useRoom'

const props = defineProps<{
  tasks: readonly RoomTask[]
}>()

const emit = defineEmits<{
  addTask: [title: string]
}>()

const newTaskTitle = ref('')

function handleAdd() {
  const title = newTaskTitle.value.trim()
  if (!title) return
  emit('addTask', title)
  newTaskTitle.value = ''
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ')
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

.task-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted, #71717a); font-size: 0.72rem; }
.task-person-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 6px; border-radius: 6px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
}
.task-person-copy { display: flex; flex-direction: column; }
.task-person-role { font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #71717a); }
.task-person-name { font-size: 0.72rem; font-weight: 700; color: var(--text, #fafafa); }

.add-task-form {
  display: flex; gap: 6px;
  padding: 10px; border-radius: 8px;
  border: 1px dashed var(--line-strong, #3f3f46); margin-bottom: 12px;
}
.add-task-form .input {
  flex: 1; padding: 10px 12px; border-radius: 8px;
  background: var(--surface, #18181b); border: 1px solid var(--line, #27272a);
  font-size: 0.85rem; outline: none; color: var(--text, #fafafa);
}
.btn {
  padding: 10px 14px; border-radius: 8px;
  font-weight: 600; font-size: 0.82rem;
  transition: background 150ms;
  border: none; cursor: pointer;
}
.btn-primary { background: var(--text, #fafafa); color: var(--bg-0, #09090b); }

.board-empty { display: grid; place-items: center; text-align: center; padding: 40px 20px; color: var(--muted, #71717a); }
.board-empty h3 { color: var(--text, #fafafa); margin-bottom: 4px; font-size: 0.88rem; }
</style>
