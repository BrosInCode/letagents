import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubRoomEvent } from "../db.js";
import type { GitHubWebhookPayload } from "../github/app.js";
import {
  materializeGitHubRoomEvent,
  materializeGitHubWebhookEvent,
} from "../github-room-events.js";
import { rehydratePullRequestRoomEvent } from "../github/room-events.js";
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
    review_id: "9001",
    review_submitted_at: null,
    review_commit_id: "abc123def456",
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
    review_id: "9001",
    review_submitted_at: null,
    review_commit_id: null,
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
        changed_files: 4,
        additions: 120,
        deletions: 18,
        base: { ref: "staging" },
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
    changed_files: 4,
    additions: 120,
    deletions: 18,
    base_ref: "staging",
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

test("Activity workflow events retain attempts and PR ownership without task/chat effects", () => {
  const payload = {
    action: "in_progress", repository: { id: 1, full_name: "BrosInCode/letagents", name: "letagents", owner: { login: "BrosInCode" } },
    workflow_run: { id: 901, run_attempt: 2, name: "CI", html_url: "https://github.com/BrosInCode/letagents/actions/runs/901", status: "in_progress", conclusion: null, head_sha: "merge-sha", head_branch: "codex/activity", head_repository: {id: 1, full_name: "BrosInCode/letagents"}, updated_at: "2026-10-11T10:00:00Z", pull_requests: [{ number: 42, head: { sha: "pr-head" } }] },
  };
  const run = materializeGitHubWebhookEvent("workflow_run", payload, "run-1");
  assert.ok(run);
  assert.equal(run.roomEvent, null);
  assert.equal(run.routingEvent?.kind, "pull_request");
  assert.equal(run.metadata?.pull_request_number, 42);
  assert.equal(run.metadata?.run_attempt, 2);
  assert.equal(run.metadata?.pull_request_head_sha, "pr-head");
  const job = materializeGitHubWebhookEvent("workflow_job", { ...payload, workflow_job: {id: 19, run_id: 901, run_attempt: 1, name: "build", html_url: "https://github.com/BrosInCode/letagents/actions/runs/901/job/19", status: "in_progress", conclusion: null, head_sha: "merge-sha", started_at: "2026-10-11T09:00:00Z"} }, "job-1");
  assert.equal(job?.metadata?.run_attempt, 1, "late job keeps its own attempt, not the API's current attempt");
  assert.equal(job?.metadata?.job_id, "19");
  assert.equal(job?.roomEvent, null);
});

test("Activity review comments and thread state carry identity, never comment contents", () => {
  const payload = {
    action: "created", repository: { id: 1, full_name: "BrosInCode/letagents", name: "letagents", owner: { login: "BrosInCode" } },
    pull_request: { number: 42, title: "Activity", html_url: "https://github.com/BrosInCode/letagents/pull/42", head: {ref: "codex/activity", sha: "abc"} },
    comment: { id: 17, pull_request_review_id: 12, body: "PRIVATE COMMENT", html_url: "https://github.com/BrosInCode/letagents/pull/42#discussion_r17", updated_at: "2026-10-11T10:00:00Z", user: {login: "reviewer"} },
  };
  const comment = materializeGitHubWebhookEvent("pull_request_review_comment", payload, "comment-1");
  assert.equal(comment?.metadata?.review_id, "12");
  assert.equal(comment?.metadata?.comment_id, "17");
  assert.equal(comment?.roomEvent, null);
  assert.ok(!JSON.stringify(comment).includes("PRIVATE COMMENT"));
  const threadPayload = {...payload, comment: undefined, action: "resolved", thread: {node_id: "PRRT_17", comments: [{id:17,pull_request_review_id:12,body:"PRIVATE THREAD"}]} };
  const thread = materializeGitHubWebhookEvent("pull_request_review_thread", threadPayload, "thread-1");
  assert.equal(thread?.metadata?.resolved, true);
  assert.equal(thread?.metadata?.thread_id, "PRRT_17");
  assert.ok(!JSON.stringify(thread).includes("PRIVATE THREAD"));
  assert.notEqual(thread?.semantic_id, materializeGitHubWebhookEvent("pull_request_review_thread", threadPayload, "thread-2")?.semantic_id, "resolution can cycle without a provider timestamp");
});

