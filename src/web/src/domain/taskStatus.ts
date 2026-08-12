/**
 * The task lifecycle is a product contract, not a board-specific ordering.
 * Keep display labels and accent tokens here so every web surface names a
 * status in the same way.
 */
export const TASK_STATUS_ORDER = [
  'proposed',
  'accepted',
  'assigned',
  'in_progress',
  'blocked',
  'in_review',
  'merged',
  'done',
  'cancelled',
] as const

export type TaskStatus = typeof TASK_STATUS_ORDER[number]

export interface TaskStatusPresentation {
  label: string
  accentToken: string
}

export const TASK_STATUS_PRESENTATION: Readonly<Record<TaskStatus, TaskStatusPresentation>> = {
  proposed: { label: 'Proposed', accentToken: '--task-proposed' },
  accepted: { label: 'Accepted', accentToken: '--task-accepted' },
  assigned: { label: 'Assigned', accentToken: '--task-assigned' },
  in_progress: { label: 'In progress', accentToken: '--task-in-progress' },
  blocked: { label: 'Blocked', accentToken: '--task-blocked' },
  in_review: { label: 'In review', accentToken: '--task-in-review' },
  merged: { label: 'Merged', accentToken: '--task-merged' },
  done: { label: 'Done', accentToken: '--task-done' },
  cancelled: { label: 'Cancelled', accentToken: '--task-cancelled' },
}

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = Object.fromEntries(
  TASK_STATUS_ORDER.map(status => [status, TASK_STATUS_PRESENTATION[status].label]),
) as Readonly<Record<TaskStatus, string>>

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUS_ORDER.includes(value as TaskStatus)
}

export function taskStatusLabel(value: string): string {
  return isTaskStatus(value) ? TASK_STATUS_LABELS[value] : value.replace(/_/g, ' ')
}

export function taskStatusAccent(value: string): string {
  return isTaskStatus(value)
    ? `var(${TASK_STATUS_PRESENTATION[value].accentToken})`
    : 'var(--text-tertiary)'
}
