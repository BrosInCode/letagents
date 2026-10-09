import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  createAssignedTask,
  createInReviewTaskWithLease,
  createRepoRoom,
  createWorkLeaseForPr,
  pool,
  postGitHubWebhook,
  webhookIntegrationTest,
  type WebhookIntegrationContext,
} from "./harness.js";
import { buildPullRequestPayload, buildRepositoryPayload } from "./payloads.js";
import { materializeGitHubWebhookEvent } from "../../github/room-events.js";

// The one-time repair of merge events that the webhook stored but never applied
// (src/api/github/room-event-projection/unapplied-merge-repair.ts). Until the
// webhook learned to move a task that is assigned, in progress or blocked when
// its pull request merges, such a merge threw "Invalid transition", the route
// marked the delivery failed, and the stored event kept its link to the task
// although the task never moved. These scenarios rebuild that state, and the
// states the repair must not touch, and run the repair on them.

type DbModule = typeof import("../../db.js");
type ProjectionModule = typeof import("../../github/room-event-projection.js");
type RepairModule = typeof import("../../github/room-event-projection/unapplied-merge-repair.js");
type RoomServicesModule = typeof import("../../server/room-services.js");

const hasDatabase = Boolean(process.env.TEST_DB_URL);
const dbModule: DbModule | null = hasDatabase ? await import("../../db.js") : null;
const projectionModule: ProjectionModule | null = hasDatabase
  ? await import("../../github/room-event-projection.js")
  : null;
const repairModule: RepairModule | null = hasDatabase
  ? await import("../../github/room-event-projection/unapplied-merge-repair.js")
  : null;
const roomServicesModule: RoomServicesModule | null = hasDatabase
  ? await import("../../server/room-services.js")
  : null;

function required<T>(module: T | null): T {
  if (!module) throw new Error("DB-backed webhook integration tests require TEST_DB_URL");
  return module;
}

const pullRequestBase = "https://github.com/BrosInCode/letagents/pull";
const otherRepoRoomName = "github.com/brosincode/other";
const otherPullRequestBase = "https://github.com/BrosInCode/other/pull";

const prUrl = (number: number) => `${pullRequestBase}/${number}`;
const branchRef = (number: number) => `stone/change-${number}`;

