export const EXECUTION_DELEGATION_DECISIONS: readonly ["allow_once", "deny"];

export type ExecutionDelegationDecisionChoice =
  typeof EXECUTION_DELEGATION_DECISIONS[number];

export function isExecutionDelegationDecision(
  value: unknown,
): value is ExecutionDelegationDecisionChoice;
export function isExecutionDelegationIdentity(value: unknown): value is string;
export function isExecutionDelegationDigest(value: unknown): value is string;
export function isExecutionDelegationPositiveInt32(value: unknown): value is number;

export type ExecutionDelegationDecisionIntent = {
  decision_id: string;
  delegation_instance_id: string;
  delegation_revision: number;
  actor_account_id: string;
  request_id: string;
  request_version: number;
  request_sha256: string;
  projection_sha256: string;
  decision: ExecutionDelegationDecisionChoice;
  decided_at: string;
  owner_account_id: string;
  room_id: string;
  agent_key: string;
  approver_account_id: string;
  category: "file_change";
  risk_ceiling: "low";
  scope_sha256: string;
};

/** Return the exact host-delivered decision intent, or reject it as a whole. */
export function parseExecutionDelegationDecisionIntent(
  value: unknown,
): ExecutionDelegationDecisionIntent | null;
