import * as fs from "fs";
import * as path from "path";

import {
  normalizePatchPath,
  validatePatchPath,
} from "./path-policy.js";
import type {
  PatchCheckResult,
  PatchGateDeps,
  PatchGateResult,
  PatchGateVerdict,
  PatchProposal,
} from "./types.js";

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

  for (const file of proposal.files) {
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

    if (file.operation !== "delete") {
      if (file.diff && !file.content) {
        check.reason = "Diff-only patches are not yet supported — provide full content";
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

      let contentToApply = file.content;
      if (deps.scanContent) {
        const scanResult = await deps.scanContent(normalizedPath, file.content);

        if (scanResult.blocked) {
          check.reason = "Secret Firewall blocked: content contains unredactable secrets";
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
          contentToApply = scanResult.content;
        }
      }

      check.sanitizedContent = contentToApply;
    }

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

  const verdict = patchGateVerdict(checks, warnings, rejectionReasons);

  log(`Patch Gate: verdict=${verdict} (${checks.length} files, ${warnings.length} warnings, ${rejectionReasons.length} rejections)`);

  return {
    verdict,
    proposal,
    checks,
    warnings,
    rejectionReasons,
  };
}

function patchGateVerdict(
  checks: PatchCheckResult[],
  warnings: string[],
  rejectionReasons: string[],
): PatchGateVerdict {
  if (rejectionReasons.length > 0) {
    return "rejected";
  }

  if (
    checks.some((check) =>
      check.warnings.some((warning) => warning.includes("requires renter approval")),
    )
  ) {
    return "needs_renter_approval";
  }

  return warnings.length > 0 ? "passed_with_warnings" : "passed";
}