function mergePayload(
  number: number,
  input: { action?: "closed" | "reopened"; merged?: boolean; repo?: "other" } = {}
) {
  const payload = buildPullRequestPayload({
    action: input.action ?? "closed",
    number,
    title: `Ship change ${number}`,
    body: "",
    url: input.repo === "other" ? `${otherPullRequestBase}/${number}` : prUrl(number),
    branchRef: branchRef(number),
    sha: `sha-${number}`,
    actor: "octomerger",
    merged: input.merged ?? true,
    mergedBy: "octomerger",
  });
  return input.repo === "other"
    ? { ...payload, repository: { ...buildRepositoryPayload(), id: 4343, full_name: "BrosInCode/other", name: "other" } }
    : payload;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

/** GitHub sends the delivery to the real webhook route, which today applies the merge. */
async function deliver(
  port: number,
  deliveryId: string,
  number: number,
  input: { action?: "closed" | "reopened"; merged?: boolean; repo?: "other" } = {}
) {
  const result = await postGitHubWebhook({
    port,
    deliveryId,
    eventName: "pull_request",
    payload: mergePayload(number, input),
  });
  assert.equal(result.status, "processed");
}

/**
 * Stores a merge the way the webhook did before it could move the card: the
 * projection wrote the merge without the GitHub option, which refuses a task
 * that is assigned, in progress or blocked. The handler threw, the route marked
 * the delivery failed with that error, and the event stayed linked to the task.
 * The helper runs the real handler with that one projection step swapped, and
 * records the delivery as the route does.
 */
async function deliverBeforeTheFix(roomId: string, deliveryId: string, number: number): Promise<string> {
  const db = required(dbModule);
  const { handleMaterializedGitHubRoomEvent } = required(projectionModule);
  const project = await db.getProjectById(roomId);
  assert.ok(project);
  const materialized = materializeGitHubWebhookEvent("pull_request", mergePayload(number) as never, deliveryId);
  assert.ok(materialized);

  await db.recordGitHubWebhookDelivery({
    delivery_id: deliveryId,
    event_name: "pull_request",
    action: "closed",
    room_id: roomId,
  });
  let refused: unknown;
  try {
    await handleMaterializedGitHubRoomEvent(project, materialized, {
      deliveryId,
      installationId: null,
      githubRepoId: null,
      deps: {
        applyRepoRoomEventToTask: async (taskProject, task) => {
          await db.updateTask(taskProject.id, task!.id, { status: "merged" });
          return { task, authoritative: true };
        },
      },
    });
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof Error && /^Invalid transition: \w+ → merged/.test(refused.message), String(refused));
  await db.markGitHubWebhookDeliveryProcessed(deliveryId, {
    status: "failed",
    room_id: roomId,
    error: refused.message,
  });
  return refused.message;
}

/**
 * A task with the merge stored against it and never applied. It is `at` this
 * status when the merge arrives, and `then` that one after it (the worker moves
 * on without knowing). It holds a work lease for the pull request.
 */
async function createStuckTask(
  context: WebhookIntegrationContext,
  roomId: string,
  number: number,
  input: { at?: "assigned" | "in_progress" | "blocked"; then?: "in_review"; link?: "pr_url" | "lease" } = {}
) {
  const at = input.at ?? "in_progress";
  const task = await createAssignedTask(context, roomId, `Stuck task ${number}`);
  if (at !== "assigned") await context.updateTask(roomId, task.id, { status: "in_progress" });
  if (at === "blocked") await context.updateTask(roomId, task.id, { status: "blocked" });
  if (input.link !== "lease") await context.updateTask(roomId, task.id, { pr_url: prUrl(number) });
  const lease = await createWorkLeaseForPr({
    roomId,
    taskId: task.id,
    prUrl: prUrl(number),
    branchRef: branchRef(number),
  });
  await pause();
  const deliveryId = `delivery-stuck-${number}`;
  await deliverBeforeTheFix(roomId, deliveryId, number);
  if (input.then) await context.updateTask(roomId, task.id, { status: input.then });
  return { task, lease, deliveryId };
}

/** An admin reopens a merged card. */
async function reopen(context: WebhookIntegrationContext, roomId: string, taskId: string) {
  await context.updateTask(roomId, taskId, { status: "accepted" });
  await context.updateTask(roomId, taskId, { status: "assigned" });
  await context.updateTask(roomId, taskId, { status: "in_progress" });
}

async function mergedMessageCount(roomId: string, taskId: string): Promise<number> {
  const { rows } = await pool!.query(
    "SELECT count(*)::int AS n FROM messages WHERE room_id = $1 AND sender = 'letagents' AND starts_with(text, $2)",
    [roomId, `[status] ${taskId} was merged:`]
  );
  return rows[0].n;
}

async function repairAuditCount(roomId: string, taskId: string): Promise<number> {
  const { rows } = await pool!.query(
    "SELECT count(*)::int AS n FROM coordination_events WHERE room_id = $1 AND task_id = $2 AND reason LIKE 'Repaired stored merge event%'",
    [roomId, taskId]
  );
  return rows[0].n;
}

async function statusOf(context: WebhookIntegrationContext, roomId: string, taskId: string) {
  return (await context.getTaskById(roomId, taskId))?.status;
}

/** Every row of every table, so a run that must change nothing can prove it. */
async function snapshotDatabase(): Promise<Record<string, string>> {
  const tables = await pool!.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
  );
  const snapshot: Record<string, string> = {};
  for (const { table_name: name } of tables.rows) {
    const { rows } = await pool!.query(
      `SELECT count(*)::text AS n, md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS h FROM "${name}" t`
    );
    snapshot[name] = `${rows[0].n}:${rows[0].h}`;
  }
  return snapshot;
}

const repairCommand = path.resolve(
  process.cwd(),
  "src/api/github/room-event-projection/repair-unapplied-merge-events.ts"
);

/** Runs the repair as an operator does: as its own process, with its arguments. */
async function runRepairCommand(args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", path.resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs"), repairCommand, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, DB_URL: process.env.TEST_DB_URL },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

/** The output line of one card. */
function lineOf(output: string, roomId: string, taskId: string): string | undefined {
  return output.split("\n").find((line) => line.startsWith(`${roomId} | ${taskId} | `));
}

function lineFields(line: string | undefined) {
  assert.ok(line, "the card has a line");
  const [roomId, taskId, title, status, pullRequest, merged, decision] = line.split(" | ");
  return { roomId, taskId, title, status, pullRequest, merged, decision };
}

