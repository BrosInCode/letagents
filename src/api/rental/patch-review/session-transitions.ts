import { isValidTransition } from "../session-state-machine.js";
import { PatchReviewError } from "./errors.js";
import type { RentalPatchReviewDeps, RentalSessionRow } from "./types.js";

export function requireRenter(session: RentalSessionRow, accountId: string): void {
  if (session.renter_account_id !== accountId) {
    throw new PatchReviewError("not_renter", 403);
  }
  if (!session.room_id) {
    throw new PatchReviewError("room_not_assigned", 409);
  }
}

export function approvalTransitionPlan(status: RentalSessionRow["status"]): RentalSessionRow["status"][] {
  if (status === "active") return ["patch_review", "pr_opened"];
  if (status === "patch_review") return ["pr_opened"];
  if (status === "pr_opened") return [];
  throw new PatchReviewError(
    "invalid_session_status",
    409,
    `cannot approve patch while session is ${status}`,
  );
}

export function idempotentApprovalRepairPlan(
  status: RentalSessionRow["status"],
): RentalSessionRow["status"][] {
  if (status === "active") return ["patch_review", "pr_opened"];
  if (status === "patch_review") return ["pr_opened"];
  return [];
}

export function assertCanRequestChanges(status: RentalSessionRow["status"]): void {
  if (status === "active" || status === "patch_review") return;
  throw new PatchReviewError(
    "invalid_session_status",
    409,
    `cannot request patch changes while session is ${status}`,
  );
}

export async function applySessionTransitions(
  session: RentalSessionRow,
  statuses: RentalSessionRow["status"][],
  now: Date,
  deps: RentalPatchReviewDeps,
): Promise<RentalSessionRow> {
  let current = session;
  for (const status of statuses) {
    if (!isValidTransition(current.status, status)) {
      throw new PatchReviewError(
        "invalid_transition",
        409,
        `cannot move session from ${current.status} to ${status}`,
      );
    }
    const updated = await deps.updateSessionStatus(current.id, status, now);
    if (!updated) {
      throw new PatchReviewError("session_not_found", 404);
    }
    current = updated;
  }
  return current;
}
