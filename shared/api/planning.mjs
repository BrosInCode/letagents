// Planning: sprints, the release queue and the board planning document.
import { z } from "zod";

import { defineMethod } from "./core.mjs";
import { PullRequestLink } from "./git.mjs";

export const BoardColumn = z.object({
  id: z.string(),
  name: z.string(),
  /** The task statuses this column shows. */
  statuses: z.array(z.string()),
});

export const Sprint = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["future", "active", "closed"]),
  /** `YYYY-MM-DD`; null when the sprint has no dates. */
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  goal: z.string().nullable(),
  /** The tracker an imported sprint comes from; null for a sprint made on the board. */
  source: z.object({
    provider: z.string(),
    /** The tracker could not be read lately, so dates and state may be old. */
    stale: z.boolean(),
  }).nullable(),
  /** Story points the team aims to finish in the sprint. */
  targetPoints: z.number(),
  /** Tasks planned into the sprint. */
  taskIds: z.array(z.string()),
});

/** How one task is planned. Missing values are null. */
export const TaskPlan = z.object({
  taskId: z.string(),
  sprintId: z.string().nullable(),
  /** Story points. */
  estimate: z.number().nullable(),
  type: z.enum(["task", "bug", "feature"]).nullable(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
});

export const ReleaseItem = z.object({
  taskId: z.string(),
  title: z.string(),
  ticketKey: z.string().nullable(),
  ticketUrl: z.string().nullable(),
  /** Who the ticket or task belongs to. */
  owner: z.string().nullable(),
  /** When the ticket's release fields were last read from its tracker. */
  checkedAt: z.string().nullable(),
  pullRequests: z.array(PullRequestLink),
});

export const ReleaseQueue = z.object({
  /**
   * What puts a task in the queue: a board column (`column`), a tracker field
   * value (`tracker`), or nothing yet (null, and `items` is empty).
   */
  rule: z.enum(["column", "tracker"]).nullable(),
  items: z.array(ReleaseItem),
  /** Tickets whose release state cannot be read now; never take these as "not released". */
  unavailable: z.number().int().nonnegative(),
});

export const Planning = z.object({
  /** Goes up by one on each saved change to the plan. */
  revision: z.number().int().nonnegative(),
  columns: z.array(BoardColumn),
  /** Board sprints first, then sprints imported from trackers. */
  sprints: z.array(Sprint),
  defaultTargetPoints: z.number(),
  /** Only tasks that have a plan: a sprint, an estimate, a type or a priority. */
  tasks: z.array(TaskPlan),
  releaseQueue: ReleaseQueue,
});

/** @typedef {z.infer<typeof BoardColumn>} BoardColumn */
/** @typedef {z.infer<typeof Sprint>} Sprint */
/** @typedef {z.infer<typeof TaskPlan>} TaskPlan */
/** @typedef {z.infer<typeof ReleaseItem>} ReleaseItem */
/** @typedef {z.infer<typeof ReleaseQueue>} ReleaseQueue */
/** @typedef {z.infer<typeof Planning>} Planning */

export const getPlanning = defineMethod({
  name: "planning.get",
  area: "planning",
  kind: "read",
  capability: "planning.read",
  description:
    "The room's board plan: columns, sprints (made on the board or imported from a tracker) with their targets and tasks, each planned task's sprint, estimate, type and priority, and the release queue with its tickets and pull requests.",
  path: "/rooms/:room/planning",
  input: z.strictObject({}),
  output: Planning,
  rateClass: "read",
  agents: "read",
});

export const methods = /** @type {const} */ ([getPlanning]);
