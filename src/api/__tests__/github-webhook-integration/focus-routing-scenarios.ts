import assert from "node:assert/strict";

import {
  createAssignedTask,
  createRepoRoom,
  createWorkLeaseForPr,
  postGitHubWebhook,
  webhookIntegrationTest,
} from "./harness.js";
import {
  buildPullRequestPayload,
  buildRepositoryRenamedPayload,
} from "./payloads.js";

webhookIntegrationTest(
  "pull_request opened for a focused task is announced in the focus room with parent linkbacks",
  async (context) => {
    const {
      createFocusRoomForTask,
      getMessages,
      getTaskById,
      port,
      updateFocusRoomSettings,
    } = context;

    const room = await createRepoRoom(context);
    const task = await createAssignedTask(context, room.id, "Focused webhook coverage");
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      parent_visibility: "major_activity",
    });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/202";
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/focused-webhook-coverage",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-focused",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        number: 202,
        title: `${task.id}: focused webhook integration coverage`,
        body: "covers the focus room routing path",
        url: pullRequestUrl,
        branchRef: "olive/focused-webhook-coverage",
        sha: "abc202",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    const focusLifecycleMessage = focusMessages.find((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("in review")
    );
    assert.ok(focusLifecycleMessage);
    assert.equal(focusLifecycleMessage?.agent_prompt_kind, "auto");
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #202 opened by octocat") &&
      message.text.includes(task.id)
    ));
    assert.ok(parentMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("Task status") &&
      message.text.includes("Focus Room") &&
      message.text.includes(task.id)
    ));
    assert.ok(parentMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes("GitHub activity") &&
      message.text.includes("Focus Room") &&
      message.text.includes(task.id)
    ));
    assert.equal(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #202 opened by octocat")
    ), false);
  }
);

webhookIntegrationTest(
  "task-only GitHub routing keeps artifact-only pull requests out of the focus room",
  async (context) => {
    const {
      createFocusRoomForTask,
      createTask,
      getMessages,
      getTaskById,
      port,
      updateFocusRoomSettings,
      updateTask,
    } = context;

    const room = await createRepoRoom(context);
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/203";
    const task = await createTask(room.id, "Focused artifact-only webhook", "OliveWolf");
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned", pr_url: pullRequestUrl });
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      parent_visibility: "major_activity",
      github_event_routing: "task_only",
    });

    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/artifact-only-webhook",
    });
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-focused-task-only",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        number: 203,
        title: "artifact-only focus routing",
        body: "no explicit task reference",
        url: pullRequestUrl,
        branchRef: "olive/artifact-only-webhook",
        sha: "abc203",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.ok(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #203 opened by octocat")
    ));
    assert.equal(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #203 opened by octocat")
    ), false);
  }
);

webhookIntegrationTest(
  "hard-isolated focus routing keeps focus-owned pull request events out of the parent room",
  async (context) => {
    const {
      createFocusRoomForTask,
      getGitHubRoomEvents,
      getMessages,
      getTaskById,
      port,
      updateFocusRoomSettings,
    } = context;

    const room = await createRepoRoom(context);
    const task = await createAssignedTask(context, room.id, "Hard-isolated focus webhook");
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      parent_visibility: "major_activity",
      github_event_routing: "focus_owned_only",
    });

    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/204";
    await createWorkLeaseForPr({
      roomId: room.id,
      taskId: task.id,
      prUrl: pullRequestUrl,
      branchRef: "olive/hard-isolated-focus",
    });
    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-hard-isolated-focus",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        number: 204,
        title: `${task.id}: hard-isolated focus webhook coverage`,
        body: "covers parent suppression for focus-owned workflow events",
        url: pullRequestUrl,
        branchRef: "olive/hard-isolated-focus",
        sha: "abc204",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedTask = await getTaskById(room.id, task.id);
    assert.equal(updatedTask?.status, "in_review");
    assert.equal(updatedTask?.pr_url, pullRequestUrl);

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.ok(focusMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(`${task.id}`) &&
      message.text.includes("in review")
    ));
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #204 opened by octocat") &&
      message.text.includes(task.id)
    ));
    assert.equal(parentMessages.some((message) =>
      message.text.includes(task.id) &&
      (
        message.text.includes("Task status") ||
        message.text.includes("GitHub activity") ||
        message.text.includes("PR #204 opened by octocat")
      )
    ), false);

    const parentEvents = await getGitHubRoomEvents({ room_id: room.id, event_type: "pull_request" });
    const focusEvents = await getGitHubRoomEvents({ room_id: focus.room.id, event_type: "pull_request" });
    assert.equal(parentEvents.events.some((event) => event.github_object_id === "204"), false);
    assert.ok(focusEvents.events.some((event) =>
      event.github_object_id === "204" &&
      event.linked_task_id === task.id
    ));
  }
);