function reportLine(
  report: Awaited<ReturnType<RepairModule["repairUnappliedMergeEvents"]>>,
  roomId: string,
  taskId: string
) {
  return report.lines.find((line) => line.roomId === roomId && line.taskId === taskId);
}

webhookIntegrationTest(
  "the repair moves the cards a refused merge left behind, only with --apply, and only once",
  async (context) => {
    const { createProjectWithName, getTaskById, port } = context;
    const room = await createRepoRoom(context);
    const otherRoom = await createProjectWithName(otherRepoRoomName);

    // Cards the old webhook left behind, one for each status the card can be in.
    const stuck = [
      { number: 2001, ...(await createStuckTask(context, room.id, 2001)), status: "in_progress" },
      { number: 2002, ...(await createStuckTask(context, room.id, 2002, { at: "assigned" })), status: "assigned" },
      { number: 2003, ...(await createStuckTask(context, room.id, 2003, { at: "blocked" })), status: "blocked" },
      { number: 2004, ...(await createStuckTask(context, room.id, 2004, { then: "in_review" })), status: "in_review" },
      // Linked through its work lease only: the task holds no link to the pull request.
      { number: 2005, ...(await createStuckTask(context, room.id, 2005, { link: "lease" })), status: "in_progress" },
    ];

    // Merges that applied normally: nothing to repair, in this room and in another.
    const applied = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Merged normally",
      prUrl: prUrl(2101),
      branchRef: branchRef(2101),
    });
    await deliver(port, "delivery-applied-2101", 2101);
    const appliedElsewhere = await createInReviewTaskWithLease(context, {
      roomId: otherRoom.id,
      title: "Merged normally in another room",
      prUrl: `${otherPullRequestBase}/2102`,
      branchRef: branchRef(2102),
    });
    await deliver(port, "delivery-applied-2102", 2102, { repo: "other" });
    assert.equal(await statusOf(context, room.id, applied.id), "merged");
    assert.equal(await statusOf(context, otherRoom.id, appliedElsewhere.id), "merged");

    // A lease that has run out but is still marked active. A dry run must leave
    // it alone: marking it expired is a write.
    const lapsed = await createAssignedTask(context, room.id, "Its lease ran out");
    const expiredLease = await context.createTaskLease({
      room_id: room.id,
      task_id: lapsed.id,
      kind: "work",
      agent_key: "EmmyMay/olivewolf",
      actor_label: "OliveWolf | EmmyMay's agent | Agent",
      created_by: "test",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    // Dry run: one line for each card, nothing changed anywhere.
    const before = await snapshotDatabase();
    const dry = await runRepairCommand();
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^Dry run: nothing is changed\. Add --apply to move the cards\./);
    for (const card of stuck) {
      const fields = lineFields(lineOf(dry.stdout, room.id, card.task.id));
      assert.equal(fields.title, JSON.stringify(`Stuck task ${card.number}`));
      assert.equal(fields.status, card.status);
      assert.equal(fields.pullRequest, prUrl(card.number));
      assert.match(fields.merged, /^merged \d{4}-\d\d-\d\dT/);
      assert.equal(fields.decision, "would move to merged");
    }
    assert.equal(lineOf(dry.stdout, room.id, applied.id), undefined, "a merged card is not a candidate");
    assert.match(dry.stdout, /Would move to merged: 5\./);
    assert.match(dry.stdout, /Dry run: nothing was changed\. Run again with --apply to move the cards\./);
    assert.deepEqual(await snapshotDatabase(), before, "a dry run changes nothing");
    const stillActive = await pool!.query("SELECT status FROM task_leases WHERE id = $1", [expiredLease.id]);
    assert.equal(stillActive.rows[0].status, "active");

    // Apply: the cards move, each with one status message, no agent prompt and an audit row.
    const appliedRun = await runRepairCommand(["--apply"]);
    assert.equal(appliedRun.code, 0, appliedRun.stderr);
    assert.match(appliedRun.stdout, /^Apply: moving the cards that a merge left behind\./);
    assert.match(appliedRun.stdout, /Moved to merged: 5\./);
    assert.match(appliedRun.stdout, /Failed: 0\./);
    for (const card of stuck) {
      assert.equal(lineFields(lineOf(appliedRun.stdout, room.id, card.task.id)).decision, "moved to merged");
      const merged = await getTaskById(room.id, card.task.id);
      assert.equal(merged?.status, "merged");
      assert.equal(await mergedMessageCount(room.id, card.task.id), 1);
      assert.equal(await repairAuditCount(room.id, card.task.id), 1);
      const messages = await pool!.query(
        "SELECT agent_prompt_kind, client_message_id FROM messages WHERE room_id = $1 AND starts_with(text, $2)",
        [room.id, `[status] ${card.task.id} was merged:`]
      );
      assert.equal(messages.rows[0].agent_prompt_kind, null, "no agent turn starts");
      assert.match(messages.rows[0].client_message_id, /^github-event:[0-9a-f]{64}:task-status$/);
    }
    // The cards that applied normally were not touched.
    assert.equal(await mergedMessageCount(room.id, applied.id), 1);
    assert.equal(await repairAuditCount(room.id, applied.id), 0);
    assert.equal(await mergedMessageCount(otherRoom.id, appliedElsewhere.id), 1);
    assert.equal(await repairAuditCount(otherRoom.id, appliedElsewhere.id), 0);

    // Again: nothing changes and nothing is posted.
    const afterApply = await snapshotDatabase();
    const again = await runRepairCommand(["--apply"]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Cards a merge could have left behind: 0\./);
    assert.match(again.stdout, /Moved to merged: 0\./);
    assert.deepEqual(await snapshotDatabase(), afterApply, "a second run changes nothing");

    // An admin reopens a card the repair moved. The status message the repair
    // posted shows that the merge applied, so the next run leaves the card alone.
    await reopen(context, room.id, stuck[0].task.id);
    const reopenedRun = await runRepairCommand(["--apply"]);
    assert.match(
      lineFields(lineOf(reopenedRun.stdout, room.id, stuck[0].task.id)).decision,
      /^skipped: cannot prove it was never applied/
    );
    assert.equal(await statusOf(context, room.id, stuck[0].task.id), "in_progress");

    // GitHub sends a failed delivery again after the repair: the card ends merged, with one message.
    // (For the reopened card this is what the live webhook does with a delivery sent again.)
    for (const card of stuck) {
      await deliver(port, card.deliveryId, card.number);
      assert.equal(await statusOf(context, room.id, card.task.id), "merged");
      assert.equal(await mergedMessageCount(room.id, card.task.id), 1);
    }
    const afterRedelivery = await runRepairCommand(["--apply"]);
    assert.match(afterRedelivery.stdout, /Moved to merged: 0\./);
  }
);

