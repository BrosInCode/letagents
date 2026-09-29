import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_ROOM_CHAT_EVENT_KINDS,
  ROOM_AGENT_GUIDELINES_MAX_BYTES,
} from "../../../../shared/room-settings.mjs";
import {
  GITHUB_EVENT_KIND_LABELS,
  GUIDELINES_IMPORT_MAX_BYTES,
  checkGuidelinesImport,
  checkGuidelinesImportText,
  describeGuidelinesBudget,
} from "../src/components/desktop/content/room-shell/room-settings-presentation";
import {
  forgetGuidelinesDraft,
  keptGuidelinesDraft,
  rememberGuidelinesDraft,
} from "../src/components/desktop/content/room-shell/room-settings-drafts";

test("every kind the server knows has a label, and no label is left over", () => {
  assert.deepEqual(Object.keys(GITHUB_EVENT_KIND_LABELS).sort(), [...GITHUB_ROOM_CHAT_EVENT_KINDS].sort());
});

test("an empty draft invites writing and reports nothing saved", () => {
  const budget = describeGuidelinesBudget("   \n ");
  assert.equal(budget.level, "ok");
  assert.equal(budget.fill, 0);
  assert.equal(budget.message, "Up to about 2,000 tokens");
  assert.equal(budget.summary, "None");
});

test("the budget is reported in tokens and decided by the exact byte limit", () => {
  assert.deepEqual(describeGuidelinesBudget("x".repeat(360)), {
    tokens: 90, fill: 0.045, level: "ok", message: "About 90 of 2,000 tokens", summary: "5% used",
  });
  assert.equal(describeGuidelinesBudget("x").summary, "1% used", "a saved rule never rounds down to nothing");
  assert.equal(describeGuidelinesBudget("x".repeat(6399)).level, "ok");
  assert.equal(describeGuidelinesBudget("x".repeat(6400)).level, "near");

  const atLimit = describeGuidelinesBudget("x".repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES));
  assert.equal(atLimit.level, "near");
  assert.equal(atLimit.fill, 1);
  assert.equal(atLimit.message, "About 2,000 of 2,000 tokens");

  // One character over is refused by the server, so it must read as over here.
  const over = describeGuidelinesBudget("x".repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES + 1));
  assert.equal(over.level, "over");
  assert.equal(over.fill, 1);
  assert.equal(over.message, "About 1 token over the 2,000 limit. Shorten it to save.");
  assert.equal(describeGuidelinesBudget("x".repeat(9444)).message, "About 361 tokens over the 2,000 limit. Shorten it to save.");
});

test("whitespace around the text is not counted, as the server does not count it", () => {
  assert.equal(describeGuidelinesBudget(`\n\n${"x".repeat(ROOM_AGENT_GUIDELINES_MAX_BYTES)}\r\n`).level, "near");
});

test("writing that is not English is held to the same token budget", () => {
  // 2,666 Chinese characters fill the budget; by characters, 8,000 would have fitted.
  assert.equal(describeGuidelinesBudget("规".repeat(2666)).level, "near");
  assert.equal(describeGuidelinesBudget("规".repeat(2667)).level, "over");
  assert.equal(describeGuidelinesBudget("😀".repeat(2000)).fill, 1);
  assert.equal(describeGuidelinesBudget("😀".repeat(2001)).level, "over");
});

test("a file that is not plain text is refused after it is read", () => {
  assert.deepEqual(checkGuidelinesImportText("rules.md", "# Rules\n- Branch from staging."), { ok: true });
  // A Windows "Unicode" text file is UTF-16; read as UTF-8 it is full of null characters.
  assert.deepEqual(checkGuidelinesImportText("rules.txt", "R\u0000u\u0000l\u0000e\u0000s\u0000"), {
    ok: false, reason: "rules.txt isn't plain text. Save it as UTF-8 text, or paste the rules in.",
  });
});

test("unsaved guidelines are kept for the room they were written in", () => {
  assert.equal(keptGuidelinesDraft("github.com/org/repo"), null);
  rememberGuidelinesDraft("github.com/org/repo", "- Keep pull requests small.", "- Branch from staging.");
  // The saved text it was written against is kept too, so a later save by someone else can be noticed.
  assert.deepEqual(keptGuidelinesDraft("github.com/org/repo"), {
    draft: "- Keep pull requests small.", writtenAgainst: "- Branch from staging.",
  });
  assert.equal(keptGuidelinesDraft("github.com/org/other"), null);
  forgetGuidelinesDraft("github.com/org/repo");
  assert.equal(keptGuidelinesDraft("github.com/org/repo"), null);
});

test("only text files within the size limit are read", () => {
  assert.deepEqual(checkGuidelinesImport({ name: "AGENTS.md", size: 1200, type: "" }), { ok: true });
  assert.deepEqual(checkGuidelinesImport({ name: "rules", size: 1200, type: "text/plain" }), { ok: true });
  assert.deepEqual(checkGuidelinesImport({ name: "rules.TXT", size: GUIDELINES_IMPORT_MAX_BYTES, type: "" }), { ok: true });

  const image = checkGuidelinesImport({ name: "diagram.png", size: 1200, type: "image/png" });
  assert.deepEqual(image, { ok: false, reason: "diagram.png isn't a text file. Import a .md or .txt file." });

  const large = checkGuidelinesImport({ name: "handbook.md", size: 412 * 1024, type: "text/markdown" });
  assert.equal(large.ok, false);
  assert.match((large as { reason: string }).reason, /^handbook\.md is 412 KB, far past the limit\./);
});
