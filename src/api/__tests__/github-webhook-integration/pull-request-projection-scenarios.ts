import assert from "node:assert/strict";

import {
  createAssignedTask,
  createInReviewTaskWithLease,
  createRepoRoom,
  createWorkLeaseForPr,
  postGitHubWebhook,
  webhookIntegrationTest,
} from "./harness.js";
import {
  buildPullRequestPayload,
  buildPullRequestReviewPayload,
} from "./payloads.js";

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
  "pull_request opened with only a task reference is recorded but not projected without a matching lease",
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
    assert.ok(messages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("Ignored unleased GitHub pull_request projection") &&
      message.text.includes(task.id)
    ));
    const githubMessage = messages.find((message) =>
      message.sender === "github" &&
      message.text.includes("PR #299 opened by octocat")
    );
    assert.ok(githubMessage);
    assert.equal(githubMessage?.text.includes(task.id), false);
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
