import { boardTaskPlanning, type BoardSprint } from "../../../../shared/board-planning.mjs";
import { getPlanning, type Planning, type Sprint, type TaskPlan } from "../../../../shared/api/planning.mjs";
import { getBoardPlanning } from "../../db/board-planning.js";
import { defineRoute, type ApiRoute } from "../route.js";
import { toPullRequestLink } from "./git.js";

// Routes for the methods in shared/api/planning.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  // The snapshot GET /rooms/:room/board-planning answers, in a shape that does
  // not follow the board's storage. Whether the viewer may edit stays out:
  // edits are not part of this read.
  defineRoute(getPlanning, async (_input, { room }): Promise<Planning> => {
    const snapshot = await getBoardPlanning(room.id, false);
    const { document, imported } = snapshot;
    const plans: TaskPlan[] = [];
    const sprintTasks = new Map<string, string[]>();
    for (const task of snapshot.taskFacts) {
      const plan = boardTaskPlanning(snapshot, task.id);
      const sprintId = plan.sprintId ?? null;
      if (sprintId) sprintTasks.set(sprintId, [...(sprintTasks.get(sprintId) ?? []), task.id]);
      if (sprintId === null && plan.estimate == null && !plan.type && !plan.priority) continue;
      plans.push({ taskId: task.id, sprintId, estimate: plan.estimate ?? null, type: plan.type ?? null, priority: plan.priority ?? null });
    }
    const toSprint = (sprint: BoardSprint): Sprint => ({
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      goal: sprint.goal,
      source: sprint.source ? { provider: sprint.source.provider, stale: sprint.source.stale === true } : null,
      targetPoints: document.sprintTargets[sprint.id] ?? document.defaultTargetPoints,
      taskIds: sprintTasks.get(sprint.id) ?? [],
    });
    const releases = snapshot.releases ?? { items: [], unavailable: 0 };
    return {
      revision: snapshot.revision,
      columns: document.columns.map((column) => ({ id: column.id, name: column.name, statuses: [...column.statuses] })),
      sprints: [...document.sprints, ...imported.sprints].map(toSprint),
      defaultTargetPoints: document.defaultTargetPoints,
      tasks: plans,
      releaseQueue: {
        rule: document.releaseRule?.kind ?? null,
        items: releases.items.map((item) => ({
          taskId: item.taskId,
          title: item.title,
          ticketKey: item.ticketKey,
          ticketUrl: item.ticketUrl,
          owner: item.owner,
          checkedAt: item.checkedAt,
          pullRequests: item.pullRequests.map(toPullRequestLink),
        })),
        unavailable: releases.unavailable,
      },
    };
  }),
];
