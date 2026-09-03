import type { ExecutionDelegationDecisionChoice } from "../../../../shared/execution-delegation-decision.mjs";

export type ExecutionDelegationCategory = "file_change";
export type ExecutionDelegationRiskCeiling = "low";

export interface ExecutionDelegationGrant {
  delegation_instance_id: string;
  revision: number;
  owner_account_id: string;
  /** Grant that proved authority when this immutable revision was admitted. */
  admission_supervisor_grant_id: string;
  host_id: string;
  installation_id: string;
  scope_key: "owner";
  room_id: string;
  agent_key: string;
  approver_account_id: string;
  category: ExecutionDelegationCategory;
  risk_ceiling: ExecutionDelegationRiskCeiling;
  /** Exact scope digest at admission; canonical FK renames do not rewrite history. */
  scope_sha256: string;
  client_request_id: string;
  request_fingerprint: string;
  created_at: string;
  expires_at: string;
  expired_at: string | null;
  retired_at: string | null;
  retired_by_revision: number | null;
  revoked_at: string | null;
}

export type { ExecutionDelegationDecisionChoice };

export interface ExecutionDelegationDecision {
  decision_id: string;
  delegation_instance_id: string;
  delegation_revision: number;
  actor_account_id: string;
  request_id: string;
  request_version: number;
  request_sha256: string;
  projection_sha256: string;
  decision: ExecutionDelegationDecisionChoice;
  client_request_id: string;
  request_fingerprint: string;
  decided_at: string;
}

export interface ExecutionDelegationDecisionForHost extends ExecutionDelegationDecision {
  owner_account_id: string;
  host_id: string;
  installation_id: string;
  scope_key: "owner";
  room_id: string;
  agent_key: string;
  approver_account_id: string;
  category: ExecutionDelegationCategory;
  risk_ceiling: ExecutionDelegationRiskCeiling;
  scope_sha256: string;
}
