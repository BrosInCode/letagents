import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createAssignedTask,
  createInReviewTaskWithLease,
  createRepoRoom,
  createWorkLeaseForPr,
  databaseSkipReason,
  pool,
  postGitHubWebhook,
  requiresDatabase,
  webhookIntegrationTest,
} from "./harness.js";
import {
  buildPullRequestPayload,
  buildPullRequestReviewPayload,
} from "./payloads.js";
import { projectRepoRoomEvent, type TaskStatusLike } from "../../repo-workflow.js";

// The board projection and the task status table are two lists. A change the
// projection names that the table refuses fails the live webhook. This keeps
// the two in step: a projected change is valid for the table, or it is one
// only a GitHub event may make, on purpose.
test(
  "every status change a GitHub event can project is valid for the table or one only a GitHub event may make",
  { skip: requiresDatabase ? databaseSkipReason : false },
  async () => {
    const { GITHUB_EVENT_TRANSITIONS, VALID_TRANSITIONS, isValidTransition } = await import("../../db/tasks.js");
    const statuses = Object.keys(VALID_TRANSITIONS) as TaskStatusLike[];
    const events: Array<{ label: string; event: Record<string, unknown>; approvalSettlesRequestedChanges?: boolean }> = [];
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize", "converted_to_draft", "closed", "edited"]) {
      for (const merged of [false, true]) {
        events.push({ label: `pull request ${action}${merged ? " merged" : ""}`, event: { kind: "pull_request", action, pullRequest: { merged } } });
      }
    }
    for (const action of ["submitted", "edited", "dismissed"]) {
      for (const state of ["approved", "changes_requested", "commented", "dismissed"]) {
        for (const approvalSettlesRequestedChanges of [false, true]) {
          events.push({
            label: `review ${action} ${state}${approvalSettlesRequestedChanges ? " settling" : ""}`,
            event: { kind: "pull_request_review", action, review: { state } },
            approvalSettlesRequestedChanges,
          });
        }
      }
    }
    for (const action of ["opened", "closed", "reopened"]) {
      events.push({ label: `issue ${action}`, event: { kind: "issue", action } });
    }

    const named = new Set<string>();
    for (const currentStatus of statuses) {
      for (const { label, event, approvalSettlesRequestedChanges } of events) {
        const projected = projectRepoRoomEvent({ event: event as never, currentStatus, approvalSettlesRequestedChanges });
        if (!projected) continue;
        named.add(`${currentStatus} -> ${projected.newStatus}`);
        assert.ok(
          isValidTransition(currentStatus, projected.newStatus, { githubEvent: true }),
          `${label} moves ${currentStatus} to ${projected.newStatus}, which neither the table nor the GitHub-only table allows`
        );
      }
    }

    assert.ok(named.has("in_review -> merged"), "the projection still names the merge from in_review");
    for (const [from, targets] of Object.entries(GITHUB_EVENT_TRANSITIONS) as Array<[TaskStatusLike, TaskStatusLike[]]>) {
      for (const to of targets) {
        // Listed there, so a person, a worker or a board intent must not have it.
        assert.ok(!VALID_TRANSITIONS[from].includes(to), `${from} -> ${to} is in the table now: drop it from the GitHub-only table`);
        assert.equal(isValidTransition(from, to), false, `${from} -> ${to} must stay refused without the GitHub flag`);
        assert.ok(named.has(`${from} -> ${to}`), `no event projects ${from} -> ${to}: drop it from the GitHub-only table`);
      }
    }
    for (const from of ["assigned", "in_progress", "blocked"] as const) {
      assert.ok(named.has(`${from} -> merged`), `a merged pull request moves a ${from} task`);
      // Whatever the tables hold: refused by hand, allowed for a GitHub event.
      assert.equal(isValidTransition(from, "merged"), false, `${from} -> merged must be refused without the GitHub flag`);
      assert.equal(isValidTransition(from, "merged", { githubEvent: true }), true, `${from} -> merged must be allowed for a GitHub event`);
    }
  }
);

