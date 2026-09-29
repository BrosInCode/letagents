import type { DatabaseSync } from "node:sqlite";

import {
  ApprovalJournalError,
  admitExecutionApproval,
  type AdmitOperationalExecutionApproval,
  type ApprovalReference,
  type ExecutionApprovalRecord,
} from "./execution-approval-journal.js";
import {
  recordExecutionApprovalProjection,
  type ExecutionApprovalProjectionRecord,
} from "./execution-approval-projection-journal.js";
import type { PreparedExecutionApprovalProjection } from "./execution-approval-projection.js";
import type { DaemonManifestEntry } from "./types.js";

type BaseRequest = AdmitOperationalExecutionApproval["request"];
type BasePlan = { authority: AdmitOperationalExecutionApproval["authority"] };

export type ExecutionApprovalAdmissionPlan =
  | (BasePlan & {
      classification: "host_only";
      request: BaseRequest & { risk: "high" };
    })
  | {
      authority: BasePlan["authority"] & { provider: "codex" };
      classification: "delegatable_file_change";
      request: BaseRequest & { kind: "file_change"; risk: "low" };
      projection: PreparedExecutionApprovalProjection;
    };

export type ExecutionApprovalAdmission = {
  created: boolean;
  approval: ExecutionApprovalRecord;
  projection: ExecutionApprovalProjectionRecord | null;
};

function invalid(): never {
  throw new ApprovalJournalError("invalid_input");
}

function reference(record: ExecutionApprovalRecord): ApprovalReference {
  const request = record.request;
  return {
    requestId: request.requestId,
    requestVersion: request.requestVersion,
    requestSha256: request.requestSha256,
    agentId: request.agentId,
    roomId: request.roomId,
    executionGenerationId: request.executionGenerationId,
    runtimeGenerationId: request.runtimeGenerationId,
    turnId: request.turnId,
    providerContinuationId: request.providerContinuationId,
    providerTurnId: request.providerTurnId,
    connectionId: request.connectionId,
    nativeRequestId: request.nativeRequestId,
  };
}

/** Admit immutable classification and its required evidence in one transaction. */
export function admitExecutionApprovalPlan(
  database: DatabaseSync,
  plan: ExecutionApprovalAdmissionPlan,
  current: DaemonManifestEntry | undefined,
  producedAtMs: number,
): ExecutionApprovalAdmission {
  if (!database.isTransaction || !Number.isSafeInteger(producedAtMs) || producedAtMs < 0) invalid();
  const delegatable = plan.classification === "delegatable_file_change";
  if ((!delegatable && (plan.request.risk !== "high" || "projection" in plan))
    || (delegatable && (plan.authority.provider !== "codex"
      || plan.request.kind !== "file_change" || plan.request.risk !== "low"
      || plan.projection.requestSha256 !== plan.request.requestSha256
      || plan.projection.workAttemptId !== plan.authority.workAttemptId))) invalid();
  const admitted = admitExecutionApproval(database, { request: plan.request, authority: plan.authority }, current, delegatable);
  if (!delegatable) return { ...admitted, projection: null };
  const projection = recordExecutionApprovalProjection(database, {
    expected: reference(admitted.approval),
    projection: plan.projection,
    producedAtMs,
  }).projection;
  return { ...admitted, projection };
}
