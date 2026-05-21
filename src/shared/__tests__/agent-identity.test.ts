import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentActorLabel,
  formatOwnerAttribution,
  getAgentPrimaryLabel,
  inferAgentIdeLabel,
  parseAgentActorLabel,
  toTitleCaseCodename,
} from "../agent-identity.js";

// ── toTitleCaseCodename ─────────────────────────────────

test("toTitleCaseCodename converts hyphenated codenames to title case", () => {
  assert.equal(toTitleCaseCodename("amber-leaf"), "Amber Leaf");
  assert.equal(toTitleCaseCodename("marsh-indigo"), "Marsh Indigo");
});

test("toTitleCaseCodename handles single words", () => {
  assert.equal(toTitleCaseCodename("amber"), "Amber");
  assert.equal(toTitleCaseCodename("AMBER"), "Amber");
});

test("toTitleCaseCodename normalizes whitespace", () => {
  assert.equal(toTitleCaseCodename("  amber   leaf  "), "Amber Leaf");
});

test("toTitleCaseCodename returns empty string for empty input", () => {
  assert.equal(toTitleCaseCodename(""), "");
  assert.equal(toTitleCaseCodename("   "), "");
});

// ── formatOwnerAttribution ──────────────────────────────

test("formatOwnerAttribution adds possessive 's for non-s-ending names", () => {
  assert.equal(formatOwnerAttribution("EmmyMay"), "EmmyMay's agent");
  assert.equal(formatOwnerAttribution("GHOST OF SHANNON"), "GHOST OF SHANNON's agent");
});

test("formatOwnerAttribution adds only apostrophe for s-ending names", () => {
  assert.equal(formatOwnerAttribution("James"), "James' agent");
  assert.equal(formatOwnerAttribution("Chris"), "Chris' agent");
});

test("formatOwnerAttribution defaults to Owner for empty input", () => {
  assert.equal(formatOwnerAttribution(""), "Owner's agent");
  assert.equal(formatOwnerAttribution("   "), "Owner's agent");
});

// ── inferAgentIdeLabel ──────────────────────────────────

test("inferAgentIdeLabel recognizes known IDE prefixes", () => {
  assert.equal(inferAgentIdeLabel("codex"), "Codex");
  assert.equal(inferAgentIdeLabel("codex-worker"), "Codex");
  assert.equal(inferAgentIdeLabel("antigravity"), "Antigravity");
  assert.equal(inferAgentIdeLabel("antigravity-headless"), "Antigravity");
  assert.equal(inferAgentIdeLabel("claude"), "Claude");
  assert.equal(inferAgentIdeLabel("claude-3"), "Claude");
  assert.equal(inferAgentIdeLabel("orchestrator"), "Orchestrator");
  assert.equal(inferAgentIdeLabel("orchestrator-v2"), "Orchestrator");
});

test("inferAgentIdeLabel is case-insensitive", () => {
  assert.equal(inferAgentIdeLabel("CODEX"), "Codex");
  assert.equal(inferAgentIdeLabel("Antigravity"), "Antigravity");
});

test("inferAgentIdeLabel returns null for unknown labels", () => {
  assert.equal(inferAgentIdeLabel("cursor"), null);
  assert.equal(inferAgentIdeLabel("vscode"), null);
  assert.equal(inferAgentIdeLabel(""), null);
  assert.equal(inferAgentIdeLabel(null), null);
  assert.equal(inferAgentIdeLabel(undefined), null);
});

// ── buildAgentActorLabel ────────────────────────────────

test("buildAgentActorLabel builds structured three-part label", () => {
  const label = buildAgentActorLabel({
    display_name: "MarshIndigo",
    owner_label: "EmmyMay",
    ide_label: "Agent",
  });
  assert.equal(label, "MarshIndigo | EmmyMay's agent | Agent");
});

test("buildAgentActorLabel normalizes ide_label", () => {
  const label = buildAgentActorLabel({
    display_name: "LeafOpal",
    owner_label: "GHOST OF SHANNON",
    ide_label: "antigravity",
  });
  assert.equal(label, "LeafOpal | GHOST OF SHANNON's agent | Antigravity");
});

