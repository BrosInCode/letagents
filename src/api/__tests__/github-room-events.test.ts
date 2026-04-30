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
    pull_request_author_login: "author",
  });
  assert.equal(event?.roomEvent?.kind, "pull_request_review");
  assert.equal(
    event?.roomEvent?.kind === "pull_request_review" ? event.roomEvent.review.state : null,
    "dismissed"
  );
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
        user: { login: "EmmyMay" },
      },
    },
    "delivery-pr-open-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "pull_request");
  assert.equal(
    event?.idempotency_key,
    "brosincode/letagents:pr:98:opened:delivery:delivery-pr-open-1"
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