test("workflow jobs resolve their run before routing and reject mismatched identities", async () => {
  const { enrichWorkflowJob } = await import("../github/workflow-activity.js");
  const payload = {action:"queued", installation:{id:2}, repository:{id:1,full_name:"BrosInCode/letagents",name:"letagents",owner:{login:"BrosInCode"}},workflow_job:{id:19,run_id:901,run_attempt:1,name:"build",html_url:"https://github.com/BrosInCode/letagents/actions/runs/901/job/19",status:"queued",conclusion:null,head_sha:"sha"}};
  const run = {id:901,run_attempt:1,name:"CI",html_url:"https://github.com/BrosInCode/letagents/actions/runs/901",status:"queued",conclusion:null,head_sha:"sha",repository:{id:1,full_name:"BrosInCode/letagents"},pull_requests:[{number:42}]};
  const enriched = await enrichWorkflowJob(payload, async (repo, id, installation) => {assert.equal(repo,"BrosInCode/letagents");assert.equal(id,901);assert.equal(installation,"2");return run;});
  assert.equal(enriched.workflow_run?.pull_requests?.[0].number,42);
  await assert.rejects(enrichWorkflowJob(payload,async()=>({...run,head_sha:"different"})), /identity mismatch/);
  await assert.rejects(enrichWorkflowJob(payload,async()=>({...run,repository:{...run.repository,id:22}})), /identity mismatch/);
});


test("dismissing an old review orders by receipt while retaining original review time", () => {
  const event=materializeGitHubWebhookEvent("pull_request_review", {action:"dismissed",repository:{id:1,full_name:"BrosInCode/letagents",name:"letagents",owner:{login:"BrosInCode"}},pull_request:{number:42,title:"Activity",html_url:"https://github.com/BrosInCode/letagents/pull/42"},review:{id:9,state:"dismissed",submitted_at:"2026-09-01T10:00:00Z",html_url:"https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9"}},"dismiss-now");
  assert.equal(event?.provider_event_at,null);
  assert.equal(event?.provider_object_updated_at,null);
  assert.equal(event?.metadata?.review_submitted_at,"2026-09-01T10:00:00.000Z");
});


test("native review dismissal uses updated_at instead of the old submission", () => {
  const event=materializeGitHubWebhookEvent("pull_request_review", {action:"dismissed",repository:{id:1,full_name:"BrosInCode/letagents",name:"letagents",owner:{login:"BrosInCode"}},pull_request:{number:42,title:"Activity",html_url:"https://github.com/BrosInCode/letagents/pull/42"},review:{id:9,state:"dismissed",submitted_at:"2026-09-01T10:00:00Z",updated_at:"2026-10-11T10:00:00Z",html_url:"https://github.com/BrosInCode/letagents/pull/42#pullrequestreview-9"}},"dismiss-now-native");
  assert.equal(event?.provider_event_at,"2026-10-11T10:00:00.000Z");
  assert.equal(event?.metadata?.review_submitted_at,"2026-09-01T10:00:00.000Z");
});

function participantPayload(
  pullRequestOverrides: Record<string, unknown>,
  participant: Record<string, unknown>,
): GitHubWebhookPayload {
  return {
    repository: {
      id: 1,
      full_name: "owner/repo",
      name: "repo",
      owner: { login: "owner" },
    },
    sender: { login: "lerato" },
    pull_request: {
      number: 88,
      title: "Add review pings",
      html_url: "https://github.com/owner/repo/pull/88",
      updated_at: "2026-10-10T09:00:00Z",
      base: { ref: "staging" },
      head: { ref: "codex/review-pings", sha: "abc123" },
      user: { login: "lerato" },
      ...pullRequestOverrides,
    },
    ...participant,
  } as GitHubWebhookPayload;
}

/** The row a webhook would store for a materialized event. */
function storedRowFor(event: NonNullable<ReturnType<typeof materializeGitHubWebhookEvent>>): GitHubRoomEvent {
  return {
    event_type: event.event_type,
    action: event.action,
    github_object_id: event.github_object_id,
    github_object_url: event.github_object_url,
    title: event.title,
    head_ref: event.head_ref,
    head_sha: event.head_sha,
    actor_login: event.actor_login,
    metadata: event.metadata,
  } as unknown as GitHubRoomEvent;
}

