<template>
  <article
    class="desktop-task-card"
    :class="{ 'is-selected': selected }"
    :data-status="task.status"
    :data-draggable="draggableTask"
    :data-testid="`room-board-task-${task.id}`"
    :draggable="draggableTask"
    @click="onCardClick"
    @dragstart="onDragStart"
    @dragend="$emit('drag-end')"
  >
    <button
      type="button"
      class="desktop-task-card-open"
      :aria-label="`Open ${task.title}`"
      @click="$emit('select')"
    >
      <span class="desktop-task-card-header">
        <span class="desktop-task-id" :title="task.id">{{ shortTaskId(task.id) }}</span>
      </span>
      <span class="desktop-task-card-title">{{ task.title }}</span>
      <span class="desktop-task-card-meta">
        <span class="desktop-task-owner">
          <i aria-hidden="true">{{ ownerInitial }}</i>
          <span>
            <small>Owner</small>
            <strong>{{ ownerName }}</strong>
          </span>
        </span>
        <span class="desktop-task-updated">
          <small>Updated</small>
          <strong>{{ relativeTime(task.updatedAt || task.createdAt) }}</strong>
        </span>
      </span>
    </button>

    <div v-if="taskWorkLease || taskSecondaryLeases.length || task.activeLocks.length || task.stalePromptState?.isStale || task.stalePromptState?.muted || taskWorkflowRefs.length" class="desktop-task-coordination">
      <span v-if="taskWorkLease" class="desktop-task-chip" data-kind="work">
        Working: {{ compactPerson(taskWorkLease.holderLabel || taskWorkLease.agentKey) || "someone" }}
      </span>
      <span v-for="lease in taskSecondaryLeases" :key="lease.id" class="desktop-task-chip" data-kind="review">
        {{ lease.kind === "review" ? "Review" : readableStatus(lease.kind) }}: {{ compactPerson(lease.holderLabel || lease.agentKey) || "assigned" }}
      </span>
      <span v-for="lock in task.activeLocks" :key="lock.id" class="desktop-task-chip" data-kind="lock">
        {{ lock.scope }} lock: {{ lock.reason }}{{ lock.message ? ` - ${lock.message}` : "" }}
      </span>
      <span v-if="task.stalePromptState?.isStale" class="desktop-task-chip" data-kind="stale">
        {{ staleSummary(task) }}
      </span>
      <span v-if="task.stalePromptState?.muted" class="desktop-task-chip" data-kind="muted">
        reminders muted
      </span>
      <a
        v-for="ref in visibleWorkflowRefs"
        :key="ref.url"
        class="desktop-task-chip desktop-task-link-chip"
        :href="ref.url"
        target="_blank"
        rel="noopener noreferrer"
        @click.stop
      >
        View {{ ref.label }}
      </a>
      <span v-if="extraWorkflowRefCount > 0" class="desktop-task-chip">
        +{{ extraWorkflowRefCount }} links
      </span>
    </div>

    <div v-if="primaryAction" class="desktop-task-actions">
      <button
        type="button"
        class="desktop-task-action"
        :data-tone="primaryAction.tone"
        :disabled="busyAction !== null"
        @click.stop="$emit('run-action', primaryAction)"
      >
        {{ busyAction === `${task.id}:${primaryAction.id}` ? primaryAction.busyLabel || "Working..." : primaryAction.label }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import { compactPerson, readableStatus, relativeTime, shortTaskId, staleSummary } from "./formatters";
import {
  secondaryLeases,
  workLease,
  workflowRefs,
} from "./task-state";
import type { TaskAction } from "./types";

const props = defineProps<{
  task: DesktopTaskSummary;
  actions: TaskAction[];
  busyAction: string | null;
  draggableTask: boolean;
  selected: boolean;
}>();

const emit = defineEmits<{
  "drag-end": [];
  "drag-start": [taskId: string];
  "run-action": [action: TaskAction];
  "select": [];
}>();

const taskWorkLease = computed(() => workLease(props.task));
const taskSecondaryLeases = computed(() => secondaryLeases(props.task));
const taskWorkflowRefs = computed(() => workflowRefs(props.task));
const visibleWorkflowRefs = computed(() => taskWorkflowRefs.value.slice(0, 2));
const extraWorkflowRefCount = computed(() => Math.max(0, taskWorkflowRefs.value.length - visibleWorkflowRefs.value.length));
const primaryAction = computed(() => props.actions.find((action) => action.tone === "primary") || props.actions[0] || null);
const ownerName = computed(() => compactPerson(props.task.assignee) || "Unassigned");
const ownerInitial = computed(() => ownerName.value === "Unassigned"
  ? "—"
  : ownerName.value.charAt(0).toUpperCase()
);

function onDragStart(event: DragEvent): void {
  if (!props.draggableTask || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", props.task.id);
  emit("drag-start", props.task.id);
}

function onCardClick(event: MouseEvent): void {
  if ((event.target as HTMLElement).closest("button, a")) return;
  emit("select");
}
</script>
