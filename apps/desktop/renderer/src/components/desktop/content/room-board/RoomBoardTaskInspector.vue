<template>
  <aside class="desktop-task-detail-panel" :data-status="task.status">
    <header class="desktop-task-detail-header">
      <div>
        <div class="desktop-task-detail-status-row">
          <span class="desktop-task-id" :title="task.id">{{ shortTaskId(task.id) }}</span>
          <span class="desktop-task-status-badge" :data-status="task.status">
            {{ readableStatus(task.status) }}
          </span>
        </div>
        <h3>{{ task.title }}</h3>
      </div>
    </header>

    <p v-if="task.description" class="desktop-task-detail-description">{{ task.description }}</p>
    <p v-else class="desktop-task-detail-muted">No task description yet.</p>

    <section class="desktop-task-detail-grid" aria-label="Task ownership">
      <span>
        <small>Owner</small>
        <strong>{{ compactPerson(task.assignee) || "Unassigned" }}</strong>
      </span>
      <span>
        <small>Created by</small>
        <strong>{{ compactPerson(task.createdBy) || "Unknown" }}</strong>
      </span>
      <span>
        <small>Updated</small>
        <strong>{{ relativeTime(task.updatedAt || task.createdAt) }}</strong>
      </span>
      <span>
        <small>Current worker</small>
        <strong>{{ compactPerson(taskWorkLease?.holderLabel || taskWorkLease?.agentKey) || "No one is working on this now" }}</strong>
      </span>
    </section>

    <section
      v-if="showAuthority"
      class="desktop-task-detail-section desktop-task-authority-panel"
      :data-state="authorityState.state"
    >
      <header>
        <div>
          <small>Who can work on this</small>
          <strong>{{ authorityState.label }}</strong>
        </div>
        <span>{{ authorityState.badge }}</span>
      </header>
      <p>{{ authorityState.detail }}</p>
    </section>

    <section
      v-if="showReviewPanel"
      class="desktop-task-review-panel"
      :data-state="reviewAuthorityState.state"
    >
      <header>
        <div>
          <small>Reviewer</small>
          <strong>{{ reviewAuthorityState.label }}</strong>
        </div>
        <span>{{ reviewAuthorityState.badge }}</span>
      </header>
      <p>{{ reviewAuthorityState.detail }}</p>

      <div class="desktop-task-detail-grid">
        <span>
          <small>Current worker</small>
          <strong>{{ compactPerson(taskWorkLease?.holderLabel || taskWorkLease?.agentKey) || "No one is working on this now" }}</strong>
        </span>
        <span>
          <small>Reviewer</small>
          <strong>{{ reviewerSummary }}</strong>
        </span>
      </div>

      <div v-if="reviewAssignmentCandidates.length" class="desktop-task-review-assign">
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
          class="desktop-task-action"
          data-tone="neutral"
          :disabled="busyAction !== null || !selectedReviewer"
          @click="$emit('assign-review')"
        >
          {{ busyAction === `${task.id}:assign-review` ? "Assigning..." : "Assign" }}
        </button>
      </div>
    </section>

    <section v-if="coordinationItems.length" class="desktop-task-detail-section">
      <h4>Coordination</h4>
      <div class="desktop-task-coordination">
        <span
          v-for="item in coordinationItems"
          :key="item.key"
          class="desktop-task-chip"
          :data-kind="item.kind"
        >
          {{ item.label }}
        </span>
      </div>
    </section>

    <section v-if="taskWorkflowRefs.length || hasArtifactNavigationRefs" class="desktop-task-detail-section">
      <h4>Workflow</h4>
      <div v-if="taskWorkflowRefs.length" class="desktop-task-detail-list">
        <a
          v-for="ref in taskWorkflowRefs"
          :key="ref.url"
          class="desktop-task-detail-link"
          :href="ref.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          <small>{{ ref.provider }}</small>
          <span>{{ ref.label }}</span>
        </a>
      </div>
      <button
        v-if="hasGitHubEventRefs"
        type="button"
        class="desktop-task-detail-button desktop-task-events-link"
        @click="$emit('view-events', task.id)"
      >
        View events
      </button>
      <button
        v-if="hasArtifactNavigationRefs"
        type="button"
        class="desktop-task-detail-button desktop-task-events-link"
        @click="$emit('view-artifacts', task.id)"
      >
        View artifact timeline
      </button>
    </section>

    <section v-if="actions.length" class="desktop-task-detail-section">
      <h4>Actions</h4>
      <div class="desktop-task-actions">
        <button
          v-for="action in actions"
          :key="`${task.id}:${action.id}`"
          type="button"
          class="desktop-task-action"
          :data-tone="action.tone"
          :disabled="busyAction !== null"
          @click="$emit('run-action', action)"
        >
          {{ busyAction === `${task.id}:${action.id}` ? action.busyLabel || "Working..." : action.label }}
        </button>
      </div>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopAgentPresence, DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import { compactPerson, readableStatus, relativeTime, shortTaskId, staleSummary } from "./formatters";
import { reviewCandidateKey, reviewCandidateLabel, reviewCandidateValue } from "./review-candidates";
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
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
}>();

const showAuthority = computed(() => shouldShowAuthority(props.task));
const authorityState = computed(() => executionAuthorityState(props.task));
const showReviewPanel = computed(() => shouldShowReviewPanel(props.task));
const reviewAuthorityState = computed(() => reviewPanelState(props.task));
const taskWorkLease = computed(() => workLease(props.task));
const taskSecondaryLeases = computed(() => secondaryLeases(props.task));
const taskWorkflowRefs = computed(() => workflowRefs(props.task));
const hasGitHubEventRefs = computed(() =>
  Boolean(props.task.prUrl)
  || props.task.workflowArtifacts.some((artifact) => artifact.provider === "github")
  || taskWorkflowRefs.value.some((ref) => ref.provider === "github")
);
const hasArtifactNavigationRefs = computed(() =>
  props.task.workflowArtifacts.length > 0
);
const reviewerSummary = computed(() => {
  const summary = reviewSummary(props.task);
  return summary === "Not claimed" ? "Unassigned" : summary;
});
const coordinationItems = computed(() => {
  const items: Array<{ key: string; kind: string; label: string }> = [];
  for (const lease of taskSecondaryLeases.value) {
    items.push({
      key: lease.id,
      kind: lease.kind === "review" ? "review" : "lease",
      label: `${lease.kind === "review" ? "Review" : readableStatus(lease.kind)}: ${compactPerson(lease.holderLabel || lease.agentKey) || "assigned"}`,
    });
  }
  for (const lock of props.task.activeLocks) {
    items.push({
      key: lock.id,
      kind: "lock",
      label: `${lock.scope} lock: ${lock.reason}${lock.message ? ` - ${lock.message}` : ""}`,
    });
  }
  if (props.task.stalePromptState?.isStale) {
    items.push({ key: "stale", kind: "stale", label: staleSummary(props.task) });
  }
  if (props.task.stalePromptState?.muted) {
    items.push({ key: "muted", kind: "muted", label: "reminders muted" });
  }
  return items;
});

function onReviewerChange(event: Event): void {
  emit("update:selected-reviewer", (event.target as HTMLSelectElement).value);
}
</script>
