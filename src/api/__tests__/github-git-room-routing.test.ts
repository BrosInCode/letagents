import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BRANCH,
  REPO_FULL_NAME,
  REPO_ID,
  REPO_NAME,
  REPO_OWNER,
  REPO_ROOM_ID,
  WEBHOOK_BRANCH,
  WEBHOOK_BRANCH_FOCUS_KEY,
  WEBHOOK_BRANCH_ROOM_LOCATOR,
  WEBHOOK_BRANCH_ROOM_ID,
  gitFocusRoom,
  githubRepository,
  pullRequestPayload,
  pushPayload,
  repoBinding,
} from "./git-room-test-helpers.js";
import type { GitHubWebhookPayload } from "../github/app.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  buildGitHubRefFocusKey,
  buildGitHubRefRoomLocator,
  getExistingGitHubEventRefRoom,
  parseGitHubRefRoomLocator,
  selectGitHubEventRefRoomTarget,
} = await import("../github/git-room-routing.js");
const { materializeGitHubWebhookEvent } = await import("../github-room-events.js");

function event(type: string, payload: GitHubWebhookPayload, deliveryId: string) {
  const materialized = materializeGitHubWebhookEvent(type, payload, deliveryId);
  assert.ok(materialized);
  return materialized;
}

function expectedWebhookBinding(roomId = WEBHOOK_BRANCH_ROOM_ID) {
  return {
    room_id: roomId,
    provider: "github",
    host: "github.com",
    repository_id: String(REPO_ID),
    repository_full_name: REPO_FULL_NAME,
    repository_owner: REPO_OWNER,
    repository_name: REPO_NAME,
    ref_type: "branch",
    ref_name: WEBHOOK_BRANCH,
    default_branch: DEFAULT_BRANCH,
    base_ref: DEFAULT_BRANCH,
    head_ref: WEBHOOK_BRANCH,
    head_repository_id: String(REPO_ID),
    head_repository_full_name: REPO_FULL_NAME,
    head_repository_owner: REPO_OWNER,
    head_repository_name: REPO_NAME,
    visibility: "private",
    is_default: false,
    source: "webhook",
  };
}

test("buildGitHubRefRoomLocator keeps branch names opaque and case-preserving", () => {
  const roomLocator = buildGitHubRefRoomLocator({
    repositoryFullName: REPO_FULL_NAME,
    refType: "branch",
    refName: "Feature/Caps",
  });

  assert.match(roomLocator, /^github\.com\/brosincode\/letagents\/focus\/git:branch:/);
  assert.equal(roomLocator.includes("Feature/Caps"), false);
  assert.notEqual(
    roomLocator,
    buildGitHubRefRoomLocator({
      repositoryFullName: REPO_FULL_NAME,
      refType: "branch",
      refName: "feature/caps",
    })
  );
  assert.equal(
    buildGitHubRefFocusKey({ refType: "branch", refName: "Feature/Caps" }),
    "git:branch:RmVhdHVyZS9DYXBz"
  );
});

test("parseGitHubRefRoomLocator decodes contextual branch-room locators", () => {
  assert.deepEqual(parseGitHubRefRoomLocator(WEBHOOK_BRANCH_ROOM_LOCATOR), {
    repositoryFullName: "brosincode/letagents",
    refType: "branch",
    refName: WEBHOOK_BRANCH,
  });
});

test("parseGitHubRefRoomLocator rejects malformed encoded refs", () => {
  assert.equal(
    parseGitHubRefRoomLocator("github.com/brosincode/letagents/focus/git:branch:not/canonical"),
    null
  );
  assert.equal(
    parseGitHubRefRoomLocator("github.com/brosincode/letagents/focus/git:branch:%%%"),
    null
  );
});

test("selectGitHubEventRefRoomTarget routes non-default pull request heads to branch rooms", () => {
  assert.deepEqual(
    selectGitHubEventRefRoomTarget({
      event: event(
        "pull_request",
        pullRequestPayload(),
        "delivery-pr-branch"
      ),
      defaultBranch: DEFAULT_BRANCH,
    }),
    { refType: "branch", refName: WEBHOOK_BRANCH }
  );
});

test("selectGitHubEventRefRoomTarget keeps default branch pushes in the repo room", () => {
  assert.equal(
    selectGitHubEventRefRoomTarget({
      event: event("push", pushPayload("refs/heads/main"), "delivery-push-main"),
      defaultBranch: DEFAULT_BRANCH,
    }),
    null
  );
});

test("selectGitHubEventRefRoomTarget can route tag pushes to tag rooms", () => {
  assert.deepEqual(
    selectGitHubEventRefRoomTarget({
      event: event("push", pushPayload("refs/tags/v1.2.3"), "delivery-push-tag"),
      defaultBranch: DEFAULT_BRANCH,
    }),
    { refType: "tag", refName: "v1.2.3" }
  );
});

test("webhook ref routing does not create missing branch rooms", async () => {
  const payload = pullRequestPayload();
  const childLookups: unknown[] = [];
  const upserts: unknown[] = [];

  const result = await getExistingGitHubEventRefRoom({
    event: event("pull_request", payload, "delivery-pr-branch-missing-room"),
    payload,
    repository: payload.repository,
    githubRepoId: String(REPO_ID),
    deps: {
      getGitChildRoom: async (input) => {
        childLookups.push(input);
        return undefined;
      },
      upsertGitRoomBinding: async (input) => {
        upserts.push(input);
        throw new Error("should not upsert a missing branch room");
      },
    },
  });

  assert.equal(result, null);
  assert.deepEqual(childLookups, [{
    parentRoomId: REPO_ROOM_ID,
    focusKey: WEBHOOK_BRANCH_FOCUS_KEY,
  }]);
  assert.deepEqual(upserts, []);
});

test("webhook ref routing updates binding for existing same-repository branch rooms", async () => {
  const payload = pullRequestPayload({
    repository: { private: true },
  });
  const room = gitFocusRoom();
  const upserts: unknown[] = [];

  const result = await getExistingGitHubEventRefRoom({
    event: event("pull_request", payload, "delivery-pr-existing-branch-room"),
    payload,
    repository: payload.repository,
    githubRepoId: String(REPO_ID),
    deps: {
      getGitChildRoom: async () => room,
      upsertGitRoomBinding: async (input) => {
        upserts.push(input);
        return repoBinding(input);
      },
    },
  });

  assert.equal(result, room);
  assert.deepEqual(upserts, [expectedWebhookBinding(room.id)]);
});

test("webhook ref routing keeps fork pull requests in the repository room", async () => {
  const payload = pullRequestPayload({
    repository: { private: true },
    headRepository: {
      id: 2,
      full_name: "Contributor/letagents",
      owner: { login: "Contributor" },
    },
  });
  const childLookups: unknown[] = [];
  const upserts: unknown[] = [];

  const result = await getExistingGitHubEventRefRoom({
    event: event("pull_request", payload, "delivery-pr-fork-branch-room"),
    payload,
    repository: githubRepository({ private: true }),
    githubRepoId: String(REPO_ID),
    deps: {
      getGitChildRoom: async (input) => {
        childLookups.push(input);
        return gitFocusRoom();
      },
      upsertGitRoomBinding: async (input) => {
        upserts.push(input);
        return repoBinding(input);
      },
    },
  });

  assert.equal(result, null);
  assert.deepEqual(childLookups, []);
  assert.deepEqual(upserts, []);
});
