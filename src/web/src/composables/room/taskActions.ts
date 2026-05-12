import { apiFetch, roomPath } from './api'
import { fetchPresence, fetchTasks } from './data'
import type {
  RoomAgentPresence,
  RoomTask,
  TaskLeaseActionInput,
  TaskReviewLeaseActionInput,
} from './types'

export function taskFromMutationResult(
  taskId: string,
  data: any,
): RoomTask | null {
  const task = data.task || (data.id ? data : null)
  return task ? { ...task, id: task.id || taskId } : null
}

export async function fetchTasksAndPresence(
  roomIdentifier: string,
): Promise<{ tasks: RoomTask[]; presence: RoomAgentPresence[] }> {
  const [tasks, presence] = await Promise.all([
    fetchTasks(roomIdentifier),
    fetchPresence(roomIdentifier),
  ])
  return { tasks, presence }
}

export async function createRoomTask(
  roomIdentifier: string,
  title: string,
): Promise<RoomTask | null> {
  const data = await apiFetch(`${roomPath(roomIdentifier)}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title, created_by: 'human' }),
  })
  return data.task || null
}

export async function patchRoomTask(
  roomIdentifier: string,
  taskId: string,
  updates: Partial<RoomTask>,
): Promise<RoomTask | null> {
  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
  )
  return taskFromMutationResult(taskId, data)
}

export async function postTaskLeaseAction(
  roomIdentifier: string,
  taskId: string,
  input: TaskLeaseActionInput,
): Promise<RoomTask | null> {
  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/tasks/${encodeURIComponent(taskId)}/lease-action`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
  return taskFromMutationResult(taskId, data)
}

export async function postTaskReviewLeaseAction(
  roomIdentifier: string,
  taskId: string,
  input: TaskReviewLeaseActionInput,
): Promise<RoomTask | null> {
  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/tasks/${encodeURIComponent(taskId)}/review-lease-action`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
  return taskFromMutationResult(taskId, data)
}

export async function setRoomTaskStalePromptMute(
  roomIdentifier: string,
  taskId: string,
  muted: boolean,
  options?: { promptTimestamp?: string | null },
): Promise<RoomTask | null> {
  const data = await apiFetch(
    `${roomPath(roomIdentifier)}/tasks/${encodeURIComponent(taskId)}/stale-prompt-mute`,
    {
      method: muted ? 'POST' : 'DELETE',
      body: JSON.stringify({
        prompt_timestamp: options?.promptTimestamp ?? null,
      }),
    },
  )
  return taskFromMutationResult(taskId, data)
}
