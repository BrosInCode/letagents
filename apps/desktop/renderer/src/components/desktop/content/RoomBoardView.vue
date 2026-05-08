<template>
  <section class="room-tab-page desktop-board-panel" data-testid="room-board-view">
    <form class="desktop-board-add-form" @submit.prevent="addTask">
      <input
        v-model="newTaskTitle"
        class="desktop-board-add-input"
        type="text"
        placeholder="New task title..."
        :disabled="busyAction !== null"
      />
      <button
        class="desktop-board-add-button"
        type="submit"
        :disabled="!newTaskTitle.trim() || busyAction !== null"
      >
        Add
      </button>
    </form>

    <p v-if="errorMessage" class="desktop-board-error" role="alert">{{ errorMessage }}</p>

    <div v-if="groupedTasks.length === 0" class="desktop-board-empty" data-testid="room-board-empty">
      <div>
        <h3>No tasks yet</h3>
        <p>Add a task or use the <code>add_task</code> MCP tool.</p>
      </div>
    </div>

    <section
      v-for="group in groupedTasks"
      v-else
      :key="group.status"
      class="desktop-board-group"
      :data-status="group.status"
      :data-testid="`room-board-group-${group.status}`"
    >
      <button
        class="desktop-board-group-title"
        type="button"
        :aria-expanded="!collapsedGroups.has(group.status)"
        @click="toggleGroup(group.status)"
      >
        <span class="desktop-board-group-chevron" :data-collapsed="collapsedGroups.has(group.status)">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span>{{ group.label }}</span>
        <span class="desktop-board-group-count">{{ group.tasks.length }}</span>
      </button>

      <div v-if="!collapsedGroups.has(group.status)" class="desktop-board-group-list">
        <article
          v-for="task in group.tasks"
          :key="task.id"
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
            v-if="shouldShowAuthority(task)"
            class="desktop-board-authority"
            :data-state="executionAuthorityState(task).state"
          >
            <header>
              <div>
                <span>Execution authority</span>
                <h5>{{ executionAuthorityState(task).label }}</h5>
              </div>
              <strong>{{ executionAuthorityState(task).badge }}</strong>
            </header>
            <div class="desktop-board-authority-grid">
              <span>
                <small>Task owner</small>
                <strong>{{ compactPerson(task.assignee) || "Unassigned" }}</strong>
              </span>
              <span>
                <small>Work lease</small>
                <strong>{{ compactPerson(workLease(task)?.holderLabel) || "No active lease" }}</strong>
              </span>
            </div>
            <p>{{ executionAuthorityState(task).detail }}</p>
          </section>

          <section
            v-if="shouldShowReviewPanel(task)"
            class="desktop-board-review-authority"
            :data-state="reviewPanelState(task).state"
          >
            <header>
              <div>
                <span>Board review authority</span>
                <h5>{{ reviewPanelState(task).label }}</h5>
              </div>
              <strong>{{ reviewPanelState(task).badge }}</strong>
            </header>
            <div class="desktop-board-authority-grid">
              <span>
                <small>Work holder</small>
                <strong>{{ compactPerson(workLease(task)?.holderLabel) || "No active work lease" }}</strong>
              </span>
              <span>
                <small>Reviewer</small>
                <strong>{{ reviewSummary(task) === "Not claimed" ? "Unassigned" : reviewSummary(task) }}</strong>
              </span>
            </div>
            <p>{{ reviewPanelState(task).detail }}</p>
            <div v-if="reviewAssignmentCandidates(task).length" class="desktop-board-review-assign">
              <select
                :value="selectedReviewerByTask[task.id] || ''"
                :disabled="busyAction !== null"
                @change="selectedReviewerByTask[task.id] = ($event.target as HTMLSelectElement).value"
              >
                <option value="">Assign reviewer...</option>
                <option
                  v-for="candidate in reviewAssignmentCandidates(task)"
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
                :disabled="busyAction !== null || !selectedReviewerByTask[task.id]"
                @click="assignReview(task)"
              >
                {{ busyAction === `${task.id}:assign-review` ? "Assigning..." : "Assign" }}
              </button>
            </div>
          </section>

          <div v-if="secondaryLeases(task).length || task.activeLocks.length" class="desktop-board-coordination">
            <span v-for="lease in secondaryLeases(task)" :key="lease.id" class="desktop-board-coordination-badge" data-kind="lease">
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

          <div v-if="workflowRefs(task).length" class="desktop-board-workflow-links">
            <a
              v-for="ref in workflowRefs(task)"
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

          <div v-if="actionsFor(task).length" class="desktop-board-task-actions">
            <button
              v-for="action in actionsFor(task)"
              :key="`${task.id}:${action.id}`"
              type="button"
              class="desktop-board-action-button"
              :data-tone="action.tone"
              :disabled="busyAction === `${task.id}:${action.id}`"
              @click="runTaskAction(task, action)"
            >
              {{ busyAction === `${task.id}:${action.id}` ? "Working..." : action.label }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DesktopAgentPresence, DesktopTaskSummary, WorkerSnapshot } from "../../../../../electron/ipc-types";
