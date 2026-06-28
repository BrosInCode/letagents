import assert from "node:assert/strict";
import test from "node:test";

import {
  materializeGitHubRoomEvent,
  materializeGitHubWebhookEvent,
} from "../github-room-events.js";
import {
  buildRepoRoomEventArtifactMatches,
  formatRepoRoomEventMessage,
  getRepoRoomEventReferenceTexts,
} from "../repo-workflow.js";

test("materializeGitHubWebhookEvent maps pull_request_review into a persisted room event", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request_review",
    {
      action: "submitted",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "approver" },
      pull_request: {
        number: 42,
        title: "task_7: add review handling",
        body: "Review body fallback",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        head: {
          ref: "codex/review-context",
          sha: "abc123def456",
        },
      },
      review: {
        id: 9001,
        state: "approved",
        body: "Looks good",
        html_url: "https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9001",
      },
    },
    "delivery-review-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "pull_request_review");
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:review:9001:submitted:delivery:delivery-review-1"
  );
  assert.equal(event?.state, "approved");
  assert.deepEqual(event?.metadata, {
    body: "Looks good",
    dismissed_by_login: null,
    head_ref: "codex/review-context",
    head_sha: "abc123def456",
    pull_request_author_login: null,
  });
  assert.equal(event?.roomEvent?.kind, "pull_request_review");
  assert.deepEqual(buildRepoRoomEventArtifactMatches(event!.roomEvent!), [
    {
      provider: "github",
      kind: "review",
      url: "https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9001",
    },
    {
      provider: "github",
      kind: "review",
      id: "9001",
    },
    {
      provider: "github",
      kind: "pull_request",
      url: "https://github.com/BrosInCode/letagents/pull/42",
    },
    {
      provider: "github",
      kind: "pull_request",
      number: 42,
    },
  ]);
  assert.deepEqual(getRepoRoomEventReferenceTexts(event!.roomEvent!), [
    "task_7: add review handling",
    "Review body fallback",
    "Looks good",
  ]);
});

test("materializeGitHubWebhookEvent maps dismissed review to original reviewer", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request_review",
    {
      action: "dismissed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "maintainer" },
      pull_request: {
        number: 42,
        title: "task_7: add review handling",
        body: "Review body fallback",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        user: { login: "author" },
      },
      review: {
        id: 9001,
        state: "changes_requested",
        body: "Old blocker",
        html_url: "https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9001",
        user: { login: "reviewer" },
      },
    },
    "delivery-review-dismissed-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "pull_request_review");
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:review:9001:dismissed:delivery:delivery-review-dismissed-1"
  );
  assert.equal(event?.state, "dismissed");
  assert.equal(event?.actor_login, "reviewer");
  assert.deepEqual(event?.metadata, {
    body: "Old blocker",
    dismissed_by_login: "maintainer",
    head_ref: null,
    head_sha: null,
    pull_request_author_login: "author",
  });
  assert.equal(event?.roomEvent?.kind, "pull_request_review");
  assert.equal(
    event?.roomEvent?.kind === "pull_request_review" ? event.roomEvent.review.state : null,
    "dismissed"
  );
});

