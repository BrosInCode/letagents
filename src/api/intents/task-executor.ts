import { createHash } from "node:crypto";

import type { TaskCreatePayload, TaskUpdatePayload } from "../../../shared/api/intents.mjs";
import type { Task, TaskStatus } from "../db.js";

/**
 * Board kinds run as the person who proposed them, with the rights the
 * person's own board routes give an app session (PATCH and POST
 * /rooms/:room/tasks): any participant may move a task, assign it or create
 * one; title, description and the statuses below need a room admin. An
 * approving admin adds no rights: the person's role is checked again when the
 * change runs. Board intents (the agent path) are not involved.
 */
export const ADMIN_ONLY_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["accepted", "cancelled", "merged", "done"]);

/** The board as the person's routes use it; tests pass their own. */
export interface TaskIntentBoard {
  getTask(roomId: string, taskId: string): Promise<Task | null>;
  /** True when a review lease separate from the work holder would let `merged` through. */
  hasBoardReviewLease(roomId: string, taskId: string): Promise<boolean>;
  updateTask(roomId: string, taskId: string, updates: TaskIntentUpdates): Promise<Task | null>;
  findTaskByClientId(roomId: string, clientTaskId: string): Promise<Task | null>;
  createTask(roomId: string, input: { title: string; description?: string; clientTaskId: string }): Promise<Task>;
  /** The status message and the task event the person's routes send after a change. */
  announce(roomId: string, task: Task, change: { statusChanged: boolean }): Promise<void>;
}

export interface TaskIntentUpdates {
  title?: string;
  description?: string;
  status?: TaskStatus;
  assignee?: string | null;
  assignee_agent_key?: string | null;
}

/** A refusal the proposer can act on: before an intent exists it is `not_granted`; when it runs, the intent fails with it. */
export class TaskIntentRefusal extends Error {
  constructor(readonly code: "not_found" | "not_granted" | "conflict", message: string) {
    super(message);
    this.name = "TaskIntentRefusal";
  }
}

function toUpdates(payload: TaskUpdatePayload): TaskIntentUpdates {
  const updates: TaskIntentUpdates = {};
  if (payload.title !== undefined) updates.title = payload.title;
  if (payload.description !== undefined) updates.description = payload.description;
  if (payload.status !== undefined) updates.status = payload.status;
  if (payload.assignee !== undefined) updates.assignee = payload.assignee;
  if (payload.assigneeAgentKey !== undefined) updates.assignee_agent_key = payload.assigneeAgentKey;
  return updates;
}

/**
 * Whether this person may make this change now. Runs when the intent is
 * proposed (so a change the person could never make is refused at once, with
 * no pending intent) and again when it runs.
 */
export async function checkTaskUpdate(
  board: Pick<TaskIntentBoard, "getTask" | "hasBoardReviewLease">,
  input: { roomId: string; payload: TaskUpdatePayload; isAdmin: boolean },
): Promise<Task> {
  const task = await board.getTask(input.roomId, input.payload.taskId);
  if (!task) throw new TaskIntentRefusal("not_found", `No task ${input.payload.taskId} in this room.`);
  const { payload } = input;
  if (!input.isAdmin && (payload.title !== undefined || payload.description !== undefined)) {
    throw new TaskIntentRefusal("not_granted", "Only a room admin can change a task's title or description.");
  }
  if (!input.isAdmin && payload.status && ADMIN_ONLY_TASK_STATUSES.has(payload.status)) {
    throw new TaskIntentRefusal("not_granted", `Only a room admin can move a task to ${payload.status}.`);
  }
  if (payload.status === "blocked" && task.status === "in_review") {
    // The person's route keeps this for a registered review worker session.
    throw new TaskIntentRefusal("not_granted", "Requesting changes on a task in review needs a review agent's session.");
  }
  if (payload.status === "merged" && task.status === "in_review" && !(await board.hasBoardReviewLease(input.roomId, task.id))) {
    throw new TaskIntentRefusal("conflict", "Assign a board reviewer separate from the active work holder before marking this task merged.");
  }
  return task;
}