import { sortTasks } from "../../../domain/tasks";

type TaskAction = {
  id: string;
  label: string;
  tone: "primary" | "neutral" | "danger";
  run: (task: DesktopTaskSummary) => Promise<DesktopTaskSummary>;
};

type TaskLease = DesktopTaskSummary["activeLeases"][number];

const props = defineProps<{
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  presence: DesktopAgentPresence[];
  workers: WorkerSnapshot[];
}>();

const emit = defineEmits<{
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
}>();

const STATUS_ORDER = ["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review", "merged", "done", "cancelled"];
const LEASE_AUTHORITY_STATUSES = new Set(["assigned", "in_progress", "blocked", "in_review"]);

const newTaskTitle = ref("");
const busyAction = ref<string | null>(null);
const errorMessage = ref<string | null>(null);
const selectedReviewerByTask = ref<Record<string, string>>({});
const collapsedGroups = ref(new Set<string>());

const localWorker = computed(() =>
  props.workers.find((worker) =>
    worker.agentSessionId
    && normalizeRoom(worker.roomId) === normalizeRoom(props.roomIdentifier)
    && ["connected", "away"].includes(worker.state)
  ) || null
);

const groupedTasks = computed(() => {
  const groups = new Map<string, DesktopTaskSummary[]>();
  for (const task of sortTasks(props.tasks)) {
    const status = task.status || "proposed";
    if (!groups.has(status)) groups.set(status, []);
    groups.get(status)?.push(task);
  }
  return STATUS_ORDER
    .filter((status) => groups.has(status))
    .map((status) => ({
      status,
      label: readableStatus(status),
      tasks: groups.get(status) || [],
    }));
});

async function addTask(): Promise<void> {
  const title = newTaskTitle.value.trim();
  if (!title) return;
  await runBoardMutation("add", async () => {
    const result = await window.letagentsDesktop.room.addTask(props.roomIdentifier, title);
    newTaskTitle.value = "";
    return result.task;
  });
}

function toggleGroup(status: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  collapsedGroups.value = next;
}

