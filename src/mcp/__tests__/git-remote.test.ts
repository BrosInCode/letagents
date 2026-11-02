import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildActiveGitRoomContext,
  buildGitRefRoomLocator,
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

  it("maps ssh.github.com to github.com, with and without the :443 port", () => {
    for (const remote of [
      "ssh://git@ssh.github.com:443/BrosInCode/letagents.git",
      "ssh://git@ssh.github.com/BrosInCode/letagents.git",
      "ssh://git@SSH.GitHub.com:443/BrosInCode/letagents",
      "git@ssh.github.com:BrosInCode/letagents.git",
    ]) {
      assert.equal(normalizeGitRemote(remote), "github.com/brosincode/letagents", remote);
    }
  });

  it("maps www.github.com to github.com", () => {
    for (const remote of [
      "https://www.github.com/BrosInCode/letagents.git",
      "https://www.github.com/BrosInCode/letagents/",
      "http://WWW.GitHub.com/BrosInCode/letagents",
    ]) {
      assert.equal(normalizeGitRemote(remote), "github.com/brosincode/letagents", remote);
    }
  });

  it("lands every real GitHub host form in the same room", () => {
    const rooms = new Set(
      [
        "git@github.com:BrosInCode/letagents.git",
        "https://github.com/BrosInCode/letagents",
        "https://www.github.com/BrosInCode/letagents",
        "ssh://git@ssh.github.com:443/BrosInCode/letagents.git",
        "git@ssh.github.com:BrosInCode/letagents.git",
      ].map(normalizeGitRemote)
    );
    assert.deepEqual([...rooms], ["github.com/brosincode/letagents"]);
  });

  it("does not map look-alike hosts to github.com", () => {
    assert.equal(
      normalizeGitRemote("https://ssh.github.com.evil.example/Owner/Repo.git"),
      "ssh.github.com.evil.example/Owner/Repo"
    );
    assert.equal(
      normalizeGitRemote("git@www.github.com.evil.example:Owner/Repo.git"),
      "www.github.com.evil.example/Owner/Repo"
    );
    assert.equal(
      normalizeGitRemote("https://gist.github.com/Owner/Repo.git"),
      "gist.github.com/Owner/Repo"
    );
  });

  it("keeps an SSH config alias as its own host, so the server can refuse it", () => {
    assert.equal(
      normalizeGitRemote("git@github-work:acme/App.git"),
      "github-work/acme/App"
    );
  });
});

describe("buildGitRefRoomLocator", () => {
  it("builds the same contextual GitHub branch locator as webhook routing", () => {
    assert.equal(
      buildGitRefRoomLocator({
        repoRoom: "github.com/BrosInCode/letagents",
        refType: "branch",
        refName: "codex/GitRooms",
      }),
      "github.com/brosincode/letagents/focus/git:branch:Y29kZXgvR2l0Um9vbXM"
    );
  });

  it("does not derive branch rooms for unsupported repo room shapes", () => {
    assert.equal(
      buildGitRefRoomLocator({
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
        activeRefRoomLocator: null,
        activeRoomLocator: "github.com/BrosInCode/letagents",
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
        activeRefRoomLocator: "github.com/brosincode/letagents/focus/git:branch:ZmVhdHVyZS9naXQtcm9vbXM",
        activeRoomLocator: "github.com/brosincode/letagents/focus/git:branch:ZmVhdHVyZS9naXQtcm9vbXM",
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
      }).activeRoomLocator,
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
        activeRefRoomLocator: "github.com/brosincode/letagents/focus/git:branch:Y29kZXgvZ2l0LXJvb21zLWV2ZW50LXNwaW5l",
        activeRoomLocator: "github.com/brosincode/letagents/focus/git:branch:Y29kZXgvZ2l0LXJvb21zLWV2ZW50LXNwaW5l",
        activeRoomKind: "branch",
      }
    );
  });
});
