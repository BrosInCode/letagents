import assert from "node:assert/strict";

import {
  createAssignedTask,
  createRepoRoom,
  pool,
  postGitHubWebhook,
  webhookIntegrationTest,
  type WebhookIntegrationContext,
} from "./harness.js";
import { buildPullRequestPayload } from "./payloads.js";
import { materializeGitHubRoomEvent, rehydratePullRequestRoomEvent } from "../../github/room-events.js";

// A pull request can merge before anything links it to a task: the webhook then
// finds no task to move. These scenarios link it afterwards, through the real
// task route with a real worker bearer, and check when the stored merge applies.

type DbModule = typeof import("../../db.js");
const dbModule: DbModule | null = process.env.TEST_DB_URL ? await import("../../db.js") : null;

function requireDb(): DbModule {
  if (!dbModule) throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  return dbModule;
}

// Worker bearers exist only with these switched on, here and in the server.
const serverEnv = {
  LETAGENTS_AGENT_SESSION_BEARER_ENABLED: "true",
  LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED: "true",
};

async function withServerEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(serverEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, serverEnv);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const pullRequestBase = "https://github.com/BrosInCode/letagents/pull";

let ordinal = 0;

async function createWorker(roomId: string, name = "StoneFox") {
  const db = requireDb();
  const n = ++ordinal;
  const ownerId = `owner_late_link_${n}`;
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO accounts (id, provider, provider_user_id, login, display_name, avatar_url, created_at, updated_at)
     VALUES ($1, 'github', $1, $1, $1, NULL, $2, $2)`,
    [ownerId, now]
  );
  const agentKey = `${ownerId}/${name.toLowerCase()}`;
  return withServerEnv(async () => {
    const { grant } = await db.createSupervisorHostGrant({
      owner_account_id: ownerId,
      host_id: `host_late_link_${n}`,
      installation_id: `install_late_link_${n}`,
      allowed_room_ids: [roomId],
      allowed_agent_keys: [agentKey],
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    return db.createRoomAgentSession({
      room_id: roomId,
      session_kind: "worker",
      runtime: "codex",
      actor_label: `${name} | Owner's agent | Agent`,
      agent_key: agentKey,
      agent_instance_id: `inst_late_link_${n}`,
      display_name: name,
      owner_account_id: ownerId,
      owner_label: "Owner",
      ide_label: "Agent",
      supervisor_grant_id: grant.grant_id,
    });
  });
}

type Worker = Awaited<ReturnType<typeof createWorker>>;

/** The room admin accepts the task and the worker claims it: it holds the work lease. */
async function acceptAndClaim(
  context: WebhookIntegrationContext,
  roomId: string,
  taskId: string,
  worker: Worker
) {
  await context.updateTask(roomId, taskId, { status: "accepted" });
  await context.updateTask(roomId, taskId, {
    status: "assigned",
    assignee: worker.actor_label,
    assignee_agent_key: worker.agent_key,
  });
  return context.createTaskLease({
    room_id: roomId,
    task_id: taskId,
    kind: "work",
    agent_key: worker.agent_key,
    actor_label: worker.actor_label,
    created_by: worker.actor_label,
    agent_session_id: worker.session_id,
  });
}

