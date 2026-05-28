import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import {
  rental_patch_proposals,
  rental_sessions,
} from "../../db/schema.js";
import { emitActivityEvent } from "../activity-emitter.js";
import { openRentalPatchPullRequest } from "../github-pr.js";
import type { RentalPatchReviewDeps } from "./types.js";

export const defaultPatchReviewDeps: RentalPatchReviewDeps = {
  now: () => new Date(),
  async listPatches(sessionId) {
    return db
      .select()
      .from(rental_patch_proposals)
      .where(eq(rental_patch_proposals.session_id, sessionId))
      .orderBy(desc(rental_patch_proposals.created_at));
  },
  async getPatch(sessionId, patchId) {
    const [row] = await db
      .select()
      .from(rental_patch_proposals)
      .where(
        and(
          eq(rental_patch_proposals.session_id, sessionId),
          eq(rental_patch_proposals.id, patchId),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async updatePatch(sessionId, patchId, update) {
    const patch: Partial<typeof rental_patch_proposals.$inferInsert> = {
      updated_at: update.updatedAt,
    };
    if (update.gateStatus) patch.gate_status = update.gateStatus;
    if (update.checkResults) patch.check_results = update.checkResults;

    const [row] = await db
      .update(rental_patch_proposals)
      .set(patch)
      .where(
        and(
          eq(rental_patch_proposals.session_id, sessionId),
          eq(rental_patch_proposals.id, patchId),
        ),
      )
      .returning();
    return row ?? null;
  },
  async updateSessionStatus(sessionId, status, updatedAt) {
    const [row] = await db
      .update(rental_sessions)
      .set({ status, updated_at: updatedAt })
      .where(eq(rental_sessions.id, sessionId))
      .returning();
    return row ?? null;
  },
  emitActivityEvent,
  async openPullRequest({
    session,
    patch,
    approvedByAccountId,
    approvedAt,
    files,
    commitMessage,
    note,
  }) {
    return openRentalPatchPullRequest({
      repoProvider: session.repo_provider,
      repoOwner: session.repo_owner,
      repoName: session.repo_name,
      baseBranch: session.base_branch,
      workBranch: session.work_branch,
      patchFiles: files,
      commitMessage,
      title: `Rental patch: ${session.task_title || patch.summary || patch.id}`,
      body: [
        `Renter approved patch proposal ${patch.id}.`,
        "",
        `Session: ${session.id}`,
        `Approved by account: ${approvedByAccountId}`,
        `Approved at: ${approvedAt}`,
        patch.summary ? `Summary: ${patch.summary}` : null,
        note ? `Note: ${note}` : null,
      ].filter(Boolean).join("\n"),
    });
  },
};