test("materializeGitHubWebhookEvent maps check_run branch metadata", () => {
  const event = materializeGitHubWebhookEvent(
    "check_run",
    {
      action: "completed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "github-actions[bot]" },
      check_run: {
        id: 77,
        name: "deploy",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/BrosInCode/letagents/actions/runs/77",
        head_sha: "def456abc123",
        app: { name: "GitHub Actions" },
        check_suite: {
          id: 99,
          head_branch: "codex/check-run-context",
          head_sha: "def456abc123",
        },
      },
    },
    "delivery-check-run-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "check_run");
  assert.equal(event?.state, "failure");
  assert.deepEqual(event?.metadata, {
    status: "completed",
    conclusion: "failure",
    app_name: "GitHub Actions",
    suite_id: 99,
    head_branch: "codex/check-run-context",
    head_sha: "def456abc123",
  });
  assert.equal(event?.roomEvent?.kind, "check_run");
});

test("materializeGitHubWebhookEvent maps pull_request into a persisted room event", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "EmmyMay" },
      pull_request: {
        number: 98,
        title: "task_22: add webhook ingestion",
        body: "Follow-up details",
        html_url: "https://github.com/BrosInCode/letagents/pull/98",
        updated_at: "2026-06-28T10:20:00Z",
        user: { login: "EmmyMay" },
      },
    },
    "delivery-pr-open-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "pull_request");
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:pr:98:opened:at:2026-06-28T10:20:00.000Z:delivery:delivery-pr-open-1"
  );
  assert.equal(
    event?.semantic_id,
    "brosincode/letagents:pr:98:opened:at:2026-06-28T10:20:00.000Z"
  );
  assert.equal(event?.state, "open");
  assert.deepEqual(event?.metadata, {
    body: "Follow-up details",
    author_login: "EmmyMay",
    draft: null,
    merged: null,
    merged_by_login: null,
    head_ref: null,
    head_sha: null,
  });
  assert.equal(
    formatRepoRoomEventMessage({ event: event!.roomEvent!, linkedTaskId: "task_22" }),
    "PR #98 opened by EmmyMay in BrosInCode/letagents linked to task_22: task_22: add webhook ingestion https://github.com/BrosInCode/letagents/pull/98"
  );
});

test("materializeGitHubWebhookEvent uses head SHA for pull_request synchronize idempotency", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "synchronize",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "EmmyMay" },
      pull_request: {
        number: 98,
        title: "task_22: add webhook ingestion",
        body: "Follow-up details",
        html_url: "https://github.com/BrosInCode/letagents/pull/98",
        head: { sha: "abc123def456" },
        user: { login: "EmmyMay" },
      },
    },
    "delivery-pr-sync-1"
  );

  assert.ok(event);
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:pr:98:sync:abc123def456:delivery:delivery-pr-sync-1"
  );
  assert.equal(event?.semantic_id, "brosincode/letagents:pr:98:sync:abc123def456");
  assert.equal(event?.head_sha, "abc123def456");
});

test("materializeGitHubWebhookEvent maps push into branch-scoped room events", () => {
  const event = materializeGitHubWebhookEvent(
    "push",
    {
      ref: "refs/heads/codex/git-rooms-event-spine",
      before: "abc123abc123",
      after: "def456def456",
      compare: "https://github.com/BrosInCode/letagents/compare/abc123...def456",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        html_url: "https://github.com/BrosInCode/letagents",
        owner: { login: "BrosInCode" },
        pushed_at: "2026-06-28T10:15:00Z",
      },
      sender: { login: "EmmyMay" },
      head_commit: {
        id: "def456def456",
        message: "task_4: wire branch events",
        timestamp: "2026-06-28T10:14:59Z",
      },
      commits: [
        {
          id: "def456def456",
          message: "task_4: wire branch events",
          timestamp: "2026-06-28T10:14:59Z",
        },
      ],
    },
    "delivery-push-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "push");
  assert.equal(event?.action, "push");
  assert.equal(
    event?.semantic_id,
    "brosincode/letagents:push:refs/heads/codex/git-rooms-event-spine:abc123abc123:def456def456"
  );
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:push:refs/heads/codex/git-rooms-event-spine:abc123abc123:def456def456:delivery:delivery-push-1"
  );
  assert.equal(event?.provider_event_at, "2026-06-28T10:14:59.000Z");
  assert.equal(event?.ref, "refs/heads/codex/git-rooms-event-spine");
  assert.equal(event?.head_ref, "codex/git-rooms-event-spine");
  assert.equal(event?.head_sha, "def456def456");
  assert.equal(event?.roomEvent?.kind, "push");
  assert.deepEqual(buildRepoRoomEventArtifactMatches(event!.roomEvent!), [
    {
      provider: "github",
      kind: "branch",
      ref: "codex/git-rooms-event-spine",
    },
  ]);
  assert.deepEqual(getRepoRoomEventReferenceTexts(event!.roomEvent!), [
    "codex/git-rooms-event-spine",
    "task_4: wire branch events",
  ]);
  assert.equal(
    formatRepoRoomEventMessage({ event: event!.roomEvent!, linkedTaskId: "task_4" }),
    "EmmyMay pushed def456d to branch codex/git-rooms-event-spine in BrosInCode/letagents linked to task_4 https://github.com/BrosInCode/letagents/compare/abc123...def456"
  );
});

