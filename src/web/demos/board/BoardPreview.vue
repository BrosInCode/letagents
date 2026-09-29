<template>
  <main class="preview" :data-theme="light ? 'light' : 'dark'">
    <header class="preview-header">
      <strong>LetAgents <span>/</span> The Board</strong>
      <button type="button" @click="light = !light">{{ light ? 'Dark theme' : 'Light theme' }}</button>
    </header>
    <p v-if="error" class="preview-error" role="alert">{{ error }}</p>
    <TaskBoard
      room-identifier="board-preview" :tasks="tasks" :presence="[]"
      :can-manage-leases="!params.has('readonly')" :task-github-status="{}"
      :selected-task-id="params.get('selected')"
      @add-task="addTask" @update-task="updateTask"
      @lease-action="releaseLease" @review-lease-action="releaseLease"
      @focus-task="focused = $event"
    />
    <output v-if="focused" class="preview-focus">Focus requested for {{ focused }}</output>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import TaskBoard from '../../src/components/room/TaskBoard.vue'
import type { RoomTask } from '../../src/composables/useRoom'
import type { TaskUpdatePayload, TaskLeaseActionPayload, TaskReviewLeaseActionPayload } from '../../src/components/room/task-board/types'

const params = new URLSearchParams(location.search)
const light = ref(params.get('theme') === 'light')
const error = ref('')
const focused = ref('')
function task(id: number, title: string, status: string, owner: string | null = null): RoomTask {
  const timestamp = new Date(Date.now() - id * 60000).toISOString()
  return {
    id: `task_${id}`, title, status, description: 'Preserve the approval rules and verify the full workflow with an independent reviewer.',
    assignee: owner, assignee_agent_key: owner, created_by: 'EmmyMay',
    created_at: timestamp, updated_at: timestamp, pr_url: null,
    workflow_artifacts: [], workflow_refs: [], active_locks: [],
    active_leases: owner ? [{
      id: `lease_${id}`, room_id: 'board-preview', task_id: `task_${id}`, kind: 'work', status: 'active',
      agent_key: owner, agent_instance_id: null, agent_session_id: owner, actor_label: owner,
      branch_ref: null, pr_url: null, output_intent: null,
    }] : [],
  }
}
const tasks = ref(params.has('empty') ? [] : [
  task(21, 'Make event-turn timeouts activity-aware', 'proposed'),
  task(22, 'Separate runtime activity from room connectivity', 'proposed'),
  task(23, 'Deliver approved work directly to its owner', 'accepted'),
  task(24, 'Preserve the task owner through reconnects', 'assigned', 'DawnRidge'),
  task(25, 'Make board updates safe to retry', 'in_progress', 'RiverField'),
  task(26, 'Verify the approval handoff end to end', 'in_review', 'DawnRidge'),
  task(28, 'Readable manager notifications', 'done'),
])
function addTask(title: string) { tasks.value.push(task(100 + tasks.value.length, title, 'proposed')) }
async function updateTask(payload: TaskUpdatePayload) {
  if (params.has('slow')) await new Promise(resolve => setTimeout(resolve, 2000))
  if (params.has('error')) {
    error.value = 'The room could not be reached. Try again.'
    payload.onSettled?.(false)
    return
  }
  const target = tasks.value.find(task => task.id === payload.taskId)!
  Object.assign(target, 'status' in payload ? { status: payload.status } : {
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.description !== undefined ? { description: payload.description } : {}),
  })
  target.updated_at = new Date().toISOString()
  payload.onSettled?.(true)
}
function releaseLease(payload: TaskLeaseActionPayload | TaskReviewLeaseActionPayload) {
  const target = tasks.value.find(task => task.id === payload.taskId)!
  target.active_leases = target.active_leases?.filter(lease => lease.id !== payload.lease_id)
  payload.onSettled?.()
}
</script>

<style>
.preview { display: grid; grid-template-rows: 56px minmax(0, 1fr); height: 100dvh; background: var(--bg); color: var(--text); }
.preview-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 28px; border-bottom: 1px solid var(--border); font-size: 13px; }
.preview-header strong { font-weight: 600; }
.preview-header strong span { margin: 0 12px; color: var(--text-secondary); }
.preview-header button { min-height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-subtle); color: var(--text); cursor: pointer; }
.preview-error, .preview-focus { position: fixed; z-index: 2; bottom: 16px; left: 16px; right: 16px; padding: 12px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); font-size: 13px; }
@media (max-width: 600px) { .preview-header { padding-inline: 16px; } }
</style>
