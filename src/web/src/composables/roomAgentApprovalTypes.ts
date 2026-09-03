import type { ExecutionApprovalPublicationItem } from '../../../../shared/execution-approval-publication-item.mjs'
import type { ExecutionApprovalProjectionV1 } from '../../../../shared/execution-approval-projection.mjs'

export type RoomAgentApprovalEvidenceStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'unsupported'
  | 'invalid'
  | 'unavailable'
  | 'error'

export interface RoomAgentApprovalEntry {
  publication: ExecutionApprovalPublicationItem
  evidenceStatus: RoomAgentApprovalEvidenceStatus
  projectionJson: string | null
  projection: ExecutionApprovalProjectionV1 | null
  evidenceError: string
  decisionBusy: boolean
  decisionError: string
}