test("materializeGitHubWebhookEvent maps branch create without a GitHub action field", () => {
  const event = materializeGitHubWebhookEvent(
    "create",
    {
      ref: "codex/git-rooms-event-spine",
      ref_type: "branch",
      master_branch: "staging",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        html_url: "https://github.com/BrosInCode/letagents",
        default_branch: "staging",
        updated_at: "2026-06-28T11:00:00Z",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "EmmyMay" },
    },
    "delivery-create-branch-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "create");
  assert.equal(event?.action, "create");
  assert.equal(
    event?.semantic_id,
    "brosincode/letagents:create:branch:codex/git-rooms-event-spine:at:2026-06-28T11:00:00.000Z"
  );
  assert.equal(event?.provider_event_at, null);
  assert.equal(event?.provider_object_updated_at, null);
  assert.equal(event?.base_ref, "staging");
  assert.equal(event?.head_ref, "codex/git-rooms-event-spine");
  assert.equal(event?.roomEvent?.kind, "branch_ref");
  assert.deepEqual(buildRepoRoomEventArtifactMatches(event!.roomEvent!), [
    {
      provider: "github",
      kind: "branch",
      ref: "codex/git-rooms-event-spine",
    },
  ]);
  assert.equal(
    formatRepoRoomEventMessage({ event: event!.roomEvent!, linkedTaskId: "task_4" }),
    "EmmyMay created branch codex/git-rooms-event-spine in BrosInCode/letagents linked to task_4"
  );
});

test("materializeGitHubWebhookEvent preserves pull request context for issue comments on PRs", () => {
  const event = materializeGitHubWebhookEvent(
    "issue_comment",
    {
      action: "created",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "commenter" },
      issue: {
        number: 55,
        title: "task_12: improve webhook routing",
        html_url: "https://github.com/BrosInCode/letagents/issues/55",
        pull_request: {
          url: "https://api.github.com/repos/BrosInCode/letagents/pulls/55",
        },
      },
      comment: {
        id: 12,
        body: "I can reproduce this",
        html_url: "https://github.com/BrosInCode/letagents/issues/55#issuecomment-12",
      },
    },
    "delivery-comment-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "issue_comment");
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:comment:12:created:delivery:delivery-comment-1"
  );
  assert.equal(event?.roomEvent?.kind, "issue_comment");
  assert.equal(event?.roomEvent?.issue.isPullRequest, true);
  assert.equal(
    formatRepoRoomEventMessage({ event: event!.roomEvent!, linkedTaskId: "task_12" }),
    'commenter commented on PR #55 in BrosInCode/letagents linked to task_12: "I can reproduce this" https://github.com/BrosInCode/letagents/issues/55#issuecomment-12'
  );
});

