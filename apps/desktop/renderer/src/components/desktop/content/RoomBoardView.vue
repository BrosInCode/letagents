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
import type { DesktopTaskSummary, WorkerSnapshot } from "../../../../../electron/ipc-types";
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
  workers: WorkerSnapshot[];
}>();

const emit = defineEmits<{
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
}>();

const newTaskTitle = ref("");
const busyAction = ref<string | null>(null);
const errorMessage = ref<string | null>(null);

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
      run: async (nextTask) => (await window.letagentsDesktop.room.updateTaskReviewLease(props.roomIdentifier, nextTask.id, {
        action: "release",
        lease_id: review.id,
        reason: `Released board review authority for ${nextTask.id} from desktop board.`,
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
