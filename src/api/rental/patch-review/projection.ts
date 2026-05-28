import {
  buildUnifiedDiff,
  type RentalPatchProposalRow,
} from "../signed-change-journal.js";
import type { RentalPatchPullRequest } from "../github-pr.js";
import { defaultPatchReviewDeps } from "./storage.js";
import { isRecord } from "./guards.js";
import type {
  RentalPatchReviewDeps,
  RentalPatchReviewProjection,
} from "./types.js";

export function reviewRecord(row: RentalPatchProposalRow): Record<string, unknown> {
  const checkResults = isRecord(row.check_results) ? row.check_results : {};
  const review = checkResults.review;
  return isRecord(review) ? review : {};
}

export function mergeReview(
  row: RentalPatchProposalRow,
  review: Record<string, unknown>,
): Record<string, unknown> {
  const checkResults = isRecord(row.check_results) ? row.check_results : {};
  return {
    ...checkResults,
    review: {
      ...reviewRecord(row),
      ...review,
    },
  };
}

export function existingApprovedPullRequest(row: RentalPatchProposalRow): RentalPatchPullRequest | null {
  const review = reviewRecord(row);
  if (review.status !== "approved") return null;
  const url = typeof review.pr_url === "string" ? review.pr_url : "";
  const number = typeof review.pr_number === "number" ? review.pr_number : NaN;
  if (!url || !Number.isFinite(number)) return null;
  return {
    number,
    url,
    title: typeof review.pr_title === "string" ? review.pr_title : "",
    headRef: typeof review.pr_head_ref === "string" ? review.pr_head_ref : null,
    baseRef: typeof review.pr_base_ref === "string" ? review.pr_base_ref : null,
  };
}

function diffPreview(row: RentalPatchProposalRow): string | null {
  if (row.source !== "signed_change_journal") return null;
  try {
    const entry = row.journal_entry;
    if (!isRecord(entry)) return null;
    if (
      typeof entry.path !== "string"
      || typeof entry.beforeContent !== "string"
      || typeof entry.afterContent !== "string"
    ) {
      return null;
    }
    return buildUnifiedDiff({
      path: entry.path,
      beforeContent: entry.beforeContent,
      afterContent: entry.afterContent,
    });
  } catch {
    return null;
  }
}

export function projectPatchForReview(
  row: RentalPatchProposalRow,
): RentalPatchReviewProjection {
  const review = reviewRecord(row);
  return {
    ...row,
    diff_preview: diffPreview(row),
    pr_url: typeof review.pr_url === "string" ? review.pr_url : null,
  };
}

export async function listPatchProposalsForReview(
  sessionId: string,
  deps: Pick<RentalPatchReviewDeps, "listPatches"> = defaultPatchReviewDeps,
): Promise<RentalPatchReviewProjection[]> {
  const rows = await deps.listPatches(sessionId);
  return rows.map(projectPatchForReview);
}