/** Applies an approved `task.update` as the person. Returns `{ taskId }`. */
export async function runTaskUpdate(
  board: TaskIntentBoard,
  input: { roomId: string; payload: TaskUpdatePayload; isAdmin: boolean },
): Promise<{ taskId: string }> {
  const before = await checkTaskUpdate(board, input);
  const updated = await board.updateTask(input.roomId, before.id, toUpdates(input.payload));
  if (!updated) throw new TaskIntentRefusal("not_found", `No task ${input.payload.taskId} in this room.`);
  await board.announce(input.roomId, updated, { statusChanged: Boolean(input.payload.status && input.payload.status !== before.status) });
  return { taskId: updated.id };
}

/** The card's creation id: one intent creates at most one card, even when its run is repeated. */
export function intentClientTaskId(intentId: string): string {
  return createHash("sha256").update(JSON.stringify(["api_intent", intentId])).digest("hex");
}

/**
 * Creates the card as the person's app does (`created_by: "human"`). A room
 * admin's card is accepted at once, as on the board; anyone else's waits as
 * proposed for a room admin to accept.
 */
export async function runTaskCreate(
  board: TaskIntentBoard,
  input: { roomId: string; intentId: string; payload: TaskCreatePayload; isAdmin: boolean },
): Promise<{ taskId: string }> {
  const clientTaskId = intentClientTaskId(input.intentId);
  const existing = await board.findTaskByClientId(input.roomId, clientTaskId);
  if (existing) return { taskId: existing.id };
  const created = await board.createTask(input.roomId, {
    title: input.payload.title,
    ...(input.payload.description !== undefined ? { description: input.payload.description } : {}),
    clientTaskId,
  });
  const accepted = input.isAdmin ? await board.updateTask(input.roomId, created.id, { status: "accepted" }) : null;
  await board.announce(input.roomId, accepted ?? created, { statusChanged: Boolean(accepted) });
  return { taskId: created.id };
}

/** The production board: the same db functions and announcements as the person's task routes. */
export async function createDefaultTaskIntentBoard(): Promise<TaskIntentBoard> {
  const [dbModule, policy, details, events, services] = await Promise.all([
    import("../db.js"),
    import("../coordination-policy.js"),
    import("../routes/rooms/tasks/task-details.js"),
    import("../server/events.js"),
    import("../server/room-services.js"),
  ]);
  return {
    getTask: async (roomId, taskId) => (await dbModule.getTaskById(roomId, taskId)) ?? null,
    hasBoardReviewLease: async (roomId, taskId) => Boolean(policy.findBoardReviewLeaseForMerge({
      taskId,
      leases: await dbModule.getActiveTaskLeases(roomId, taskId),
    })),
    updateTask: (roomId, taskId, updates) => dbModule.updateTask(roomId, taskId, updates, {
      boardIntentApproval: null, workLeaseCreation: null, leaseFence: null,
    }),
    findTaskByClientId: dbModule.findTaskByClientId,
    createTask: (roomId, input) => dbModule.createTask(roomId, input.title, "human", input.description, undefined, {
      clientTaskId: input.clientTaskId,
    }),
    async announce(roomId, task, change) {
      // The change is committed; like the person's routes, a failed notice does not undo it.
      if (change.statusChanged) {
        try {
          await services.emitTaskLifecycleStatusMessage(roomId, task, {
            client_message_id: `task-status:${task.id}:${Date.parse(task.updated_at)}:${task.status}`,
            parent_client_message_id: `task-status-parent:${task.id}:${Date.parse(task.updated_at)}:${task.status}`,
          });
        } catch {
          console.warn("Task lifecycle notification failed after an API intent", { roomId, taskId: task.id });
        }
      }
      try {
        events.taskEvents.emit("task:updated", { projectId: roomId, task: await details.attachTaskDetails(roomId, task) });
      } catch {
        console.warn("Task event delivery failed after an API intent", { roomId, taskId: task.id });
      }
    },
  };
}
