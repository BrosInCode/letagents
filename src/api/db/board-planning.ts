import { and, eq, sql } from "drizzle-orm";
import {
  BoardPlanningConflictError, defaultBoardPlanning, validateBoardPlanningReferences,
  type BoardPlanningSnapshot, type BoardPlanningUpdate, type BoardTaskFact,
} from "../../../shared/board-planning.mjs";
import { getImportedBoardPlanning } from "../connectors/board-planning.js";
import { readTaskAgents } from "../connectors/my-work.js";
import { db } from "./client.js";
import { external_items, room_board_planning, tasks } from "./schema.js";

export async function readBoardTaskFacts(roomId: string): Promise<BoardTaskFact[]> {
  // One room-scoped read intentionally includes finished tasks. Sprint targets
  // cannot be computed from the UI's currently loaded task page.
  const rows = await db.select({
    number: tasks.number, title: tasks.title, status: tasks.status,
    assignee: tasks.assignee, assigneeAgentKey: tasks.assignee_agent_key,
    prUrl: tasks.pr_url, externalRef: tasks.external_ref, ticketUrl: external_items.url,
    updatedAt: tasks.updated_at,
  }).from(tasks).leftJoin(external_items, eq(tasks.external_item_id, external_items.id))
    .where(eq(tasks.room_id, roomId)).orderBy(tasks.number);
  const agentKeys = [...new Set(rows.map(row => row.assigneeAgentKey).filter((key): key is string => key !== null))];
  const agents = await readTaskAgents(agentKeys.map(key => ({ room_id: roomId, assignee_agent_key: key })));
  return rows.map(row => ({
    id: `task_${row.number}`, title: row.title, status: row.status,
    assignee: row.assignee, assigneeAgentKey: row.assigneeAgentKey,
    provider: row.assigneeAgentKey ? agents.get(`${roomId}\n${row.assigneeAgentKey}`)?.provider ?? null : null,
    prUrl: row.prUrl, externalRef: row.externalRef, ticketUrl: row.ticketUrl, updatedAt: row.updatedAt,
  }));
}

export async function getBoardPlanning(roomId: string, canEdit: boolean): Promise<BoardPlanningSnapshot> {
  const [rows, taskFacts, imported] = await Promise.all([
    db.select().from(room_board_planning).where(eq(room_board_planning.room_id, roomId)).limit(1),
    readBoardTaskFacts(roomId), getImportedBoardPlanning(roomId),
  ]);
  return { roomId, revision: rows[0]?.revision ?? 0, document: rows[0]?.document ?? defaultBoardPlanning(), imported, taskFacts, canEdit };
}

/** Client revisions prevent silently overwriting another person's sprint or column changes. */
export async function updateBoardPlanning(roomId: string, actor: string, input: BoardPlanningUpdate): Promise<void> {
  const imported = await getImportedBoardPlanning(roomId);
  await db.transaction(async tx => {
    await tx.insert(room_board_planning).values({ room_id: roomId, document: defaultBoardPlanning(), updated_by: actor })
      .onConflictDoNothing();
    const [current] = await tx.select().from(room_board_planning).where(eq(room_board_planning.room_id, roomId)).for("update");
    if (!current || current.revision !== input.expectedRevision) throw new BoardPlanningConflictError();
    const taskIds = new Set((await tx.select({ number: tasks.number }).from(tasks).where(eq(tasks.room_id, roomId))).map(row => `task_${row.number}`));
    validateBoardPlanningReferences(input.document, taskIds, new Set(imported.sprints.map(sprint => sprint.id)));
    await tx.update(room_board_planning).set({ document: input.document, revision: sql`${room_board_planning.revision} + 1`, updated_by: actor, updated_at: new Date().toISOString() })
      .where(and(eq(room_board_planning.room_id, roomId), eq(room_board_planning.revision, input.expectedRevision)));
  });
}
