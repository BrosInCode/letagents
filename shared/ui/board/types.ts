import type { BoardPlanningDocument, BoardPlanningSnapshot } from '../../board-planning.mjs';

export interface BoardTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  assigneeLabel: string | null;
  assigneeKey: string | null;
  provider?: string | null;
  avatarUrl?: string | null;
  pr?: { url: string; number: number | null; state?: string | null } | null;
  ticket?: { key: string; url?: string | null; provider: string } | null;
  updatedAt: string;
  allowedTransitions: { id: string; label: string; targetStatus: string }[];
}

export interface BoardServices {
  loadPlanning(): Promise<BoardPlanningSnapshot>;
  savePlanning(expectedRevision: number, document: BoardPlanningDocument): Promise<BoardPlanningSnapshot>;
  moveTask(taskId: string, transitionId: string): Promise<boolean>;
  openExternal(url: string): Promise<unknown> | void;
}
