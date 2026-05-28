import type { RentalPatchPullRequestFile } from "../github-pr.js";
import type { PatchCheckResult, PatchFile } from "../patch-gate.js";
import type { RentalPatchProposalRow } from "../signed-change-journal.js";
import { PatchReviewError } from "./errors.js";
import { isRecord } from "./guards.js";
import type { RentalSessionRow } from "./types.js";

function normalizePatchPath(filePath: string): string {
  const normalizedInput = filePath.replace(/\\/g, "/");
  const segments = normalizedInput
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (
    normalizedInput.startsWith("/")
    || normalizedInput.includes("\0")
    || segments.includes("..")
    || /^[a-zA-Z]:/.test(normalizedInput)
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
    !isRecord(entry)
    || typeof entry.path !== "string"
    || typeof entry.afterContent !== "string"
  ) {
    throw new PatchReviewError("patch_files_missing", 409);
  }
  return {
    path: entry.path,
    operation: "modify",
    content: entry.afterContent,
  };
}

export function extractApprovedPatchFiles(
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

export function buildPatchCommitMessage(
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
