<template>
  <div class="focus-rooms-panel">
    <section class="focus-hero">
      <div class="focus-hero-copy">
        <p class="focus-eyebrow">Rooms</p>
        <h3>Give bigger work a quieter room.</h3>
        <p>Keep the main room clear while agents go deep on one task.</p>
      </div>
      <div class="focus-route">
        <span>Route</span>
        <strong>{{ previewRoute }}</strong>
      </div>
    </section>

    <div class="focus-layout">
      <section class="focus-list">
        <div class="focus-section-header">
          <div>
            <h4>Focus candidates</h4>
            <p>Large, noisy, or multi-agent work belongs here.</p>
          </div>
          <span>{{ candidateTasks.length }}</span>
        </div>

        <div v-if="candidateTasks.length === 0" class="focus-empty">
          <h4>No open tasks yet</h4>
          <p>Add a task first, then focus it into a room.</p>
        </div>

        <button
          v-for="task in candidateTasks"
          :key="task.id"
          class="focus-task"
          :data-selected="task.id === currentTask?.id"
          type="button"
          @click="emit('selectTask', task.id)"
        >
          <div>
            <strong>{{ task.title }}</strong>
            <span>{{ task.description || task.id }}</span>
          </div>
          <small>{{ taskStatusLabel(task.status) }}</small>
        </button>
      </section>

      <aside class="focus-detail">
        <template v-if="currentTask">
          <p class="focus-eyebrow">Selected task</p>
          <h4>{{ currentTask.title }}</h4>
          <p class="focus-detail-copy">
            Open a Focus Room when this task needs its own discussion, agents, logs, or decisions.
          </p>

          <dl class="focus-facts">
            <div>
              <dt>Parent</dt>
              <dd>{{ roomLabel }}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{{ taskStatusLabel(currentTask.status) }}</dd>
            </div>
            <div>
              <dt>Share back</dt>
              <dd>Outcome summary</dd>
            </div>
          </dl>

          <button class="focus-primary" type="button" @click="emit('createFocusRoom', currentTask.id)">
            Focus on this
          </button>
          <p class="focus-note">
            This prepares the Focus Room path. Server-side room creation still needs to land.
          </p>
        </template>

        <template v-else>
          <p class="focus-eyebrow">No task selected</p>
          <h4>Choose a task to focus.</h4>
          <p class="focus-detail-copy">
            Start from the board or pick a candidate here.
          </p>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type RoomTask } from '@/composables/useRoom'

const props = defineProps<{
  tasks: readonly RoomTask[]
  selectedTaskId: string | null
  roomLabel: string
  roomAddress: string
}>()

const emit = defineEmits<{
  selectTask: [taskId: string]
  createFocusRoom: [taskId: string]
}>()

const candidateTasks = computed(() =>
  props.tasks.filter(task => !['done', 'cancelled'].includes(task.status))
)

const currentTask = computed(() => {
  const selected = props.selectedTaskId
    ? candidateTasks.value.find(task => task.id === props.selectedTaskId)
    : null
  return selected ?? candidateTasks.value[0] ?? null
})

const previewRoute = computed(() => {
  const base = props.roomAddress || 'room'
  const taskId = currentTask.value?.id || 'task'
  return `/in/${base}/focus/${taskId}`
})

function taskStatusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}
</script>

<style scoped>
.focus-rooms-panel {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 22px;
  background: var(--bg-0, #09090b);
}

.focus-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 0.72fr);
  gap: 14px;
  align-items: stretch;
  margin-bottom: 14px;
}

.focus-hero-copy,
.focus-route,
.focus-list,
.focus-detail {
  border: 1px solid var(--line, #27272a);
  background: var(--bg-1, #0f0f11);
  border-radius: 8px;
}

.focus-hero-copy {
  padding: 18px;
}

.focus-eyebrow {
  margin: 0 0 8px;
  color: #93c5fd;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.focus-hero h3,
.focus-detail h4,
.focus-empty h4 {
  margin: 0;
  color: var(--text, #fafafa);
  font-weight: 800;
  letter-spacing: -0.02em;
}

.focus-hero h3 {
  font-size: 1.28rem;
}

.focus-hero p,
.focus-section-header p,
.focus-detail-copy,
.focus-note,
.focus-empty p {
  margin: 6px 0 0;
  color: var(--muted, #71717a);
  line-height: 1.55;
  font-size: 0.82rem;
}

.focus-route {
  display: grid;
  align-content: center;
  gap: 6px;
  padding: 18px;
}

.focus-route span,
.focus-facts dt {
  color: var(--muted, #71717a);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.focus-route strong {
  display: block;
  color: var(--text, #fafafa);
  font-family: var(--font-mono, monospace);
  font-size: 0.76rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.focus-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.52fr);
  gap: 14px;
  min-height: 0;
}

.focus-list,
.focus-detail {
  padding: 14px;
}

.focus-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.focus-section-header h4 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.86rem;
}

.focus-section-header span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  font-size: 0.72rem;
  font-weight: 800;
}

.focus-task {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 11px 12px;
  margin-bottom: 7px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  cursor: pointer;
  text-align: left;
  transition: border-color 150ms, background 150ms;
}

.focus-task:hover,
.focus-task[data-selected="true"] {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(96, 165, 250, 0.08);
}

.focus-task strong,
.focus-task span {
  display: block;
}

.focus-task strong {
  font-size: 0.82rem;
  line-height: 1.4;
}

.focus-task span {
  margin-top: 3px;
  color: var(--muted, #71717a);
  font-size: 0.74rem;
  line-height: 1.45;
}

.focus-task small {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--surface, #18181b);
  color: #93c5fd;
  font-size: 0.64rem;
  font-weight: 800;
  text-transform: capitalize;
}

.focus-detail {
  position: sticky;
  top: 0;
  align-self: start;
}

.focus-facts {
  display: grid;
  gap: 8px;
  margin: 14px 0;
}

.focus-facts div {
  display: grid;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
}

.focus-facts dd {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.focus-primary {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(96, 165, 250, 0.3);
  background: #dbeafe;
  color: #111827;
  font-size: 0.82rem;
  font-weight: 800;
  cursor: pointer;
  transition: opacity 150ms;
}

.focus-primary:hover {
  opacity: 0.9;
}

.focus-note {
  text-align: center;
}

.focus-empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--muted, #71717a);
}

@media (max-width: 860px) {
  .focus-hero,
  .focus-layout {
    grid-template-columns: 1fr;
  }

  .focus-detail {
    position: static;
  }
}

@media (max-width: 768px) {
  .focus-rooms-panel {
    padding: 12px 12px 16px;
  }

  .focus-hero-copy,
  .focus-route,
  .focus-list,
  .focus-detail {
    padding: 12px;
  }

  .focus-task {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
