import {
  createRoomTask,
  mergeCreatedTask,
  patchRoomTask,
  postTaskLeaseAction,
  postTaskReviewLeaseAction,
  setRoomTaskStalePromptMute,
} from './taskActions'
import { room, tasks, upsertTask } from './state'
import { fetchTasks } from './data'
import type {
  RoomTask,
  TaskLeaseActionInput,
  TaskReviewLeaseActionInput,
} from './types'

interface RoomTaskMutationDeps {
  refreshRoomBoard: () => Promise<boolean>
  refreshTasksAndPresence: (roomIdentifier: string) => Promise<void>
}

export function createRoomTaskMutations(deps: RoomTaskMutationDeps) {
  async function addTask(title: string): Promise<boolean> {
    if (!room.value) return false
    const roomIdentifier = room.value.identifier
    try {
      const task = await createRoomTask(roomIdentifier, title)
      if (room.value?.identifier !== roomIdentifier) return false
      if (task) tasks.value = mergeCreatedTask(tasks.value, task)

      await deps.refreshRoomBoard()
      if (
        task &&
        room.value?.identifier === roomIdentifier &&
        !tasks.value.some((item) => item.id === task.id)
      ) {
        tasks.value = mergeCreatedTask(tasks.value, task)
      }
      return true
    } catch {
      return false
    }
  }

  async function updateTask(
    taskId: string,
    updates: Partial<RoomTask>,
  ): Promise<boolean> {
    if (!room.value) return false
    try {
      const task = await patchRoomTask(room.value.identifier, taskId, updates)
      if (task) upsertTask(task)
      await deps.refreshTasksAndPresence(room.value.identifier)
      return true
    } catch {
      return false
    }
  }

  async function updateTaskLease(
    taskId: string,
    input: TaskLeaseActionInput,
  ): Promise<boolean> {
    if (!room.value) return false
    try {
      const task = await postTaskLeaseAction(
        room.value.identifier,
        taskId,
        input,
      )
      if (task) upsertTask(task)
      await deps.refreshTasksAndPresence(room.value.identifier)
      return true
    } catch {
      return false
    }
  }

  async function updateTaskReviewLease(
    taskId: string,
    input: TaskReviewLeaseActionInput,
  ): Promise<boolean> {
    if (!room.value) return false
    try {
      const task = await postTaskReviewLeaseAction(
        room.value.identifier,
        taskId,
        input,
      )
      if (task) upsertTask(task)
      await deps.refreshTasksAndPresence(room.value.identifier)
      return true
    } catch {
      return false
    }
  }

  async function setTaskStalePromptMute(
    taskId: string,
    muted: boolean,
    options?: { promptTimestamp?: string | null },
  ): Promise<boolean> {
    if (!room.value) return false
    try {
      const task = await setRoomTaskStalePromptMute(
        room.value.identifier,
        taskId,
        muted,
        options,
      )
      if (task) upsertTask(task)
      tasks.value = await fetchTasks(room.value.identifier)
      return true
    } catch (error) {
      tasks.value = await fetchTasks(room.value.identifier)
      if ((error as { code?: string | null }).code === 'STALE_PROMPT_OUTDATED') {
        return true
      }
      return false
    }
  }

  return {
    addTask,
    setTaskStalePromptMute,
    updateTask,
    updateTaskLease,
    updateTaskReviewLease,
  }
}
