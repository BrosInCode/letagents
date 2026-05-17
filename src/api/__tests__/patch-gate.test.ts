/**
 * Tests for Patch Gate — p4.3
 *
 * Uses node:test + node:assert/strict (project convention).
 * Tests validation logic (path safety, scope, secrets) and
 * atomic apply/rollback.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import {
  validatePatch,
  applyPatch,
  type PatchGateDeps,
  type PatchProposal,
} from "../rental/patch-gate.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createTmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-gate-test-"));
  // Initialize as a git repo
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });

  // Create some files
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src/index.ts"),
    'export const hello = "world";',
  );
  fs.writeFileSync(
    path.join(dir, "src/utils.ts"),
    'export function add(a: number, b: number) { return a + b; }',
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Project");

  // Initial commit
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });

  return dir;
}

function cleanupWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Creates deps with a configurable exposure set. */
function createDeps(
  workspacePath: string,
  exposedPaths: Set<string>,
  opts?: {
    scanContent?: PatchGateDeps["scanContent"];
  },
): PatchGateDeps {
  return {
    isPathExposed: async (_sid, filePath) => exposedPaths.has(filePath),
    scanContent: opts?.scanContent,
    workspacePath,
  };
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("PatchGate — Validation", () => {
  it("rejects empty patch proposals", async () => {
    const deps = createDeps("/tmp/fake", new Set());
    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k1",
      files: [],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("Empty patch"));
  });

  it("rejects absolute POSIX paths", async () => {
    const deps = createDeps("/tmp/fake", new Set());
    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k2",
      files: [
        { path: "/etc/passwd", operation: "modify", content: "hacked" },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("Absolute path"));
  });

  it("rejects Windows drive-root paths", async () => {
    const deps = createDeps("/tmp/fake", new Set());
    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k3",
      files: [
        {
          path: "C:\\Users\\kd\\secret.txt",
          operation: "modify",
          content: "data",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("Absolute path"));
  });

  it("rejects path traversal", async () => {
    const deps = createDeps("/tmp/fake", new Set());
    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k4",
      files: [
        {
          path: "../../etc/passwd",
          operation: "modify",
          content: "data",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("traversal"));
  });

  it("rejects null bytes in paths", async () => {
    const deps = createDeps("/tmp/fake", new Set());
    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k5",
      files: [
        {
          path: "src/index\0.ts",
          operation: "modify",
          content: "data",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("Null byte"));
  });

  it("rejects modifications to unexposed files", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/index.ts"])); // only index exposed

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k6",
      files: [
        {
          path: "src/utils.ts", // NOT exposed
          operation: "modify",
          content: "new content",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("not exposed"));

    cleanupWorkspace(tmpDir);
  });

  // FIX #4: creates now require exposure check too
  it("rejects creation of new files when not exposed", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set()); // nothing exposed

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k7",
      files: [
        {
          path: "src/new-file.ts",
          operation: "create",
          content: 'export const foo = "bar";',
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("not exposed"));

    cleanupWorkspace(tmpDir);
  });

  it("allows creation of new files when exposed", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/new-file.ts"])); // exposed

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k7b",
      files: [
        {
          path: "src/new-file.ts",
          operation: "create",
          content: 'export const foo = "bar";',
        },
      ],
    });

    assert.equal(result.verdict, "passed");
    assert.equal(result.checks[0].passed, true);

    cleanupWorkspace(tmpDir);
  });

  it("flags sensitive paths for renter approval", async () => {
    tmpDir = createTmpWorkspace();
    // Create the file
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    execFileSync("git", ["add", "package.json"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "add pkg"], { cwd: tmpDir });

    const deps = createDeps(tmpDir, new Set(["package.json"]));

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k8",
      files: [
        {
          path: "package.json",
          operation: "modify",
          content: '{"name": "modified"}',
        },
      ],
    });

    assert.equal(result.verdict, "needs_renter_approval");
    assert.ok(
      result.warnings.some((w) => w.includes("Sensitive file")),
    );

    cleanupWorkspace(tmpDir);
  });

  it("rejects when Secret Firewall blocks content", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/index.ts"]), {
      scanContent: async () => ({
        blocked: true,
        redactionCount: 0,
        content: "",
      }),
    });

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k9",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: 'const SECRET = "ghp_abc123...";',
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("Secret Firewall"));

    cleanupWorkspace(tmpDir);
  });

  // FIX #1: verify redacted content is stored in check result
  it("stores redacted content for apply phase", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/index.ts"]), {
      scanContent: async (_path, content) => ({
        blocked: false,
        redactionCount: 2,
        content: content.replace(/secret/gi, "REDACTED"),
      }),
    });

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k10",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: 'const value = "not-a-secret";',
        },
      ],
    });

    assert.equal(result.verdict, "passed_with_warnings");
    assert.ok(result.warnings.some((w) => w.includes("redacted")));
    assert.equal(result.checks[0].secretsRedacted, 2);
    // Verify sanitized content is stored
    assert.ok(result.checks[0].sanitizedContent?.includes("REDACTED"));
    assert.ok(!result.checks[0].sanitizedContent?.includes("secret"));

    cleanupWorkspace(tmpDir);
  });

  it("rejects modifications to non-existent files", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/missing.ts"]));

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k11",
      files: [
        {
          path: "src/missing.ts",
          operation: "modify",
          content: "new content",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("does not exist"));

    cleanupWorkspace(tmpDir);
  });

  it("rejects when no content/diff provided for modify", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/index.ts"]));

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k12",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("no content"));

    cleanupWorkspace(tmpDir);
  });

  // FIX #3: diff-only proposals are rejected
  it("rejects diff-only proposals", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/index.ts"]));

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k12b",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          diff: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    });

    assert.equal(result.verdict, "rejected");
    assert.ok(result.rejectionReasons[0].includes("diff-only"));

    cleanupWorkspace(tmpDir);
  });

  it("passes valid multi-file patch", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(
      tmpDir,
      new Set(["src/index.ts", "src/utils.ts", "src/new.ts"]),
    );

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "k13",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: 'export const hello = "updated";',
        },
        {
          path: "src/utils.ts",
          operation: "modify",
          content: 'export function add(a: number, b: number): number { return a + b; }',
        },
        {
          path: "src/new.ts",
          operation: "create",
          content: 'export const NEW = true;',
        },
      ],
    });

    assert.equal(result.verdict, "passed");
    assert.equal(result.checks.length, 3);
    assert.ok(result.checks.every((c) => c.passed));

    cleanupWorkspace(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// Apply tests
// ---------------------------------------------------------------------------

describe("PatchGate — Apply", () => {
  it("applies a valid patch atomically", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(
      tmpDir,
      new Set(["src/index.ts"]),
    );

    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_1",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: 'export const hello = "patched";',
        },
      ],
    });

    assert.equal(validation.verdict, "passed");

    const applied = await applyPatch(deps, validation);
    assert.ok(applied.appliedAt, "should have appliedAt timestamp");

    // Verify the file was changed
    const content = fs.readFileSync(
      path.join(tmpDir, "src/index.ts"),
      "utf-8",
    );
    assert.equal(content, 'export const hello = "patched";');

    cleanupWorkspace(tmpDir);
  });

  // FIX #1: verify redacted content is what gets written to disk
  it("applies redacted content from Secret Firewall", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/index.ts"]), {
      scanContent: async (_path, content) => ({
        blocked: false,
        redactionCount: 1,
        content: content.replace("my-secret-key", "REDACTED"),
      }),
    });

    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_redact",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: 'const apiKey = "my-secret-key";',
        },
      ],
    });

    assert.equal(validation.verdict, "passed_with_warnings");

    const applied = await applyPatch(deps, validation);
    assert.ok(applied.appliedAt);

    // Verify REDACTED content was written, not original
    const content = fs.readFileSync(path.join(tmpDir, "src/index.ts"), "utf-8");
    assert.ok(content.includes("REDACTED"), "should contain REDACTED");
    assert.ok(!content.includes("my-secret-key"), "should NOT contain original secret");

    cleanupWorkspace(tmpDir);
  });

  it("creates new files with parent directories", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["src/deep/nested/file.ts"]));

    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_2",
      files: [
        {
          path: "src/deep/nested/file.ts",
          operation: "create",
          content: 'export const deep = true;',
        },
      ],
    });

    assert.equal(validation.verdict, "passed");

    await applyPatch(deps, validation);

    const exists = fs.existsSync(
      path.join(tmpDir, "src/deep/nested/file.ts"),
    );
    assert.ok(exists, "nested file should be created");

    cleanupWorkspace(tmpDir);
  });

  it("deletes files", async () => {
    tmpDir = createTmpWorkspace();
    const deps = createDeps(tmpDir, new Set(["README.md"]));

    // Verify file exists before deletion
    assert.ok(fs.existsSync(path.join(tmpDir, "README.md")));

    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_3",
      files: [
        {
          path: "README.md",
          operation: "delete",
        },
      ],
    });

    // delete requires exposure check
    assert.equal(validation.verdict, "passed");

    await applyPatch(deps, validation);

    assert.ok(
      !fs.existsSync(path.join(tmpDir, "README.md")),
      "file should be deleted",
    );

    cleanupWorkspace(tmpDir);
  });

  it("throws when trying to apply a rejected patch", async () => {
    const deps = createDeps("/tmp/fake", new Set());

    const result = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_4",
      files: [],
    });

    assert.equal(result.verdict, "rejected");

    await assert.rejects(
      () => applyPatch(deps, result),
      /Cannot apply a rejected patch/,
    );
  });

  // FIX #2: needs_renter_approval throws without explicit approval
  it("throws when applying needs_renter_approval without approval flag", async () => {
    tmpDir = createTmpWorkspace();
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    execFileSync("git", ["add", "package.json"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "add pkg"], { cwd: tmpDir });

    const deps = createDeps(tmpDir, new Set(["package.json"]));

    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_approval",
      files: [
        {
          path: "package.json",
          operation: "modify",
          content: '{"name": "modified"}',
        },
      ],
    });

    assert.equal(validation.verdict, "needs_renter_approval");

    await assert.rejects(
      () => applyPatch(deps, validation),
      /needs_renter_approval/,
    );

    cleanupWorkspace(tmpDir);
  });

  // FIX #2: needs_renter_approval succeeds WITH explicit approval
  it("applies needs_renter_approval when renterApproved is true", async () => {
    tmpDir = createTmpWorkspace();
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    execFileSync("git", ["add", "package.json"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "add pkg"], { cwd: tmpDir });

    const deps = createDeps(tmpDir, new Set(["package.json"]));

    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_approved",
      files: [
        {
          path: "package.json",
          operation: "modify",
          content: '{"name": "modified"}',
        },
      ],
    });

    assert.equal(validation.verdict, "needs_renter_approval");

    const applied = await applyPatch(deps, validation, { renterApproved: true });
    assert.ok(applied.appliedAt);

    const content = fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8");
    assert.equal(content, '{"name": "modified"}');

    cleanupWorkspace(tmpDir);
  });

  it("rolls back on failure", async () => {
    tmpDir = createTmpWorkspace();
    const originalContent = fs.readFileSync(
      path.join(tmpDir, "src/index.ts"),
      "utf-8",
    );

    const deps = createDeps(
      tmpDir,
      new Set(["src/index.ts"]),
    );

    // Create a validation result that includes a modify that will work
    // and a modify of a file with an impossible path (to trigger error)
    const validation = await validatePatch(deps, {
      sessionId: "s1",
      idempotencyKey: "apply_5",
      files: [
        {
          path: "src/index.ts",
          operation: "modify",
          content: 'export const hello = "will be rolled back";',
        },
      ],
    });

    // Manually corrupt the result to have a second file that will fail on apply
    validation.proposal.files.push({
      path: "src/will-fail.ts",
      operation: "modify",
      // no content — will throw during apply
    });

    try {
      await applyPatch(deps, validation);
      assert.fail("should have thrown");
    } catch (err: unknown) {
      assert.ok((err as Error).message.includes("rolled back"));
    }

    // Verify rollback — original content should be restored
    const restored = fs.readFileSync(
      path.join(tmpDir, "src/index.ts"),
      "utf-8",
    );
    assert.equal(restored, originalContent, "file should be rolled back");

    cleanupWorkspace(tmpDir);
  });
});
