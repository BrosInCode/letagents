<template>
  <section class="room-tab-page" data-testid="room-board-view">
    <RoomBoardSummary :tasks="tasks" />

    <form class="desktop-board-toolbar" @submit.prevent="addTask">
      <label class="desktop-board-add">
        <span>New task</span>
        <input
          v-model="newTaskTitle"
          type="text"
          placeholder="Add work to the room board..."
          :disabled="busyAction !== null"
        />
      </label>
      <button class="desktop-board-primary-action" type="submit" :disabled="!newTaskTitle.trim() || busyAction !== null">
        Add
      </button>
    </form>

    <p v-if="errorMessage" class="desktop-board-error" role="alert">{{ errorMessage }}</p>

    <div class="desktop-task-board" data-testid="room-board-tasks">
      <section
        v-for="column in columns"
        :key="column.id"
        class="desktop-task-column"
        :data-testid="`room-board-column-${column.id}`"
      >
        <header class="desktop-task-column-header">
          <div>
            <p class="sidebar-label">{{ column.label }}</p>
            <span>{{ column.description }}</span>
          </div>
          <strong>{{ column.tasks.length }}</strong>
        </header>

        <article
          v-for="task in column.tasks"
          :key="task.id"
          class="desktop-task-card"
          :data-status="task.status"
          :data-testid="`room-board-task-${task.id}`"
        >
          <div class="desktop-task-card-header">
            <div class="desktop-task-title-block">
              <span class="desktop-task-id">{{ shortTaskId(task.id) }}</span>
              <span class="state-pill" :data-state="task.status">{{ readableStatus(task.status) }}</span>
            </div>
            <code>{{ task.id }}</code>
          </div>

          <h4>{{ task.title }}</h4>
          <p v-if="task.description" class="desktop-task-description">{{ task.description }}</p>

          <div class="desktop-task-meta-grid">
            <span>
              <small>Owner</small>
              <strong>{{ task.assignee || "Unassigned" }}</strong>
            </span>
            <span>
              <small>Work lease</small>
              <strong>{{ workLease(task)?.holderLabel || "No active worker" }}</strong>
            </span>
            <span>
              <small>Review</small>
              <strong>{{ reviewLeases(task).length ? reviewLeases(task).map((lease) => lease.holderLabel || "Reviewer").join(", ") : "Not claimed" }}</strong>
            </span>
            <span>
              <small>Updated</small>
              <strong>{{ relativeTime(task.updatedAt) }}</strong>
            </span>
          </div>

          <div v-if="task.workflowRefs.length || task.prUrl" class="desktop-task-links">
            <a
              v-for="ref in workflowRefs(task)"
              :key="ref.url"
              class="desktop-task-pr-link"
              :href="ref.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ ref.label }}
            </a>
          </div>

          <div v-if="task.activeLeases.length || task.activeLocks.length" class="desktop-task-coordination">
            <span v-for="lease in task.activeLeases" :key="lease.id" class="desktop-task-chip" :data-kind="lease.kind">
              {{ lease.kind }}: {{ lease.holderLabel || lease.agentKey || "assigned" }}
            </span>
            <span v-for="lock in task.activeLocks" :key="lock.id" class="desktop-task-chip" data-kind="lock">
              lock: {{ lock.reason || lock.message || lock.scope }}
            </span>
          </div>

          <section
            v-if="shouldShowReviewPanel(task)"
            class="desktop-task-review-panel"
            :data-state="reviewPanelState(task).state"
          >
            <header>
              <div>
                <small>Review authority</small>
                <strong>{{ reviewPanelState(task).label }}</strong>
              </div>
              <span>{{ reviewPanelState(task).badge }}</span>
            </header>
            <p>{{ reviewPanelState(task).detail }}</p>
            <div v-if="reviewAssignmentCandidates(task).length" class="desktop-task-review-assign">
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
                class="desktop-task-action"
                data-tone="neutral"
                :disabled="busyAction !== null || !selectedReviewerByTask[task.id]"
                @click="assignReview(task)"
              >
                {{ busyAction === `${task.id}:assign-review` ? "Assigning..." : "Assign" }}
              </button>
            </div>
          </section>

          <div v-if="actionsFor(task).length" class="desktop-task-actions">
            <button
              v-for="action in actionsFor(task)"
              :key="`${task.id}:${action.id}`"
              type="button"
              class="desktop-task-action"
              :data-tone="action.tone"
              :disabled="busyAction === `${task.id}:${action.id}`"
              @click="runTaskAction(task, action)"
            >
              {{ busyAction === `${task.id}:${action.id}` ? "Working..." : action.label }}
            </button>
          </div>
        </article>

        <article v-if="!column.tasks.length" class="desktop-task-empty">
          <p>No tasks here.</p>
        </article>
      </section>
    </div>

    <article v-if="!tasks.length" class="room-empty-card" data-testid="room-board-empty">
      <div>
        <h3>No tasks in this room yet.</h3>
        <p>When humans or agents add work, it will appear here with ownership, review, and lease context.</p>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DesktopAgentPresence, DesktopTaskSummary, WorkerSnapshot } from "../../../../../electron/ipc-types";