webhookIntegrationTest(
  "the repair leaves a card alone when the merge may have applied before, as when an admin reopened it",
  async (context) => {
    const { getTaskById, port } = context;
    const db = required(dbModule);
    const { repairUnappliedMergeEvents } = required(repairModule);
    const room = await createRepoRoom(context);

    // The merge applied normally, then an admin reopened the card: it is back in
    // progress, and the stored event is still linked to it.
    const reopened = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Reopened after the merge applied",
      prUrl: prUrl(2201),
      branchRef: branchRef(2201),
    });
    await deliver(port, "delivery-applied-2201", 2201);
    assert.equal(await statusOf(context, room.id, reopened.id), "merged");
    await reopen(context, room.id, reopened.id);

    // The same, and GitHub then sent the delivery again while the board still
    // refused the move: the delivery reads as failed on the refused merge.
    const resent = await createInReviewTaskWithLease(context, {
      roomId: room.id,
      title: "Reopened, delivery sent again",
      prUrl: prUrl(2202),
      branchRef: branchRef(2202),
    });
    await deliver(port, "delivery-applied-2202", 2202);
    await reopen(context, room.id, resent.id);
    let refused: unknown;
    try {
      await db.updateTask(room.id, resent.id, { status: "merged" });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused instanceof Error);
    await db.markGitHubWebhookDeliveryProcessed("delivery-applied-2202", { status: "failed", error: refused.message });

    // The merge was stuck, and a person marked the card merged by hand, with the
    // status message the task route posts. Later an admin reopened it.
    const byHand = await createStuckTask(context, room.id, 2203);
    await context.updateTask(room.id, byHand.task.id, { status: "in_review" });
    const handMerged = await context.updateTask(room.id, byHand.task.id, { status: "merged" });
    await required(roomServicesModule).emitTaskLifecycleStatusMessage(room.id, handMerged!);
    await reopen(context, room.id, byHand.task.id);

    // The delivery never finished: the process stopped after it stored the event.
    const crashed = await createStuckTask(context, room.id, 2204);
    await pool!.query(
      "UPDATE github_webhook_deliveries SET status = 'received', error = NULL, processed_at = NULL WHERE delivery_id = $1",
      [crashed.deliveryId]
    );
    // The delivery failed on something other than the refused merge.
    const failedElsewhere = await createStuckTask(context, room.id, 2205);
    await pool!.query(
      "UPDATE github_webhook_deliveries SET error = 'connection terminated unexpectedly' WHERE delivery_id = $1",
      [failedElsewhere.deliveryId]
    );
    // No record of the delivery.
    const unrecorded = await createStuckTask(context, room.id, 2206);
    await pool!.query("DELETE FROM github_webhook_deliveries WHERE delivery_id = $1", [unrecorded.deliveryId]);

    // A card the merge never reached: the repair does its work here.
    const control = await createStuckTask(context, room.id, 2299);

    const untouched = [
      { task: crashed.task, reason: "its delivery was received" },
      { task: failedElsewhere.task, reason: "its delivery failed on something else: connection terminated unexpectedly" },
      { task: unrecorded.task, reason: "its delivery is not recorded" },
      { task: reopened, reason: "its delivery was processed" },
      { task: resent, reason: "its status message was posted" },
      { task: byHand.task, reason: "the task was marked merged after the event arrived" },
    ];
    const messageCountsBefore = await Promise.all(untouched.map(({ task }) => mergedMessageCount(room.id, task.id)));
    const report = await repairUnappliedMergeEvents({ apply: true });

    for (const { task, reason } of untouched) {
      const line = reportLine(report, room.id, task.id);
      assert.deepEqual(
        line?.decision,
        { kind: "skipped", reason: `cannot prove it was never applied (${reason})` },
        task.title
      );
      assert.equal(await statusOf(context, room.id, task.id), "in_progress", task.title);
      assert.equal(await repairAuditCount(room.id, task.id), 0, task.title);
    }
    assert.deepEqual(
      await Promise.all(untouched.map(({ task }) => mergedMessageCount(room.id, task.id))),
      messageCountsBefore,
      "nothing is posted for a card that was left alone"
    );

    assert.deepEqual(reportLine(report, room.id, control.task.id)?.decision, { kind: "moved" });
    assert.equal((await getTaskById(room.id, control.task.id))?.status, "merged");
  }
);

