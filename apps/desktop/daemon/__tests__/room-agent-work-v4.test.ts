import assert from "node:assert/strict";
import test from "node:test";
import { hasReviewableRoomContribution, parseRoomAgentWorkSummary, ROOM_CONTRIBUTION_EDIT_LIMITS } from "../../../../shared/room-agent-work.mjs";

const changes = (files: Array<{ path: string; additions: number; deletions: number }> = [{ path: "app.ts", additions: 1, deletions: 1 }]) => ({
  captured_at: "2026-11-13T10:00:00.000Z", branch: "fix/one", base_revision: "a".repeat(40), state: "ready",
  files: files.map((file) => ({ ...file, previous_path: null, status: "modified", binary: false })),
  additions: files.reduce((n, file) => n + file.additions, 0), deletions: files.reduce((n, file) => n + file.deletions, 0),
  hidden_files: 0, patch: "@@ -1 +1 @@\n-original\n+new\n", patch_truncated: false,
});
const execution = () => ({ recorded_state: "completed", evidence_incomplete: false, elapsed_ms: 1250,
  operation_counts: { unresolved: 0, succeeded: 2, failed: 0, denied_before_start: 0, cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 } });
const v3 = () => ({ version: 3, ...execution(), workspace: changes(), contribution: { changes: changes(), summary: "Fixed it" } });
const edit = (path = "app.ts", patch = "@@ -1,1 +1,1 @@\n-original\n+new") => ({ path, additions: 1, deletions: 1, patch, patch_truncated: false });
const v4 = (edits: unknown = { files: [edit()], hidden_files: 0 }, start: unknown = { committed_at: "2026-09-20T08:00:00+02:00", in_history: false }) =>
  ({ ...v3(), version: 4, contribution: { ...v3().contribution, edits, start } });

test("v3 summaries parse to exactly the bytes they did before v4", () => {
  // Pinned output of the v3 parser before this change; key order is part of the publication echo check.
  const expected = '{"version":3,"recorded_state":"completed","workspace":{"captured_at":"2026-11-13T10:00:00.000Z","branch":"fix/one","base_revision":"'
    + "a".repeat(40) + '","state":"ready","files":[{"path":"app.ts","previous_path":null,"status":"modified","additions":1,"deletions":1,"binary":false}],"additions":1,"deletions":1,"hidden_files":0,"patch":"@@ -1 +1 @@\\n-original\\n+new\\n","patch_truncated":false},'
    + '"contribution":{"changes":{"captured_at":"2026-11-13T10:00:00.000Z","branch":"fix/one","base_revision":"' + "a".repeat(40)
    + '","state":"ready","files":[{"path":"app.ts","previous_path":null,"status":"modified","additions":1,"deletions":1,"binary":false}],"additions":1,"deletions":1,"hidden_files":0,"patch":"@@ -1 +1 @@\\n-original\\n+new\\n","patch_truncated":false},"summary":"Fixed it"},'
    + '"evidence_incomplete":false,"elapsed_ms":1250,"operation_counts":{"unresolved":0,"succeeded":2,"failed":0,"denied_before_start":0,"cancelled_before_start":0,"interrupted_after_start":0,"lost_after_start":0}}';
  assert.equal(JSON.stringify(parseRoomAgentWorkSummary(v3())), expected);
  assert.equal(parseRoomAgentWorkSummary({ ...v3(), contribution: { ...v3().contribution, edits: null, start: null } }), null, "v3 never carries edits");
});

