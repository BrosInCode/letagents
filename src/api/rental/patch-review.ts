/**
 * Renter-facing patch review orchestration.
 *
 * This bridges persisted Patch Gate proposals to the renter review
 * API. Approval opens a GitHub PR through the LetAgents GitHub App;
 * request-changes marks the proposal as needing revision and returns
 * the session to active work when it was waiting in patch_review.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  rental_patch_proposals,
  rental_sessions,
} from "../db/schema.js";
import {
  PATCH_APPROVED,
  PATCH_CHANGES_REQUESTED,
} from "./activity-event-types.js";
import {
  emitActivityEvent,
  type ActivityEvent,
  type EmitActivityEventInput,
} from "./activity-emitter.js";
import {
  openRentalPatchPullRequest,
  type RentalPatchPullRequest,
  type RentalPatchPullRequestFile,
} from "./github-pr.js";
import type { PatchCheckResult, PatchFile } from "./patch-gate.js";
import {
  buildUnifiedDiff,
  type RentalPatchProposalRow,
} from "./signed-change-journal.js";
import { isValidTransition } from "./session-state-machine.js";

export type RentalSessionRow = typeof rental_sessions.$inferSelect;
type PatchGateStatus = typeof rental_patch_proposals.$inferSelect["gate_status"];

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

export class PatchReviewError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "PatchReviewError";
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePatchPath(filePath: string): string {
  const normalizedInput = filePath.replace(/\\/g, "/");
  const segments = normalizedInput
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (
    normalizedInput.startsWith("/") ||
    normalizedInput.includes("\0") ||
    segments.includes("..") ||
    /^[a-zA-Z]:/.test(normalizedInput)
  ) {
    throw new PatchReviewError("patch_files_invalid", 409);
  }
  return segments.join("/");
}

function isPatchOperation(value: unknown): value is PatchFile["operation"] {
  return value === "modify" || value === "create" || value === "delete";
}

function storedPatchChecks(row: RentalPatchProposalRow): PatchCheckResult[] {
  const checkResults = isRecord(row.check_results) ? row.check_results : {};
  const checks = checkResults.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (!isRecord(check)) return [];
    const file = typeof check.file === "string" ? check.file : "";
    const operation = typeof check.operation === "string" ? check.operation : "";
    const passed = check.passed === true;
    const warnings = Array.isArray(check.warnings)
      ? check.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
    return [{
      file,
      operation,
      passed,
      reason: typeof check.reason === "string" ? check.reason : undefined,
      warnings,
      secretsRedacted: typeof check.secretsRedacted === "number" ? check.secretsRedacted : 0,
      sanitizedContent:
        typeof check.sanitizedContent === "string" ? check.sanitizedContent : undefined,
    }];
  });
}

function explicitPatchFilesFromJournal(row: RentalPatchProposalRow): PatchFile[] {
  const entry = row.journal_entry;
  if (!isRecord(entry) || !Array.isArray(entry.files)) {
    throw new PatchReviewError("patch_files_missing", 409);
  }
  return entry.files.map((file) => {
    if (!isRecord(file)) {
      throw new PatchReviewError("patch_files_invalid", 409);
    }
    const filePath = typeof file.path === "string" ? file.path.trim() : "";
    if (!filePath || !isPatchOperation(file.operation)) {
      throw new PatchReviewError("patch_files_invalid", 409);
    }
    return {
      path: filePath,
      operation: file.operation,
      content: typeof file.content === "string" ? file.content : undefined,
      diff: typeof file.diff === "string" ? file.diff : undefined,
    };
  });
}

function signedJournalPatchFile(row: RentalPatchProposalRow): PatchFile {
  const entry = row.journal_entry;
  if (
    !isRecord(entry) ||
    typeof entry.path !== "string" ||
    typeof entry.afterContent !== "string"
  ) {
    throw new PatchReviewError("patch_files_missing", 409);
  }
  return {
    path: entry.path,
    operation: "modify",
    content: entry.afterContent,
  };
}

function extractApprovedPatchFiles(
  row: RentalPatchProposalRow,
): RentalPatchPullRequestFile[] {
  const files = row.source === "signed_change_journal"
    ? [signedJournalPatchFile(row)]
    : explicitPatchFilesFromJournal(row);
  const checks = storedPatchChecks(row);
  const failedCheck = checks.find((check) => check.passed === false);
  if (failedCheck) {
    throw new PatchReviewError("patch_checks_not_passed", 409);
  }

  const sanitized = new Map<string, string>();
  for (const check of checks) {
    if (typeof check.sanitizedContent === "string") {
      sanitized.set(normalizePatchPath(check.file), check.sanitizedContent);
    }
  }

  return files.map((file) => {
    const path = normalizePatchPath(file.path);
    if (!path) {
      throw new PatchReviewError("patch_files_invalid", 409);
    }
    if (file.operation === "delete") {
      return { path, operation: "delete" };
    }
    const content = sanitized.get(path) ?? file.content;
    if (typeof content !== "string") {
      throw new PatchReviewError("patch_content_missing", 409);
    }
    return { path, operation: file.operation, content };
  });
}

function buildPatchCommitMessage(
  session: RentalSessionRow,
  patch: RentalPatchProposalRow,
): string {
  return [
    `rental: ${patch.summary || session.task_title || "approved patch"}`,
    "",
    `Session: ${session.id}`,
    `Patch: ${patch.id}`,
  ].join("\n");
}

function reviewRecord(row: RentalPatchProposalRow): Record<string, unknown> {
  const checkResults = isRecord(row.check_results) ? row.check_results : {};
  const review = checkResults.review;
  return isRecord(review) ? review : {};
}

function mergeReview(
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

function existingApprovedPullRequest(row: RentalPatchProposalRow): RentalPatchPullRequest | null {
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
      typeof entry.path !== "string" ||
      typeof entry.beforeContent !== "string" ||
      typeof entry.afterContent !== "string"
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

function requireRenter(session: RentalSessionRow, accountId: string): void {
  if (session.renter_account_id !== accountId) {
    throw new PatchReviewError("not_renter", 403);
  }
  if (!session.room_id) {
    throw new PatchReviewError("room_not_assigned", 409);
  }
}

function requirePatch(row: RentalPatchProposalRow | null): RentalPatchProposalRow {
  if (!row) {
    throw new PatchReviewError("patch_not_found", 404);
  }
  return row;
}

function approvalTransitionPlan(status: RentalSessionRow["status"]): RentalSessionRow["status"][] {
  if (status === "active") return ["patch_review", "pr_opened"];
  if (status === "patch_review") return ["pr_opened"];
  if (status === "pr_opened") return [];
  throw new PatchReviewError(
    "invalid_session_status",
    409,
    `cannot approve patch while session is ${status}`,
  );
}

function idempotentApprovalRepairPlan(
  status: RentalSessionRow["status"],
): RentalSessionRow["status"][] {
  if (status === "active") return ["patch_review", "pr_opened"];
  if (status === "patch_review") return ["pr_opened"];
  return [];
}

function assertCanRequestChanges(status: RentalSessionRow["status"]): void {
  if (status === "active" || status === "patch_review") return;
  throw new PatchReviewError(
    "invalid_session_status",
    409,
    `cannot request patch changes while session is ${status}`,
  );
}

async function applySessionTransitions(
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