function actionsFor(task: DesktopTaskSummary): TaskAction[] {
  const actions: TaskAction[] = [];
  const work = workLease(task);
  const review = reviewLeases(task)[0] || null;
  const worker = localWorker.value;
  const workerOwnsTask = Boolean(worker && work && (
    work.agentSessionId === worker.agentSessionId
    || (!!work.agentKey && work.agentKey === worker.agentKey)
  ));
  const workerReviewsTask = Boolean(worker && review && (
    review.agentSessionId === worker.agentSessionId
    || (!!review.agentKey && review.agentKey === worker.agentKey)
  ));

  if (task.status === "proposed") {
    actions.push(statusAction("accept", "Accept", "primary", "accepted"));
    actions.push(statusAction("cancel", "Cancel", "danger", "cancelled"));
  }
  if (task.status === "accepted") {
    if (worker && !work) {
      actions.push(workerAction("claim", "Claim", "primary"));
    }
    actions.push(statusAction("cancel", "Cancel", "danger", "cancelled"));
  }
  if (task.status === "assigned" && workerOwnsTask) {
    actions.push(workerAction("start", "Start", "primary"));
    actions.push(workerAction("block", "Block", "neutral"));
  }
  if (task.status === "in_progress" && workerOwnsTask) {
    actions.push(workerAction("submit_review", "Submit review", "primary"));
    actions.push(workerAction("block", "Block", "neutral"));
  }
  if (task.status === "blocked" && workerOwnsTask) {
    actions.push(workerAction("resume", "Resume", "primary"));
    actions.push(workerAction("submit_review", "Submit review", "neutral"));
  }
  if (task.status === "in_review") {
    if (workerReviewsTask) {
      actions.push(workerAction("block", "Request changes", "danger"));
    }
    actions.push(statusAction("merged", "Mark Merged", "primary", "merged"));
  }
  if (task.status === "merged") {
    actions.push(statusAction("done", "Mark Done", "primary", "done"));
    actions.push(statusAction("reopen", "Reopen", "neutral", "accepted"));
  }
  if (work) {
    actions.push({
      id: "release-work",
      label: "Release lane",
      tone: "neutral",
      run: async (nextTask) => (await window.letagentsDesktop.room.updateTaskLease(props.roomIdentifier, nextTask.id, {
        action: "release",
        lease_id: work.id,
        reason: `Released work lease for ${nextTask.id} from desktop board.`,
      })).task,
    });
  }
  if (review) {
    actions.push({
      id: "release-review",
      label: "Release review",
      tone: "neutral",
      run: async (nextTask) => {
        if (workerReviewsTask) {
          return (await window.letagentsDesktop.room.runTaskReviewWorkerAction(props.roomIdentifier, nextTask.id, {
            action: "release",
            lease_id: review.id,
            reason: `Released board review authority for ${nextTask.id} from desktop board.`,
          })).task;
        }
        return (await window.letagentsDesktop.room.updateTaskReviewLease(props.roomIdentifier, nextTask.id, {
          action: "release",
          lease_id: review.id,
          reason: `Released board review authority for ${nextTask.id} from desktop board.`,
        })).task;
      },
    });
  }
  if (canClaimReview(task)) {
    actions.push({
      id: "claim-review",
      label: "Claim review",
      tone: "primary",
      run: async (nextTask) => (await window.letagentsDesktop.room.runTaskReviewWorkerAction(props.roomIdentifier, nextTask.id, {
        action: "claim",
        reason: `Claimed board review authority for ${nextTask.id} from desktop board.`,
      })).task,
    });
  }

  return actions;
}

function statusAction(id: string, label: string, tone: TaskAction["tone"], status: string): TaskAction {
  return {
    id,
    label,
    tone,
    run: async (task) => (await window.letagentsDesktop.room.updateTask(props.roomIdentifier, task.id, { status })).task,
  };
}

function workerAction(
  action: "claim" | "start" | "block" | "resume" | "submit_review",
  label: string,
  tone: TaskAction["tone"]
): TaskAction {
  return {
    id: action,
    label,
    tone,
    run: async (task) => (await window.letagentsDesktop.room.runTaskWorkerAction(props.roomIdentifier, task.id, { action })).task,
  };
}

async function runTaskAction(task: DesktopTaskSummary, action: TaskAction): Promise<void> {
  await runBoardMutation(`${task.id}:${action.id}`, () => action.run(task));
}

async function runBoardMutation(id: string, mutation: () => Promise<DesktopTaskSummary>): Promise<void> {
  busyAction.value = id;
  errorMessage.value = null;
  try {
    const task = await mutation();
    emit("task-updated", task);
    emit("refresh-room");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Task update failed.";
  } finally {
    busyAction.value = null;
  }
}

