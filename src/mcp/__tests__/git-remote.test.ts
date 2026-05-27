import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGitRemote } from "../git-remote.js";

describe("normalizeGitRemote", () => {
  it("normalizes SSH git@github.com format", () => {
    assert.equal(
      normalizeGitRemote("git@github.com:BrosInCode/letagents.git"),
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes SSH without .git suffix", () => {
    assert.equal(
      normalizeGitRemote("git@github.com:BrosInCode/letagents"),
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes SSH with gitlab host", () => {
    assert.equal(
      normalizeGitRemote("git@gitlab.com:team/project.git"),
      "gitlab.com/team/project"
    );
  });

  it("normalizes HTTPS with .git suffix", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/BrosInCode/letagents.git"),
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes HTTPS without .git suffix", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/BrosInCode/letagents"),
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes HTTPS with trailing slash", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/BrosInCode/letagents/"),
      "github.com/BrosInCode/letagents"
    );
  });

  it("normalizes ssh:// protocol format", () => {
    assert.equal(
      normalizeGitRemote("ssh://git@gitlab.com/team/project.git"),
      "gitlab.com/team/project"
    );
  });

  it("handles whitespace", () => {
    assert.equal(
      normalizeGitRemote("  git@github.com:BrosInCode/letagents.git  "),
      "github.com/BrosInCode/letagents"
    );
  });

  it("handles nested paths", () => {
    assert.equal(
      normalizeGitRemote("https://gitlab.com/org/sub-group/project.git"),
      "gitlab.com/org/sub-group/project"
    );
  });

  it("handles Bitbucket SSH format", () => {
    assert.equal(
      normalizeGitRemote("git@bitbucket.org:workspace/repo.git"),
      "bitbucket.org/workspace/repo"
    );
  });
});