webhookIntegrationTest(
  "pull_request opened transitions an assigned task to in_review through the real webhook route",
  async (context) => {
    const { getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const task = await createAssignedTask(context, room.id, "Webhook coverage");

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/201";
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/webhook-coverage",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        number: 201,
        title: `${task.id}: add webhook integration coverage`,
        body: "covers the end-to-end route",
        url: pullRequestUrl,
        branchRef: "olive/webhook-coverage",
        sha: "abc123",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const messages = (await getMessages(room.id)).messages;
    const lifecycleMessage = messages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("in review")
    );
    assert.ok(lifecycleMessage);
    assert.equal(lifecycleMessage?.agent_prompt_kind, "auto");
    assert.ok(messages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #201 opened by octocat") &&
      message.text.includes(task.id)
    ));
  }
);

webhookIntegrationTest(
  "pull_request prose alone creates an event without selecting or warning about a room task",
  async (context) => {
    const { getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const task = await createAssignedTask(context, room.id, "Unleased PR coverage");

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/299";
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-unleased",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        number: 299,
        title: `${task.id}: unauthorized work should not project`,
        body: "mentions the task id but has no active work lease",
        url: pullRequestUrl,
        branchRef: "octocat/unleased-work",
        sha: "def456",
      }),
    });

    assert.equal(result.status, "processed");

    const unchangedTask = await getTaskById(room.id, task.id);
    assert.equal(unchangedTask?.status, "assigned");
    assert.equal(unchangedTask?.pr_url, null);

    const messages = (await getMessages(room.id)).messages;
    assert.equal(messages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("Ignored unleased GitHub pull_request projection")
    ), false);
    const githubMessage = messages.find((message) =>
      message.sender === "github" &&
      message.text.includes("PR #299 opened by octocat")
    );
    assert.ok(githubMessage);
    assert.equal(githubMessage?.text.includes("linked to"), false);
    assert.ok(githubMessage?.text.includes(`${task.id}: unauthorized work should not project`));
    const events = await context.getGitHubRoomEvents({
      room_id: room.id,
      event_type: "pull_request",
      github_object_id: "299",
    });
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].linked_task_id, null);
  }
);

webhookIntegrationTest(
  "duplicate pull_request delivery is persisted once and not projected twice",
  async (context) => {
    const { getGitHubRoomEvents, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const task = await createAssignedTask(context, room.id, "Duplicate delivery coverage");

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/204";
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/duplicate-delivery",
    });

    const payload = buildPullRequestPayload({
      number: 204,
      title: `${task.id}: duplicate delivery coverage`,
      body: "exercise duplicate webhook delivery handling",
      url: pullRequestUrl,
      branchRef: "olive/duplicate-delivery",
      sha: "abc204",
    });

    const firstResult = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-duplicate",
      eventName: "pull_request",
      payload,
    });
    const secondResult = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-duplicate",
      eventName: "pull_request",
      payload,
    });

    assert.equal(firstResult.status, "processed");
    assert.equal(secondResult.duplicate, true);

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const events = await getGitHubRoomEvents({
      room_id: room.id,
      event_type: "pull_request",
      github_object_id: "204",
    });
    assert.equal(events.events.length, 1);

    const messages = (await getMessages(room.id)).messages;
    assert.equal(
      messages.filter((message) =>
        message.sender === "github" &&
        message.text.includes("PR #204 opened by octocat")
      ).length,
      1
    );
    assert.equal(
      messages.filter((message) =>
        message.sender === "letagents" &&
        message.text.includes(`${task.id}`) &&
        message.text.includes("in review")
      ).length,
      1
    );
  }
);

