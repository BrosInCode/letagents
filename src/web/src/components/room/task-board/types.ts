export type { LeaseActionPayload as TaskLeaseActionPayload } from '../task-lease-authority/model'
export type { ReviewLeaseActionPayload as TaskReviewLeaseActionPayload } from '../task-review-authority/model'

export type TaskUpdatePayload = {
  taskId: string
  onSettled?: (updated: boolean) => void
} & ({ status: string } | TaskContentPatch)
import type { TaskContentPatch } from '../../../../../../shared/task-markdown-editing.mjs'
