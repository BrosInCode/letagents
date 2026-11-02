import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  isReservedRoomId,
  resolveCanonicalRoomRequestId,
} = await import("../rooms/resolution.js");
const {
  isKnownProvider,
  isReservedMainRoomCreationId,
  normalizeRoomName,
  parseFocusRoomLocator,
} = await import("../rooms/routing.js");

test("parseFocusRoomLocator extracts parent room and focus key", () => {
  assert.deepEqual(parseFocusRoomLocator("github.com/owner/repo/focus/task_1"), {
    parentRoomId: "github.com/owner/repo",
    focusKey: "task_1",
  });
  assert.deepEqual(parseFocusRoomLocator("parent/focus/review"), {
    parentRoomId: "parent",
    focusKey: "review",
  });
});

test("parseFocusRoomLocator rejects non-focus and nested focus locators", () => {
  assert.equal(parseFocusRoomLocator("focus_5"), null);
  assert.equal(parseFocusRoomLocator("/focus/key"), null);
  assert.equal(parseFocusRoomLocator("parent/focus/child/extra"), null);
});

test("GitHub focus locators normalize repository casing without corrupting opaque focus keys", () => {
  assert.equal(
    normalizeRoomName("github.com/BrosInCode/LetAgents/FOCUS/git:branch:RmVhdHVyZS9DYXBz"),
    "github.com/brosincode/letagents/focus/git:branch:RmVhdHVyZS9DYXBz"
  );
});

test("GitHub host aliases normalize to the real github.com room", () => {
  for (const alias of [
    "ssh.github.com/BrosInCode/LetAgents",
    "ssh.github.com:443/BrosInCode/LetAgents",
    "SSH.GitHub.com:443/BrosInCode/LetAgents.git",
    "www.github.com/BrosInCode/LetAgents",
    "https://www.github.com/BrosInCode/LetAgents/",
    "http://WWW.GITHUB.COM/BrosInCode/LetAgents.git",
    "git@ssh.github.com:BrosInCode/LetAgents.git",
    "git@www.github.com:BrosInCode/LetAgents.git",
    "ssh://git@ssh.github.com:443/BrosInCode/LetAgents.git",
    "ssh://git@ssh.github.com/BrosInCode/LetAgents",
    "ssh://ssh.github.com:443/BrosInCode/LetAgents.git",
    "github.com/BrosInCode/LetAgents",
  ]) {
    assert.equal(normalizeRoomName(alias), "github.com/brosincode/letagents", alias);
  }
});

test("GitHub host aliases keep opaque focus keys intact, like github.com", () => {
  assert.equal(
    normalizeRoomName("www.github.com/BrosInCode/LetAgents/focus/git:branch:RmVhdHVyZS9DYXBz"),
    "github.com/brosincode/letagents/focus/git:branch:RmVhdHVyZS9DYXBz"
  );
});

test("an SSH config alias and look-alike hosts are not mapped to github.com", () => {
  assert.equal(normalizeRoomName("git@github-work:acme/App.git"), "github-work/acme/App");
  assert.equal(
    normalizeRoomName("ssh://git@github-work/acme/App.git"),
    "github-work/acme/App"
  );
  assert.equal(
    normalizeRoomName("ssh.github.com.evil.example/Owner/Repo"),
    "ssh.github.com.evil.example/Owner/Repo"
  );
  assert.equal(normalizeRoomName("gist.github.com/Owner/Repo"), "gist.github.com/Owner/Repo");
  assert.equal(normalizeRoomName("api.github.com/Owner/Repo"), "api.github.com/Owner/Repo");
  // A bare alias with no path is left alone.
  assert.equal(normalizeRoomName("www.github.com"), "www.github.com");
});

test("ssh URLs for other hosts drop the scheme, user and port", () => {
  assert.equal(
    normalizeRoomName("ssh://git@gitlab.com:2222/team/Project.git"),
    "gitlab.com/team/Project"
  );
  assert.equal(
    normalizeRoomName("ssh://git@bitbucket.org/ws/repo.git"),
    "bitbucket.org/ws/repo"
  );
});

test("isKnownProvider accepts the GitHub host aliases", () => {
  assert.equal(isKnownProvider("github.com"), true);
  assert.equal(isKnownProvider("WWW.GitHub.com"), true);
  assert.equal(isKnownProvider("ssh.github.com"), true);
  assert.equal(isKnownProvider("gitlab.com"), true);
  assert.equal(isKnownProvider("gist.github.com"), false);
  assert.equal(isKnownProvider("github-work"), false);
});

test("normalized alias ids resolve to the GitHub repo and stay repo-backed", async () => {
  const { isRepoBackedRoomId } = await import("../rooms/room-ids.js");
  const { parseGitHubRepoName } = await import("../github/repo-access.js");

  for (const alias of [
    "ssh.github.com:443/Owner/Repo",
    "www.github.com/Owner/Repo",
    "ssh://git@ssh.github.com:443/Owner/Repo.git",
  ]) {
    const roomId = normalizeRoomName(alias);
    assert.equal(roomId, "github.com/owner/repo", alias);
    assert.equal(isRepoBackedRoomId(roomId), true, alias);
    assert.deepEqual(parseGitHubRepoName(roomId), { owner: "owner", repo: "repo" }, alias);
    // Even an alias that reaches the parser un-normalized names the same repo.
    assert.deepEqual(parseGitHubRepoName(alias), { owner: "owner", repo: "repo" }, alias);
  }
});

test("isReservedRoomId only matches generated focus ids", () => {
  assert.equal(isReservedRoomId("focus_5"), true);
  assert.equal(isReservedRoomId("focus_123"), true);
  assert.equal(isReservedRoomId("focus_0"), true);
  assert.equal(isReservedRoomId("focus_alpha"), false);
  assert.equal(isReservedRoomId("github.com/owner/repo"), false);
});

test("main room creation reserves focus locators and the retired Git focus namespace", () => {
  assert.equal(isReservedMainRoomCreationId("focus_00"), true);
  assert.equal(isReservedMainRoomCreationId("github.com/owner/repo/focus/git:branch:bWFpbg"), true);
  assert.equal(isReservedMainRoomCreationId("github.com/private/repo/focus/git:branch:Zm9v/bar"), true);
  assert.equal(isReservedMainRoomCreationId("named/focus/not-a-valid-locator/either"), true);
  assert.equal(isReservedMainRoomCreationId("git-room:github.com:owner/repo:branch:bWFpbg"), true);
  assert.equal(isReservedMainRoomCreationId("github.com/owner/repo"), false);
});

test("resolveCanonicalRoomRequestId preserves invite codes without DB lookup", async () => {
  assert.equal(await resolveCanonicalRoomRequestId("ABCX-7291"), "ABCX-7291");
  assert.equal(await resolveCanonicalRoomRequestId("ABCX-7291-L2QP"), "ABCX-7291-L2QP");
});
