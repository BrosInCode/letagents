import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHandoffCapabilityManifest,
  evaluateHandoffPolicy,
  getDefaultHandoffGrantTypes,
  getDefaultHandoffPermissionProfile,
  isSupportedHandoffExecutionMode,
  normalizeHandoffExecutionMode,
  normalizeHandoffGrantStatus,
  normalizeHandoffGrantType,
  normalizeHandoffOutputType,
  normalizeHandoffPermissionProfile,
  normalizeHandoffSessionStatus,
} from "../handoff.js";

test("normalizeHandoffExecutionMode accepts known modes", () => {
  assert.equal(normalizeHandoffExecutionMode("hosted_isolated"), "hosted_isolated");
  assert.equal(normalizeHandoffExecutionMode(" supplier_local "), "supplier_local");
});

test("normalizeHandoffExecutionMode rejects unknown modes", () => {
  assert.equal(normalizeHandoffExecutionMode("hosted"), null);
  assert.equal(normalizeHandoffExecutionMode(""), null);
});

test("handoff output defaults map to least-privilege profiles and grants", () => {
  assert.equal(getDefaultHandoffPermissionProfile("research_note"), "research_readonly");
  assert.deepEqual(getDefaultHandoffGrantTypes("research_note"), ["repo_read"]);

  assert.equal(getDefaultHandoffPermissionProfile("comment"), "comment_review");
  assert.deepEqual(getDefaultHandoffGrantTypes("comment"), ["repo_read", "pr_comment"]);

  assert.equal(getDefaultHandoffPermissionProfile("draft_pr"), "draft_pr_write");
  assert.deepEqual(getDefaultHandoffGrantTypes("draft_pr"), ["repo_read", "branch_write"]);
});

test("normalizeHandoff* helpers reject invalid enum values", () => {
  assert.equal(normalizeHandoffOutputType("review"), null);
  assert.equal(normalizeHandoffPermissionProfile("write_all"), null);
  assert.equal(normalizeHandoffSessionStatus("paused"), null);
  assert.equal(normalizeHandoffGrantType("shell"), null);
  assert.equal(normalizeHandoffGrantStatus("stopped"), null);
});

test("isSupportedHandoffExecutionMode only allows the contracted v1 lane", () => {
  assert.equal(isSupportedHandoffExecutionMode("hosted_isolated"), true);
  assert.equal(isSupportedHandoffExecutionMode("supplier_local"), false);
});

test("evaluateHandoffPolicy builds manifest and enforces v1 gates", () => {
  const ok = evaluateHandoffPolicy({
    outputType: "draft_pr",
    repoScope: "acme/app",
    targetBranch: "feature/handoff-1",
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) throw new Error("expected ok");
  assert.equal(ok.permissionProfile, "draft_pr_write");
  assert.equal(ok.executionMode, "hosted_isolated");
  assert.equal(ok.manifest.recursive_handoff, "deny");
  assert.equal(ok.manifest.repo_instructions_trusted, false);
  assert.equal(ok.manifest.grants.length, 2);
  const branchWrite = ok.manifest.grants.find((g) => g.grant_type === "branch_write");
  assert.ok(branchWrite);
  assert.equal(branchWrite?.scoped_branch, "feature/handoff-1");
});

test("evaluateHandoffPolicy rejects supplier_local for v1", () => {
  const bad = evaluateHandoffPolicy({
    outputType: "research_note",
    executionMode: "supplier_local",
    repoScope: "acme/app",
    targetBranch: "main",
  });
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error("expected failure");
  assert.equal(bad.code, "unsupported_execution_mode");
});

test("evaluateHandoffPolicy rejects nested sessions", () => {
  const bad = evaluateHandoffPolicy({
    outputType: "comment",
    parentSessionId: "handoff_session_x",
    repoScope: "acme/app",
    targetBranch: "main",
  });
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error("expected failure");
  assert.equal(bad.code, "recursive_handoff_forbidden");
});

test("evaluateHandoffPolicy rejects permission profile mismatched to output", () => {
  const bad = evaluateHandoffPolicy({
    outputType: "research_note",
    permissionProfile: "draft_pr_write",
    repoScope: "acme/app",
    targetBranch: "main",
  });
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error("expected failure");
  assert.equal(bad.code, "permission_profile_mismatch");
});

test("buildHandoffCapabilityManifest scopes branch_write to target branch", () => {
  const manifest = buildHandoffCapabilityManifest({
    outputType: "draft_pr",
    permissionProfile: "draft_pr_write",
    executionMode: "hosted_isolated",
    repoScope: "acme/app",
    targetBranch: "fix/thing",
  });
  assert.deepEqual(
    manifest.grants.map((g) => [g.grant_type, g.scoped_branch]),
    [
      ["repo_read", null],
      ["branch_write", "fix/thing"],
    ]
  );
});