test("materializeGitHubWebhookEvent maps review_requested for a user into a participant room event", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, {
      action: "review_requested",
      requested_reviewer: { login: "katrin", id: 555 },
    }),
    "delivery-review-requested-1"
  );

  assert.ok(event);
  assert.equal(event?.event_type, "pull_request");
  assert.equal(event?.action, "review_requested");
  assert.equal(
    event?.semantic_id,
    "owner/repo:pr:88:review_requested:user:katrin:at:2026-10-10T09:00:00.000Z"
  );
  assert.equal(
    event?.idempotency_key,
    "owner/repo:pr:88:review_requested:user:katrin:at:2026-10-10T09:00:00.000Z:delivery:delivery-review-requested-1"
  );
  assert.equal(event?.actor_login, "lerato");
  assert.equal(event?.state, "open");
  assert.deepEqual(event?.metadata?.participant, {
    role: "reviewer",
    change: "added",
    login: "katrin",
    github_user_id: "555",
    team_slug: null,
    team_name: null,
  });
  assert.equal(event?.roomEvent?.kind, "pull_request_participant");
  assert.equal(
    event?.roomEvent?.kind === "pull_request_participant" ? event.roomEvent.participant.login : null,
    "katrin"
  );
  assert.equal(event?.roomEvent?.action, "review_requested");
});

test("materializeGitHubWebhookEvent maps review_requested for a team with the subject in the key", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, {
      action: "review_requested",
      requested_team: { slug: "backend" },
    }),
    "delivery-review-team-1"
  );

  assert.ok(event);
  assert.equal(
    event?.semantic_id,
    "owner/repo:pr:88:review_requested:team:backend:at:2026-10-10T09:00:00.000Z"
  );
  assert.deepEqual(event?.metadata?.participant, {
    role: "reviewer",
    change: "added",
    login: null,
    github_user_id: null,
    team_slug: "backend",
    team_name: null,
  });
  assert.equal(event?.roomEvent?.kind, "pull_request_participant");
});

test("materializeGitHubWebhookEvent gives each reviewer its own semantic key", () => {
  const first = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, { action: "review_requested", requested_reviewer: { login: "katrin" } }),
    "delivery-a"
  );
  const second = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, { action: "review_requested", requested_reviewer: { login: "sipho" } }),
    "delivery-b"
  );

  assert.notEqual(first?.semantic_id, second?.semantic_id);
});

test("materializeGitHubWebhookEvent maps review_request_removed with change removed", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, {
      action: "review_request_removed",
      requested_reviewer: { login: "katrin", id: 555 },
    }),
    "delivery-review-removed-1"
  );

  assert.ok(event);
  assert.equal(event?.action, "review_request_removed");
  assert.match(event?.semantic_id ?? "", /:review_request_removed:user:katrin:at:/);
  assert.equal(
    event?.metadata?.participant && (event.metadata.participant as { change: string }).change,
    "removed"
  );
  assert.equal(event?.roomEvent?.kind, "pull_request_participant");
});

test("materializeGitHubWebhookEvent maps assigned and unassigned for an assignee", () => {
  const assigned = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, { action: "assigned", assignee: { login: "katrin", id: 555 } }),
    "delivery-assigned-1"
  );
  const unassigned = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, { action: "unassigned", assignee: { login: "katrin", id: 555 } }),
    "delivery-unassigned-1"
  );

  assert.ok(assigned);
  assert.match(assigned?.semantic_id ?? "", /:assigned:user:katrin:at:/);
  assert.deepEqual(assigned?.metadata?.participant, {
    role: "assignee",
    change: "added",
    login: "katrin",
    github_user_id: "555",
    team_slug: null,
    team_name: null,
  });
  assert.equal(assigned?.roomEvent?.kind, "pull_request_participant");

  assert.ok(unassigned);
  assert.match(unassigned?.semantic_id ?? "", /:unassigned:user:katrin:at:/);
  assert.equal(
    unassigned?.metadata?.participant && (unassigned.metadata.participant as { change: string }).change,
    "removed"
  );
});