webhookIntegrationTest(
  "hard-isolated focus routing resolves leases owned by the focus room itself",
  async (context) => {
    const {
      createFocusRoomForTask,
      getGitHubRoomEvents,
      getMessages,
      getTaskById,
      port,
      updateFocusRoomSettings,
    } = context;

    const room = await createRepoRoom(context);
    const parentTask = await createAssignedTask(context, room.id, "Open focus lane");
    const focus = await createFocusRoomForTask(room.id, parentTask.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, parentTask.id, {
      parent_visibility: "major_activity",
      github_event_routing: "focus_owned_only",
    });

    const focusTask = await createAssignedTask(context, focus.room.id, "Focus-owned implementation");
    const pullRequestUrl = "https://github.com/BrosInCode/letagents/pull/205";
    await createWorkLeaseForPr({
      roomId: focus.room.id,
      taskId: focusTask.id,
      prUrl: null,
      branchRef: "olive/focus-owned-branch",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-pr-opened-focus-owned-lease",
      eventName: "pull_request",
      payload: buildPullRequestPayload({
        number: 205,
        title: "focus-owned branch without task mention",
        body: "covers focus room owned lease routing",
        url: pullRequestUrl,
        branchRef: "olive/focus-owned-branch",
        sha: "abc205",
      }),
    });

    assert.equal(result.status, "processed");

    const updatedFocusTask = await getTaskById(focus.room.id, focusTask.id);
    assert.equal(updatedFocusTask?.status, "in_review");
    assert.equal(updatedFocusTask?.pr_url, pullRequestUrl);

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.equal(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #205 opened by octocat")
    ), false);
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("PR #205 opened by octocat") &&
      message.text.includes(focusTask.id)
    ));

    const parentEvents = await getGitHubRoomEvents({ room_id: room.id, event_type: "pull_request" });
    const focusEvents = await getGitHubRoomEvents({ room_id: focus.room.id, event_type: "pull_request" });
    assert.equal(parentEvents.events.some((event) => event.github_object_id === "205"), false);
    assert.ok(focusEvents.events.some((event) =>
      event.github_object_id === "205" &&
      event.linked_task_id === focusTask.id
    ));
  }
);

webhookIntegrationTest(
  "all-parent-repo GitHub routing mirrors unlinked repo events into opted-in focus rooms",
  async (context) => {
    const {
      createFocusRoomForTask,
      createTask,
      getMessages,
      port,
      updateFocusRoomSettings,
    } = context;

    const room = await createRepoRoom(context);
    const task = await createTask(room.id, "Watch parent repo events", "OliveWolf");
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    await updateFocusRoomSettings(room.id, task.id, {
      github_event_routing: "all_parent_repo",
    });

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-repository-renamed-focused",
      eventName: "repository",
      payload: buildRepositoryRenamedPayload({
        from: "oldagents",
      }),
    });

    assert.equal(result.status, "processed");

    const parentMessages = (await getMessages(room.id)).messages;
    const focusMessages = (await getMessages(focus.room.id)).messages;
    assert.ok(parentMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("Repository renamed from BrosInCode/oldagents")
    ));
    assert.ok(focusMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes("Repository renamed from BrosInCode/oldagents")
    ));
  }
);
