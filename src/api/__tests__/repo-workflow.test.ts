import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRepoRoomId,
  buildLegacyTaskWorkflowArtifacts,
  buildTaskWorkflowRefs,
  extractReferencedTaskId,
  formatRepoCheckRunEventMessage,
  formatRepoIssueCommentEventMessage,
  formatRepoIssueEventMessage,
  formatRepoPullRequestEventMessage,
  formatRepoPullRequestReviewEventMessage,
  formatRepoRepositoryEventMessage,
  normalizeTaskWorkflowArtifacts,
  parseRepoRoomName,
  projectIssueEvent,
  projectPullRequestEvent,
  projectPullRequestReviewEvent,
  synchronizeTaskWorkflowArtifactsWithPrUrl,
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

test("synchronizeTaskWorkflowArtifactsWithPrUrl replaces stale legacy PR artifacts when pr_url changes", () => {
  assert.deepEqual(
    synchronizeTaskWorkflowArtifactsWithPrUrl({
      artifacts: [
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
      ],
      previousPrUrl: "https://github.com/BrosInCode/letagents/pull/107",
      nextPrUrl: "https://github.com/BrosInCode/letagents/pull/121",
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
        number: 121,
        url: "https://github.com/BrosInCode/letagents/pull/121",
      },
    ]
  );
});

// ─── Issue event formatter ───

test("formatRepoIssueEventMessage formats opened issues", () => {
  const message = formatRepoIssueEventMessage({
    provider: "github",
    action: "opened",
    repositoryFullName: "brosincode/letagents",
    issue: { number: 5, title: "Bug in login", url: "https://github.com/BrosInCode/letagents/issues/5" },
    senderLogin: "EmmyMay",
  });
  assert.equal(
    message,
    "Issue #5 opened by EmmyMay in brosincode/letagents: Bug in login https://github.com/BrosInCode/letagents/issues/5"
  );
});

test("formatRepoIssueEventMessage returns null for labeled events", () => {
  assert.equal(
    formatRepoIssueEventMessage({
      provider: "github",
      action: "labeled",
      repositoryFullName: "brosincode/letagents",
      issue: { number: 5, title: "Bug", url: "https://github.com/BrosInCode/letagents/issues/5" },
    }),
    null
  );
});

// ─── Issue comment event formatter ───

test("formatRepoIssueCommentEventMessage formats new comments", () => {
  const message = formatRepoIssueCommentEventMessage({
    provider: "github",
    action: "created",
    repositoryFullName: "brosincode/letagents",
    issue: { number: 5, title: "Bug in login" },
    comment: { body: "I can reproduce this", url: "https://github.com/BrosInCode/letagents/issues/5#comment-1" },
    senderLogin: "EmmyMay",
  });
  assert.ok(message?.includes("EmmyMay commented on Issue #5"));
  assert.ok(message?.includes("\"I can reproduce this\""));
});

test("formatRepoIssueCommentEventMessage uses PR label for pull request comments", () => {
  const message = formatRepoIssueCommentEventMessage({
    provider: "github",
    action: "created",
    repositoryFullName: "brosincode/letagents",
    issue: { number: 42, title: "Add feature" },
    comment: { body: "LGTM", url: "https://github.com/BrosInCode/letagents/pull/42#comment-1" },
    senderLogin: "reviewer",
    isPullRequest: true,
  });
  assert.ok(message?.includes("commented on PR #42"));
  assert.ok(!message?.includes("Issue #42"));
});

test("formatRepoIssueCommentEventMessage returns null for edited comments", () => {
  assert.equal(
    formatRepoIssueCommentEventMessage({
      provider: "github",
      action: "edited",
      repositoryFullName: "brosincode/letagents",
      issue: { number: 5, title: "Bug" },
      comment: { body: "updated", url: "https://example.com" },
    }),
    null
  );
});

// ─── PR review event formatter ───

test("formatRepoPullRequestReviewEventMessage formats approved reviews", () => {
  const message = formatRepoPullRequestReviewEventMessage({
    provider: "github",
    action: "submitted",
    repositoryFullName: "brosincode/letagents",
    pullRequest: { number: 42, title: "Add feature" },
    review: { state: "approved", url: "https://github.com/BrosInCode/letagents/pull/42#review-1" },
    senderLogin: "reviewer",
    linkedTaskId: "task_10",
  });
  assert.equal(
    message,
    "reviewer approved PR #42 in brosincode/letagents linked to task_10 https://github.com/BrosInCode/letagents/pull/42#review-1"
  );
});

