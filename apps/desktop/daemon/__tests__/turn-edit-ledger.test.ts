import assert from "node:assert/strict";
import test from "node:test";
import { TurnEditLedger } from "../turn-edit-ledger.js";
import { ROOM_CONTRIBUTION_EDIT_LIMITS } from "../../../../shared/room-agent-work.mjs";

const edit = (path: string, patch = "@@ -1 +1 @@\n-a\n+b", additions = 1, deletions = 1) => ({ path, additions, deletions, patch, patch_truncated: false });

test("edits of one turn merge per path in call order", () => {
  const ledger = new TurnEditLedger();
  ledger.turnStarted("agent", "inbox-1");
  ledger.observe("agent", [edit("/w/a.ts")]);
  ledger.observe("agent", [edit("/w/b.ts", "@@ -0,0 +1,1 @@\n+x", 1, 0), edit("/w/a.ts", "@@ -5 +5 @@\n-c\n+d")]);
  ledger.turnStarted("agent", "inbox-1"); // the next phase of the same turn keeps its edits
  assert.deepEqual(ledger.take("agent", "inbox-1", "claude-code"), { hidden_files: 0, files: [
    { path: "/w/a.ts", additions: 2, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n+d", patch_truncated: false },
    { path: "/w/b.ts", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+x", patch_truncated: false },
  ] });
  assert.equal(ledger.take("agent", "inbox-1", "cursor"), null, "a provider without edit events has no evidence");
  assert.equal(ledger.take("agent", "inbox-2", "codex"), null, "another turn's item is not this turn");
});

test("a new turn starts empty; evidence outside a turn is dropped", () => {
  const ledger = new TurnEditLedger();
  ledger.observe("agent", [edit("/w/early.ts")]);
  ledger.turnStarted("agent", "inbox-1");
  assert.deepEqual(ledger.take("agent", "inbox-1", "codex"), { files: [], hidden_files: 0 }, "the provider reports edits and reported none");
  ledger.observe("agent", [edit("/w/a.ts")]);
  ledger.turnStarted("agent", "inbox-2");
  assert.deepEqual(ledger.take("agent", "inbox-2", "codex")?.files, []);
  ledger.observe("agent", [edit("/w/b.ts")]);
  ledger.turnEnded("agent", "inbox-1"); // an older turn's end does not end this one
  assert.equal(ledger.take("agent", "inbox-2", "codex")?.files.length, 1);
  ledger.turnEnded("agent", null);
  ledger.observe("agent", [edit("/w/late.ts")]);
  assert.equal(ledger.take("agent", "inbox-2", "codex"), null);
  ledger.turnStarted("other", "inbox-9");
  ledger.observe("agent", [edit("/w/x.ts")]);
  assert.deepEqual(ledger.take("other", "inbox-9", "claude-code")?.files, [], "agents do not share a turn");
});

test("the limits hold: files, hidden files, per-file and total patch text", () => {
  const { files: fileLimit, patchChars, totalPatchChars } = ROOM_CONTRIBUTION_EDIT_LIMITS;
  const ledger = new TurnEditLedger();
  ledger.turnStarted("agent", "inbox-1");
  const big = (lines: number) => `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+${"x".repeat(40)} ${i}`).join("\n")}`;
  for (let i = 0; i < fileLimit + 5; i++) ledger.observe("agent", [edit(`/w/${i}.ts`, big(300), 300, 0)]);
  ledger.observe("agent", [edit("/w/21.ts", "@@ -1 +1 @@\n-a\n+b")]); // an already hidden file is counted once
  ledger.observe("agent", [edit("/w/0.ts", "@@ -1 +1 @@\n-a\n+b")]); // appended to a cut patch: counts only
  const taken = ledger.take("agent", "inbox-1", "codex")!;
  assert.equal(taken.files.length, fileLimit);
  assert.equal(taken.hidden_files, 5);
  assert.equal(taken.files[0]!.additions, 301);
  assert.ok(taken.files.every((file) => file.patch.length <= patchChars && file.patch_truncated));
  assert.ok(taken.files.reduce((n, file) => n + file.patch.length, 0) <= totalPatchChars);
  assert.equal(taken.files.at(-1)!.patch, "", "later patches are withheld once the total is spent");
  assert.ok(!taken.files[0]!.patch.includes("-a\n+b"), "nothing follows a cut patch");
});
