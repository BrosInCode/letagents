import type {
  RoomTask,
  TaskLeaseActionInput,
  TaskReviewLeaseActionInput,
} from '@/composables/useRoom'
import type {
  TaskLeaseActionPayload,
  TaskReviewLeaseActionPayload,
  TaskStatusUpdatePayload,
} from './types'

interface RoomTaskHandlerDeps {
  addTask: (title: string) => Promise<boolean>
  updateTask: (taskId: string, updates: Partial<RoomTask>) => Promise<boolean>
  updateTaskLease: (taskId: string, input: TaskLeaseActionInput) => Promise<boolean>
  updateTaskReviewLease: (
    taskId: string,
    input: TaskReviewLeaseActionInput,
  ) => Promise<boolean>
  setTaskStalePromptMute: (
    taskId: string,
    muted: boolean,
    options?: { promptTimestamp?: string | null },
  ) => Promise<boolean>
  toast: {
    error(message: string, duration?: number): void
  }
}

export function useRoomTaskHandlers(deps: RoomTaskHandlerDeps) {
  async function handleAddTask(title: string) {
    await deps.addTask(title)
  }

  async function handleUpdateTask(payload: TaskStatusUpdatePayload) {
    let updated = false
    try {
      updated = await deps.updateTask(payload.taskId, { status: payload.status })
      if (!updated) {
        deps.toast.error('Task status could not be updated.')
      }
    } finally {
      payload.onSettled?.(updated)
    }
  }

  async function handleTaskLeaseAction(payload: TaskLeaseActionPayload) {
    try {
      const updated = await deps.updateTaskLease(
        payload.taskId,
        taskLeaseInputFromPayload(payload),
      )
      if (!updated) {
        deps.toast.error('Task lease could not be updated.')
      }
    } finally {
      payload.onSettled?.()
    }
  }

  async function handleTaskReviewLeaseAction(payload: TaskReviewLeaseActionPayload) {
    try {
      const updated = await deps.updateTaskReviewLease(
        payload.taskId,
        taskReviewLeaseInputFromPayload(payload),
      )
      if (!updated) {
        deps.toast.error('Task review authority could not be updated.')
      }
    } finally {
      payload.onSettled?.()
    }
  }

  async function handleToggleStalePromptMute(payload: {
    taskId: string
    muted: boolean
    promptTimestamp: string
  }) {
    const updated = await deps.setTaskStalePromptMute(payload.taskId, payload.muted, {
      promptTimestamp: payload.promptTimestamp,
    })
    if (!updated) {
      deps.toast.error('Stale task reminder preference could not be updated.')
    }
  }

  return {
    handleAddTask,
    handleTaskLeaseAction,
    handleTaskReviewLeaseAction,
    handleToggleStalePromptMute,
    handleUpdateTask,
  }
}

function taskLeaseInputFromPayload(payload: TaskLeaseActionPayload): TaskLeaseActionInput {
  return {
    action: payload.action,
    lease_id: payload.lease_id ?? null,
    target_actor_key: payload.target_actor_key ?? null,
    target_actor_instance_id: payload.target_actor_instance_id ?? null,
    target_agent_session_id: payload.target_agent_session_id ?? null,
    reason: payload.reason ?? null,
  }
}

function taskReviewLeaseInputFromPayload(
  payload: TaskReviewLeaseActionPayload,
): TaskReviewLeaseActionInput {
  return {
    action: payload.action,
    lease_id: payload.lease_id ?? null,
    target_actor_key: payload.target_actor_key ?? null,
    target_actor_instance_id: payload.target_actor_instance_id ?? null,
    target_agent_session_id: payload.target_agent_session_id ?? null,
    reason: payload.reason ?? null,
  }
}