async function assignReview(task: DesktopTaskSummary): Promise<void> {
  const selected = parseReviewCandidateValue(selectedReviewerByTask.value[task.id] || "");
  if (!selected) return;
  await runBoardMutation(`${task.id}:assign-review`, async () => {
    const result = await window.letagentsDesktop.room.updateTaskReviewLease(props.roomIdentifier, task.id, {
      action: "assign",
      target_actor_key: selected.agentKey,
      target_actor_instance_id: selected.agentInstanceId,
      target_agent_session_id: selected.agentSessionId,
      reason: `Assigned board review authority for ${task.id} from desktop board.`,
    });
    selectedReviewerByTask.value = {
      ...selectedReviewerByTask.value,
      [task.id]: "",
    };
    return result.task;
  });
}

function workflowRefs(task: DesktopTaskSummary): DesktopTaskSummary["workflowRefs"] {
  return task.workflowRefs.length
    ? task.workflowRefs
    : task.prUrl
      ? [{ provider: "github", kind: "pull_request", label: "PR", url: task.prUrl }]
      : [];
}

function readableStatus(status: string): string {
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function shortTaskId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim());
  return match ? `T${match[1]}` : taskId.replace(/^task_/i, "T");
}

function workLease(task: DesktopTaskSummary): TaskLease | null {
  return task.activeLeases.find((lease) => lease.kind === "work") || null;
}

function reviewLeases(task: DesktopTaskSummary): TaskLease[] {
  return task.activeLeases.filter((lease) => lease.kind === "review");
}

function secondaryLeases(task: DesktopTaskSummary): TaskLease[] {
  return task.activeLeases.filter((lease) => lease.kind !== "work" && lease.kind !== "review");
}

function shouldShowAuthority(task: DesktopTaskSummary): boolean {
  return Boolean(workLease(task) || task.assignee || LEASE_AUTHORITY_STATUSES.has(task.status));
}

function executionAuthorityState(task: DesktopTaskSummary): {
  state: "held" | "mismatch" | "missing";
  label: string;
  badge: string;
  detail: string;
} {
  const lease = workLease(task);
  if (lease) {
    const owner = compactPerson(task.assignee);
    const holder = compactPerson(lease.holderLabel || lease.agentKey);
    if (owner && task.assigneeAgentKey && lease.agentKey && normalizeActor(task.assigneeAgentKey) !== normalizeActor(lease.agentKey)) {
      return {
        state: "mismatch",
        label: "Lease overrides owner",
        badge: "Mismatch",
        detail: `Assigned to ${owner}, but execution authority is held by ${holder || "another worker"}. Release the lane if this is stale.`,
      };
    }
    return {
      state: "held",
      label: "Lane held",
      badge: "Lane held",
      detail: `${holder || "A worker"} has active execution authority for this task.`,
    };
  }
  return {
    state: "missing",
    label: "No active lease",
    badge: "Missing",
    detail: task.assignee
      ? "The task has an owner but no active work lease recorded."
      : "No worker owns this task yet.",
  };
}

function shouldShowReviewPanel(task: DesktopTaskSummary): boolean {
  return ["in_review", "blocked"].includes(task.status) || reviewLeases(task).length > 0;
}

function canClaimReview(task: DesktopTaskSummary): boolean {
  return Boolean(localWorker.value) && shouldShowReviewPanel(task) && reviewLeases(task).length === 0;
}