test("formatRepoPullRequestReviewEventMessage returns null for non-submitted actions", () => {
  assert.equal(
    formatRepoPullRequestReviewEventMessage({
      provider: "github",
      action: "dismissed",
      repositoryFullName: "brosincode/letagents",
      pullRequest: { number: 42, title: "Add feature" },
      review: { state: "approved", url: "https://example.com" },
    }),
    null
  );
});

// ─── Check run event formatter ───

test("formatRepoCheckRunEventMessage surfaces failures only", () => {
  assert.equal(
    formatRepoCheckRunEventMessage({
      provider: "github",
      action: "completed",
      repositoryFullName: "brosincode/letagents",
      checkRun: { name: "tests", status: "completed", conclusion: "success", url: "https://example.com" },
    }),
    null
  );

  const failMsg = formatRepoCheckRunEventMessage({
    provider: "github",
    action: "completed",
    repositoryFullName: "brosincode/letagents",
    checkRun: { name: "lint", status: "completed", conclusion: "failure", url: "https://example.com/check", appName: "CI" },
  });
  assert.ok(failMsg?.includes('Check "lint" (CI) failure'));
});

// ---------------------------------------------------------------------------
// Board projection tests
// ---------------------------------------------------------------------------

test("projectPullRequestEvent: PR opened transitions assigned → in_review", () => {
  const result = projectPullRequestEvent({ action: "opened", merged: false, currentStatus: "assigned" });
  assert.deepEqual(result, { newStatus: "in_review", reason: "pr_opened" });
});

test("projectPullRequestEvent: PR opened transitions in_progress → in_review", () => {
  const result = projectPullRequestEvent({ action: "opened", merged: false, currentStatus: "in_progress" });
  assert.deepEqual(result, { newStatus: "in_review", reason: "pr_opened" });
});

test("projectPullRequestEvent: PR opened does NOT transition already in_review task", () => {
  const result = projectPullRequestEvent({ action: "opened", merged: false, currentStatus: "in_review" });
  assert.equal(result, null);
});

test("projectPullRequestEvent: ready_for_review transitions in_progress → in_review", () => {
  const result = projectPullRequestEvent({ action: "ready_for_review", merged: false, currentStatus: "in_progress" });
  assert.deepEqual(result, { newStatus: "in_review", reason: "pr_opened" });
});

test("projectPullRequestEvent: PR merged transitions in_review → merged", () => {
  const result = projectPullRequestEvent({ action: "closed", merged: true, currentStatus: "in_review" });
  assert.deepEqual(result, { newStatus: "merged", reason: "pr_merged" });
});

test("projectPullRequestEvent: PR merged transitions assigned → merged", () => {
  const result = projectPullRequestEvent({ action: "closed", merged: true, currentStatus: "assigned" });
  assert.deepEqual(result, { newStatus: "merged", reason: "pr_merged" });
});

test("projectPullRequestEvent: PR closed without merge has no transition", () => {
  const result = projectPullRequestEvent({ action: "closed", merged: false, currentStatus: "in_review" });
  assert.equal(result, null);
});

test("projectPullRequestEvent: PR opened does NOT transition done task", () => {
  const result = projectPullRequestEvent({ action: "opened", merged: false, currentStatus: "done" });
  assert.equal(result, null);
});

test("projectPullRequestReviewEvent: changes_requested transitions in_review → blocked", () => {
  const result = projectPullRequestReviewEvent({ action: "submitted", reviewState: "changes_requested", currentStatus: "in_review" });
  assert.deepEqual(result, { newStatus: "blocked", reason: "review_changes_requested" });
});

test("projectPullRequestReviewEvent: approved review does NOT transition", () => {
  const result = projectPullRequestReviewEvent({ action: "submitted", reviewState: "approved", currentStatus: "in_review" });
  assert.equal(result, null);
});

test("projectIssueEvent: issue closed transitions merged → done", () => {
  const result = projectIssueEvent({ action: "closed", currentStatus: "merged" });
  assert.deepEqual(result, { newStatus: "done", reason: "issue_closed" });
});

test("projectIssueEvent: issue closed transitions in_progress → done", () => {
  const result = projectIssueEvent({ action: "closed", currentStatus: "in_progress" });
  assert.deepEqual(result, { newStatus: "done", reason: "issue_closed" });
});

test("projectIssueEvent: issue closed does NOT transition proposed task", () => {
  const result = projectIssueEvent({ action: "closed", currentStatus: "proposed" });
  assert.equal(result, null);
});

test("projectIssueEvent: issue opened does NOT transition", () => {
  const result = projectIssueEvent({ action: "opened", currentStatus: "in_progress" });
  assert.equal(result, null);
});
