import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { normalizePatchPath } from "./path-policy.js";
import type {
  PatchGateDeps,
  PatchGateResult,
} from "./types.js";

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

  const sanitizedContentMap = new Map<string, string>();
  for (const check of result.checks) {
    if (check.sanitizedContent !== undefined) {
      sanitizedContentMap.set(check.file, check.sanitizedContent);
    }
  }

  const backups = new Map<string, { content: Buffer | null; existed: boolean }>();

  try {
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

    for (const file of result.proposal.files) {
      const normalizedPath = normalizePatchPath(file.path);
      const fullPath = path.join(deps.workspacePath, normalizedPath);

      switch (file.operation) {
        case "create":
        case "modify": {
          const content = sanitizedContentMap.get(normalizedPath) ?? file.content;
          if (!content) {
            throw new Error(`No content for ${file.operation}: ${normalizedPath}`);
          }
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

    const filePaths = result.proposal.files.map((file) =>
      normalizePatchPath(file.path),
    );

    execFileSync("git", ["add", "--", ...filePaths], {
      cwd: deps.workspacePath,
      timeout: 10_000,
    });

    const deletions = result.proposal.files
      .filter((file) => file.operation === "delete")
      .map((file) => normalizePatchPath(file.path));

    if (deletions.length > 0) {
      execFileSync("git", ["rm", "--cached", "--ignore-unmatch", "--", ...deletions], {
        cwd: deps.workspacePath,
        timeout: 10_000,
      });
    }

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

    log("Committed patch to workspace branch");

    result.appliedAt = new Date();
    return result;
  } catch (err) {
    log(`Patch apply failed, rolling back: ${err}`);
    rollbackPatch(deps.workspacePath, backups, log);
    throw new Error(`Patch apply failed and rolled back: ${err}`);
  }
}

function rollbackPatch(
  workspacePath: string,
  backups: Map<string, { content: Buffer | null; existed: boolean }>,
  log: (msg: string) => void,
): void {
  for (const [filePath, backup] of backups) {
    const fullPath = path.join(workspacePath, filePath);
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

  try {
    execFileSync("git", ["reset", "HEAD", "--"], {
      cwd: workspacePath,
      timeout: 10_000,
    });
  } catch {
    // Best-effort index reset.
  }
}
