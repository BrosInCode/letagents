import assert from "node:assert/strict";

import {
  createInReviewTaskWithLease,
  createRepoRoom,
  pool,
  postGitHubWebhook,
  webhookIntegrationTest,
} from "./harness.js";
import { buildPullRequestParticipantPayload } from "./payloads.js";

type DbModule = typeof import("../../db.js");
const dbModule: DbModule | null = process.env.TEST_DB_URL ? await import("../../db.js") : null;

const katrinGitHubUserId = "424242";
const katrinDeviceId = "device-katrin-review";
const prUrl = "https://github.com/BrosInCode/letagents/pull/88";
const branchRef = "lerato/review-pings";

async function seedKatrinPushDevice(): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, created_at, updated_at)
     VALUES ('acct-katrin', 'github', $1, 'katrin', $2, $2)`,
    [katrinGitHubUserId, now]
  );
  await pool!.query(`
    INSERT INTO desktop_push_devices (
      id, account_id, installation_id, device_token, token_hash, bundle_id,
      environment, enabled, failure_count, last_registered_at, created_at, updated_at
    ) VALUES ($1, 'acct-katrin', 'installation-katrin', $2, 'hash-katrin',
      'chat.letagents.desktop', 'production', TRUE, 0, $3, $3, $3)
  `, [katrinDeviceId, "1".padStart(64, "0"), now]);
}

async function pushRowsForRoom(roomId: string): Promise<Array<{ device_id: string; state: string }>> {
  const result = await pool!.query(
    `SELECT device_id, state FROM desktop_push_notifications WHERE room_id = $1 ORDER BY id`,
    [roomId]
  );
  return result.rows;
}

/** Every task row of the room. A review or assignment event must leave them all as they were. */
async function taskSnapshot(roomId: string): Promise<unknown[]> {
  const result = await pool!.query(
    "SELECT number, status, pr_url, assignee FROM tasks WHERE room_id = $1 ORDER BY number",
    [roomId]
  );
  return result.rows;
}

async function leaseSnapshot(taskId: string): Promise<unknown[]> {
  const result = await pool!.query(
    "SELECT id, status, epoch, agent_key, pr_url, branch_ref FROM task_leases WHERE task_id = $1 ORDER BY id",
    [taskId]
  );
  return result.rows;
}

function reviewRequestedForKatrin(deliveryActor = "lerato") {
  return buildPullRequestParticipantPayload({
    action: "review_requested",
    number: 88,
    title: "Review pings",
    body: "adds review request pings",
    url: prUrl,
    branchRef,
    sha: "abc123",
    actor: deliveryActor,
    requestedReviewer: { login: "katrin", id: Number(katrinGitHubUserId) },
  });
}

webhookIntegrationTest(
  "review_requested for a user messages them and pushes to a device with no room recents",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();

    const result = await postGitHubWebhook({
      port,
      deliveryId: "delivery-review-requested-user",
      eventName: "pull_request",
      payload: reviewRequestedForKatrin(),
    });
    assert.equal(result.ok, true);

    const messages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.startsWith("@katrin review requested by ")
    );
    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.text.includes("PR #"));

    const pushes = await pushRowsForRoom(room.id);
    assert.deepEqual(pushes, [{ device_id: katrinDeviceId, state: "queued" }]);

    const recents = await pool!.query(
      `SELECT archived FROM account_room_recents WHERE account_id = 'acct-katrin' AND room_id = $1`,
      [room.id]
    );
    assert.equal(recents.rows.length, 1);
    assert.equal(recents.rows[0].archived, false);
  }
);

webhookIntegrationTest(
  "the same review_requested delivery twice creates no second message and no second push",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();

    const payload = reviewRequestedForKatrin();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await postGitHubWebhook({
        port,
        deliveryId: "delivery-review-requested-repeat",
        eventName: "pull_request",
        payload,
      });
    }

    const messages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.startsWith("@katrin review requested by ")
    );
    assert.equal(messages.length, 1);
    assert.equal((await pushRowsForRoom(room.id)).length, 1);
  }
);

webhookIntegrationTest(
  "review_requested for a team posts a message without a mention and pushes nobody",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-review-requested-team",
      eventName: "pull_request",
      payload: buildPullRequestParticipantPayload({
        action: "review_requested",
        number: 88,
        title: "Review pings",
        body: "adds review request pings",
        url: prUrl,
        branchRef,
        sha: "abc123",
        actor: "lerato",
        requestedTeam: { slug: "backend", name: "Backend" },
      }),
    });

    const teamMessages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.includes("team")
    );
    assert.equal(teamMessages.length, 1);
    assert.equal(teamMessages[0]!.text.includes("@"), false);
    assert.equal((await pushRowsForRoom(room.id)).length, 0);
  }
);

webhookIntegrationTest(
  "review_request_removed for a user posts a removal message and pushes nobody",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-review-request-removed",
      eventName: "pull_request",
      payload: buildPullRequestParticipantPayload({
        action: "review_request_removed",
        number: 88,
        title: "Review pings",
        body: "adds review request pings",
        url: prUrl,
        branchRef,
        sha: "abc123",
        actor: "lerato",
        requestedReviewer: { login: "katrin", id: Number(katrinGitHubUserId) },
      }),
    });

    const removedMessages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.includes("removed")
    );
    assert.equal(removedMessages.length, 1);
    assert.equal((await pushRowsForRoom(room.id)).length, 0);
  }
);

/** Counts the `[status]` messages the `letagents` sender posted in one room. */
async function statusMessageCount(
  getMessages: (roomId: string) => Promise<{ messages: Array<{ sender: string; text: string }> }>,
  roomId: string
): Promise<number> {
  const { messages } = await getMessages(roomId);
  return messages.filter((message) => message.sender === "letagents" && message.text.startsWith("[status]")).length;
}

webhookIntegrationTest(
  "review_requested for an in-review focused task pings the reviewer in the focus room, once, and leaves the task alone",
  async (context) => {
    const { createFocusRoomForTask, getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Review pings task",
      prUrl,
      branchRef,
    });
    const focus = await createFocusRoomForTask(room.id, task.id);
    assert.ok(focus);
    const taskBefore = await taskSnapshot(room.id);
    const leasesBefore = await leaseSnapshot(task.id);
    const statusBefore = await statusMessageCount(getMessages, room.id)
      + await statusMessageCount(getMessages, focus.room.id);

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-review-requested-task",
      eventName: "pull_request",
      payload: reviewRequestedForKatrin(),
    });

    // (1) The @katrin message is in the task's focus room.
    const focusMessages = (await getMessages(focus.room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.startsWith("@katrin review requested by lerato ")
    );
    assert.equal(focusMessages.length, 1);

    // (2) The repo room gets no copy of it, as with the sibling `opened` scenario.
    const repoMessages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.includes("@katrin review requested")
    );
    assert.equal(repoMessages.length, 0);

    // (3) One push row for katrin's device across all rooms.
    const pushCount = await pool!.query(
      "SELECT count(*)::int AS n FROM desktop_push_notifications WHERE device_id = $1",
      [katrinDeviceId]
    );
    assert.equal(pushCount.rows[0].n, 1);
    assert.deepEqual(await pushRowsForRoom(focus.room.id), [{ device_id: katrinDeviceId, state: "queued" }]);

    // (4) The task row and its lease are unchanged.
    assert.deepEqual(await taskSnapshot(room.id), taskBefore);
    assert.deepEqual(await leaseSnapshot(task.id), leasesBefore);

    // (5) The webhook posted no `[status]` message.
    const statusAfter = await statusMessageCount(getMessages, room.id)
      + await statusMessageCount(getMessages, focus.room.id);
    assert.equal(statusAfter, statusBefore);
  }
);

webhookIntegrationTest(
  "assigned names the assignee, pushes them, and leaves the task alone",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();
    const task = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Assignment task",
      prUrl,
      branchRef,
    });
    const taskBefore = await taskSnapshot(room.id);

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-assigned-user",
      eventName: "pull_request",
      payload: buildPullRequestParticipantPayload({
        action: "assigned",
        number: 88,
        title: "Review pings",
        body: "adds review request pings",
        url: prUrl,
        branchRef,
        sha: "abc123",
        actor: "lerato",
        assignee: { login: "katrin", id: Number(katrinGitHubUserId) },
      }),
    });

    const messages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.startsWith("@katrin assigned by ")
    );
    assert.equal(messages.length, 1);
    assert.deepEqual(await pushRowsForRoom(room.id), [{ device_id: katrinDeviceId, state: "queued" }]);
    assert.deepEqual(await taskSnapshot(room.id), taskBefore);
  }
);

webhookIntegrationTest(
  "unassigned posts a message and pushes nobody",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-unassigned-user",
      eventName: "pull_request",
      payload: buildPullRequestParticipantPayload({
        action: "unassigned",
        number: 88,
        title: "Review pings",
        body: "adds review request pings",
        url: prUrl,
        branchRef,
        sha: "abc123",
        actor: "lerato",
        assignee: { login: "katrin", id: Number(katrinGitHubUserId) },
      }),
    });

    const messages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.includes("unassigned")
    );
    assert.equal(messages.length, 1);
    assert.equal((await pushRowsForRoom(room.id)).length, 0);
  }
);

webhookIntegrationTest(
  "a reviewer who requests their own review gets a message and no push",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-review-requested-self",
      eventName: "pull_request",
      payload: reviewRequestedForKatrin("katrin"),
    });

    const messages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.startsWith("@katrin review requested by katrin ")
    );
    assert.equal(messages.length, 1);
    assert.equal((await pushRowsForRoom(room.id)).length, 0);
  }
);

webhookIntegrationTest(
  "a review request on a fork pull request lands in the repository room, not the branch room",
  async (context) => {
    const { getMessages, port } = context;
    const room = await createRepoRoom(context);
    await seedKatrinPushDevice();
    const branchRoom = (await dbModule!.getOrCreateGitChildRoom({
      parentRoomId: room.id,
      focusKey: `git:branch:${Buffer.from(branchRef).toString("base64url")}`,
      displayName: `Branch: ${branchRef}`,
    })).room;

    await postGitHubWebhook({
      port,
      deliveryId: "delivery-review-requested-fork",
      eventName: "pull_request",
      payload: buildPullRequestParticipantPayload({
        action: "review_requested",
        number: 88,
        title: "Review pings",
        body: "adds review request pings",
        url: prUrl,
        branchRef,
        sha: "abc123",
        actor: "lerato",
        headRepository: "Contributor/letagents",
        requestedReviewer: { login: "katrin", id: Number(katrinGitHubUserId) },
      }),
    });

    const repoMessages = (await getMessages(room.id)).messages.filter((message) =>
      message.sender === "github" && message.text.startsWith("@katrin review requested by ")
    );
    assert.equal(repoMessages.length, 1);
    const branchMessages = (await getMessages(branchRoom.id)).messages.filter((message) =>
      message.sender === "github"
    );
    assert.equal(branchMessages.length, 0);
    assert.deepEqual(await pushRowsForRoom(room.id), [{ device_id: katrinDeviceId, state: "queued" }]);
  }
);