import RoomBoardSummary from "./RoomBoardSummary.vue";

type TaskAction = {
  id: string;
  label: string;
  tone: "primary" | "neutral" | "danger";
  run: (task: DesktopTaskSummary) => Promise<DesktopTaskSummary>;
};

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

const newTaskTitle = ref("");
const busyAction = ref<string | null>(null);
const errorMessage = ref<string | null>(null);
const selectedReviewerByTask = ref<Record<string, string>>({});

const localWorker = computed(() =>
  props.workers.find((worker) =>
    worker.agentSessionId
    && normalizeRoom(worker.roomId) === normalizeRoom(props.roomIdentifier)
    && ["connected", "away"].includes(worker.state)
  ) || null
);

const statusRanks: Record<string, number> = {
  proposed: 10,
  accepted: 20,
  assigned: 30,
  in_progress: 40,
  blocked: 50,
  in_review: 60,
  merged: 70,
  done: 80,
  cancelled: 90,
};

const columns = computed(() => [
  {
    id: "open",
    label: "Open",
    description: "New work and tasks ready to start.",
    tasks: sortTasks(props.tasks.filter((task) => ["proposed", "accepted", "assigned"].includes(task.status))),
  },
  {
    id: "moving",
    label: "Moving",
    description: "Owned, blocked, or actively changing.",
    tasks: sortTasks(props.tasks.filter((task) => ["in_progress", "blocked"].includes(task.status))),
  },
  {
    id: "review",
    label: "Review",
    description: "Needs review, merge, or closure.",
    tasks: sortTasks(props.tasks.filter((task) => ["in_review", "merged"].includes(task.status))),
  },
  {
    id: "done",
    label: "Done",
    description: "Completed or intentionally closed.",
    tasks: sortTasks(props.tasks.filter((task) => ["done", "cancelled"].includes(task.status))),
  },
]);

async function addTask(): Promise<void> {
  const title = newTaskTitle.value.trim();
  if (!title) return;
  await runBoardMutation("add", async () => {
    const result = await window.letagentsDesktop.room.addTask(props.roomIdentifier, title);
    newTaskTitle.value = "";
    return result.task;
  });
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
    actions.push(statusAction("merged", "Mark merged", "primary", "merged"));
  }
  if (task.status === "merged") {
    actions.push(statusAction("done", "Mark done", "primary", "done"));
    actions.push(statusAction("reopen", "Reopen", "neutral", "accepted"));
  }
  if (work) {
    actions.push({
      id: "release-work",
      label: "Release work lease",
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

function sortTasks(tasks: DesktopTaskSummary[]): DesktopTaskSummary[] {
  return [...tasks].sort((left, right) => {
    const statusDelta = (statusRanks[left.status] || 999) - (statusRanks[right.status] || 999);
    if (statusDelta !== 0) return statusDelta;
    return timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  });
}

function workflowRefs(task: DesktopTaskSummary): DesktopTaskSummary["workflowRefs"] {
  return task.workflowRefs.length
    ? task.workflowRefs
    : task.prUrl
      ? [{ provider: "github", kind: "pull_request", label: "Pull request", url: task.prUrl }]
      : [];
}

function readableStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function shortTaskId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim());
  return match ? `T${match[1]}` : taskId.replace(/^task_/i, "T");
}

function workLease(task: DesktopTaskSummary) {
  return task.activeLeases.find((lease) => lease.kind === "work") || null;
}

function reviewLeases(task: DesktopTaskSummary) {
  return task.activeLeases.filter((lease) => lease.kind === "review");
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
      label: "Reviewer conflicts with worker",
      badge: "Conflict",
      detail: "The active worker also holds review authority. Assign a different reachable worker before merge handoff.",
    };
  }
  if (reviews.length) {
    return {
      state: "assigned",
      label: reviews.map((lease) => lease.holderLabel || lease.agentKey || "Reviewer").join(", "),
      badge: "Assigned",
      detail: "A separate review lane is recorded for this task. Release it here if the assignment is stale or incorrect.",
    };
  }
  return {
    state: "missing",
    label: "No reviewer assigned",
    badge: "Needed",
    detail: "Assign a reachable worker session for board review, or try claiming review authority from a registered desktop worker context.",
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

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 45) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

function timestampValue(value: string | null | undefined): number {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}
</script>
