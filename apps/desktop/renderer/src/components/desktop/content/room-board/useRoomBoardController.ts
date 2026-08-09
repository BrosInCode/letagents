import { computed, ref } from "vue";
import type {
  DesktopAgentPresence,
  DesktopTaskCreateInput,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";
import { findLocalRoomWorker } from "./board-workers";
import { parseReviewCandidateValue, reviewAssignmentCandidates as getReviewAssignmentCandidates } from "./review-candidates";
import { reviewLeases, shouldShowReviewPanel, workLease } from "./task-state";
import type { TaskAction } from "./types";
import { desktopIpc } from "../../../../ipc/index.js";

interface RoomBoardControllerProps {
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  presence: DesktopAgentPresence[];
  workers: WorkerSnapshot[];
}

type RoomBoardEmit = {
  (event: "task-updated", task: DesktopTaskSummary): void;
  (event: "refresh-room"): void;
};

export function useRoomBoardController(
  props: RoomBoardControllerProps,
  emit: RoomBoardEmit
) {
  const busyAction = ref<string | null>(null);
  const errorMessage = ref<string | null>(null);
  const selectedReviewerByTask = ref<Record<string, string>>({});

  const localWorker = computed(() =>
    findLocalRoomWorker(props.workers, props.roomIdentifier)
  );

  async function addTask(input: DesktopTaskCreateInput): Promise<boolean> {
    const title = input.title.trim();
    if (!title) return false;
    return runBoardMutation("add", async () => {
      const result = await desktopIpc.room.addTask(props.roomIdentifier, {
        title,
        description: input.description?.trim() || null,
      });
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
      if (!work) actions.push(statusAction("cancel", "Cancel task", "danger", "cancelled", false, "Cancelling..."));
    }
    if (task.status === "accepted") {
      if (worker && !work) {
        actions.push(workerAction("claim", "Claim", "primary"));
      }
      if (!work) actions.push(statusAction("cancel", "Cancel task", "danger", "cancelled", false, "Cancelling..."));
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
        label: "Release worker",
        busyLabel: "Releasing...",
        tone: "neutral",
        run: async (nextTask) => (await desktopIpc.room.updateTaskLease(props.roomIdentifier, nextTask.id, {
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
        busyLabel: "Releasing...",
        tone: "neutral",
        run: async (nextTask) => {
          if (workerReviewsTask) {
            return (await desktopIpc.room.runTaskReviewWorkerAction(props.roomIdentifier, nextTask.id, {
              action: "release",
              lease_id: review.id,
              reason: `Released board review authority for ${nextTask.id} from desktop board.`,
            })).task;
          }
          return (await desktopIpc.room.updateTaskReviewLease(props.roomIdentifier, nextTask.id, {
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
        busyLabel: "Claiming...",
        tone: "primary",
        run: async (nextTask) => (await desktopIpc.room.runTaskReviewWorkerAction(props.roomIdentifier, nextTask.id, {
          action: "claim",
          reason: `Claimed board review authority for ${nextTask.id} from desktop board.`,
        })).task,
      });
    }

    return actions;
  }

  function setSelectedReviewer(taskId: string, value: string): void {
    selectedReviewerByTask.value = {
      ...selectedReviewerByTask.value,
      [taskId]: value,
    };
  }

  function reviewAssignmentCandidates(task: DesktopTaskSummary): DesktopAgentPresence[] {
    return getReviewAssignmentCandidates(task, props.presence);
  }

  async function runTaskAction(task: DesktopTaskSummary, action: TaskAction): Promise<void> {
    await runBoardMutation(`${task.id}:${action.id}`, () => action.run(task));
  }

  async function assignReview(task: DesktopTaskSummary): Promise<void> {
    const selected = parseReviewCandidateValue(selectedReviewerByTask.value[task.id] || "");
    if (!selected) return;
    await runBoardMutation(`${task.id}:assign-review`, async () => {
      const result = await desktopIpc.room.updateTaskReviewLease(props.roomIdentifier, task.id, {
        action: "assign",
        target_actor_key: selected.agentKey,
        target_actor_instance_id: selected.agentInstanceId,
        target_agent_session_id: selected.agentSessionId,
        reason: `Assigned board review authority for ${task.id} from desktop board.`,
      });
      setSelectedReviewer(task.id, "");
      return result.task;
    });
  }

  async function runBoardMutation(id: string, mutation: () => Promise<DesktopTaskSummary>): Promise<boolean> {
    if (busyAction.value !== null) return false;
    busyAction.value = id;
    errorMessage.value = null;
    try {
      const task = await mutation();
      emit("task-updated", task);
      emit("refresh-room");
      return true;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Task update failed.";
      return false;
    } finally {
      busyAction.value = null;
    }
  }

  function statusAction(
    id: string,
    label: string,
    tone: TaskAction["tone"],
    status: string,
    draggable = true,
    busyLabel?: string
  ): TaskAction {
    return {
      id,
      label,
      busyLabel,
      tone,
      targetStatus: draggable ? status : undefined,
      run: async (task) => (await desktopIpc.room.updateTask(props.roomIdentifier, task.id, { status })).task,
    };
  }

  function workerAction(
    action: "claim" | "start" | "block" | "resume" | "submit_review",
    label: string,
    tone: TaskAction["tone"]
  ): TaskAction {
    const targetStatusByAction: Record<typeof action, string> = {
      claim: "assigned",
      start: "in_progress",
      block: "blocked",
      resume: "in_progress",
      submit_review: "in_review",
    };
    const busyLabelByAction: Record<typeof action, string> = {
      claim: "Claiming...",
      start: "Starting...",
      block: "Blocking...",
      resume: "Resuming...",
      submit_review: "Submitting...",
    };
    return {
      id: action,
      label,
      busyLabel: busyLabelByAction[action],
      tone,
      targetStatus: targetStatusByAction[action],
      run: async (task) => (await desktopIpc.room.runTaskWorkerAction(props.roomIdentifier, task.id, { action })).task,
    };
  }

  function canClaimReview(task: DesktopTaskSummary): boolean {
    return Boolean(localWorker.value) && shouldShowReviewPanel(task) && reviewLeases(task).length === 0;
  }

  return {
    actionsFor,
    addTask,
    assignReview,
    busyAction,
    errorMessage,
    reviewAssignmentCandidates,
    runTaskAction,
    selectedReviewerByTask,
    setSelectedReviewer,
  };
}
