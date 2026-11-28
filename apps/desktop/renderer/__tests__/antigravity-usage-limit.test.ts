import assert from "node:assert/strict";
import test from "node:test";
import { antigravityLimitNotice } from "../src/domain/antigravity-usage-limit";
import { claudeLimitNotice } from "../src/domain/claude-usage-limit";

const NOW = Date.parse("2026-11-28T10:00:00.000Z");

test("an Antigravity usage limit error reads as 'You may have run out of usage', with a reset still ahead", () => {
  const notice = antigravityLimitNotice("You may have run out of Antigravity usage for this model. Antigravity answered with a usage limit error; the limit resets at 2026-11-28T18:00:00.000Z. The turn ended without a reply.", "antigravity", NOW);
  assert.equal(notice?.title, "You may have run out of usage");
  assert.match(notice?.detail ?? "", /usage limit error/);
  assert.ok(notice?.reset, "the reset is ahead, so it shows");
  assert.equal(notice?.modelFamily, null, "no Claude model recovery");
  assert.equal(notice?.usageLink, null, "Antigravity has no usage page to open");
  const passed = antigravityLimitNotice("You may have run out of Antigravity usage for this model. Antigravity answered with a usage limit error; the limit resets at 2026-11-27T18:00:00.000Z. The turn ended without a reply.", "antigravity", NOW);
  assert.equal(passed?.reset, null, "a reset in the past is not shown");
});

test("the words of earlier releases and a refused turn read the same way", () => {
  for (const error of [
    "Antigravity's usage limit for this model is reached; it resets at 2026-11-28T18:00:00.000Z. The turn ended without a reply.",
    "Antigravity refused this turn. You may have run out of usage.",
    "Antigravity refused this turn. The account may have reached its usage limit.",
  ]) assert.equal(antigravityLimitNotice(error, "antigravity", NOW)?.title, "You may have run out of usage", error);
});

test("other failures and other providers get no Antigravity notice", () => {
  assert.equal(antigravityLimitNotice("Antigravity's model request failed (NOT_FOUND 404): model gemini-x is not available. The turn ended without a reply.", "antigravity", NOW), null);
  assert.equal(antigravityLimitNotice("Antigravity refused this turn. I will not do that.", "antigravity", NOW), null, "a refusal with the model's own words is not a limit");
  assert.equal(antigravityLimitNotice("You may have run out of Antigravity usage for this model.", "codex", NOW), null);
  assert.equal(antigravityLimitNotice(null, "antigravity", NOW), null);
  assert.equal(claudeLimitNotice("You may have run out of Antigravity usage for this model.", "antigravity"), null);
});

test("Claude's notice keeps its usage page", () => {
  assert.deepEqual(claudeLimitNotice("You've hit your weekly limit · resets Mon 9am", "claude-code")?.usageLink,
    { url: "https://claude.ai/settings/usage", label: "Manage Claude usage" });
});