webhookIntegrationTest(
  "the repair leaves a card whose pull request changed after the merge, and one that needs a person",
  async (context) => {
    const { port } = context;
    const db = required(dbModule);
    const { repairUnappliedMergeEvents } = required(repairModule);
    const room = await createRepoRoom(context);

    // The pull request was reopened after the merge was stored.
    const reopenedPr = await createStuckTask(context, room.id, 2301);
    await pause();
    await deliver(port, "delivery-reopened-2301", 2301, { action: "reopened", merged: false });

    // The worker let go of its lease after the merge: nobody holds the work.
    const noLease = await createStuckTask(context, room.id, 2302);
    await db.revokeTaskLease(room.id, noLease.lease.id, "the worker let go of the task");

    // The task is locked.
    const locked = await createStuckTask(context, room.id, 2303);
    await db.createTaskLock({
      room_id: room.id,
      scope: "task",
      task_id: locked.task.id,
      reason: "human_stop",
      created_by: "test",
    });

    // The merge is dated before the task existed: it cannot be this task's work.
    const early = await createStuckTask(context, room.id, 2304);
    const created = (await context.getTaskById(room.id, early.task.id))!.created_at;
    await pool!.query(
      "UPDATE github_room_events SET event_order_at = $1 WHERE github_object_url = $2 AND action = 'closed'",
      [new Date(Date.parse(created) - 86_400_000).toISOString(), prUrl(2304)]
    );

    // The pull request link moved to another task after the merge: the event
    // was linked to the first one, and the repair does not hand it to the other.
    const movedFrom = await createStuckTask(context, room.id, 2305);
    const movedTo = await createAssignedTask(context, room.id, "Holds the link now");
    await context.updateTask(room.id, movedFrom.task.id, { pr_url: prUrl(2398) });
    await context.updateTask(room.id, movedTo.id, { status: "in_progress", pr_url: prUrl(2305) });

    // A person cancelled the card after the merge was stored.
    const cancelled = await createStuckTask(context, room.id, 2306);
    await context.updateTask(room.id, cancelled.task.id, { status: "cancelled" });

    const control = await createStuckTask(context, room.id, 2399);

    const messagesBefore = await pool!.query("SELECT count(*)::int AS n FROM messages WHERE room_id = $1", [room.id]);
    const report = await repairUnappliedMergeEvents({ apply: true });

    assert.deepEqual(reportLine(report, room.id, reopenedPr.task.id)?.decision, {
      kind: "skipped",
      reason: "the pull request has a newer stored event (reopened)",
    });
    assert.deepEqual(reportLine(report, room.id, noLease.task.id)?.decision, {
      kind: "skipped",
      reason: "needs a person (no active work lease)",
    });
    assert.deepEqual(reportLine(report, room.id, locked.task.id)?.decision, {
      kind: "skipped",
      reason: "needs a person (the task is locked)",
    });
    assert.deepEqual(reportLine(report, room.id, early.task.id)?.decision, {
      kind: "skipped",
      reason: "the task was created after the pull request merged",
    });
    // Cards the event does not belong to, or that a person ended, are no candidates and have no line.
    for (const task of [movedFrom.task, movedTo, cancelled.task]) {
      assert.equal(reportLine(report, room.id, task.id), undefined, task.title);
    }
    assert.equal(await statusOf(context, room.id, movedFrom.task.id), "in_progress");
    assert.equal(await statusOf(context, room.id, movedTo.id), "in_progress");
    assert.equal(await statusOf(context, room.id, cancelled.task.id), "cancelled");
    for (const { task } of [reopenedPr, noLease, locked, early]) {
      assert.equal(await statusOf(context, room.id, task.id), "in_progress", task.title);
      assert.equal(await mergedMessageCount(room.id, task.id), 0, task.title);
      assert.equal(await repairAuditCount(room.id, task.id), 0, task.title);
    }
    // Nothing is posted for them either, not even the live path's note about an unleased projection.
    const messagesAfter = await pool!.query("SELECT count(*)::int AS n FROM messages WHERE room_id = $1", [room.id]);
    assert.equal(messagesAfter.rows[0].n, messagesBefore.rows[0].n + 1, "only the control's status message is new");

    assert.deepEqual(reportLine(report, room.id, control.task.id)?.decision, { kind: "moved" });
    assert.equal(await statusOf(context, room.id, control.task.id), "merged");
  }
);

