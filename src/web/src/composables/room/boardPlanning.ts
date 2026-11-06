import type { BoardPlanningSnapshot, BoardPlanningUpdate } from '../../../../../shared/board-planning.mjs'
import { apiFetch, roomPath } from './api'

export function fetchBoardPlanning(roomIdentifier: string): Promise<BoardPlanningSnapshot> {
  return apiFetch(`${roomPath(roomIdentifier)}/board-planning`)
}

export function saveBoardPlanning(roomIdentifier: string, input: BoardPlanningUpdate): Promise<BoardPlanningSnapshot> {
  return apiFetch(`${roomPath(roomIdentifier)}/board-planning`, {
    method: 'PATCH', body: JSON.stringify(input),
  })
}
