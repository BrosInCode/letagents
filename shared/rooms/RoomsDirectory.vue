<template>
  <section class="rooms-directory" aria-label="Rooms">
    <header class="rooms-heading">
      <div>
        <p class="rooms-parent">
          <span aria-hidden="true">⌂</span> {{ parentLabel }}
        </p>
        <h2>Rooms</h2>
        <p class="rooms-intro">
          Give a task or topic its own conversation. Bring the outcome back
          here.
        </p>
      </div>
      <div class="rooms-heading-actions">
        <button
          v-if="canRefresh"
          class="rooms-icon-button"
          type="button"
          aria-label="Refresh rooms"
          @click="emit('refresh')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"
            />
          </svg>
        </button>
        <button
          ref="newRoomButton"
          class="rooms-button rooms-button-primary"
          type="button"
          :aria-expanded="composing"
          :aria-controls="`${uid}-create`"
          @click="toggleComposer"
        >
          <span aria-hidden="true">+</span> New room
        </button>
      </div>
    </header>

    <Transition name="rooms-reveal">
      <section
        v-if="composing"
        :id="`${uid}-create`"
        class="rooms-composer"
        aria-label="New room"
        @keydown.esc.stop.prevent="closeComposer"
      >
        <div class="rooms-composer-heading">
          <div>
            <h3>Make space for focused work</h3>
            <p>The conversation stays connected to {{ parentLabel }}.</p>
          </div>
          <button
            class="rooms-icon-button"
            type="button"
            aria-label="Cancel new room"
            :disabled="busy"
            @click="closeComposer"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div class="rooms-mode" aria-label="Room purpose">
          <button
            type="button"
            :aria-pressed="creationMode === 'topic'"
            :disabled="busy"
            @click="setCreationMode('topic')"
          >
            For a topic
          </button>
          <button
            type="button"
            :aria-pressed="creationMode === 'task'"
            :disabled="busy"
            @click="setCreationMode('task')"
          >
            From a task
          </button>
        </div>
        <form
          v-if="creationMode === 'topic'"
          class="rooms-topic-form"
          @submit.prevent="createTopic"
        >
          <label :for="`${uid}-title`">Room name</label>
          <div class="rooms-input-action">
            <input
              :id="`${uid}-title`"
              ref="titleInput"
              v-model="topicTitle"
              placeholder="e.g. Plan the next release"
              autocomplete="off"
              :disabled="busy"
              required
            />
            <button
              class="rooms-button rooms-button-primary"
              type="submit"
              :disabled="busy || !topicTitle.trim()"
            >
              {{ busy ? 'Creating…' : 'Create and open'
              }}<span v-if="!busy" aria-hidden="true">↗</span>
            </button>
          </div>
          <p class="rooms-hint">
            A shared conversation, with its own agents and history. No task
            required.
          </p>
        </form>
        <div v-else class="rooms-task-picker">
          <label class="rooms-search"
            ><svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 4 4" /></svg
            ><input
              ref="taskSearchInput"
              v-model="taskQuery"
              type="search"
              aria-label="Find a task"
              placeholder="Find a task…"
              :disabled="busy"
          /></label>
          <div
            v-if="visibleTasks.length"
            class="rooms-task-list"
            aria-label="Choose a task"
          >
            <button
              v-for="task in visibleTasks"
              :key="task.id"
              type="button"
              :aria-pressed="selectedTaskId === task.id"
              :disabled="busy"
              @click="selectedTaskId = task.id"
            >
              <span class="rooms-task-radio" aria-hidden="true"></span
              ><span
                ><strong>{{ task.title }}</strong
                ><small>{{
                  task.roomId
                    ? task.roomClosed
                      ? 'Room closed · view its result'
                      : 'Room already open'
                    : taskStatusLabel(task.status)
                }}</small></span
              ><span v-if="selectedTaskId === task.id" aria-hidden="true"
                >✓</span
              >
            </button>
          </div>
          <p v-else class="rooms-task-empty">
            {{
              taskQuery
                ? 'No tasks match your search.'
                : 'No open tasks yet. Add a task on the board, or start with a topic.'
            }}
          </p>
          <div class="rooms-task-footer">
            <p>
              {{
                selectedTask?.roomId
                  ? 'This task already has a room. Continue the conversation there.'
                  : 'The task and this conversation stay linked.'
              }}
            </p>
            <button
              class="rooms-button rooms-button-primary"
              type="button"
              :disabled="!selectedTask || busy"
              @click="createTask"
            >
              {{
                busy
                  ? 'Opening…'
                  : selectedTask?.roomId
                    ? 'Open existing room'
                    : 'Create and open'
              }}<span v-if="!busy" aria-hidden="true">↗</span>
            </button>
          </div>
        </div>
      </section>
    </Transition>
    <div v-if="error" class="rooms-error" role="alert">
      <p>{{ error }}</p>
      <button
        v-if="createdRoom"
        class="rooms-button"
        type="button"
        :disabled="busy"
        @click="emit('retryOpen')"
      >
        Open {{ createdRoom.title }} <span aria-hidden="true">↗</span>
      </button>
    </div>

    <div class="rooms-toolbar">
      <div class="rooms-filters" aria-label="Room status">
        <button
          type="button"
          :aria-pressed="!showClosed"
          @click="showClosed = false"
        >
          Open <span>{{ rooms.filter((room) => !room.closed).length }}</span>
        </button>
        <button
          type="button"
          :aria-pressed="showClosed"
          @click="showClosed = true"
        >
          Closed <span>{{ rooms.filter((room) => room.closed).length }}</span>
        </button>
      </div>
      <label class="rooms-search"
        ><svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" /></svg
        ><input
          v-model="query"
          type="search"
          aria-label="Search rooms"
          placeholder="Search rooms…"
      /></label>
    </div>
    <div class="rooms-list-caption">
      <span>{{
        showClosed
          ? 'Finished conversations & outcomes'
          : 'Conversations in this room'
      }}</span
      ><span>Newest first</span>
    </div>
    <div v-if="visibleRooms.length" class="rooms-list">
      <article
        v-for="room in visibleRooms"
        :key="room.id"
        class="rooms-entry"
        :data-expanded="expandedId === room.id"
      >
        <div class="rooms-entry-row">
          <button
            class="rooms-entry-main"
            type="button"
            :aria-label="`${room.closed ? 'View result for' : 'Open'} ${room.title}`"
            @click="
              room.closed ? toggleDetails(room.id) : emit('open', room.id)
            "
          >
            <span
              class="rooms-entry-icon"
              :data-kind="room.kind"
              aria-hidden="true"
              ><svg viewBox="0 0 24 24">
                <template v-if="room.closed">
                  <path d="m6 12 4 4 8-9" />
                </template>
                <template v-else-if="room.kind === 'branch'">
                  <circle cx="7" cy="5" r="2" />
                  <circle cx="17" cy="6" r="2" />
                  <circle cx="7" cy="19" r="2" />
                  <path d="M7 7v10m10-9c0 6-10 2-10 7" />
                </template>
                <template v-else-if="room.kind === 'task'">
                  <rect x="5" y="4" width="14" height="17" rx="3" />
                  <path d="M9 4V2h6v2M9 12l2 2 4-5" />
                </template>
                <template v-else>
                  <path d="M20 11a8 8 0 0 1-8 8H5l-3 2 1-6a8 8 0 1 1 17-4Z" />
                </template></svg
            ></span>
            <span class="rooms-entry-copy"
              ><span class="rooms-entry-title">{{ room.title }}</span
              ><span class="rooms-entry-description"
                ><span class="rooms-mobile-kind"
                  >{{ roomKindLabel(room) }} · </span
                >{{
                  room.description ||
                  (room.closed
                    ? 'No outcome recorded. The conversation is still available.'
                    : room.kind === 'branch'
                      ? 'Conversation for this Git branch'
                      : room.kind === 'task'
                        ? 'A dedicated conversation for this task'
                        : 'A separate space for this topic')
                }}</span
              ></span
            >
            <span class="rooms-entry-kind">{{ roomKindLabel(room) }}</span>
            <time
              class="rooms-entry-date"
              :datetime="
                (room.closed ? room.closedAt : room.createdAt) || undefined
              "
              >{{
                roomDate(room.closed ? room.closedAt : room.createdAt)
              }}</time
            >
            <span class="rooms-entry-arrow" aria-hidden="true">{{
              room.closed ? '↓' : '↗'
            }}</span>
          </button>
          <button
            :id="`${uid}-toggle-${room.id}`"
            class="rooms-icon-button rooms-details-toggle"
            type="button"
            :aria-label="`${expandedId === room.id ? 'Hide' : 'Show'} details for ${room.title}`"
            :aria-expanded="expandedId === room.id"
            :aria-controls="`${uid}-details-${room.id}`"
            @click="toggleDetails(room.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                :d="expandedId === room.id ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'"
              />
            </svg>
          </button>
        </div>
        <Transition name="rooms-reveal">
          <section
            v-if="expandedId === room.id"
            :id="`${uid}-details-${room.id}`"
            class="rooms-entry-details"
            :aria-label="`${room.title} details`"
          >
            <slot name="details" :room="room"
              ><p>{{ room.description }}</p></slot
            >
          </section>
        </Transition>
      </article>
    </div>
    <div v-else class="rooms-empty">
      <div class="rooms-empty-mark" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <h3>
        {{
          query
            ? 'No rooms match your search'
            : showClosed
              ? 'Outcomes will live here'
              : 'A little room to focus'
        }}
      </h3>
      <p>
        {{
          query
            ? 'Try a room name, task, or branch.'
            : showClosed
              ? 'Close a room when the work is done. Its conversation and result stay available here.'
              : 'Start a conversation for one task or idea, with space for the right people and agents.'
        }}
      </p>
      <button
        v-if="query"
        class="rooms-button"
        type="button"
        @click="query = ''"
      >
        Clear search
      </button>
      <button
        v-else-if="!showClosed"
        class="rooms-button"
        type="button"
        @click="openComposer"
      >
        Create your first room <span aria-hidden="true">↗</span>
      </button>
    </div>
    <details class="rooms-explainer">
      <summary>How rooms work</summary>
      <div>
        <p>
          <strong>One conversation per task or topic.</strong> People and agents
          can join to work together, then record an outcome when the room
          closes.
        </p>
        <p>
          <strong>Still connected.</strong> New rooms share their final note
          back here by default. Change this in a room’s settings.
        </p>
        <p>
          <strong>Git branches have rooms too.</strong> These follow the branch
          agents are working on. Creating a topic room does not create a Git
          branch or a local checkout.
        </p>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import {
  filterRooms,
  roomDate,
  roomKindLabel,
  taskStatusLabel,
  type DirectoryRoom,
  type DirectoryTask,
} from './directory'

