/**
 * Patch Gate — p4.3
 *
 * Per spec §3.3 / §10.6 / §19.4:
 * > The provider-side environment is never authoritative.
 * > All provider output is untrusted input until it passes the Patch Gate.
 *
 * Validates proposed changes from provider agents before they can be
 * applied to the rental workspace. Checks include:
 *
 * 1. **Scope validation**: Every changed file must be an exposed `file`
 *    type with non-blocked secret scan status. Includes creates.
 * 2. **Path safety**: Reject absolute, traversal, and sensitive paths.
 * 3. **Content requirement**: Diff-only proposals are rejected until
 *    diff application is implemented.
 * 4. **Secret scan**: Run Secret Firewall on proposed content. When
 *    secrets are redacted, the redacted version replaces the original.
 * 5. **Atomic apply**: Apply patches transactionally — all or nothing.
 *    Git commit failure triggers full rollback.
 */

import { execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatchGateVerdict =
  | "passed"
  | "passed_with_warnings"
  | "needs_renter_approval"
  | "rejected";

export interface PatchFile {
  /** Repo-relative file path (must match an exposed file). */
  path: string;
  /** The operation: modify existing, create new, or delete. */
  operation: "modify" | "create" | "delete";
  /** New content (required for modify/create, omitted for delete). */
  content?: string;
  /** Unified diff — currently rejected; reserved for future use. */
  diff?: string;
}

export interface PatchProposal {
  sessionId: string;
  /** Unique key for idempotent processing. */
  idempotencyKey: string;
  /** Files being changed. */
  files: PatchFile[];
  /** Optional summary from the agent. */
  summary?: string;
}

export interface PatchCheckResult {
  file: string;
  operation: string;
  passed: boolean;
  reason?: string;
  warnings: string[];
  secretsRedacted: number;
  /** The content that will actually be written (after redaction). */
  sanitizedContent?: string;
}

export interface PatchGateResult {
  verdict: PatchGateVerdict;
  proposal: PatchProposal;
  checks: PatchCheckResult[];
  warnings: string[];
  rejectionReasons: string[];
  appliedAt?: Date;
}

export interface PatchGateDeps {
  /** Check if a file path was exposed for this session. */
  isPathExposed: (sessionId: string, filePath: string) => Promise<boolean>;
  /** Scan content for secrets, returns { blocked, redactionCount, content }. */
  scanContent?: (
    filePath: string,
    content: string,
  ) => Promise<{
    blocked: boolean;
    redactionCount: number;
    content: string;
  }>;
  /** Absolute path to the workspace root. */
  workspacePath: string;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** Paths that should always trigger renter approval. */
const SENSITIVE_PATH_PATTERNS = [
  /^\.github\//,
  /^\.gitlab-ci/,
  /Dockerfile$/i,
  /^docker-compose/i,
  /^Makefile$/i,
  /^\.env/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^\.eslintrc/,
  /^\.prettierrc/,
];

/**
 * Validate a file path is safe for patch operations.
 * Rejects absolute paths, traversal, and null bytes.
 */
function validatePatchPath(filePath: string): {
  valid: boolean;
  reason?: string;
  sensitive: boolean;
} {
  // Normalize separators
  const normalized = filePath.replace(/\\/g, "/");

  // Reject null bytes
  if (normalized.includes("\0")) {
    return { valid: false, reason: "Null byte in path", sensitive: false };
  }

  // Reject absolute paths (POSIX and Windows)
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return {
      valid: false,
      reason: `Absolute path rejected: "${filePath}"`,
      sensitive: false,
    };
  }

  // Reject traversal
  const segments = normalized.split("/");
  let depth = 0;
  for (const seg of segments) {
    if (seg === "..") {
      depth--;
      if (depth < 0) {
        return {
          valid: false,
          reason: `Path traversal detected: "${filePath}"`,
          sensitive: false,
        };
      }
    } else if (seg !== "." && seg !== "") {
      depth++;
    }
  }

  // Check sensitivity
  const sensitive = SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized));

  return { valid: true, sensitive };
}

/**
 * Normalize a file path for consistent comparison.
 */
function normalizePatchPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
}

// ---------------------------------------------------------------------------
// Core gate logic
// ---------------------------------------------------------------------------

/**
 * Validate a patch proposal against the exposure ledger and security policies.
 * Does NOT apply the patch — call `applyPatch` separately after validation.
 */
