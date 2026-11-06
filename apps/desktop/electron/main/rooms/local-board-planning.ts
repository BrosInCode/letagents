import {
  BoardPlanningConflictError, defaultBoardPlanning, validateBoardPlanningReferences, validateBoardPlanningUpdate,
  type BoardPlanningSnapshot, type BoardPlanningUpdate,
} from "../../../../../shared/board-planning.mjs";
import { isLocalBoardOwner, notifyLocalBoardChanged } from "../../../../../shared/local-board-owner.mjs";
import { beginImmediate, rollback, type SqliteDatabase } from "./local-db.js";
import { getLocalRoom, getLocalTaskDatabase, listLocalTasks } from "./local-store.js";
import { requestDesktopBoardMutation } from "./local-task-subscription.js";

function ensurePlanningSchema(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS local_board_planning (
    room_id TEXT PRIMARY KEY REFERENCES local_rooms(room_id) ON DELETE CASCADE ON UPDATE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 0), document TEXT NOT NULL
  )`);
}

export async function getLocalBoardPlanning(roomId: string): Promise<BoardPlanningSnapshot> {
  if (!isLocalBoardOwner()) return requestDesktopBoardMutation("getLocalBoardPlanning", [roomId]);
  if (!await getLocalRoom(roomId)) throw new Error("This local room is no longer available.");
  const database = await getLocalTaskDatabase();
  ensurePlanningSchema(database);
  const row = database.prepare("SELECT revision, document FROM local_board_planning WHERE room_id=?").get(roomId);
  const tasks = await listLocalTasks(roomId);
  const providers = new Map<string, string>();
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_supervisor_grants'").get()) {
    for (const grant of database.prepare("SELECT agent_key, provider FROM local_supervisor_grants WHERE room_id=? ORDER BY created_at DESC, grant_id DESC").all(roomId)) {
      if (!providers.has(String(grant.agent_key))) providers.set(String(grant.agent_key), String(grant.provider));
    }
  }
  return {
    roomId, revision: Number(row?.revision ?? 0), document: row ? JSON.parse(String(row.document)) : defaultBoardPlanning(),
    imported: { sprints: [], tasks: {} }, canEdit: true,
    taskFacts: tasks.map(task => ({
      id: task.id, title: task.title, status: task.status, assignee: task.assignee ?? null,
      assigneeAgentKey: task.assigneeAgentKey ?? null, provider: task.assigneeAgentKey ? providers.get(task.assigneeAgentKey) ?? null : null,
      prUrl: task.prUrl ?? null, externalRef: null, ticketUrl: null, updatedAt: task.updatedAt,
    })),
  };
}

export async function updateLocalBoardPlanning(roomId: string, raw: BoardPlanningUpdate): Promise<BoardPlanningSnapshot> {
  if (!isLocalBoardOwner()) return requestDesktopBoardMutation("updateLocalBoardPlanning", [roomId, raw]);
  const input = validateBoardPlanningUpdate(raw);
  if (!await getLocalRoom(roomId)) throw new Error("This local room is no longer available.");
  const database = await getLocalTaskDatabase();
  ensurePlanningSchema(database);
  beginImmediate(database);
  try {
    const row = database.prepare("SELECT revision FROM local_board_planning WHERE room_id=?").get(roomId);
    if (Number(row?.revision ?? 0) !== input.expectedRevision) throw new BoardPlanningConflictError();
    const taskIds = new Set(database.prepare("SELECT task_id FROM local_tasks WHERE room_id=?").all(roomId).map(row => String(row.task_id)));
    validateBoardPlanningReferences(input.document, taskIds, new Set());
    database.prepare(`INSERT INTO local_board_planning(room_id, revision, document) VALUES (?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET revision=excluded.revision, document=excluded.document`)
      .run(roomId, input.expectedRevision + 1, JSON.stringify(input.document));
    database.prepare(`INSERT INTO local_task_revisions(room_id, revision) VALUES (?, 1)
      ON CONFLICT(room_id) DO UPDATE SET revision=revision+1`).run(roomId);
    database.exec("COMMIT");
  } catch (error) { rollback(database); throw error; }
  notifyLocalBoardChanged(roomId);
  return getLocalBoardPlanning(roomId);
}