function reviewPanelState(task: DesktopTaskSummary): {
  state: "assigned" | "missing" | "conflict" | "idle";
  label: string;
  badge: string;
  detail: string;
} {
  const work = workLease(task);
  const reviews = reviewLeases(task);
  const conflicts = reviews.filter((review) => review.agentKey && review.agentKey === work?.agentKey);
  if (!shouldShowReviewPanel(task)) {
    return {
      state: "idle",
      label: "Review not active",
      badge: "Idle",
      detail: "Move the task to review before assigning board review authority.",
    };
  }
  if (conflicts.length) {
    return {
      state: "conflict",
      label: "Reviewer conflicts with work holder",
      badge: "Conflict",
      detail: "At least one reviewer also matches the active work lease. Assign a different worker before treating the board review as valid.",
    };
  }
  if (reviews.length) {
    return {
      state: "assigned",
      label: "Reviewer assigned",
      badge: "Assigned",
      detail: "A separate worker has board review authority for this task.",
    };
  }
  return {
    state: "missing",
    label: "Review unassigned",
    badge: "Needed",
    detail: "This task is waiting for an explicit LetAgents reviewer.",
  };
}

function reviewAssignmentCandidates(task: DesktopTaskSummary): DesktopAgentPresence[] {
  const work = workLease(task);
  const reviews = reviewLeases(task);
  const seen = new Set<string>();
  return props.presence
    .filter((entry) => {
      if (entry.sessionKind !== "worker") return false;
      if (!entry.agentKey || !entry.agentSessionId) return false;
      if (entry.freshness !== "active" || entry.activityState === "offline") return false;
      if (work?.agentKey && entry.agentKey === work.agentKey) return false;
      if (reviews.some((lease) => lease.agentKey && lease.agentKey === entry.agentKey)) return false;
      const key = reviewCandidateKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function reviewCandidateKey(candidate: DesktopAgentPresence): string {
  return [
    candidate.agentKey || "agent",
    candidate.agentInstanceId || "instance",
    candidate.agentSessionId || candidate.actorLabel,
  ].join(":");
}

function reviewCandidateValue(candidate: DesktopAgentPresence): string {
  return JSON.stringify({
    agentKey: candidate.agentKey,
    agentInstanceId: candidate.agentInstanceId,
    agentSessionId: candidate.agentSessionId,
  });
}

function parseReviewCandidateValue(value: string): {
  agentKey: string;
  agentInstanceId: string | null;
  agentSessionId: string;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      agentKey?: unknown;
      agentInstanceId?: unknown;
      agentSessionId?: unknown;
    };
    const agentKey = typeof parsed.agentKey === "string" ? parsed.agentKey.trim() : "";
    const agentSessionId = typeof parsed.agentSessionId === "string" ? parsed.agentSessionId.trim() : "";
    if (!agentKey || !agentSessionId) return null;
    return {
      agentKey,
      agentInstanceId: typeof parsed.agentInstanceId === "string" && parsed.agentInstanceId.trim()
        ? parsed.agentInstanceId.trim()
        : null,
      agentSessionId,
    };
  } catch {
    return null;
  }
}

function reviewCandidateLabel(candidate: DesktopAgentPresence): string {
  const sessionSuffix = candidate.agentSessionId ? candidate.agentSessionId.slice(-6) : "session";
  return `${candidate.displayName} (${sessionSuffix})`;
}

function normalizeRoom(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeActor(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function reviewSummary(task: DesktopTaskSummary): string {
  const reviews = reviewLeases(task);
  return reviews.length
    ? reviews.map((lease) => compactPerson(lease.holderLabel || lease.agentKey) || "Reviewer").join(", ")
    : "Not claimed";
}

function compactPerson(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const parts = normalized.split("|").map((part) => part.trim()).filter(Boolean);
  return parts[0] || normalized;
}

function staleSummary(task: DesktopTaskSummary): string {
  const state = task.stalePromptState;
  if (!state) return "";
  const reason = state.reason ? readableStatus(state.reason) : "Stale";
  const duration = formatStaleDuration(state.staleForMs);
  if (state.isStale && duration) return `${reason} for ${duration}`;
  if (state.isStale) return reason;
  return state.muted ? "Reminders muted" : "";
}

function formatStaleDuration(value: number | null): string {
  if (!value || value < 0) return "";
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return "less than 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function relativeTime(value: string | null | undefined): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "recently";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 45) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  const days = Math.floor(deltaSeconds / 86_400);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

</script>