webhookIntegrationTest(
  "pull_request_review changes_requested transitions an in_review task to blocked through the real webhook route",
  async (context) => {
    const { getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/202";
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Review transition coverage",
      prUrl: pullRequestUrl,
      branchRef: "olive/review-transition",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-review",
      eventName: "pull_request_review",
      payload: buildPullRequestReviewPayload({
        number: 202,
        title: `${task.id}: review integration coverage`,
        body: "exercise real review transitions",
        url: pullRequestUrl,
        branchRef: "olive/review-transition",
        sha: "abc789",
        reviewId: 88,
        reviewState: "changes_requested",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "blocked");

    const messages = (await getMessages(room.id)).messages;
    const lifecycleMessage = messages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("blocked")
    );
    assert.ok(lifecycleMessage);
    assert.equal(lifecycleMessage?.agent_prompt_kind, "auto");
    assert.ok(messages.some((message) =>
      message.sender === "github" &&
      message.text.includes("reviewer requested changes on PR #202") &&
      message.text.includes(task.id)
    ));
  }
);

webhookIntegrationTest(
  "pull_request merged transitions an in_review task to merged through the real webhook route",
  async (context) => {
    const { getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/203";
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Merge transition coverage",
      prUrl: pullRequestUrl,
      branchRef: "olive/merge-transition",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-merged",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        action: "closed",
        number: 203,
        title: `${task.id}: merge integration coverage`,
        body: "exercise real merge transitions",
        url: pullRequestUrl,
        branchRef: "olive/merge-transition",
        sha: "abc999",
        actor: "octomerger",
        merged: true,
        mergedBy: "octomerger",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "merged");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const messages = (await getMessages(room.id)).messages;
    const lifecycleMessage = messages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("was merged")
    );
    assert.ok(lifecycleMessage);
    assert.equal(lifecycleMessage?.agent_prompt_kind, null);
    assert.ok(messages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #203 was merged by octomerger") &&
      message.text.includes(task.id)
    ));
  }
);

/**
 * A review the effect journal published for a review lease on the task, as
 * the broker writes it: a journal row, and its marker in the review body.
 */
async function journalReview(input: {
  roomId: string;
  taskId: string;
  leaseId: string;
  verdict: "approve" | "request_changes";
  pullNumber: number;
  headSha: string;
  reviewId: number;
  /**
   * `pending`: in flight, GitHub has the review and the journal not yet its id.
   * `failed`: never published.
   */
  state?: "succeeded" | "pending" | "failed";
}): Promise<string> {
  const correlationKey = `lae_${crypto.randomBytes(16).toString("hex")}`;
  await pool!.query(`
    INSERT INTO workflow_effects (id, room_id, task_id, lease_id, kind, provider, idempotency_key, correlation_key,
      request_fingerprint, request_payload, state, attempt_count, max_attempts, external_id, created_by, created_at, updated_at, completed_at)
    VALUES ($1, $2, $3, $4, 'github_review_verdict', 'github', $5, $6, 'fingerprint', $7::jsonb, $8, 1, 3, $9, 'test', now(), now(),
      CASE WHEN $8 = 'succeeded' THEN now() END)
  `, [`effect_${correlationKey}`, input.roomId, input.taskId, input.leaseId, `verdict-${correlationKey}`, correlationKey,
    JSON.stringify({ verdict: input.verdict, pull_number: input.pullNumber, expected_head_sha: input.headSha }),
    input.state ?? "succeeded", (input.state ?? "succeeded") === "succeeded" ? String(input.reviewId) : null]);
  return `Re-reviewed at ${input.headSha}.\n\n<!-- letagents-effect:${correlationKey} -->`;
}

