import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRepoRoomId,
  buildLegacyTaskWorkflowArtifacts,
  buildTaskWorkflowRefs,
  extractReferencedTaskId,
  formatRepoPullRequestEventMessage,
  formatRepoRepositoryEventMessage,
  normalizeTaskWorkflowArtifacts,
  parseRepoRoomName,
  validateTaskWorkflowArtifactsInput,
} from "../repo-workflow.js";

test("buildRepoRoomId normalizes GitHub repository names", () => {
  assert.equal(buildRepoRoomId("github", "BrosInCode/LetAgents"), "github.com/brosincode/letagents");
});

test("buildRepoRoomId preserves case for GitLab repository names", () => {
  assert.equal(buildRepoRoomId("gitlab", "TeamAlpha/LetAgents"), "gitlab.com/TeamAlpha/LetAgents");
});

test("parseRepoRoomName parses a GitHub repo room", () => {
  assert.deepEqual(parseRepoRoomName("github.com/BrosInCode/LetAgents"), {
    provider: "github",
    host: "github.com",
    namespace: "brosincode",
    repo: "letagents",
    fullName: "brosincode/letagents",
  });
});

test("parseRepoRoomName supports nested GitLab namespaces", () => {
  assert.deepEqual(parseRepoRoomName("gitlab.com/TeamAlpha/platform/LetAgents"), {
    provider: "gitlab",
    host: "gitlab.com",
    namespace: "TeamAlpha/platform",
    repo: "LetAgents",
    fullName: "TeamAlpha/platform/LetAgents",
  });
});

test("extractReferencedTaskId returns the first explicit task reference from title or body", () => {
  assert.equal(
    extractReferencedTaskId(
      "task_22: wire webhook ingestion",
      "follow-up in body for task_99 should not win"
    ),
    "task_22"
  );
  assert.equal(extractReferencedTaskId("No task here", null), null);
});

test("formatRepoPullRequestEventMessage formats GitHub pull request events", () => {
  const message = formatRepoPullRequestEventMessage({
    provider: "github",
    action: "opened",
    repositoryFullName: "brosincode/letagents",
    senderLogin: "EmmyMay",
    linkedTaskId: "task_22",
    pullRequest: {
      number: 98,
      title: "task_22: add webhook ingestion",
      url: "https://github.com/BrosInCode/letagents/pull/98",
    },
  });

  assert.equal(
    message,
    "PR #98 opened by EmmyMay in brosincode/letagents linked to task_22: task_22: add webhook ingestion https://github.com/BrosInCode/letagents/pull/98"
  );
});

test("formatRepoPullRequestEventMessage formats GitLab merge request events", () => {
  const message = formatRepoPullRequestEventMessage({
    provider: "gitlab",
    action: "ready_for_review",
    repositoryFullName: "TeamAlpha/LetAgents",
    senderLogin: "octavia",
    pullRequest: {
      number: 14,
      title: "provider-neutral workflow core",
      url: "https://gitlab.com/TeamAlpha/LetAgents/-/merge_requests/14",
    },
  });

  assert.equal(
    message,
    "MR !14 is ready for review in TeamAlpha/LetAgents: provider-neutral workflow core https://gitlab.com/TeamAlpha/LetAgents/-/merge_requests/14"
  );
});

test("formatRepoRepositoryEventMessage formats repository transfers", () => {
  const message = formatRepoRepositoryEventMessage({
    provider: "bitbucket",
    action: "transferred",
    repositoryFullName: "NewOrg/letagents",
    oldFullName: "OldOrg/letagents",
    senderLogin: "EmmyMay",
  });

  assert.equal(
    message,
    "Repository transferred from OldOrg/letagents to NewOrg/letagents by EmmyMay"
  );
});

test("buildTaskWorkflowRefs derives provider-neutral pull request refs from GitHub URLs", () => {
  assert.deepEqual(
    buildTaskWorkflowRefs({
      prUrl: "https://github.com/BrosInCode/letagents/pull/107",
    }),
    [{
      provider: "github",
      kind: "pull_request",
      label: "PR #107",
      url: "https://github.com/BrosInCode/letagents/pull/107",
    }]
  );
});

test("buildTaskWorkflowRefs derives merge request refs from GitLab URLs", () => {
  assert.deepEqual(
    buildTaskWorkflowRefs({
      prUrl: "https://gitlab.com/TeamAlpha/platform/LetAgents/-/merge_requests/14",
    }),
    [{
      provider: "gitlab",
      kind: "merge_request",
      label: "MR !14",
      url: "https://gitlab.com/TeamAlpha/platform/LetAgents/-/merge_requests/14",
    }]
  );
});

test("buildLegacyTaskWorkflowArtifacts derives pull request artifacts from GitHub URLs", () => {
  assert.deepEqual(
    buildLegacyTaskWorkflowArtifacts({
      prUrl: "https://github.com/BrosInCode/letagents/pull/107",
    }),
    [{
      provider: "github",
      kind: "pull_request",
      number: 107,
      url: "https://github.com/BrosInCode/letagents/pull/107",
    }]
  );
});

test("normalizeTaskWorkflowArtifacts keeps persisted artifacts and merges legacy pr_url backfill", () => {
  assert.deepEqual(
    normalizeTaskWorkflowArtifacts({
      artifacts: [{
        provider: "github",
        kind: "issue",
        number: 42,
        url: "https://github.com/BrosInCode/letagents/issues/42",
      }],
      prUrl: "https://github.com/BrosInCode/letagents/pull/107",
    }),
    [
      {
        provider: "github",
        kind: "issue",
        number: 42,
        url: "https://github.com/BrosInCode/letagents/issues/42",
      },
      {
        provider: "github",
        kind: "pull_request",
        number: 107,
        url: "https://github.com/BrosInCode/letagents/pull/107",
      },
    ]
  );
});

test("buildTaskWorkflowRefs renders persisted issue and check artifacts", () => {
  assert.deepEqual(
    buildTaskWorkflowRefs({
      artifacts: [
        {
          provider: "github",
          kind: "issue",
          number: 42,
          url: "https://github.com/BrosInCode/letagents/issues/42",
        },
        {
          provider: "github",
          kind: "check_run",
          title: "ci / build",
          url: "https://github.com/BrosInCode/letagents/actions/runs/123",
        },
      ],
    }),
    [
      {
        provider: "github",
        kind: "issue",
        label: "Issue #42",
        url: "https://github.com/BrosInCode/letagents/issues/42",
      },
      {
        provider: "github",
        kind: "check_run",
        label: "Check ci / build",
        url: "https://github.com/BrosInCode/letagents/actions/runs/123",
      },
    ]
  );
});

test("validateTaskWorkflowArtifactsInput rejects unsupported keys", () => {
  assert.throws(
    () =>
      validateTaskWorkflowArtifactsInput([
        {
          provider: "github",
          kind: "pull_request",
          metadata: { danger: true },
        },
      ]),
    /unsupported key/
  );
});

test("validateTaskWorkflowArtifactsInput accepts valid artifacts", () => {
  assert.deepEqual(
    validateTaskWorkflowArtifactsInput([
      {
        provider: "github",
        kind: "pull_request",
        number: 121,
        url: "https://github.com/BrosInCode/letagents/pull/121",
      },
    ]),
    [
      {
        provider: "github",
        kind: "pull_request",
        number: 121,
        url: "https://github.com/BrosInCode/letagents/pull/121",
      },
    ]
  );
});