test("buildAgentActorLabel defaults ide_label to Agent when null", () => {
  const label = buildAgentActorLabel({
    display_name: "AmberLeaf",
    owner_label: "TestUser",
  });
  assert.equal(label, "AmberLeaf | TestUser's agent | Agent");
});

test("buildAgentActorLabel defaults display_name to Agent when empty", () => {
  const label = buildAgentActorLabel({
    display_name: "",
    owner_label: "TestUser",
    ide_label: "Codex",
  });
  assert.equal(label, "Agent | TestUser's agent | Codex");
});

// ── parseAgentActorLabel ────────────────────────────────

test("parseAgentActorLabel parses structured three-part labels", () => {
  const parsed = parseAgentActorLabel("MarshIndigo | EmmyMay's agent | Agent");
  assert.ok(parsed);
  assert.equal(parsed.display_name, "MarshIndigo");
  assert.equal(parsed.owner_attribution, "EmmyMay's agent");
  assert.equal(parsed.ide_label, "Agent");
  assert.equal(parsed.structured, true);
});

test("parseAgentActorLabel parses labels with known IDE names", () => {
  const parsed = parseAgentActorLabel("LeafOpal | GHOST OF SHANNON's agent | Antigravity");
  assert.ok(parsed);
  assert.equal(parsed.display_name, "LeafOpal");
  assert.equal(parsed.owner_attribution, "GHOST OF SHANNON's agent");
  assert.equal(parsed.ide_label, "Antigravity");
  assert.equal(parsed.structured, true);
});

test("parseAgentActorLabel parses legacy parenthesized format", () => {
  const parsed = parseAgentActorLabel("AmberLeaf (TestUser's agent)");
  assert.ok(parsed);
  assert.equal(parsed.display_name, "AmberLeaf");
  assert.equal(parsed.owner_attribution, "TestUser's agent");
  assert.equal(parsed.structured, false);
});

test("parseAgentActorLabel handles plain agent names without structure", () => {
  const parsed = parseAgentActorLabel("some-random-agent");
  assert.ok(parsed);
  assert.equal(parsed.display_name, "some-random-agent");
  assert.equal(parsed.owner_attribution, null);
  assert.equal(parsed.structured, false);
});

test("parseAgentActorLabel infers ide_label for known prefixes in plain names", () => {
  const codex = parseAgentActorLabel("codex-worker");
  assert.ok(codex);
  assert.equal(codex.ide_label, "Codex");

  const antigravity = parseAgentActorLabel("antigravity-headless");
  assert.ok(antigravity);
  assert.equal(antigravity.ide_label, "Antigravity");
});

test("parseAgentActorLabel returns null for null/undefined/empty input", () => {
  assert.equal(parseAgentActorLabel(null), null);
  assert.equal(parseAgentActorLabel(undefined), null);
  assert.equal(parseAgentActorLabel(""), null);
  assert.equal(parseAgentActorLabel("   "), null);
});

test("parseAgentActorLabel roundtrips with buildAgentActorLabel", () => {
  const original = {
    display_name: "RidgeTimber",
    owner_label: "EmmyMay",
    ide_label: "Agent",
  };
  const label = buildAgentActorLabel(original);
  const parsed = parseAgentActorLabel(label);

  assert.ok(parsed);
  assert.equal(parsed.display_name, original.display_name);
  assert.equal(parsed.owner_attribution, formatOwnerAttribution(original.owner_label));
  assert.equal(parsed.ide_label, "Agent");
  assert.equal(parsed.structured, true);
});

// ── getAgentPrimaryLabel ────────────────────────────────

test("getAgentPrimaryLabel extracts display_name from structured labels", () => {
  assert.equal(
    getAgentPrimaryLabel("MarshIndigo | EmmyMay's agent | Agent"),
    "MarshIndigo"
  );
});

test("getAgentPrimaryLabel returns raw string for unstructured labels", () => {
  assert.equal(getAgentPrimaryLabel("some-agent"), "some-agent");
});

test("getAgentPrimaryLabel returns empty string for null/undefined", () => {
  assert.equal(getAgentPrimaryLabel(null), "");
  assert.equal(getAgentPrimaryLabel(undefined), "");
});