test("v4 is accepted and rebuilt canonically, and parsing is idempotent", () => {
  const parsed = parseRoomAgentWorkSummary(v4());
  assert.ok(parsed);
  assert.equal(parsed.version, 4);
  assert.deepEqual(Object.keys(parsed.contribution!), ["changes", "summary", "edits", "start"]);
  assert.deepEqual(parsed.contribution!.edits, { files: [edit()], hidden_files: 0 });
  assert.deepEqual(parsed.contribution!.start, { committed_at: "2026-09-20T06:00:00.000Z", in_history: false });
  assert.equal(JSON.stringify(parseRoomAgentWorkSummary(parsed)), JSON.stringify(parsed));
  assert.ok(parseRoomAgentWorkSummary(v4(null, null)), "edits and start may each be null");
  assert.ok(parseRoomAgentWorkSummary(v4({ files: [], hidden_files: 0 }, { committed_at: null, in_history: null })));
  assert.ok(parseRoomAgentWorkSummary(v4({ files: [{ ...edit(), patch: "", patch_truncated: true }], hidden_files: 3 })));
  assert.ok(parseRoomAgentWorkSummary(v4({ files: [edit("a.ts", "@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file")], hidden_files: 0 })));
  assert.equal(hasReviewableRoomContribution(parsed), true);
  const noComparison = parseRoomAgentWorkSummary({ ...v4(), contribution: { ...v4().contribution, changes: { ...changes([]), patch: "" } } });
  assert.ok(noComparison);
  assert.equal(hasReviewableRoomContribution(noComparison), false, "edits alone are not a reviewable comparison");
});

test("v4 rejects anything outside the contract", () => {
  const { files: limit, patchChars, totalPatchChars } = ROOM_CONTRIBUTION_EDIT_LIMITS;
  const many = (count: number) => Array.from({ length: count }, (_, i) => edit(`f${i}.ts`));
  const rejected: Array<[string, unknown]> = [
    ["missing edits", { ...v3(), version: 4 }],
    ["extra contribution key", { ...v4(), contribution: { ...v4().contribution, extra: 1 } }],
    ["edits extra key", v4({ files: [], hidden_files: 0, extra: 1 })],
    ["file extra key", v4({ files: [{ ...edit(), status: "modified" }], hidden_files: 0 })],
    ["duplicate path", v4({ files: [edit(), edit()], hidden_files: 0 })],
    ["absolute path", v4({ files: [edit("/etc/passwd")], hidden_files: 0 })],
    ["parent path", v4({ files: [edit("../outside.ts")], hidden_files: 0 })],
    ["drive path", v4({ files: [edit("C:/x.ts")], hidden_files: 0 })],
    ["control character", v4({ files: [edit("a\nb.ts")], hidden_files: 0 })],
    ["empty path", v4({ files: [edit("")], hidden_files: 0 })],
    ["fractional count", v4({ files: [{ ...edit(), additions: 1.5 }], hidden_files: 0 })],
    ["negative count", v4({ files: [{ ...edit(), deletions: -1 }], hidden_files: 0 })],
    ["string count", v4({ files: [{ ...edit(), additions: "1" }], hidden_files: 0 })],
    ["fractional hidden", v4({ files: [], hidden_files: 0.5 })],
    ["too many files", v4({ files: many(limit + 1), hidden_files: 0 })],
    ["over-long patch", v4({ files: [edit("a.ts", `@@ -0,0 +1,1 @@\n+${"x".repeat(patchChars)}`)], hidden_files: 0 })],
    ["over total patch", v4({ files: many(limit).map((file) => ({ ...file, patch: `@@ -0,0 +1,1 @@\n+${"x".repeat(Math.ceil(totalPatchChars / limit))}` })), hidden_files: 0 })],
    ["not hunks", v4({ files: [edit("a.ts", "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b")], hidden_files: 0 })],
    ["foreign line", v4({ files: [edit("a.ts", "@@ -1 +1 @@\nplain")], hidden_files: 0 })],
    ["patch_truncated not boolean", v4({ files: [{ ...edit(), patch_truncated: 0 }], hidden_files: 0 })],
    ["non-ISO committed_at", v4(undefined, { committed_at: "20 Sep 2026", in_history: true })],
    ["date-only committed_at", v4(undefined, { committed_at: "2026-09-20", in_history: true })],
    ["impossible committed_at", v4(undefined, { committed_at: "2026-13-40T00:00:00Z", in_history: true })],
    ["in_history string", v4(undefined, { committed_at: null, in_history: "yes" })],
    ["start extra key", v4(undefined, { committed_at: null, in_history: null, head: "x" })],
    ["start missing key", v4(undefined, { committed_at: null })],
    ["edits array", v4([])],
  ];
  for (const [name, value] of rejected) assert.equal(parseRoomAgentWorkSummary(value), null, name);
  assert.ok(parseRoomAgentWorkSummary(v4({ files: many(limit), hidden_files: 7 })), "exactly the file limit");
});