async function patchTask(
  port: number,
  roomId: string,
  taskId: string,
  worker: Worker,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${port}/rooms/${roomId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${worker.worker_bearer}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function pullRequestLink(number: number, state = "open") {
  const url = `${pullRequestBase}/${number}`;
  return {
    pr_url: url,
    workflow_artifacts: [
      { provider: "github", kind: "pull_request", number, title: `Pull request ${number}`, url, state },
    ],
  };
}

function pullRequestPayload(
  number: number,
  input: { action?: "closed" | "reopened" | "opened"; merged?: boolean; headRepository?: string } = {}
) {
  return buildPullRequestPayload({
    action: input.action ?? "closed",
    number,
    title: `Ship change ${number}`,
    body: "",
    url: `${pullRequestBase}/${number}`,
    branchRef: `stone/change-${number}`,
    sha: `sha-${number}`,
    actor: "octomerger",
    merged: input.merged ?? true,
    mergedBy: "octomerger",
    headRepository: input.headRepository,
  });
}

async function deliver(
  port: number,
  deliveryId: string,
  number: number,
  input: { action?: "closed" | "reopened" | "opened"; merged?: boolean; headRepository?: string } = {}
) {
  const result = await postGitHubWebhook({
    port,
    deliveryId,
    eventName: "pull_request",
    payload: pullRequestPayload(number, input),
  });
  assert.equal(result.status, "processed");
}

function mergedMessages(messages: Array<{ sender: string; text: string }>, taskId: string) {
  return messages.filter((message) =>
    message.sender === "letagents" && message.text.includes(taskId) && message.text.includes("was merged")
  );
}

async function storedEvent(context: WebhookIntegrationContext, roomId: string, number: number) {
  const { events } = await context.getGitHubRoomEvents({
    room_id: roomId,
    event_type: "pull_request",
    github_object_id: String(number),
  });
  return events[0];
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

webhookIntegrationTest(
  "a pull request merged before it was linked moves the task to merged when the worker links it",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const db = requireDb();
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Ship the change", worker.actor_label);
    const { pr_url, workflow_artifacts } = pullRequestLink(1563);

    // The pull request merges while the task is only proposed. Nothing links it.
    await pause();
    await deliver(port, "delivery-late-merge", 1563);
    const stored = await storedEvent(context, room.id, 1563);
    assert.equal(stored.linked_task_id, null);
    // The replay sees the event as the live webhook saw it.
    const live = materializeGitHubRoomEvent("pull_request", pullRequestPayload(1563) as never);
    assert.deepEqual(
      JSON.parse(JSON.stringify(rehydratePullRequestRoomEvent(stored))),
      JSON.parse(JSON.stringify(live)),
    );
    assert.equal((await getTaskById(room.id, task.id))?.status, "proposed");

    await acceptAndClaim(context, room.id, task.id, worker);
    // A request to close this task, still waiting for a decision.
    const closeRequest = await db.createBoardIntent({
      room_id: room.id,
      action_type: "task_close",
      payload: db.boardIntentPayloadForTaskMutation({ taskId: task.id, status: "merged" }),
      task_id: task.id,
      proposer_actor_label: worker.actor_label,
      proposer_actor_key: worker.agent_key,
      proposer_agent_session_id: worker.session_id,
    });

    // The worker links the merged pull request while the task is in progress.
    // The merge is a fact on GitHub, so the card follows it at the link.
    const link = await patchTask(port, room.id, task.id, worker, { status: "in_progress", pr_url, workflow_artifacts });
    assert.equal(link.status, 200);
    assert.equal(link.body.status, "merged", "the response shows the task as it now stands");

    const merged = await getTaskById(room.id, task.id);
    assert.equal(merged?.status, "merged");
    assert.equal(merged?.pr_url, pr_url);
    assert.equal((await storedEvent(context, room.id, 1563)).linked_task_id, task.id);
    assert.equal((await db.getBoardIntent({ room_id: room.id, intent_id: closeRequest.id }))?.status, "superseded");

    const messages = (await getMessages(room.id)).messages;
    assert.equal(mergedMessages(messages, task.id).length, 1);
    const audit = await pool!.query(
      "SELECT reason FROM coordination_events WHERE room_id = $1 AND task_id = $2 AND reason LIKE 'Replayed stored merge event%'",
      [room.id, task.id]
    );
    assert.equal(audit.rowCount, 1);

    // A repeat of the write, and the same merge delivered again, change nothing.
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_review" })).status, 400);
    await deliver(port, "delivery-late-merge-again", 1563);
    const afterRepeat = await getMessages(room.id);
    assert.equal(mergedMessages(afterRepeat.messages, task.id).length, 1);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
  },
  { serverEnv }
);

webhookIntegrationTest(
  "linking a merged pull request moves a task that is already in_review at the link",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Ship the change", worker.actor_label);
    const link = pullRequestLink(1564);

    await pause();
    await deliver(port, "delivery-late-merge-in-review", 1564);
    await acceptAndClaim(context, room.id, task.id, worker);
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_review" })).body.status, "in_review");

    const linked = await patchTask(port, room.id, task.id, worker, link);
    assert.equal(linked.status, 200);
    assert.equal(linked.body.status, "merged");
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);

    // Linking again is a repeat of the same write.
    assert.equal((await patchTask(port, room.id, task.id, worker, link)).status, 200);
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a pull request whose latest stored state is not a merge does not move the task",
  async (context) => {
    const { createTask, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const closedTask = await createTask(room.id, "Closed without a merge", worker.actor_label);
    const reopenedTask = await createTask(room.id, "Reopened after the merge", worker.actor_label);

    await pause();
    await deliver(port, "delivery-closed-unmerged", 1570, { merged: false });
    await deliver(port, "delivery-merged-then-reopened", 1571);
    await pause();
    await deliver(port, "delivery-reopened", 1571, { action: "reopened", merged: false });

    for (const [task, number] of [[closedTask, 1570], [reopenedTask, 1571]] as const) {
      await acceptAndClaim(context, room.id, task.id, worker);
      assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(number) })).status, 200);
      assert.equal((await getTaskById(room.id, task.id))?.status, "in_progress", `pull request ${number} at the link`);
      const review = await patchTask(port, room.id, task.id, worker, { status: "in_review" });
      assert.equal(review.status, 200);
      assert.equal((await getTaskById(room.id, task.id))?.status, "in_review", `pull request ${number}`);
      assert.equal((await storedEvent(context, room.id, number)).linked_task_id, null);
    }
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merged state the worker supplies moves nothing, and the worker still cannot set merged",
  async (context) => {
    const { createTask, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Claims a merge nobody stored", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);

    // No pull request event was ever stored for this one.
    const link = pullRequestLink(1590, "merged");
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...link })).status, 200);
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_review", ...link })).status, 200);
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");

    const direct = await patchTask(port, room.id, task.id, worker, { status: "merged" });
    assert.equal(direct.status, 403);
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merge from before the task existed is not applied to the task",
  async (context) => {
    const { createTask, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);

    await deliver(port, "delivery-merge-before-task", 1600);
    await pause();
    const task = await createTask(room.id, "Created after the merge", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1600) });
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });

    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
    assert.equal((await storedEvent(context, room.id, 1600)).linked_task_id, null);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a pull request another task already took is not replayed to a second task",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const owner = await createTask(room.id, "Owns the pull request", worker.actor_label);
    const other = await createTask(room.id, "Wants the same pull request", worker.actor_label);
    await acceptAndClaim(context, room.id, owner.id, worker);
    await acceptAndClaim(context, room.id, other.id, worker);

    await patchTask(port, room.id, owner.id, worker, { status: "in_progress", ...pullRequestLink(1610) });
    await patchTask(port, room.id, owner.id, worker, { status: "in_review" });
    await deliver(port, "delivery-owner-merge", 1610);
    assert.equal((await getTaskById(room.id, owner.id))?.status, "merged");
    assert.equal((await storedEvent(context, room.id, 1610)).linked_task_id, owner.id);

    await patchTask(port, room.id, other.id, worker, { status: "in_progress", ...pullRequestLink(1610) });
    await patchTask(port, room.id, other.id, worker, { status: "in_review" });

    assert.equal((await getTaskById(room.id, other.id))?.status, "in_review");
    assert.equal((await storedEvent(context, room.id, 1610)).linked_task_id, owner.id);
    assert.equal(mergedMessages((await getMessages(room.id)).messages, other.id).length, 0);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "linking only an artifact, without binding the work lease, moves nothing, as a live merge would not have",
  async (context) => {
    const { createTask, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Artifact link only", worker.actor_label);

    await pause();
    await deliver(port, "delivery-unbound-merge", 1620);
    await acceptAndClaim(context, room.id, task.id, worker);
    const { workflow_artifacts } = pullRequestLink(1620);
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_progress", workflow_artifacts })).status, 200);
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_review" })).status, 200);

    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
    assert.equal((await storedEvent(context, room.id, 1620)).linked_task_id, null);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merge stored in another room is not applied to a task in this room",
  async (context) => {
    const { createProjectWithName, createTask, getTaskById, port } = context;
    const db = requireDb();
    const room = await createRepoRoom(context);
    const elsewhere = await createProjectWithName("github.com/brosincode/elsewhere");
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Links a merge from another room", worker.actor_label);
    const { pr_url } = pullRequestLink(1630);

    await pause();
    await db.insertGitHubRoomEvent({
      room_id: elsewhere.id,
      delivery_id: null,
      event_type: "pull_request",
      action: "closed",
      idempotency_key: "elsewhere:pr:1630:closed",
      semantic_id: "elsewhere:pr:1630:closed",
      github_object_id: "1630",
      github_object_url: pr_url,
      title: "Merged in another room",
      state: "merged",
      head_ref: "stone/change-1630",
      head_sha: "sha-1630",
      metadata: { merged: true },
    });
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1630) });
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });

    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merge goes to the task the live resolver picks, not to a later task that also links the pull request",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const first = await createTask(room.id, "Linked the artifact first", worker.actor_label);
    const second = await createTask(room.id, "Links with its lease later", worker.actor_label);
    await acceptAndClaim(context, room.id, first.id, worker);
    await acceptAndClaim(context, room.id, second.id, worker);

    // The first task holds the pull request as an artifact, without binding its lease.
    const { workflow_artifacts } = pullRequestLink(1670);
    await patchTask(port, room.id, first.id, worker, { status: "in_progress", workflow_artifacts });
    // The merge finds that task, and its lease does not cover the pull request.
    await deliver(port, "delivery-two-tasks-merge", 1670);
    assert.equal((await getTaskById(room.id, first.id))?.status, "in_progress");
    assert.equal((await storedEvent(context, room.id, 1670)).linked_task_id, null);

    await patchTask(port, room.id, second.id, worker, { status: "in_progress", ...pullRequestLink(1670) });
    await patchTask(port, room.id, second.id, worker, { status: "in_review" });

    assert.equal((await getTaskById(room.id, second.id))?.status, "in_review");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, second.id).length, 0);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a task an admin reopened is not merged again by the merge it already took",
  async (context) => {
    const { createTask, getMessages, getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Reopened after the merge", worker.actor_label);

    await pause();
    await deliver(port, "delivery-reopen-merge", 1650);
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1650) });
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");

    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, {
      status: "assigned",
      assignee: worker.actor_label,
      assignee_agent_key: worker.agent_key,
    });
    await patchTask(port, room.id, task.id, worker, { status: "in_progress" });
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });

    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a replay the task's own change interrupts leaves the merge free for the next replay",
  async (context) => {
    const { createTask, getMessages, getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Cancelled while the merge is applied", worker.actor_label);

    await pause();
    await deliver(port, "delivery-interrupted-merge", 1680);
    await acceptAndClaim(context, room.id, task.id, worker);

    // An admin's change to cancelled commits between the replay's read of the
    // task and its write: the write to merged is then refused. The trigger
    // makes that change as the replay records its coordination decision.
    await pool!.query(`
      CREATE FUNCTION cancel_task_during_replay() RETURNS trigger AS $$
      BEGIN
        UPDATE tasks SET status = 'cancelled'
          WHERE room_id = NEW.room_id AND number = substring(NEW.task_id from 6)::int;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool!.query(`
      CREATE TRIGGER cancel_task_during_replay AFTER INSERT ON coordination_events
        FOR EACH ROW WHEN (NEW.reason LIKE 'Allowed webhook_projection%')
        EXECUTE FUNCTION cancel_task_during_replay()`);
    const link = await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1680) });
    assert.equal(link.status, 200, "a failed replay never fails the worker's write");
    await pool!.query("DROP TRIGGER cancel_task_during_replay ON coordination_events");

    assert.equal((await getTaskById(room.id, task.id))?.status, "cancelled");
    assert.equal((await storedEvent(context, room.id, 1680)).linked_task_id, null, "the merge was not used up");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 0);

    // The admin reopens the task and the worker takes it up again: the merge applies now.
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, {
      status: "assigned",
      assignee: worker.actor_label,
      assignee_agent_key: worker.agent_key,
    });
    const back = await patchTask(port, room.id, task.id, worker, { status: "in_progress" });
    assert.equal(back.body.status, "merged");
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal((await storedEvent(context, room.id, 1680)).linked_task_id, task.id);
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merge the pull request's branch room stored applies, and one a sibling task's focus room stored does not",
  async (context) => {
    const { createFocusRoomForTask, createTask, getTaskById, port } = context;
    const db = requireDb();
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const branchTask = await createTask(room.id, "Merged from a branch with its own room", worker.actor_label);
    const siblingTask = await createTask(room.id, "Links a merge a sibling room stored", worker.actor_label);

    // The branch has a Git room, so the merge is stored there, not in the repo room.
    const branchRoom = (await db.getOrCreateGitChildRoom({
      parentRoomId: room.id,
      focusKey: `git:branch:${Buffer.from("stone/change-1660").toString("base64url")}`,
      displayName: "Branch: stone/change-1660",
    })).room;
    await pause();
    await deliver(port, "delivery-branch-room-merged", 1660, { headRepository: "BrosInCode/letagents" });
    const storedIn = await pool!.query(
      "SELECT room_id FROM github_room_events WHERE github_object_url = $1 AND action = 'closed'",
      [`${pullRequestBase}/1660`]
    );
    assert.deepEqual(storedIn.rows.map((row) => row.room_id), [branchRoom.id], "the branch room holds the merge");

    await acceptAndClaim(context, room.id, branchTask.id, worker);
    await patchTask(port, room.id, branchTask.id, worker, { status: "in_progress", ...pullRequestLink(1660) });
    await patchTask(port, room.id, branchTask.id, worker, { status: "in_review" });
    assert.equal((await getTaskById(room.id, branchTask.id))?.status, "merged");

    // Another task's focus room holds a merge no task claimed: it stays that room's.
    const other = await createAssignedTask(context, room.id, "Has its own focus room");
    const otherFocus = await createFocusRoomForTask(room.id, other.id);
    assert.ok(otherFocus);
    await db.insertGitHubRoomEvent({
      room_id: otherFocus.room.id,
      delivery_id: null,
      event_type: "pull_request",
      action: "closed",
      idempotency_key: "sibling:pr:1661:closed",
      semantic_id: "sibling:pr:1661:closed",
      github_object_id: "1661",
      github_object_url: `${pullRequestBase}/1661`,
      title: "Merged in a sibling focus room",
      state: "merged",
      head_ref: "stone/change-1661",
      head_sha: "sha-1661",
      metadata: { merged: true },
    });
    await acceptAndClaim(context, room.id, siblingTask.id, worker);
    await patchTask(port, room.id, siblingTask.id, worker, { status: "in_progress", ...pullRequestLink(1661) });
    await patchTask(port, room.id, siblingTask.id, worker, { status: "in_review" });
    assert.equal((await getTaskById(room.id, siblingTask.id))?.status, "in_review");
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a task in a focus room takes the merge the repo room stored, not the same-numbered task of the repo room",
  async (context) => {
    const { createFocusRoomForTask, createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const parentTask = await createAssignedTask(context, room.id, "Parent room task");
    const focus = await createFocusRoomForTask(room.id, parentTask.id);
    assert.ok(focus);
    const worker = await createWorker(focus.room.id);
    const task = await createTask(focus.room.id, "Focus room task", worker.actor_label);
    assert.equal(task.id, parentTask.id, "both rooms number their first task the same");

    await pause();
    await deliver(port, "delivery-focus-late-merge", 1640);
    // The repo room stores it, as no task held the link when it merged.
    assert.equal((await storedEvent(context, room.id, 1640)).linked_task_id, null);

    await acceptAndClaim(context, focus.room.id, task.id, worker);
    const link = await patchTask(port, focus.room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1640) });
    assert.equal(link.status, 200);
    assert.equal(link.body.status, "merged");

    assert.equal((await getTaskById(focus.room.id, task.id))?.status, "merged");
    assert.equal((await getTaskById(room.id, parentTask.id))?.status, "assigned");
    assert.equal(mergedMessages((await getMessages(focus.room.id)).messages, task.id).length, 1);
    assert.equal((await storedEvent(context, room.id, 1640)).linked_task_id, task.id);
  },
  { serverEnv }
);

// A merge on GitHub is a fact, so the card follows it at once: from assigned,
// in_progress and blocked, not only from in_review. Only a GitHub event makes
// these moves: the webhook projection and the stored merge replay.

async function auditCount(roomId: string, taskId: string, like: string): Promise<number> {
  const rows = await pool!.query(
    "SELECT 1 FROM coordination_events WHERE room_id = $1 AND task_id = $2 AND reason LIKE $3",
    [roomId, taskId, like]
  );
  return rows.rowCount ?? 0;
}

webhookIntegrationTest(
  "a pull request that merges while the task is in_progress moves the task to merged at once",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Merges before the review step", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    const link = pullRequestLink(1700);
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...link })).status, 200);

    // The webhook is accepted and the card follows the merge.
    await pause();
    await deliver(port, "delivery-merge-in-progress", 1700);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal((await storedEvent(context, room.id, 1700)).linked_task_id, task.id);
    const shown = await pool!.query(
      "SELECT state FROM room_shared_artifacts WHERE room_id = $1 AND url = $2",
      [room.id, link.pr_url]
    );
    assert.deepEqual(shown.rows.map((row) => row.state), ["merged"]);
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);

    // GitHub delivers the same merge again: with the same delivery id, and with a new one.
    const same = await postGitHubWebhook({
      port,
      deliveryId: "delivery-merge-in-progress",
      eventName: "pull_request",
      payload: pullRequestPayload(1700),
    });
    assert.equal(same.duplicate, true);
    await deliver(port, "delivery-merge-in-progress-resent", 1700);
    // The worker then sets the card to in_review, as it did before the merge: refused, nothing moves.
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "in_review" })).status, 400);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
    assert.equal(await auditCount(room.id, task.id, "Replayed stored merge event%"), 0, "the live path applied it");
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a pull request that merges while the task is only assigned moves the task to merged at once",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Merges straight from assigned", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    // The worker binds the pull request to its lease without leaving assigned.
    assert.equal((await patchTask(port, room.id, task.id, worker, pullRequestLink(1701))).status, 200);
    assert.equal((await getTaskById(room.id, task.id))?.status, "assigned");

    await pause();
    await deliver(port, "delivery-merge-assigned", 1701);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a pull request that merges while the task is blocked moves the task to merged",
  async (context) => {
    const { createTask, getMessages, getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Merged although changes were requested", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1702) });
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });
    // A reviewer asks for changes, then the pull request merges anyway.
    await updateTask(room.id, task.id, { status: "blocked" });

    await pause();
    await deliver(port, "delivery-merge-blocked", 1702);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merged pull request linked while the task is only assigned moves the task to merged at the link",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Links a merged pull request from assigned", worker.actor_label);

    await pause();
    await deliver(port, "delivery-late-merge-assigned", 1703);
    await acceptAndClaim(context, room.id, task.id, worker);
    const link = await patchTask(port, room.id, task.id, worker, pullRequestLink(1703));
    assert.equal(link.status, 200);
    assert.equal(link.body.status, "merged");
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a task an admin reopened is not merged again by a merge the webhook applied from in_progress",
  async (context) => {
    const { createTask, getMessages, getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Reopened after a live merge", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1704) });

    await pause();
    await deliver(port, "delivery-live-merge-reopened-admin", 1704);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");

    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, {
      status: "assigned",
      assignee: worker.actor_label,
      assignee_agent_key: worker.agent_key,
    });
    await patchTask(port, room.id, task.id, worker, { status: "in_progress" });
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });

    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a pull request reopened on GitHub after it merged does not move the task again",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Merged, then reopened", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1705) });

    await pause();
    await deliver(port, "delivery-merge-then-reopen", 1705);
    await pause();
    await deliver(port, "delivery-reopened-after-merge", 1705, { action: "reopened", merged: false });

    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a merged pull request does not move a task that holds no work lease",
  async (context) => {
    const { createTask, getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const proposed = await createTask(room.id, "Only proposed", worker.actor_label);
    const accepted = await createTask(room.id, "Accepted, nobody holds it", worker.actor_label);
    await updateTask(room.id, accepted.id, { status: "accepted" });
    // Each task points at its pull request, but neither has a work lease to cover it.
    await updateTask(room.id, proposed.id, { pr_url: pullRequestLink(1706).pr_url });
    await updateTask(room.id, accepted.id, { pr_url: pullRequestLink(1707).pr_url });

    await deliver(port, "delivery-merge-proposed", 1706);
    await deliver(port, "delivery-merge-accepted", 1707);
    assert.equal((await getTaskById(room.id, proposed.id))?.status, "proposed");
    assert.equal((await getTaskById(room.id, accepted.id))?.status, "accepted");
    assert.equal((await storedEvent(context, room.id, 1706)).linked_task_id, null);
    assert.equal((await storedEvent(context, room.id, 1707)).linked_task_id, null);
  },
  { serverEnv }
);

webhookIntegrationTest(
  "only a GitHub event moves a task to merged before review: a worker, a person and a board intent cannot",
  async (context) => {
    const { createTask, getTaskById, port, updateTask } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Nobody may merge it by hand", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);

    for (const from of ["assigned", "in_progress", "blocked"] as const) {
      if (from !== "assigned") await updateTask(room.id, task.id, { status: from });
      // A worker's own write is refused by the route.
      assert.equal((await patchTask(port, room.id, task.id, worker, { status: "merged" })).status, 403, from);
      // Every route and board intent writes the status through updateTask without the GitHub flag.
      await assert.rejects(updateTask(room.id, task.id, { status: "merged" }), /Invalid transition/, from);
      assert.equal((await getTaskById(room.id, task.id))?.status, from);
    }
    await updateTask(room.id, task.id, { status: "in_review" });
    assert.equal((await patchTask(port, room.id, task.id, worker, { status: "merged" })).status, 403, "in_review");
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
  },
  { serverEnv }
);

webhookIntegrationTest(
  "a delivery that failed after its merge was stored is applied when GitHub sends it again",
  async (context) => {
    const { createTask, getMessages, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const worker = await createWorker(room.id);
    const task = await createTask(room.id, "Delivery failed before the fix", worker.actor_label);
    await acceptAndClaim(context, room.id, task.id, worker);
    await patchTask(port, room.id, task.id, worker, { status: "in_progress", ...pullRequestLink(1708) });

    // The write to merged fails, as it did while the board refused it: the
    // webhook answers 500, and the merge is stored linked to the task.
    await pool!.query(`
      CREATE FUNCTION refuse_merged_task() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'merged refused'; END $$ LANGUAGE plpgsql`);
    await pool!.query(`
      CREATE TRIGGER refuse_merged_task BEFORE UPDATE ON tasks
        FOR EACH ROW WHEN (NEW.status = 'merged') EXECUTE FUNCTION refuse_merged_task()`);
    await pause();
    await postGitHubWebhook({
      port,
      deliveryId: "delivery-failed-before-fix",
      eventName: "pull_request",
      payload: pullRequestPayload(1708),
      expectedStatus: 500,
    });
    await pool!.query("DROP TRIGGER refuse_merged_task ON tasks");
    assert.equal((await storedEvent(context, room.id, 1708)).linked_task_id, task.id);

    // The replay leaves an event a task holds alone, so the task stays in review.
    await patchTask(port, room.id, task.id, worker, { status: "in_review" });
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");

    // GitHub sends the failed delivery again: it applies, once.
    await deliver(port, "delivery-failed-before-fix", 1708);
    assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
    await deliver(port, "delivery-failed-before-fix-resent", 1708);
    assert.equal(mergedMessages((await getMessages(room.id)).messages, task.id).length, 1);
  },
  { serverEnv }
);