export async function validatePatch(
  deps: PatchGateDeps,
  proposal: PatchProposal,
): Promise<PatchGateResult> {
  const log = deps.log ?? (() => {});
  const checks: PatchCheckResult[] = [];
  const warnings: string[] = [];
  const rejectionReasons: string[] = [];

  log(`Patch Gate: validating proposal ${proposal.idempotencyKey} (${proposal.files.length} files)`);

  if (proposal.files.length === 0) {
    return {
      verdict: "rejected",
      proposal,
      checks: [],
      warnings: [],
      rejectionReasons: ["Empty patch — no files to apply"],
    };
  }

  // Check each file
  for (const file of proposal.files) {
    // 1. Path safety — validate the RAW path BEFORE normalization
    //    so absolute paths (/, C:\) are caught before stripping
    const pathCheck = validatePatchPath(file.path);
    const normalizedPath = normalizePatchPath(file.path);
    const check: PatchCheckResult = {
      file: normalizedPath,
      operation: file.operation,
      passed: false,
      warnings: [],
      secretsRedacted: 0,
    };

    if (!pathCheck.valid) {
      check.reason = pathCheck.reason;
      checks.push(check);
      rejectionReasons.push(`${file.path}: ${pathCheck.reason}`);
      continue;
    }

    if (pathCheck.sensitive) {
      check.warnings.push(`Sensitive path: ${normalizedPath} — requires renter approval`);
      warnings.push(`Sensitive file modified: ${normalizedPath}`);
    }

    // 2. Scope validation — ALL operations require exposure check
    //    (creates included — agent can only create files in exposed scope)
    const exposed = await deps.isPathExposed(
      proposal.sessionId,
      normalizedPath,
    );
    if (!exposed) {
      check.reason = `File not exposed in session: "${normalizedPath}"`;
      checks.push(check);
      rejectionReasons.push(
        `${normalizedPath}: not exposed — edits only allowed on exposed files`,
      );
      continue;
    }

    // 3. Content validation — diff-only is rejected until diff apply is implemented
    if (file.operation !== "delete") {
      if (file.diff && !file.content) {
        check.reason = `Diff-only patches are not yet supported — provide full content`;
        checks.push(check);
        rejectionReasons.push(
          `${normalizedPath}: diff-only patches not supported`,
        );
        continue;
      }

      if (!file.content) {
        check.reason = `No content provided for ${file.operation}`;
        checks.push(check);
        rejectionReasons.push(`${normalizedPath}: no content provided`);
        continue;
      }

      // 4. Secret scan on proposed content — write REDACTED version back
      let contentToApply = file.content;
      if (deps.scanContent) {
        const scanResult = await deps.scanContent(normalizedPath, file.content);

        if (scanResult.blocked) {
          check.reason = `Secret Firewall blocked: content contains unredactable secrets`;
          checks.push(check);
          rejectionReasons.push(
            `${normalizedPath}: Secret Firewall blocked the proposed content`,
          );
          continue;
        }

        if (scanResult.redactionCount > 0) {
          check.secretsRedacted = scanResult.redactionCount;
          check.warnings.push(
            `${scanResult.redactionCount} secrets redacted from proposed content`,
          );
          warnings.push(
            `${normalizedPath}: ${scanResult.redactionCount} secrets redacted`,
          );
          // Use the redacted content instead of the original
          contentToApply = scanResult.content;
        }
      }

      // Store the sanitized content for apply phase
      check.sanitizedContent = contentToApply;
    }

    // 5. For modifications, verify the target file exists
    if (file.operation === "modify") {
      const fullPath = path.join(deps.workspacePath, normalizedPath);
      if (!fs.existsSync(fullPath)) {
        check.reason = `Target file does not exist: "${normalizedPath}"`;
        checks.push(check);
        rejectionReasons.push(
          `${normalizedPath}: file does not exist in workspace`,
        );
        continue;
      }
    }

    // 6. For deletions, verify the file exists
    if (file.operation === "delete") {
      const fullPath = path.join(deps.workspacePath, normalizedPath);
      if (!fs.existsSync(fullPath)) {
        check.warnings.push(`File already absent: "${normalizedPath}"`);
        warnings.push(`${normalizedPath}: already absent (delete is no-op)`);
      }
    }

    check.passed = true;
    checks.push(check);
  }

  // Determine verdict
  let verdict: PatchGateVerdict;

  if (rejectionReasons.length > 0) {
    verdict = "rejected";
  } else if (
    checks.some((c) =>
      c.warnings.some((w) => w.includes("requires renter approval")),
    )
  ) {
    verdict = "needs_renter_approval";
  } else if (warnings.length > 0) {
    verdict = "passed_with_warnings";
  } else {
    verdict = "passed";
  }

  log(`Patch Gate: verdict=${verdict} (${checks.length} files, ${warnings.length} warnings, ${rejectionReasons.length} rejections)`);

  return {
    verdict,
    proposal,
    checks,
    warnings,
    rejectionReasons,
  };
}

