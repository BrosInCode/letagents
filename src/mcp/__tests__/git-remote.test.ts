import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildActiveGitRoomContext,
  buildGitRefRoomIdentity,
  normalizeGitRemote,
} from "../git-remote.js";

describe("normalizeGitRemote", () => {
  it("normalizes SSH git@github.com format", () => {
    assert.equal(
      normalizeGitRemote("git@github.com:BrosInCode/letagents.git"),
      "github.com/brosincode/letagents"
    );
  });

  it("normalizes SSH without .git suffix", () => {
    assert.equal(
      normalizeGitRemote("git@github.com:BrosInCode/letagents"),
      "github.com/brosincode/letagents"
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
      "github.com/brosincode/letagents"
    );
  });

  it("normalizes HTTPS without .git suffix", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/BrosInCode/letagents"),
      "github.com/brosincode/letagents"
    );
  });

  it("normalizes HTTPS with trailing slash", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/BrosInCode/letagents/"),
      "github.com/brosincode/letagents"
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
      "github.com/brosincode/letagents"
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

describe("buildGitRefRoomIdentity", () => {
  it("builds the same opaque GitHub branch room id as webhook routing", () => {
    assert.equal(
      buildGitRefRoomIdentity({
        repoRoom: "github.com/BrosInCode/letagents",
        refType: "branch",
        refName: "codex/GitRooms",
      }),
      "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM"
    );
  });

  it("does not derive branch rooms for unsupported repo room shapes", () => {
    assert.equal(
      buildGitRefRoomIdentity({
        repoRoom: "not-a-repo-room",
        refType: "branch",
        refName: "feature/git-rooms",
      }),
      null
    );
  });
});

describe("buildActiveGitRoomContext", () => {
  it("selects the repo room for the default branch", () => {
    assert.deepEqual(
      buildActiveGitRoomContext({
        repoRoom: "github.com/BrosInCode/letagents",
        currentBranch: "main",
        defaultBranch: "main",
      }),
      {
        repoRoom: "github.com/BrosInCode/letagents",
        currentBranch: "main",
        defaultBranch: "main",
        activeRefRoom: null,
        activeRoom: "github.com/BrosInCode/letagents",
        activeRoomKind: "repo",
      }
    );
  });

  it("selects a branch room for non-default branches", () => {
    assert.deepEqual(
      buildActiveGitRoomContext({
        repoRoom: "github.com/BrosInCode/letagents",
        currentBranch: "feature/git-rooms",
        defaultBranch: "main",
      }),
      {
        repoRoom: "github.com/BrosInCode/letagents",
        currentBranch: "feature/git-rooms",
        defaultBranch: "main",
        activeRefRoom: "git-room:github.com:brosincode/letagents:branch:ZmVhdHVyZS9naXQtcm9vbXM",
        activeRoom: "git-room:github.com:brosincode/letagents:branch:ZmVhdHVyZS9naXQtcm9vbXM",
        activeRoomKind: "branch",
      }
    );
  });

  it("keeps likely default branch names in the repo room when the default branch is unknown", () => {
    assert.equal(
      buildActiveGitRoomContext({
        repoRoom: "github.com/brosincode/letagents",
        currentBranch: "main",
        defaultBranch: null,
      }).activeRoom,
      "github.com/brosincode/letagents"
    );
  });

  it("selects a branch room for non-default-looking branches when the default branch is unknown", () => {
    assert.deepEqual(
      buildActiveGitRoomContext({
        repoRoom: "github.com/BrosInCode/letagents",
        currentBranch: "codex/git-rooms-event-spine",
        defaultBranch: null,
      }),
      {
        repoRoom: "github.com/BrosInCode/letagents",
        currentBranch: "codex/git-rooms-event-spine",
        defaultBranch: null,
        activeRefRoom: "git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21zLWV2ZW50LXNwaW5l",
        activeRoom: "git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21zLWV2ZW50LXNwaW5l",
        activeRoomKind: "branch",
      }
    );
  });
});
