// Tasks: board tasks with status, assignees, external refs and PR links.
import { z } from "zod";

import { defineMethod, queryInt } from "./core.mjs";
import { PullRequestLink } from "./git.mjs";

const TaskId = z.string().regex(/^task_[1-9]\d*$/, "Expected a task id such as task_42.");

export const TASK_STATUSES = /** @type {const} */ ([
  "proposed",
  "accepted",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
  "merged",
  "done",
  "cancelled",
]);

/** An agent or person working on a task, as the board names them. */
export const TaskWorker = z.object({
  name: z.string(),
  /** `owner/name` of an agent; null for a person. */
  agentKey: z.string().nullable(),
});

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  assignee: TaskWorker.nullable(),
  /** Agents holding a review of the task now. */
  reviewers: z.array(TaskWorker),
  createdBy: z.string(),
  /** The ticket the task tracks, as `provider:KEY` (`jira:HT-12`). */
  externalRef: z.string().nullable(),
  /** The ticket key alone (`HT-12`). */
  ticketKey: z.string().nullable(),
  /** The ticket's own status in its tracker, as last synced. */
  ticketState: z.string().nullable(),
  pullRequests: z.array(PullRequestLink),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TaskPage = z.object({
  /** In board order (oldest task first). */
  tasks: z.array(Task),
  /** Pass as `after` for the next page; null on the last page. */
  nextAfter: z.string().nullable(),
});

/** @typedef {z.infer<typeof TaskWorker>} TaskWorker */
/** @typedef {z.infer<typeof Task>} Task */
/** @typedef {z.infer<typeof TaskPage>} TaskPage */

export const listTasks = defineMethod({
  name: "tasks.list",
  area: "tasks",
  kind: "read",
  capability: "tasks.read",
  description:
    "Board tasks of the room in board order, `limit` at a time (1 to 100, default 50), optionally only one `status`. Each has its assignee, reviewers, ticket and linked pull requests with their check and review state. Pass `nextAfter` as `after` for the next page.",
  path: "/rooms/:room/tasks",
  input: z.strictObject({
    status: z.enum(TASK_STATUSES).optional(),
    after: TaskId.optional(),
    limit: queryInt({ min: 1, max: 100, default: 50 }),
  }),
  output: TaskPage,
  rateClass: "read",
});

export const getTask = defineMethod({
  name: "tasks.get",
  area: "tasks",
  kind: "read",
  capability: "tasks.read",
  description: "One board task by id (`task_42`), with its assignee, reviewers, ticket and linked pull requests.",
  path: "/rooms/:room/tasks/:taskId",
  input: z.strictObject({ taskId: TaskId }),
  output: Task,
  errors: ["not_found"],
  rateClass: "read",
});

export const methods = /** @type {const} */ ([listTasks, getTask]);