webhookIntegrationTest(
  "one card that fails does not stop the repair, and the failure is named",
  async (context) => {
    const { getTaskById } = context;
    const { repairUnappliedMergeEvents } = required(repairModule);
    const room = await createRepoRoom(context);

    // The first card in line refuses the write to merged.
    const refused = await createStuckTask(context, room.id, 2401);
    const second = await createStuckTask(context, room.id, 2402);
    const third = await createStuckTask(context, room.id, 2403);
    await pool!.query(`
      CREATE FUNCTION refuse_merged_task() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'merged refused'; END $$ LANGUAGE plpgsql`);
    await pool!.query(`
      CREATE TRIGGER refuse_merged_task BEFORE UPDATE ON tasks
        FOR EACH ROW WHEN (NEW.status = 'merged' AND NEW.title = 'Stuck task 2401')
        EXECUTE FUNCTION refuse_merged_task()`);

    const report = await repairUnappliedMergeEvents({ apply: true });
    const failure = reportLine(report, room.id, refused.task.id)?.decision;
    assert.equal(failure?.kind, "failed");
    assert.match(failure.kind === "failed" ? failure.error : "", /merged refused/);
    assert.equal((await getTaskById(room.id, refused.task.id))?.status, "in_progress");
    assert.equal(await repairAuditCount(room.id, refused.task.id), 0);
    for (const { task } of [second, third]) {
      assert.deepEqual(reportLine(report, room.id, task.id)?.decision, { kind: "moved" });
      assert.equal((await getTaskById(room.id, task.id))?.status, "merged");
    }

    // The command names the failure and exits with an error.
    const run = await runRepairCommand(["--apply"]);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /Failed: 1\./);
    assert.match(run.stdout, new RegExp(`${room.id} ${refused.task.id}: .*merged refused`));
    assert.match(run.stdout, /Moved to merged: 0\./);

    // An argument it does not know is refused before it touches anything.
    const unknown = await runRepairCommand(["--aply"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown argument: --aply/);
  }
);
