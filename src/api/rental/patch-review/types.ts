import type { rental_patch_proposals, rental_sessions } from "../../db/schema.js";
import type { ActivityEvent, EmitActivityEventInput } from "../activity-emitter.js";
import type {
  RentalPatchPullRequest,
  RentalPatchPullRequestFile,
} from "../github-pr.js";
import type { RentalPatchProposalRow } from "../signed-change-journal.js";

export type RentalSessionRow = typeof rental_sessions.$inferSelect;
export type PatchGateStatus = typeof rental_patch_proposals.$inferSelect["gate_status"];

export interface RentalPatchReviewProjection extends RentalPatchProposalRow {
  diff_preview: string | null;
  pr_url: string | null;
}

export interface RentalPatchReviewDecisionResult {
  session: RentalSessionRow;
  patch: RentalPatchReviewProjection;
  pullRequest?: RentalPatchPullRequest | null;
  event: ActivityEvent | null;
  idempotent: boolean;
}

export interface RentalPatchReviewDeps {
  now(): Date;
  listPatches(sessionId: string): Promise<RentalPatchProposalRow[]>;
  getPatch(sessionId: string, patchId: string): Promise<RentalPatchProposalRow | null>;
  updatePatch(
    sessionId: string,
    patchId: string,
    update: {
      gateStatus?: PatchGateStatus;
      checkResults?: Record<string, unknown>;
      updatedAt: Date;
    },
  ): Promise<RentalPatchProposalRow | null>;
  updateSessionStatus(
    sessionId: string,
    status: RentalSessionRow["status"],
    updatedAt: Date,
  ): Promise<RentalSessionRow | null>;
  emitActivityEvent(input: EmitActivityEventInput): Promise<ActivityEvent>;
  openPullRequest(input: {
    session: RentalSessionRow;
    patch: RentalPatchProposalRow;
    approvedByAccountId: string;
    approvedAt: string;
    files: RentalPatchPullRequestFile[];
    commitMessage: string;
    note?: string | null;
  }): Promise<RentalPatchPullRequest>;
}
