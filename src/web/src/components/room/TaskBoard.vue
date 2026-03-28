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
.board-panel { height: 100%; overflow-y: auto; padding: 24px; }
.board-group { margin-bottom: 24px; max-width: 980px; margin-left: auto; margin-right: auto; }
.board-group-title {
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; color: rgba(255, 255, 255, 0.44); margin-bottom: 10px;
  display: flex; align-items: center; gap: 6px;
}
.board-group-count {
  padding: 3px 8px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.05); font-size: 0.66rem;
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.task-card {
  padding: 16px 18px; border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.01)),
    rgba(18, 18, 20, 0.9);
  margin-bottom: 10px; transition: border-color 150ms, transform 150ms, box-shadow 150ms;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.16);
}
.task-card:hover {
  border-color: rgba(255, 255, 255, 0.12);
  transform: translateY(-1px);
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.2);
}
.task-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.task-card-title { font-size: 0.92rem; font-weight: 650; letter-spacing: -0.02em; }
.task-status-badge {
  padding: 5px 10px; border-radius: 999px;
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
  padding: 5px 10px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.06);
}
.task-person-copy { display: flex; flex-direction: column; }
.task-person-role { font-size: 0.58rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #71717a); }
.task-person-name { font-size: 0.72rem; font-weight: 700; color: var(--text, #fafafa); }

.add-task-form {
  display: flex; gap: 6px;
  max-width: 980px;
  margin: 0 auto 18px;
  padding: 12px; border-radius: 22px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.add-task-form .input {
  flex: 1; padding: 12px 14px; border-radius: 14px;
  background: rgba(7, 7, 8, 0.34); border: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 0.88rem; outline: none; color: var(--text, #fafafa);
}
.btn {
  padding: 12px 16px; border-radius: 14px;
  font-weight: 600; font-size: 0.82rem;
  transition: background 150ms;
  border: none; cursor: pointer;
}
.btn-primary {
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  box-shadow: 0 10px 24px rgba(255, 255, 255, 0.1);
}

.board-empty { display: grid; place-items: center; text-align: center; padding: 40px 20px; color: var(--muted, #71717a); }
.board-empty h3 { color: var(--text, #fafafa); margin-bottom: 4px; font-size: 0.88rem; }

@media (max-width: 900px) {
  .board-panel {
    padding: 16px 14px;
  }

  .add-task-form {
    flex-direction: column;
    border-radius: 18px;
  }
}
</style>
