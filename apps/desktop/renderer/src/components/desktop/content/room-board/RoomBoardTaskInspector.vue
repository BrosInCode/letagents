<template>
  <aside class="desktop-task-detail-panel" :data-status="task.status">
    <header class="desktop-task-detail-header">
      <div>
        <div class="desktop-task-detail-status-row">
          <template v-if="ticket">
            <span class="desktop-task-provider-chip" :data-provider="ticket.provider">{{ ticket.providerLabel }}</span>
            <span class="desktop-task-id" :title="`${ticket.key} (${task.id})`">{{ ticket.key }}</span>
          </template>
          <span v-else class="desktop-task-id" :title="task.id">{{ shortTaskId(task.id) }}</span>
          <span class="desktop-task-status-badge" :data-status="task.status">
            {{ readableStatus(task.status) }}
          </span>
          <span
            v-if="ticket && ticketState"
            class="desktop-task-ticket-state"
            :data-ticket-state="task.ticketState"
            :title="`${ticket.providerLabel} state. The other badge is the work state.`"
          >{{ ticket.providerLabel }}: {{ ticketState }}</span>
        </div>
        <h3>{{ task.title }}</h3>
      </div>
      <button v-if="canEdit" type="button" class="desktop-task-detail-button" title="Edit task" aria-label="Edit task" :disabled="busyAction !== null" @click="emit('edit')"><Pencil :size="16" aria-hidden="true" /></button>
    </header>

    <MarkdownBlock v-if="task.description" class="task-markdown-preview" :text="task.description" :mentions="false" preserve-paths />
    <p v-else class="desktop-task-detail-muted">No task description yet.</p>
    <p v-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>

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
        <strong>{{ relativeTime(task.updatedAt || task.createdAt, now) }}</strong>
      </span>
      <span>
        <small>Working agent</small>
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
          <small>Working agent</small>
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

    <section v-if="ticket && task.ticketState" class="desktop-task-detail-section" aria-label="Ticket" data-testid="room-board-ticket-section">
      <h4>Ticket</h4>
      <p v-if="ticketDetailsError" class="desktop-task-detail-muted">{{ ticketDetailsError }}</p>
      <p v-else-if="!ticketDetails" class="desktop-task-detail-muted">Loading ticket...</p>
      <template v-else>
        <div class="desktop-task-detail-grid">
          <span>
            <small>{{ ticket.providerLabel }} status</small>
            <strong>{{ ticketDetails.rawStatus }}</strong>
          </span>
          <span>
            <small>Ticket state</small>
            <strong>{{ ticketStateLabel(ticketDetails.ticketState) }}</strong>
          </span>
          <span>
            <small>Assignee</small>
            <strong>{{ ticketDetails.assigneeLabel || "Unassigned" }}</strong>
          </span>
          <span>
            <small>Synced</small>
            <strong>{{ relativeTime(ticketDetails.syncedAt, now) }}</strong>
          </span>
        </div>
        <a
          v-if="ticketDetails.url"
          class="desktop-task-detail-link"
          :href="ticketDetails.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          <small>{{ ticket.providerLabel }}</small>
          <span>Open {{ ticket.key }}</span>
        </a>
      </template>
    </section>

    <section v-if="ticket" class="desktop-task-detail-section" aria-label="Linked threads">
      <h4>Linked threads</h4>
      <p v-if="mentionsError" class="desktop-task-detail-muted">{{ mentionsError }}</p>
      <p v-else-if="mentionsLoading && !mentions.length" class="desktop-task-detail-muted">Loading threads...</p>
      <p v-else-if="!mentions.length" class="desktop-task-detail-muted">No room message names {{ ticket.key }} yet.</p>
      <div v-else class="desktop-task-detail-list">
        <button
          v-for="mention in mentions"
          :key="mention.messageId"
          type="button"
          class="desktop-task-detail-link desktop-task-mention"
          @click="emit('open-thread', mention.threadRootId)"
        >
          <small>{{ compactPerson(mention.sender) || mention.sender }} · {{ relativeTime(mention.timestamp, now) }}</small>
          <span>{{ mention.text }}</span>
        </button>
      </div>
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
import { computed, ref, watch } from "vue";
import { Pencil } from '@lucide/vue';
import MarkdownBlock from '../formatting/MarkdownBlock.vue';
import type { DesktopAgentPresence, DesktopTaskMention, DesktopTaskSummary, DesktopTaskTicket } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import { ticketRefParts, ticketStateLabel } from "./ticket-ref";
import { compactPerson, readableStatus, relativeTime, shortTaskId, staleSummary } from "./formatters";
import { useNow } from "../../../../composables/useNow";

// Labels such as "2m ago" move on with the shared clock even when the data is unchanged.
const now = useNow(30_000);
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
  error: string | null;
  reviewAssignmentCandidates: DesktopAgentPresence[];
  selectedReviewer: string;
  canEdit?: boolean;
  roomIdentifier?: string;
}>();

const emit = defineEmits<{
  edit: [];
  "assign-review": [];
  "run-action": [action: TaskAction];
  "update:selected-reviewer": [value: string];
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
  "open-thread": [threadRootId: string];
}>();

const ticket = computed(() => ticketRefParts(props.task.externalRef));
const mentions = ref<DesktopTaskMention[]>([]);
const mentionsLoading = ref(false);
const mentionsError = ref<string | null>(null);
let mentionsRequest = 0;

// Only cards that name a ticket ask for threads, so other cards make no call.
watch(
  () => [props.roomIdentifier, props.task.id, props.task.externalRef, props.task.updatedAt] as const,
  async ([roomIdentifier, taskId, externalRef]) => {
    const request = ++mentionsRequest;
    if (!roomIdentifier || !externalRef) {
      mentions.value = [];
      mentionsError.value = null;
      return;
    }
    mentionsLoading.value = true;
    try {
      const next = await desktopIpc.room.getTaskMentions(roomIdentifier, taskId);
      if (request !== mentionsRequest) return;
      mentions.value = next;
      mentionsError.value = null;
    } catch {
      if (request !== mentionsRequest) return;
      mentionsError.value = "Linked threads could not be loaded.";
    } finally {
      if (request === mentionsRequest) mentionsLoading.value = false;
    }
  },
  { immediate: true },
);

const ticketState = computed(() => ticketStateLabel(props.task.ticketState));
const ticketDetails = ref<DesktopTaskTicket | null>(null);
const ticketDetailsError = ref<string | null>(null);
let ticketRequest = 0;

// Only cards with a tracker state ask for the ticket, so other cards make no call.
watch(
  () => [props.roomIdentifier, props.task.id, props.task.ticketState, props.task.updatedAt] as const,
  async ([roomIdentifier, taskId, ticketStateValue]) => {
    const request = ++ticketRequest;
    if (!roomIdentifier || !ticketStateValue) {
      ticketDetails.value = null;
      ticketDetailsError.value = null;
      return;
    }
    try {
      const next = await desktopIpc.room.getTaskTicket(roomIdentifier, taskId);
      if (request !== ticketRequest) return;
      ticketDetails.value = next;
      ticketDetailsError.value = next ? null : "The ticket has not synced yet.";
    } catch {
      if (request !== ticketRequest) return;
      ticketDetailsError.value = "The ticket could not be loaded.";
    }
  },
  { immediate: true },
);

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

<style scoped>
.desktop-task-provider-chip {
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
}
.desktop-task-ticket-state {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--surface-muted, rgba(127, 127, 127, 0.14));
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
}
.desktop-task-mention { width: 100%; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
.desktop-task-mention span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
</style>