/**
 * Apply a validated patch to the workspace.
 *
 * Only applies patches with verdict "passed" or "passed_with_warnings".
 * "needs_renter_approval" requires explicit renter approval (renterApproved flag).
 * "rejected" always throws.
 *
 * Applies atomically:
 * - Creates a backup of each modified/deleted file
 * - Applies all changes using SANITIZED content (post-redaction)
 * - Stages and commits to git
 * - On ANY failure (including git), rolls back all changes from backup
 */
export async function applyPatch(
  deps: PatchGateDeps,
  result: PatchGateResult,
  opts?: { renterApproved?: boolean },
): Promise<PatchGateResult> {
  const log = deps.log ?? (() => {});

  if (result.verdict === "rejected") {
    throw new Error("Cannot apply a rejected patch");
  }

  if (result.verdict === "needs_renter_approval" && !opts?.renterApproved) {
    throw new Error(
      "Cannot apply patch with verdict 'needs_renter_approval' without explicit renter approval",
    );
  }

  // Build a map from normalized path → sanitized content from checks
  const sanitizedContentMap = new Map<string, string>();
  for (const check of result.checks) {
    if (check.sanitizedContent !== undefined) {
      sanitizedContentMap.set(check.file, check.sanitizedContent);
    }
  }

  const backups = new Map<string, { content: Buffer | null; existed: boolean }>();

  try {
    // Phase 1: Create backups
    for (const file of result.proposal.files) {
      const normalizedPath = normalizePatchPath(file.path);
      const fullPath = path.join(deps.workspacePath, normalizedPath);

      if (fs.existsSync(fullPath)) {
        backups.set(normalizedPath, {
          content: fs.readFileSync(fullPath),
          existed: true,
        });
      } else {
        backups.set(normalizedPath, { content: null, existed: false });
      }
    }

    // Phase 2: Apply changes — use SANITIZED content
    for (const file of result.proposal.files) {
      const normalizedPath = normalizePatchPath(file.path);
      const fullPath = path.join(deps.workspacePath, normalizedPath);

      switch (file.operation) {
        case "create":
        case "modify": {
          // Use sanitized content (post-redaction) from validation
          const content = sanitizedContentMap.get(normalizedPath) ?? file.content;
          if (!content) {
            throw new Error(`No content for ${file.operation}: ${normalizedPath}`);
          }
          // Ensure parent directory exists
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(fullPath, content, "utf-8");
          log(`Applied ${file.operation}: ${normalizedPath}`);
          break;
        }
        case "delete": {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            log(`Deleted: ${normalizedPath}`);
          }
          break;
        }
      }
    }

    // Phase 3: Stage and commit — failure triggers full rollback
    const filePaths = result.proposal.files.map((f) =>
      normalizePatchPath(f.path),
    );

    // Stage all changed files
    execFileSync("git", ["add", "--", ...filePaths], {
      cwd: deps.workspacePath,
      timeout: 10_000,
    });

    // Also stage deletions
    const deletions = result.proposal.files
      .filter((f) => f.operation === "delete")
      .map((f) => normalizePatchPath(f.path));

    if (deletions.length > 0) {
      execFileSync("git", ["rm", "--cached", "--ignore-unmatch", "--", ...deletions], {
        cwd: deps.workspacePath,
        timeout: 10_000,
      });
    }

    // Commit
    const commitMsg = [
      `rental: ${result.proposal.summary ?? "agent patch"}`,
      "",
      `Session: ${result.proposal.sessionId}`,
      `Key: ${result.proposal.idempotencyKey}`,
      `Files: ${result.proposal.files.length}`,
      `Verdict: ${result.verdict}`,
    ].join("\n");

    execFileSync("git", ["commit", "-m", commitMsg, "--allow-empty"], {
      cwd: deps.workspacePath,
      timeout: 15_000,
    });

    log(`Committed patch to workspace branch`);

    result.appliedAt = new Date();
    return result;
  } catch (err) {
    // Rollback — restores files AND resets git index
    log(`Patch apply failed, rolling back: ${err}`);

    for (const [filePath, backup] of backups) {
      const fullPath = path.join(deps.workspacePath, filePath);
      try {
        if (backup.existed && backup.content) {
          fs.writeFileSync(fullPath, backup.content);
        } else if (!backup.existed && fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (rollbackErr) {
        log(`Rollback failed for ${filePath}: ${rollbackErr}`);
      }
    }

    // Reset git index to match working tree after rollback
    try {
      execFileSync("git", ["reset", "HEAD", "--"], {
        cwd: deps.workspacePath,
        timeout: 10_000,
      });
    } catch {
      // Best-effort index reset
    }

    throw new Error(`Patch apply failed and rolled back: ${err}`);
  }
}