test("materializeGitHubWebhookEvent materializes installation events without a room event", () => {
  const event = materializeGitHubWebhookEvent(
    "installation",
    {
      action: "suspend",
      installation: {
        id: 77,
        account: { id: 10, login: "BrosInCode" },
        target_type: "Organization",
        repository_selection: "selected",
        permissions: { contents: "read" },
      },
      sender: { login: "EmmyMay" },
    },
    "delivery-installation-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "installation");
  assert.equal(
    event?.idempotency_key,
    "installation:77:suspend:delivery:delivery-installation-1"
  );
  assert.equal(event?.state, "suspended");
  assert.equal(event?.roomEvent, null);
  assert.deepEqual(event?.metadata, {
    target_login: "BrosInCode",
    target_type: "Organization",
    repository_selection: "selected",
    permissions: { contents: "read" },
  });
});

test("materializeGitHubWebhookEvent materializes installation repository additions", () => {
  const event = materializeGitHubWebhookEvent(
    "installation_repositories",
    {
      action: "added",
      installation: {
        id: 77,
        account: { id: 10, login: "BrosInCode" },
      },
      repositories_added: [
        {
          id: 12,
          full_name: "BrosInCode/letagents",
          name: "letagents",
        },
        {
          id: 20,
          full_name: "BrosInCode/other-repo",
          name: "other-repo",
        },
      ],
    },
    "delivery-installation-repos-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "installation_repositories");
  assert.equal(
    event?.idempotency_key,
    "installation_repositories:77:added:12,20:delivery:delivery-installation-repos-1"
  );
  assert.equal(event?.roomEvent, null);
  assert.deepEqual(event?.metadata, {
    target_login: "BrosInCode",
    repositories_added: [
      { id: "12", full_name: "BrosInCode/letagents" },
      { id: "20", full_name: "BrosInCode/other-repo" },
    ],
    repositories_removed: [],
  });
});

test("materializeGitHubWebhookEvent derives rename context for repository events", () => {
  const event = materializeGitHubWebhookEvent(
    "repository",
    {
      action: "renamed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        owner: { login: "BrosInCode" },
      },
      sender: { login: "EmmyMay" },
      changes: {
        repository: {
          name: { from: "old-agents" },
        },
      },
    },
    "delivery-repository-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "repository");
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:repository:1:renamed:brosincode/old-agents:delivery:delivery-repository-1"
  );
  assert.equal(event?.roomEvent?.kind, "repository");
  assert.equal(event?.roomEvent?.oldFullName, "BrosInCode/old-agents");
  assert.equal(
    formatRepoRoomEventMessage({ event: event!.roomEvent! }),
    "Repository renamed from BrosInCode/old-agents to BrosInCode/letagents by EmmyMay"
  );
});

test("materializeGitHubRoomEvent keeps the legacy room-event wrapper for room-scoped events", () => {
  const event = materializeGitHubRoomEvent("issues", {
    action: "closed",
    repository: {
      id: 1,
      full_name: "BrosInCode/letagents",
      name: "letagents",
      owner: { login: "BrosInCode" },
    },
    issue: {
      number: 42,
      title: "task_42: finish room events",
      html_url: "https://github.com/BrosInCode/letagents/issues/42",
      state: "closed",
    },
    sender: { login: "EmmyMay" },
  });

  assert.ok(event);
  assert.equal(event?.kind, "issue");
});

test("materializeGitHubWebhookEvent distinguishes repeated issue transitions by delivery id", () => {
  const payload = {
    action: "closed",
    repository: {
      id: 1,
      full_name: "BrosInCode/letagents",
      name: "letagents",
      owner: { login: "BrosInCode" },
    },
    issue: {
      number: 42,
      title: "task_42: finish room events",
      html_url: "https://github.com/BrosInCode/letagents/issues/42",
      state: "closed",
    },
    sender: { login: "EmmyMay" },
  } as const;

  const first = materializeGitHubWebhookEvent("issues", payload, "delivery-issue-1");
  const sameDelivery = materializeGitHubWebhookEvent("issues", payload, "delivery-issue-1");
  const second = materializeGitHubWebhookEvent("issues", payload, "delivery-issue-2");

  assert.ok(first);
  assert.ok(sameDelivery);
  assert.ok(second);
  assert.equal(first?.idempotency_key, sameDelivery?.idempotency_key);
  assert.notEqual(first?.idempotency_key, second?.idempotency_key);
});

test("materializeGitHubWebhookEvent distinguishes repeated installation actions by delivery id", () => {
  const payload = {
    action: "suspend",
    installation: {
      id: 77,
      account: { id: 10, login: "BrosInCode" },
    },
  } as const;

  const first = materializeGitHubWebhookEvent("installation", payload, "delivery-install-1");
  const second = materializeGitHubWebhookEvent("installation", payload, "delivery-install-2");

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first?.idempotency_key, second?.idempotency_key);
});
