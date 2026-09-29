import type { DatabaseSync } from "node:sqlite";

import {
  parseExecutionDelegationDecisionIntent,
  type ExecutionDelegationDecisionIntent,
} from "../../../shared/execution-delegation-decision.mjs";
import {
  ApprovalJournalError,
  getExecutionApproval,
  validateExecutionApprovalAuthority,
  type ApprovalAuthority,
  type ApprovalReference,
  type ExecutionApprovalRecord,
} from "./execution-approval-journal.js";
import {
  validateExecutionDelegation,
  type ExecutionDelegationHostAuthority,
} from "./execution-delegation-journal.js";
import type { DaemonManifestEntry } from "./types.js";

export type SelectDelegatedApproval = {
  intent: ExecutionDelegationDecisionIntent;
  expected: ApprovalReference;
  locallyWitnessedProjectionSha256: string;
  approvalAuthority: ApprovalAuthority;
  authority: ExecutionDelegationHostAuthority;
  atMs: number;
};

function reject(code: ApprovalJournalError["code"]): never {
  throw new ApprovalJournalError(code);
}

function sameCommittedIntent(
  record: ExecutionApprovalRecord,
  intent: ExecutionDelegationDecisionIntent,
): boolean {
  const decision = record.decision;
  return decision?.source === "delegate"
    && decision.decisionId === intent.decision_id
    && decision.actorId === intent.actor_account_id
    && decision.decision === intent.decision
    && decision.projectionSha256 === intent.projection_sha256
    && decision.delegationInstanceId === intent.delegation_instance_id
    && decision.delegationRevision === intent.delegation_revision
    && decision.delegationScopeSha256 === intent.scope_sha256;
}

/**
 * Record one immutable server intent as a local delegated selection.
 *
 * The caller owns the surrounding BEGIN IMMEDIATE transaction and repeats its
 * process-held host/runtime witnesses inside that transaction. This function
 * independently revalidates the exact local request and delegation revision.
 * The resulting decision is admission-complete, never a dispatch permit.
 */
export function selectDelegatedApproval(
  db: DatabaseSync,
  input: SelectDelegatedApproval,
  entry: DaemonManifestEntry | undefined,
): ExecutionApprovalRecord {
  const intent = parseExecutionDelegationDecisionIntent(input.intent);
  if (!intent || input.locallyWitnessedProjectionSha256 !== intent.projection_sha256
    || !Number.isSafeInteger(input.atMs) || input.atMs < 0) reject("invalid_input");

  const current = getExecutionApproval(db, input.expected);
  if (!current
    || current.request.requestId !== intent.request_id
    || current.request.requestVersion !== intent.request_version
    || current.request.requestSha256 !== intent.request_sha256
    || current.request.roomId !== intent.room_id) reject("identity_mismatch");
  if (current.decision) {
    if (!sameCommittedIntent(current, intent)) reject("decision_conflict");
    return current;
  }
  if (current.request.state !== "requested" || !current.request.delegatable
    || current.request.kind !== "file_change" || current.request.risk !== "low") reject("invalid_transition");
  if (input.atMs < current.request.createdAtMs) reject("invalid_input");
  if (input.atMs >= current.request.expiresAtMs) reject("expired");
  validateExecutionApprovalAuthority(db, input.expected, input.approvalAuthority, entry);

  const delegation = validateExecutionDelegation(db, {
    delegationInstanceId: intent.delegation_instance_id,
    revision: intent.delegation_revision,
    agentId: current.request.agentId,
    approverAccountId: intent.approver_account_id,
    category: intent.category,
    risk: intent.risk_ceiling,
    scopeSha256: intent.scope_sha256,
    authority: input.authority,
    atMs: input.atMs,
  }, entry);
  if (intent.owner_account_id !== input.authority.ownerAccountId
    || intent.agent_key !== input.authority.agentKey
    || delegation.roomId !== intent.room_id
    || delegation.agentKey !== intent.agent_key
    || delegation.ownerAccountId !== intent.owner_account_id) reject("identity_mismatch");

  const request = current.request;
  db.prepare(`INSERT INTO execution_approval_decisions(
    decision_id,request_id,request_version,agent_id,room_id,execution_generation_id,turn_id,
    request_delegatable,request_sha256,decision,source,actor_id,delegation_instance_id,
    delegation_revision,delegation_scope_sha256,dispatch_state,decided_at_ms,projection_sha256
  ) VALUES(?,?,?,?,?,?,?,1,?,?,'delegate',?,?,?,?, 'not_dispatched',?,?)`).run(
    intent.decision_id,
    request.requestId,
    request.requestVersion,
    request.agentId,
    request.roomId,
    request.executionGenerationId,
    request.turnId,
    request.requestSha256,
    intent.decision,
    intent.actor_account_id,
    intent.delegation_instance_id,
    intent.delegation_revision,
    intent.scope_sha256,
    input.atMs,
    intent.projection_sha256,
  );
  db.prepare("UPDATE execution_approval_requests SET state='decision_recorded' WHERE request_id=? AND request_version=?")
    .run(request.requestId, request.requestVersion);
  return getExecutionApproval(db, input.expected)!;
}