webhookIntegrationTest(
  "only the task's own journal re-review approval moves a blocked task back to in_review, so its merge lands",
  async (context) => {
    const { createTaskLease, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/206";
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Re-review coverage",
      prUrl: pullRequestUrl,
      branchRef: "olive/re-review",
    });
    const reviewLease = await createTaskLease({
      room_id: room.id, task_id: task.id, kind: "review", agent_key: "EmmyMay/harbormarsh",
      actor_label: "HarborMarsh | EmmyMay's agent | Codex", created_by: "test",
    });
    const pullRequest = {
      number: 206,
      title: `${task.id}: re-review coverage`,
      body: "exercise the re-review loop",
      url: pullRequestUrl,
      branchRef: "olive/re-review",
    };
    const journal = (verdict: "approve" | "request_changes", reviewId: number, headSha: string, state?: "pending" | "failed") =>
      journalReview({ roomId: room.id, taskId: task.id, leaseId: reviewLease.id, verdict, pullNumber: 206, headSha, reviewId, state });
    const bot = "letagents-app[bot]";

    const reviews = [
      ["requested changes", 91, "changes_requested", "sha-first", bot, await journal("request_changes", 91, "sha-first"), "blocked"],
      ["a stranger's approval", 92, "approved", "sha-fixed", "drive-by-stranger", "LGTM", "blocked"],
      ["an approval of an earlier head", 93, "approved", "sha-fixed", bot, await journal("approve", 93, "sha-first"), "blocked"],
      ["a copied journal marker", 94, "approved", "sha-fixed", "drive-by-stranger", await journal("approve", 95, "sha-fixed"), "blocked"],
      ["a copied in-flight journal marker", 96, "approved", "sha-fixed", "drive-by-stranger", await journal("approve", 0, "sha-fixed", "pending"), "blocked"],
      ["another App's bot carrying an in-flight marker", 97, "approved", "sha-fixed", "github-actions[bot]", await journal("approve", 0, "sha-fixed", "pending"), "blocked"],
      ["the App's review carrying a never-published approval's marker", 100, "approved", "sha-fixed", bot, await journal("approve", 0, "sha-fixed", "failed"), "blocked"],
      ["a review carrying another review's marker", 98, "approved", "sha-fixed", bot, await journal("approve", 99, "sha-fixed"), "blocked"],
      ["the re-review's approval", 95, "approved", "sha-fixed", bot, null, "in_review"],
    ] as const;
    for (const [label, reviewId, reviewState, sha, actor, reviewBody, expected] of reviews) {
      const result = await postGitHubWebhook({
        port,
        deliveryId: `delivery-re-review-${reviewId}`,
        eventName: "pull_request_review",
        payload: buildPullRequestReviewPayload({
          ...pullRequest, sha, reviewId, reviewState, actor,
          // The approval the copied marker came from.
          reviewBody: reviewBody ?? reviews[3][5],
        }),
      });
      assert.equal(result.status, "processed");
      assert.equal((await getTaskById(room.id, task.id))?.status, expected, `after ${label}`);
    }

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-re-review-merged",
      eventName: "pull_request",
      payload: buildPullRequestPayload({ ...pullRequest, action: "closed", sha: "sha-fixed", merged: true, mergedBy: "octomerger" }),
    });
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
  }
);

webhookIntegrationTest(
  "a journal approval leaves the task blocked while another reviewer's requested changes stand",
  async (context) => {
    const { createTaskLease, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/209";
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Second reviewer coverage",
      prUrl: pullRequestUrl,
      branchRef: "olive/second-reviewer",
    });
    const reviewLease = await createTaskLease({
      room_id: room.id, task_id: task.id, kind: "review", agent_key: "EmmyMay/fieldtrail",
      actor_label: "FieldTrail | EmmyMay's agent | Cursor", created_by: "test",
    });
    const pullRequest = {
      number: 209,
      title: `${task.id}: second reviewer coverage`,
      body: "a person and an agent review",
      url: pullRequestUrl,
      branchRef: "olive/second-reviewer",
      sha: "sha-209",
    };
    const review = (reviewId: number, reviewState: string, actor: string, reviewBody?: string) => postGitHubWebhook({
      port,
      deliveryId: `delivery-second-reviewer-${reviewId}`,
      eventName: "pull_request_review",
      payload: buildPullRequestReviewPayload({ ...pullRequest, reviewId, reviewState, actor, reviewBody }),
    });

    await review(97, "changes_requested", "maintainer");
    assert.equal((await getTaskById(room.id, task.id))?.status, "blocked");
    const approval = await journalReview({
      roomId: room.id, taskId: task.id, leaseId: reviewLease.id, verdict: "approve", pullNumber: 209, headSha: "sha-209", reviewId: 98,
    });
    await review(98, "approved", "letagents-app[bot]", approval);
    assert.equal((await getTaskById(room.id, task.id))?.status, "blocked", "the person's requested changes still stand");

    await review(99, "approved", "maintainer");
    await review(100, "approved", "letagents-app[bot]", await journalReview({
      roomId: room.id, taskId: task.id, leaseId: reviewLease.id, verdict: "approve", pullNumber: 209, headSha: "sha-209", reviewId: 100,
    }));
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review", "once the person approved too");
  }
);