const props = defineProps<{
  rooms: readonly DirectoryRoom[]
  tasks: readonly DirectoryTask[]
  parentLabel: string
  busy?: boolean
  error?: string | null
  canRefresh?: boolean
  initialTaskId?: string | null
  createdRoom?: { id: string; title: string } | null
}>()
const emit = defineEmits<{
  open: [id: string]
  select: [id: string | null]
  createTopic: [title: string]
  createTask: [id: string]
  refresh: []
  retryOpen: []
}>()
const uid = useId()
const composing = ref(false)
const creationMode = ref<'topic' | 'task'>('topic')
const topicTitle = ref('')
const query = ref('')
const taskQuery = ref('')
const showClosed = ref(false)
const expandedId = ref<string | null>(null)
const selectedTaskId = ref<string | null>(null)
const newRoomButton = ref<HTMLButtonElement | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
const taskSearchInput = ref<HTMLInputElement | null>(null)
const visibleRooms = computed(() =>
  filterRooms(props.rooms, showClosed.value, query.value),
)
const visibleTasks = computed(() =>
  props.tasks.filter((task) =>
    `${task.title} ${task.description}`
      .toLocaleLowerCase()
      .includes(taskQuery.value.trim().toLocaleLowerCase()),
  ),
)
const selectedTask = computed(() =>
  visibleTasks.value.find((task) => task.id === selectedTaskId.value),
)

