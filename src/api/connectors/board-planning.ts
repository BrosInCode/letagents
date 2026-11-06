import { desc, eq } from "drizzle-orm";

import type { BoardImportedPlanning, BoardSprint } from "../../../shared/board-planning.mjs";
import { db } from "../db/client.js";
import { external_items, tasks } from "../db/schema.js";
import { asRecord } from "./providers/http.js";
import { jiraIteration, linearCycleState, planningEstimate, trackerAvatarUrl, TRACKER_ITERATION_STALE_MS } from "./providers/planning.js";

/** Only already-bound cards in this room contribute tracker planning data. */
export async function getImportedBoardPlanning(roomId: string, now = new Date()): Promise<BoardImportedPlanning> {
  const rows = await db.select({
    taskNumber: tasks.number,
    connectionId: external_items.connection_id,
    provider: external_items.provider,
    payload: external_items.payload,
    assigneeId: external_items.assignee_id,
    assigneeName: external_items.assignee_label,
    ticketState: external_items.ticket_state,
    syncedAt: external_items.synced_at,
  }).from(tasks)
    .innerJoin(external_items, eq(tasks.external_item_id, external_items.id))
    .where(eq(tasks.room_id, roomId))
    .orderBy(desc(external_items.synced_at));
  const sprints = new Map<string, BoardSprint>();
  const importedTasks: BoardImportedPlanning["tasks"] = {};
  for (const row of rows) {
    if (row.provider !== "jira" && row.provider !== "linear") continue;
    const planning = asRecord(row.payload?.planning);
    if (!Object.keys(planning).length) continue;
    const checkedAt = Date.parse(row.syncedAt);
    const iterations = (Array.isArray(planning.iterations) ? planning.iterations : [])
      .flatMap(value => {
        const iteration = jiraIteration(value);
        if (!iteration) return [];
        const cycleState = row.provider === "linear" ? linearCycleState(planning.cycleTiming, now) : null;
        const stale = planning.iterationsAvailable === false || (row.provider === "linear" ? !cycleState
          : !Number.isFinite(checkedAt) || now.getTime() - checkedAt > TRACKER_ITERATION_STALE_MS);
        const id = `imported:${row.provider}:${row.connectionId}:${iteration.id}`;
        if (id.length > 240 || !/^[A-Za-z0-9_.:/-]+$/.test(id)) return [];
        if (!sprints.has(id)) sprints.set(id, {
          ...iteration, id, state: cycleState ?? iteration.state,
          source: { provider: row.provider, connectionId: row.connectionId, id: iteration.id,
            ...(Number.isFinite(checkedAt) ? { checkedAt: new Date(checkedAt).toISOString() } : {}), stale },
        });
        return [id];
      });
    const order = { active: 0, future: 1, closed: 2 };
    const primary = [...iterations].sort((a, b) => order[sprints.get(a)!.state] - order[sprints.get(b)!.state]
      || (sprints.get(b)!.startDate ?? "").localeCompare(sprints.get(a)!.startDate ?? ""))[0] ?? null;
    importedTasks[`task_${row.taskNumber}`] = {
      estimate: planningEstimate(planning.estimate), sprintId: primary, sprintIds: [...new Set(iterations)],
      assigneeId: row.assigneeId ? `${row.provider}:${row.connectionId}:${row.assigneeId}` : null,
      assigneeName: row.assigneeName,
      assigneeAvatarUrl: trackerAvatarUrl(planning.assigneeAvatarUrl),
      ticketState: row.ticketState,
      done: row.ticketState === "done",
    };
  }
  return { sprints: [...sprints.values()], tasks: importedTasks };
}