webhookIntegrationTest(
  "requested changes from a review lease that ended no longer hold a task blocked",
  async (context) => {
    const { createTaskLease, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/210";
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Reviewer handoff coverage",
      prUrl: pullRequestUrl,
      branchRef: "olive/handoff",
    });
    const lease = (agent: string) => createTaskLease({
      room_id: room.id, task_id: task.id, kind: "review", agent_key: `EmmyMay/${agent}`, actor_label: agent, created_by: "test",
    });
    const [first, second] = [await lease("fieldtrail"), await lease("harbormarsh")];
    const pullRequest = {
      number: 210, title: `${task.id}: reviewer handoff`, body: "", url: pullRequestUrl, branchRef: "olive/handoff", sha: "sha-210",
    };
    const review = async (reviewId: number, leaseId: string, verdict: "approve" | "request_changes") => postGitHubWebhook({
      port,
      deliveryId: `delivery-handoff-${reviewId}`,
      eventName: "pull_request_review",
      payload: buildPullRequestReviewPayload({
        ...pullRequest, reviewId, reviewState: verdict === "approve" ? "approved" : "changes_requested", actor: "letagents-app[bot]",
        reviewBody: await journalReview({ roomId: room.id, taskId: task.id, leaseId, verdict, pullNumber: 210, headSha: "sha-210", reviewId }),
      }),
    });

    await review(111, first.id, "request_changes");
    await review(112, second.id, "approve");
    assert.equal((await getTaskById(room.id, task.id))?.status, "blocked", "the first reviewer still holds the review");
    await pool!.query("UPDATE task_leases SET status = 'released' WHERE id = $1", [first.id]);
    await review(113, second.id, "approve");
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review", "once it handed the review off");
  }
);

webhookIntegrationTest(
  "a follow-up pull request for a merged task shows beside the one it shipped with",
  async (context) => {
    const { getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const shippedUrl = "https://github.com/BrosInCode/letagents/pull/207";
    const followUpUrl = "https://github.com/BrosInCode/letagents/pull/208";
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Follow-up coverage",
      prUrl: shippedUrl,
      branchRef: "olive/tide",
    });
    const deliver = (deliveryId: string, payload: Parameters<typeof buildPullRequestPayload>[0]) =>
      postGitHubWebhook({ port, deliveryId, eventName: "pull_request", payload: buildPullRequestPayload(payload) });

    await deliver("delivery-shipped-merged", {
      action: "closed", number: 207, title: `${task.id}: tide`, body: "", url: shippedUrl,
      branchRef: "olive/tide", sha: "sha-shipped", merged: true, mergedBy: "octomerger",
    });
    const followUp = {
      number: 208, title: `${task.id}: paint the gradient through CSS`, body: "follow-up", url: followUpUrl,
      branchRef: "olive/tide", sha: "sha-follow-up",
    };
    await deliver("delivery-follow-up-opened", { ...followUp, draft: true });
    const drafted = await getTaskById(room.id, task.id);
    assert.deepEqual(drafted?.workflow_refs.map((ref) => ref.label), ["PR #207", "Follow-up PR #208 (draft)"]);
    await deliver("delivery-follow-up-ready", { ...followUp, action: "ready_for_review" });

    const withFollowUp = await getTaskById(room.id, task.id);
    assert.equal(withFollowUp?.status, "merged");
    assert.equal(withFollowUp?.pr_url, shippedUrl, "the task keeps the pull request it shipped with");
    assert.deepEqual(withFollowUp?.workflow_refs.map((ref) => ref.label), ["PR #207", "Follow-up PR #208 in review"]);

    // The task closes and its work lease ends before the follow-up merges:
    // the follow-up still stops showing as in review.
    await updateTask(room.id, task.id, { status: "done" });
    await pool!.query("UPDATE task_leases SET status = 'released' WHERE room_id = $1 AND task_id = $2", [room.id, task.id]);
    await deliver("delivery-follow-up-merged", {
      action: "closed", number: 208, title: `${task.id}: paint the gradient through CSS`, body: "follow-up", url: followUpUrl,
      branchRef: "olive/tide", sha: "sha-follow-up", merged: true, mergedBy: "octomerger",
    });
    const closed = await getTaskById(room.id, task.id);
    assert.equal(closed?.status, "done");
    assert.equal(closed?.pr_url, shippedUrl);
    assert.deepEqual(closed?.workflow_refs.map((ref) => ref.label), ["PR #207", "PR #208"]);
  }
);
