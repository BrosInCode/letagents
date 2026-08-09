import { computed, type Ref } from 'vue'

import type { RoomTask } from '../../../composables/useRoom'
import {
  TASK_STATUS_ORDER,
  taskStatusLabel,
} from '../../../domain/taskStatus'

const LEASE_AUTHORITY_STATUSES = new Set(['assigned', 'in_progress', 'blocked', 'in_review'])

export interface TaskAction {
  label: string
  cls: string
  status: string
}

export interface TaskGroup {
  status: string
  label: string
  tasks: RoomTask[]
}

export type TaskLease = NonNullable<RoomTask['active_leases']>[number]
export type { TaskLeaseActionPayload, TaskReviewLeaseActionPayload } from './types'

export function useTaskGroups(tasks: Ref<readonly RoomTask[]>) {
  return computed<TaskGroup[]>(() => {
    const groups = new Map<string, RoomTask[]>()
    for (const task of tasks.value) {
      const status = task.status || 'proposed'
      if (!groups.has(status)) groups.set(status, [])
      groups.get(status)!.push(task as RoomTask)
    }
    const canonicalGroups = TASK_STATUS_ORDER
      .filter(status => groups.has(status))
      .map(status => ({
        status,
        label: taskStatusLabel(status),
        tasks: groups.get(status)!,
      }))
    const additionalGroups = [...groups.entries()]
      .filter(([status]) => !TASK_STATUS_ORDER.includes(status as typeof TASK_STATUS_ORDER[number]))
      .map(([status, groupTasks]) => ({ status, label: taskStatusLabel(status), tasks: groupTasks }))
    return [...canonicalGroups, ...additionalGroups]
  })
}

export function getTaskActions(task: RoomTask): TaskAction[] {
  switch (task.status) {
    case 'proposed':
      return [
        { label: 'Accept', cls: 'accept', status: 'accepted' },
        { label: 'Cancel', cls: 'cancel', status: 'cancelled' },
      ]
    case 'in_review':
      return [{ label: 'Mark Merged', cls: 'merge', status: 'merged' }]
    case 'merged':
      return [{ label: 'Mark Done', cls: 'merge', status: 'done' }]
    case 'accepted':
      return [{ label: 'Cancel', cls: 'cancel', status: 'cancelled' }]
    default:
      return []
  }
}

export function canFocusTask(task: RoomTask): boolean {
  return !['done', 'cancelled'].includes(task.status)
}

export function formatActorName(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const parts = normalized.split('|').map(part => part.trim()).filter(Boolean)
  return parts[0] || normalized
}

export function getWorkLease(task: RoomTask): TaskLease | null {
  return task.active_leases?.find(lease => lease.kind === 'work') ?? null
}

export function getSecondaryLeases(task: RoomTask): TaskLease[] {
  return (task.active_leases ?? []).filter(lease => lease.kind !== 'work' && lease.kind !== 'review')
}

export function shouldShowAuthority(task: RoomTask): boolean {
  return Boolean(getWorkLease(task) || task.assignee || LEASE_AUTHORITY_STATUSES.has(task.status))
}

export function shouldShowReviewAuthority(task: RoomTask): boolean {
  return Boolean(
    task.active_leases?.some(lease => lease.kind === 'review')
    || ['in_review', 'blocked'].includes(task.status)
  )
}

export function formatTimestamp(timestamp: string): string {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatTaskShortId(taskId: string): string {
  const match = /^task_(\d+)$/i.exec(taskId.trim())
  if (match) return `T${match[1]}`
  return taskId.replace(/^task_/i, 'T')
}

export function getTaskWorkflowRefs(task: RoomTask) {
  return task.workflow_refs?.length
    ? task.workflow_refs
    : task.pr_url
      ? [{ provider: 'unknown', kind: 'pull_request', label: 'PR', url: task.pr_url }]
      : []
}
