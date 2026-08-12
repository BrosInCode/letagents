export type { LeaseActionPayload as TaskLeaseActionPayload } from '../task-lease-authority/model'
export type { ReviewLeaseActionPayload as TaskReviewLeaseActionPayload } from '../task-review-authority/model'

export interface TaskStatusUpdatePayload {
  taskId: string
  status: string
  onSettled?: (updated: boolean) => void
}
