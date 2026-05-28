/**
 * Renter-facing patch review orchestration.
 *
 * This public module keeps approve/request-change decisions together while the
 * storage adapter, projection helpers, file extraction, and session transition
 * checks live beside it.
 */

import {
  PATCH_APPROVED,
  PATCH_CHANGES_REQUESTED,
} from "../activity-event-types.js";
import type { RentalPatchProposalRow } from "../signed-change-journal.js";
import { PatchReviewError } from "./errors.js";
import {
  buildPatchCommitMessage,
  extractApprovedPatchFiles,
} from "./files.js";
import {
  existingApprovedPullRequest,
  listPatchProposalsForReview,
  mergeReview,
  projectPatchForReview,
} from "./projection.js";
import {
  applySessionTransitions,
  approvalTransitionPlan,
  assertCanRequestChanges,
  idempotentApprovalRepairPlan,
  requireRenter,
} from "./session-transitions.js";
import { defaultPatchReviewDeps } from "./storage.js";
import type {
  PatchGateStatus,
  RentalPatchReviewDecisionResult,
  RentalPatchReviewDeps,
  RentalPatchReviewProjection,
  RentalSessionRow,
} from "./types.js";

export { PatchReviewError } from "./errors.js";
export { listPatchProposalsForReview, projectPatchForReview } from "./projection.js";
export { defaultPatchReviewDeps } from "./storage.js";
export type {
  PatchGateStatus,
  RentalPatchReviewDecisionResult,
  RentalPatchReviewDeps,
  RentalPatchReviewProjection,
  RentalSessionRow,
} from "./types.js";

const APPROVABLE_GATE_STATUSES: ReadonlySet<PatchGateStatus> = new Set([
  "passed",
  "passed_with_warnings",
  "needs_renter_approval",
]);

const CHANGE_REQUESTABLE_STATUSES: ReadonlySet<PatchGateStatus> = new Set([
  "pending",
  "passed",
  "passed_with_warnings",
  "needs_renter_approval",
  "needs_revision",
]);

function requirePatch(row: RentalPatchProposalRow | null): RentalPatchProposalRow {
  if (!row) {
    throw new PatchReviewError("patch_not_found", 404);
  }
  return row;
}

export async function approvePatchForRenter(
  session: RentalSessionRow,
  renterAccountId: string,
  patchId: string,
  input: { note?: string | null } = {},
  deps: RentalPatchReviewDeps = defaultPatchReviewDeps,
): Promise<RentalPatchReviewDecisionResult> {
  requireRenter(session, renterAccountId);
  const normalizedPatchId = patchId.trim();
  if (!normalizedPatchId) {
    throw new PatchReviewError("patch_id_required", 400);
  }

  const patch = requirePatch(await deps.getPatch(session.id, normalizedPatchId));
  const existingPullRequest = existingApprovedPullRequest(patch);
  if (existingPullRequest) {
    const repairedSession = await applySessionTransitions(
      session,
      idempotentApprovalRepairPlan(session.status),
      deps.now(),
      deps,
    );
    return {
      session: repairedSession,
      patch: projectPatchForReview(patch),
      pullRequest: existingPullRequest,
      event: null,
      idempotent: true,
    };
  }

  if (!APPROVABLE_GATE_STATUSES.has(patch.gate_status)) {
    throw new PatchReviewError(
      "patch_not_approvable",
      409,
      `cannot approve patch with gate_status=${patch.gate_status}`,
    );
  }

  const now = deps.now();
  const approvedAt = now.toISOString();
  const transitions = approvalTransitionPlan(session.status);
  const pullRequest = await deps.openPullRequest({
    session,
    patch,
    approvedByAccountId: renterAccountId,
    approvedAt,
    files: extractApprovedPatchFiles(patch),
    commitMessage: buildPatchCommitMessage(session, patch),
    note: input.note ?? null,
  });
  const updatedPatch = await deps.updatePatch(session.id, patch.id, {
    updatedAt: now,
    checkResults: mergeReview(patch, {
      status: "approved",
      approved_by_account_id: renterAccountId,
      approved_at: approvedAt,
      note: input.note ?? null,
      pr_url: pullRequest.url,
      pr_number: pullRequest.number,
      pr_title: pullRequest.title,
      pr_head_ref: pullRequest.headRef,
      pr_base_ref: pullRequest.baseRef,
      commit_sha: pullRequest.commitSha ?? null,
    }),
  });
  if (!updatedPatch) {
    throw new PatchReviewError("patch_not_found", 404);
  }

  const updatedSession = await applySessionTransitions(session, transitions, now, deps);
  const event = await deps.emitActivityEvent({
    sessionId: session.id,
    roomId: session.room_id!,
    eventType: PATCH_APPROVED,
    source: "renter",
    payload: {
      patch_id: patch.id,
      gate_status: patch.gate_status,
      approved_by_account_id: renterAccountId,
      approved_at: approvedAt,
      pr_url: pullRequest.url,
      pr_number: pullRequest.number,
      commit_sha: pullRequest.commitSha ?? null,
      note: input.note ?? null,
      previous_status: session.status,
      new_status: updatedSession.status,
    },
  });

  return {
    session: updatedSession,
    patch: projectPatchForReview(updatedPatch),
    pullRequest,
    event,
    idempotent: false,
  };
}

export async function requestPatchChangesForRenter(
  session: RentalSessionRow,
  renterAccountId: string,
  patchId: string,
  input: { note?: string | null } = {},
  deps: RentalPatchReviewDeps = defaultPatchReviewDeps,
): Promise<RentalPatchReviewDecisionResult> {
  requireRenter(session, renterAccountId);
  assertCanRequestChanges(session.status);
  const normalizedPatchId = patchId.trim();
  if (!normalizedPatchId) {
    throw new PatchReviewError("patch_id_required", 400);
  }

  const patch = requirePatch(await deps.getPatch(session.id, normalizedPatchId));
  if (!CHANGE_REQUESTABLE_STATUSES.has(patch.gate_status)) {
    throw new PatchReviewError(
      "patch_not_reviewable",
      409,
      `cannot request changes for patch with gate_status=${patch.gate_status}`,
    );
  }

  const now = deps.now();
  const requestedAt = now.toISOString();
  const updatedPatch = await deps.updatePatch(session.id, patch.id, {
    gateStatus: "needs_revision",
    updatedAt: now,
    checkResults: mergeReview(patch, {
      status: "needs_revision",
      requested_by_account_id: renterAccountId,
      requested_at: requestedAt,
      note: input.note ?? null,
    }),
  });
  if (!updatedPatch) {
    throw new PatchReviewError("patch_not_found", 404);
  }

  let updatedSession = session;
  if (session.status === "patch_review") {
    updatedSession = await applySessionTransitions(session, ["active"], now, deps);
  }

  const event = await deps.emitActivityEvent({
    sessionId: session.id,
    roomId: session.room_id!,
    eventType: PATCH_CHANGES_REQUESTED,
    source: "renter",
    payload: {
      patch_id: patch.id,
      previous_gate_status: patch.gate_status,
      new_gate_status: "needs_revision",
      requested_by_account_id: renterAccountId,
      requested_at: requestedAt,
      note: input.note ?? null,
      previous_status: session.status,
      new_status: updatedSession.status,
    },
  });

  return {
    session: updatedSession,
    patch: projectPatchForReview(updatedPatch),
    pullRequest: null,
    event,
    idempotent: false,
  };
}