watch(
  () => props.initialTaskId,
  (id) => {
    if (!id) return
    taskQuery.value = ''
    selectedTaskId.value = id
    creationMode.value = 'task'
    composing.value = true
  },
  { immediate: true },
)
watch(visibleRooms, (rooms) => {
  if (expandedId.value && !rooms.some((room) => room.id === expandedId.value)) {
    expandedId.value = null
    emit('select', null)
  }
})
watch(
  visibleTasks,
  (tasks) => {
    if (
      selectedTaskId.value &&
      !tasks.some((task) => task.id === selectedTaskId.value)
    )
      selectedTaskId.value = null
  },
  { flush: 'sync' },
)
async function openComposer() {
  composing.value = true
  await focusComposer()
}
async function focusComposer() {
  await nextTick()
  ;(creationMode.value === 'topic'
    ? titleInput.value
    : taskSearchInput.value
  )?.focus()
}
function toggleComposer() {
  if (composing.value) closeComposer()
  else void openComposer()
}
async function closeComposer() {
  if (props.busy) return
  composing.value = false
  await nextTick()
  newRoomButton.value?.focus()
}
async function setCreationMode(mode: 'topic' | 'task') {
  creationMode.value = mode
  await focusComposer()
}
function toggleDetails(id: string) {
  expandedId.value = expandedId.value === id ? null : id
  emit('select', expandedId.value)
}
function createTopic() {
  if (!props.busy && topicTitle.value.trim())
    emit('createTopic', topicTitle.value.trim())
}
function createTask() {
  if (props.busy || !selectedTask.value) return
  if (selectedTask.value.roomId) emit('open', selectedTask.value.roomId)
  else emit('createTask', selectedTask.value.id)
}
</script>

<style src="./rooms-directory.css"></style>
