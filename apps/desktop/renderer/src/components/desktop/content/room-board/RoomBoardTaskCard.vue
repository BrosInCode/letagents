<template>
  <article
    class="desktop-board-task-card"
    :data-status="task.status"
    :data-testid="`room-board-task-${task.id}`"
  >
    <header class="desktop-board-task-header">
      <div class="desktop-board-task-heading">
        <span class="desktop-board-task-id" :title="task.id">{{ shortTaskId(task.id) }}</span>
        <h4>{{ task.title }}</h4>
      </div>
      <span class="desktop-board-status-badge" :data-status="task.status">
        {{ readableStatus(task.status) }}
      </span>
    </header>

    <div class="desktop-board-task-meta">
      <span v-if="task.assignee" class="desktop-board-person-chip">
        <small>Assignee</small>
        <strong>{{ compactPerson(task.assignee) }}</strong>
      </span>
      <span v-if="task.createdBy" class="desktop-board-person-chip">
        <small>Created by</small>
        <strong>{{ compactPerson(task.createdBy) }}</strong>
      </span>
      <span>{{ relativeTime(task.createdAt || task.updatedAt) }}</span>
    </div>

    <p v-if="task.description" class="desktop-board-task-description">{{ task.description }}</p>

    <section
      v-if="showAuthority"
      class="desktop-board-authority"
      :data-state="authorityState.state"
    >
      <header>
        <div>
          <span>Execution authority</span>
          <h5>{{ authorityState.label }}</h5>
        </div>
        <strong>{{ authorityState.badge }}</strong>
      </header>
      <div class="desktop-board-authority-grid">
        <span>
          <small>Task owner</small>
          <strong>{{ compactPerson(task.assignee) || "Unassigned" }}</strong>
        </span>
        <span>
          <small>Work lease</small>
          <strong>{{ compactPerson(taskWorkLease?.holderLabel) || "No active lease" }}</strong>
        </span>
      </div>
      <p>{{ authorityState.detail }}</p>
    </section>

    <section
      v-if="showReviewPanel"
      class="desktop-board-review-authority"
      :data-state="reviewAuthorityState.state"
    >
      <header>
        <div>
          <span>Board review authority</span>
          <h5>{{ reviewAuthorityState.label }}</h5>
        </div>
        <strong>{{ reviewAuthorityState.badge }}</strong>
      </header>
      <div class="desktop-board-authority-grid">
        <span>
          <small>Work holder</small>
          <strong>{{ compactPerson(taskWorkLease?.holderLabel) || "No active work lease" }}</strong>
        </span>
        <span>
          <small>Reviewer</small>
          <strong>{{ reviewerSummary }}</strong>
        </span>
      </div>
      <p>{{ reviewAuthorityState.detail }}</p>
      <div v-if="reviewAssignmentCandidates.length" class="desktop-board-review-assign">
        <select
          :value="selectedReviewer"
          :disabled="busyAction !== null"
          @change="onReviewerChange"
        >
          <option value="">Assign reviewer...</option>
          <option
            v-for="candidate in reviewAssignmentCandidates"
            :key="reviewCandidateKey(candidate)"
            :value="reviewCandidateValue(candidate)"
          >
            {{ reviewCandidateLabel(candidate) }}
          </option>
        </select>
        <button
          type="button"
          class="desktop-board-action-button"
          data-tone="neutral"
          :disabled="busyAction !== null || !selectedReviewer"
          @click="$emit('assign-review')"
        >
          {{ busyAction === `${task.id}:assign-review` ? "Assigning..." : "Assign" }}
        </button>
      </div>
    </section>

    <div v-if="taskSecondaryLeases.length || task.activeLocks.length" class="desktop-board-coordination">
      <span v-for="lease in taskSecondaryLeases" :key="lease.id" class="desktop-board-coordination-badge" data-kind="lease">
        {{ lease.kind }} lease: {{ compactPerson(lease.holderLabel || lease.agentKey) || "assigned" }}
      </span>
      <span v-for="lock in task.activeLocks" :key="lock.id" class="desktop-board-coordination-badge" data-kind="lock">
        {{ lock.scope }} lock: {{ lock.reason }}{{ lock.message ? ` - ${lock.message}` : "" }}
      </span>
    </div>

    <div v-if="task.stalePromptState?.isStale || task.stalePromptState?.muted" class="desktop-board-coordination">
      <span v-if="task.stalePromptState?.isStale" class="desktop-board-coordination-badge" data-kind="stale">
        {{ staleSummary(task) }}
      </span>
      <span v-if="task.stalePromptState?.muted" class="desktop-board-coordination-badge" data-kind="muted">
        reminders muted
      </span>
    </div>

    <div v-if="taskWorkflowRefs.length" class="desktop-board-workflow-links">
      <a
        v-for="ref in taskWorkflowRefs"
        :key="ref.url"
        :href="ref.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <polyline points="15 3 21 3 21 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        View {{ ref.label }}
      </a>
    </div>

    <div v-if="actions.length" class="desktop-board-task-actions">
      <button
        v-for="action in actions"
        :key="`${task.id}:${action.id}`"
        type="button"
        class="desktop-board-action-button"
        :data-tone="action.tone"
        :disabled="busyAction === `${task.id}:${action.id}`"
        @click="$emit('run-action', action)"
      >
        {{ busyAction === `${task.id}:${action.id}` ? "Working..." : action.label }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopAgentPresence, DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import { compactPerson, readableStatus, relativeTime, shortTaskId, staleSummary } from "./formatters";
import {
  executionAuthorityState,
  reviewPanelState,
  reviewSummary,
  secondaryLeases,
  shouldShowAuthority,
  shouldShowReviewPanel,
  workLease,
  workflowRefs,
} from "./task-state";
import { reviewCandidateKey, reviewCandidateLabel, reviewCandidateValue } from "./review-candidates";
import type { TaskAction } from "./types";

const props = defineProps<{
  task: DesktopTaskSummary;
  actions: TaskAction[];
  busyAction: string | null;
  reviewAssignmentCandidates: DesktopAgentPresence[];
  selectedReviewer: string;
}>();

const emit = defineEmits<{
  "assign-review": [];
  "run-action": [action: TaskAction];
  "update:selected-reviewer": [value: string];
}>();

const showAuthority = computed(() => shouldShowAuthority(props.task));
const authorityState = computed(() => executionAuthorityState(props.task));
const showReviewPanel = computed(() => shouldShowReviewPanel(props.task));
const reviewAuthorityState = computed(() => reviewPanelState(props.task));
const taskWorkLease = computed(() => workLease(props.task));
const taskSecondaryLeases = computed(() => secondaryLeases(props.task));
const taskWorkflowRefs = computed(() => workflowRefs(props.task));
const reviewerSummary = computed(() => {
  const summary = reviewSummary(props.task);
  return summary === "Not claimed" ? "Unassigned" : summary;
});

function onReviewerChange(event: Event): void {
  emit("update:selected-reviewer", (event.target as HTMLSelectElement).value);
}
</script>