test("materializeGitHubWebhookEvent keeps participant metadata and rehydrates the same kind", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({ draft: true }, {
      action: "review_requested",
      requested_reviewer: { login: "katrin", id: 555 },
    }),
    "delivery-rehydrate-1"
  );

  assert.ok(event);
  const rehydrated = rehydratePullRequestRoomEvent(storedRowFor(event!));
  assert.ok(rehydrated);
  assert.equal(rehydrated?.kind, "pull_request_participant");
  assert.equal(rehydrated?.action, "review_requested");
  assert.equal(rehydrated?.repositoryFullName, "owner/repo");
  assert.equal(rehydrated?.pullRequest.number, 88);
  assert.equal(rehydrated?.pullRequest.draft, true);
  assert.deepEqual(
    rehydrated?.kind === "pull_request_participant" ? rehydrated.participant : null,
    event?.roomEvent?.kind === "pull_request_participant" ? event.roomEvent.participant : undefined
  );
});

test("rehydratePullRequestRoomEvent rebuilds a team participant from stored metadata", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, {
      action: "review_request_removed",
      requested_team: { slug: "backend", name: "Backend" },
    }),
    "delivery-rehydrate-team-1"
  );

  assert.ok(event);
  const rehydrated = rehydratePullRequestRoomEvent(storedRowFor(event!));
  assert.equal(rehydrated?.kind, "pull_request_participant");
  assert.deepEqual(
    rehydrated?.kind === "pull_request_participant" ? rehydrated.participant : null,
    {
      role: "reviewer",
      change: "removed",
      login: null,
      github_user_id: null,
      team_slug: "backend",
      team_name: "Backend",
    }
  );
});

test("rehydratePullRequestRoomEvent returns null for a participant row without participant metadata", () => {
  const row = {
    event_type: "pull_request",
    action: "assigned",
    github_object_id: "88",
    github_object_url: "https://github.com/owner/repo/pull/88",
    title: "Add review pings",
    head_ref: null,
    head_sha: null,
    actor_login: "lerato",
    metadata: {},
  } as unknown as GitHubRoomEvent;

  assert.equal(rehydratePullRequestRoomEvent(row), null);
});

test("formatRepoRoomEventMessage formats review and assignment participant events", () => {
  const materialize = (action: string, participant: Record<string, unknown>) => {
    const event = materializeGitHubWebhookEvent(
      "pull_request",
      participantPayload({}, { action, ...participant }),
      "delivery-message-1"
    );
    assert.ok(event?.roomEvent);
    return event!.roomEvent!;
  };
  const url = "https://github.com/owner/repo/pull/88";
  const title = "Add review pings";

  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("review_requested", { requested_reviewer: { login: "katrin" } }),
    }),
    `@katrin review requested by lerato on PR #88 in owner/repo: ${title} ${url}`
  );
  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("review_requested", { requested_team: { slug: "backend" } }),
    }),
    `Review requested from team owner/backend by lerato on PR #88 in owner/repo: ${title} ${url}`
  );
  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("review_requested", { requested_team: { slug: "backend", name: "Backend" } }),
    }),
    `Review requested from team owner/backend by lerato on PR #88 in owner/repo: ${title} ${url}`
  );
  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("review_request_removed", { requested_reviewer: { login: "katrin" } }),
    }),
    `Review request for @katrin removed by lerato on PR #88 in owner/repo: ${title} ${url}`
  );
  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("review_request_removed", { requested_team: { slug: "backend" } }),
    }),
    `Review request for team owner/backend removed by lerato on PR #88 in owner/repo: ${title} ${url}`
  );
  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("assigned", { assignee: { login: "katrin" } }),
    }),
    `@katrin assigned by lerato to PR #88 in owner/repo: ${title} ${url}`
  );
  assert.equal(
    formatRepoRoomEventMessage({
      event: materialize("unassigned", { assignee: { login: "katrin" } }),
    }),
    `@katrin unassigned by lerato from PR #88 in owner/repo: ${title} ${url}`
  );
});

test("formatRepoRoomEventMessage omits the by clause when the sender is missing", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    participantPayload({}, { action: "assigned", assignee: { login: "katrin" } }),
    "delivery-message-no-sender-1"
  );
  assert.ok(event?.roomEvent);
  const withoutSender = { ...event!.roomEvent!, senderLogin: null };
  const url = "https://github.com/owner/repo/pull/88";
  const title = "Add review pings";

  assert.equal(
    formatRepoRoomEventMessage({ event: withoutSender }),
    `@katrin assigned to PR #88 in owner/repo: ${title} ${url}`
  );
});
