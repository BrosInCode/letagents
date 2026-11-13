import assert from "node:assert/strict";
import test from "node:test";
import { boundEditPatch, claudeEditEvidence, codexEditEvidence, providerEditEvidence } from "../../../../shared/agent-edit-evidence.mjs";

// Shapes probed from Claude Code 2.1.321 stream-json (see the change-card contract).
const claudeResult = (toolUseResult: unknown, isError = false) => ({
  type: "user", session_id: "session", parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", ...(isError ? { is_error: true } : {}) }] },
  tool_use_result: toolUseResult,
});

test("Claude Edit: the structured patch's hunks and counts", () => {
  const evidence = claudeEditEvidence(claudeResult({
    filePath: "/work/notes.txt", oldString: "line two", newString: "line two changed\nline two b", originalFile: "line one\nline two\nline three\n",
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" line one", "-line two", "+line two changed", "+line two b", " line three"] }],
    userModified: false, replaceAll: false,
  }));
  assert.deepEqual(evidence, [{ path: "/work/notes.txt", additions: 2, deletions: 1, patch_truncated: false,
    patch: "@@ -1,3 +1,4 @@\n line one\n-line two\n+line two changed\n+line two b\n line three" }]);
});

test("Claude Edit with replace_all: every replaced line counts", () => {
  const evidence = claudeEditEvidence(claudeResult({
    filePath: "/work/a.ts", oldString: "foo", newString: "bar", replaceAll: true, originalFile: "foo\nx\nfoo\n",
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-foo", "+bar", " x", "-foo", "+bar"] }],
  }));
  assert.deepEqual(evidence?.map(({ additions, deletions }) => [additions, deletions]), [[2, 2]]);
});

test("Claude Write of a new file: one hunk of added lines", () => {
  const evidence = claudeEditEvidence(claudeResult({ type: "create", filePath: "/work/new.txt", content: "a\nb\nc", structuredPatch: [], originalFile: null }));
  assert.deepEqual(evidence, [{ path: "/work/new.txt", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c", patch_truncated: false }]);
  assert.deepEqual(claudeEditEvidence(claudeResult({ type: "create", filePath: "/work/empty.txt", content: "", structuredPatch: [], originalFile: null })),
    [{ path: "/work/empty.txt", additions: 0, deletions: 0, patch: "", patch_truncated: false }]);
});

test("Claude Write over a file: its hunks; a no-newline marker is not a count", () => {
  const evidence = claudeEditEvidence(claudeResult({ type: "update", filePath: "/work/a.txt", content: "one\nTWO", originalFile: "one\ntwo",
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" one", "-two", "\\ No newline at end of file", "+TWO", "\\ No newline at end of file"] }] }));
  assert.deepEqual(evidence?.[0] && [evidence[0].additions, evidence[0].deletions], [1, 1]);
  assert.match(evidence![0]!.patch, /^@@ -1,2 \+1,2 @@\n one\n-two\n\\ No newline at end of file\n\+TWO\n\\ No newline/);
});

test("Claude: a refused or failed call, and other messages, have no evidence", () => {
  assert.equal(claudeEditEvidence(claudeResult("User rejected tool use", true)), null);
  assert.equal(claudeEditEvidence(claudeResult({ filePath: "/work/a", structuredPatch: [] }, true)), null);
  assert.equal(claudeEditEvidence({ type: "assistant", tool_use_result: { filePath: "/a", structuredPatch: [] } }), null);
  assert.equal(claudeEditEvidence(claudeResult({ stdout: "ok", stderr: "" })), null, "a Bash result");
  assert.equal(claudeEditEvidence(null), null);
  // A subagent's edit counts for the turn as well.
  assert.equal(claudeEditEvidence({ ...claudeResult({ filePath: "/w/s.ts", structuredPatch: [] }), parent_tool_use_id: "toolu_parent" })?.length, 1);
});

const codexCompleted = (changes: unknown[], status = "completed") => ({ threadId: "thread", turnId: "turn",
  item: { type: "fileChange", id: "item_1", changes, status } });

test("Codex update: a unified diff; file headers and the move note are left out", () => {
  const evidence = codexEditEvidence("item/completed", codexCompleted([{ path: "/work/src/a.ts", kind: { type: "update", move_path: null },
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ export\n keep\n--- removed dashes\n+++ added pluses\n keep\n" }]));
  assert.deepEqual(evidence, [{ path: "/work/src/a.ts", additions: 1, deletions: 1, patch_truncated: false,
    patch: "@@ -1,3 +1,3 @@\n keep\n--- removed dashes\n+++ added pluses\n keep" }]);
  const moved = codexEditEvidence("item/completed", codexCompleted([{ path: "old.ts", kind: { type: "update", move_path: "new.ts" },
    diff: "@@ -1 +1 @@\n-a\n+b\n\nMoved to: new.ts\n" }]));
  assert.deepEqual(moved?.map(({ path, additions, deletions, patch }) => [path, additions, deletions, patch]), [["new.ts", 1, 1, "@@ -1 +1 @@\n-a\n+b"]]);
});

test("Codex add and delete: the diff is the file content", () => {
  const evidence = codexEditEvidence("item/completed", codexCompleted([
    { path: "added.ts", kind: { type: "add" }, diff: "one\ntwo\n" },
    { path: "gone.ts", kind: { type: "delete" }, diff: "x\n" },
    { path: "hunked.ts", kind: { type: "add" }, diff: "@@ -0,0 +1,1 @@\n+only\n" },
  ]));
  assert.deepEqual(evidence, [
    { path: "added.ts", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+one\n+two", patch_truncated: false },
    { path: "gone.ts", additions: 0, deletions: 1, patch: "@@ -1,1 +0,0 @@\n-x", patch_truncated: false },
    { path: "hunked.ts", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+only", patch_truncated: false },
  ]);
});

test("Codex kind as a plain string, and only a completed item counts", () => {
  assert.deepEqual(codexEditEvidence("item/completed", codexCompleted([{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }]))?.map((file) => file.additions), [1]);
  for (const status of ["inProgress", "failed", "declined"]) assert.equal(codexEditEvidence("item/completed", codexCompleted([{ path: "a.ts", kind: "add", diff: "x" }], status)), null, status);
  assert.equal(codexEditEvidence("item/started", codexCompleted([{ path: "a.ts", kind: "add", diff: "x" }])), null);
  assert.equal(codexEditEvidence("item/completed", { item: { type: "commandExecution", status: "completed" } }), null);
  assert.equal(providerEditEvidence("cursor", "item/completed", codexCompleted([{ path: "a.ts", kind: "add", diff: "x" }])), null);
});

test("a long patch is cut at a line boundary", () => {
  const patch = `@@ -0,0 +1,3000 @@\n${Array.from({ length: 3000 }, (_, i) => `+line ${i}`).join("\n")}`;
  const bounded = boundEditPatch(patch, 8000);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.patch.length <= 8000);
  assert.ok(patch.startsWith(`${bounded.patch}\n`), "a whole number of lines");
  const [file] = claudeEditEvidence(claudeResult({ type: "create", filePath: "/w/big.txt", content: Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"), structuredPatch: [] }))!;
  assert.equal(file!.additions, 3000, "the counts are not cut");
  assert.equal(file!.patch_truncated, true);
  assert.ok(file!.patch.length <= 8000);
});
