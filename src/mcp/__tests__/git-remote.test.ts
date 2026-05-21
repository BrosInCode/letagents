import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGitRemote } from "../git-remote.js";

// SSH format tests
test("normalizeGitRemote normalizes SSH git@github.com format", () => {
  assert.equal(
    normalizeGitRemote("git@github.com:BrosInCode/letagents.git"),
    "github.com/BrosInCode/letagents"
  );
});

test("normalizeGitRemote normalizes SSH without .git suffix", () => {
  assert.equal(
    normalizeGitRemote("git@github.com:BrosInCode/letagents"),
    "github.com/BrosInCode/letagents"
  );
});

test("normalizeGitRemote normalizes SSH with gitlab host", () => {
  assert.equal(
    normalizeGitRemote("git@gitlab.com:team/project.git"),
    "gitlab.com/team/project"
  );
});

// HTTPS format tests
test("normalizeGitRemote normalizes HTTPS with .git suffix", () => {
  assert.equal(
    normalizeGitRemote("https://github.com/BrosInCode/letagents.git"),
    "github.com/BrosInCode/letagents"
  );
});

test("normalizeGitRemote normalizes HTTPS without .git suffix", () => {
  assert.equal(
    normalizeGitRemote("https://github.com/BrosInCode/letagents"),
    "github.com/BrosInCode/letagents"
  );
});

test("normalizeGitRemote normalizes HTTPS with trailing slash", () => {
  assert.equal(
    normalizeGitRemote("https://github.com/BrosInCode/letagents/"),
    "github.com/BrosInCode/letagents"
  );
});

// SSH protocol format tests
test("normalizeGitRemote normalizes ssh:// protocol format", () => {
  assert.equal(
    normalizeGitRemote("ssh://git@gitlab.com/team/project.git"),
    "gitlab.com/team/project"
  );
});

// Edge cases
test("normalizeGitRemote handles whitespace", () => {
  assert.equal(
    normalizeGitRemote("  git@github.com:BrosInCode/letagents.git  "),
    "github.com/BrosInCode/letagents"
  );
});

test("normalizeGitRemote handles nested paths", () => {
  assert.equal(
    normalizeGitRemote("https://gitlab.com/org/sub-group/project.git"),
    "gitlab.com/org/sub-group/project"
  );
});

test("normalizeGitRemote handles Bitbucket SSH format", () => {
  assert.equal(
    normalizeGitRemote("git@bitbucket.org:workspace/repo.git"),
    "bitbucket.org/workspace/repo"
  );
});
