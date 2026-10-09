import {
  findTaskByPrUrl,
  findTaskByWorkflowArtifactMatches,
  getActiveTaskLocks,
  getFocusRoomsForParent,
  getProjectById,
  getTaskById,
  isValidTransition,
  type GitHubRoomEvent,
  type Task,
  type TaskStatus,
} from "../../db.js";
import {
  getGitHubWebhookDelivery,
  getMergeApplicationTraces,
  getNewestPullRequestRoomEvent,
  listLinkedPullRequestMergeEvents,
  readActiveTaskLeases,
} from "../../db/github/merge-event-repair.js";
import {
  evaluateWorkflowArtifactMutation,
  isActiveCoordinationLease,
  leaseMatchesWorkflowArtifact,
} from "../../coordination-policy.js";
import { projectRepoRoomEvent } from "../../repo-workflow.js";
import { recordCoordinationDecision } from "../../server/room-services.js";
import { formatTaskLifecycleStatus } from "../../tasks/lifecycle-status.js";
import {
  createRepoRoomEventTaskResolver,
  toGitHubRoutingContext,
} from "../repo-event-task-resolution.js";
import { syncRoomSharedArtifactsForGitHubRoomEvent } from "../room-event-artifacts.js";
import { rehydratePullRequestRoomEvent } from "../room-events.js";
import { githubProjectionMessageIdBase } from "../room-event-projection.js";
import { applyRepoRoomEventToTask, getProjectForResolvedTask } from "./task-projection.js";

// Until the live webhook learned to move a task that is still assigned or in
// progress when its pull request merges, such a merge threw "Invalid
// transition", the webhook answered 500, and the stored merge event kept its
// link to the task although the task never moved. Nothing sends those events
// again: the stored merge replay only reads events that have no task.
//
// This repairs them once, by an operator. It does what a GitHub redelivery of
// the old delivery does today: the stored merge goes through the live
// projection, so the work lease check and every live rule still decide.

/** The statuses a merge that never applied can have left the card in. */
const REPAIRABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
]);

/**
 * What the route stored when the old projection refused the merge. `updateTask`
 * words it "Invalid transition: <status> → merged. Allowed: ...".
 */
const REFUSED_MERGE_ERROR = /^Invalid transition: (?:assigned|in_progress|blocked) (?:→|->) merged(?:\.|$)/;

const REPAIR_ACTOR_LABEL = "repair-unapplied-merge-events";

export type MergeRepairDecision =
  | { kind: "would_move" }
  /** `artifactSyncError`: the card moved, but its shared pull request artifact could not be brought to merged. */
  | { kind: "moved"; artifactSyncError?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export interface MergeRepairLine {
  roomId: string;
  taskId: string;
  title: string;
  status: TaskStatus | "-";
  prUrl: string;
  mergedAt: string;
  decision: MergeRepairDecision;
}

export interface MergeRepairReport {
  apply: boolean;
  /** The stored merge events a task holds, all of which were looked at. */
  checked: number;
  /** One line for each card an event could have left behind. */
  lines: MergeRepairLine[];
}

/** The time as UTC, whatever zone the database session reports it in. */
function toIsoTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** The database error under a failed query, not the query: its text carries task content. */
export function describeError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatMergeRepairLine(line: MergeRepairLine): string {
  const decision = (() => {
    switch (line.decision.kind) {
      case "would_move": return "would move to merged";
      case "moved": return line.decision.artifactSyncError === undefined
        ? "moved to merged"
        : `moved to merged, but the shared artifact was not synced: ${shorten(line.decision.artifactSyncError, 200)}`;
      case "skipped": return `skipped: ${line.decision.reason}`;
      case "failed": return `failed: ${shorten(line.decision.error, 200)}`;
    }
  })();
  return [
    line.roomId,
    line.taskId,
    JSON.stringify(shorten(line.title, 60)),
    line.status,
    line.prUrl,
    `merged ${line.mergedAt}`,
    decision,
  ].join(" | ");
}

export function summarizeMergeRepair(report: MergeRepairReport): string[] {
  const count = (kind: MergeRepairDecision["kind"]) =>
    report.lines.filter((line) => line.decision.kind === kind).length;
  const skipped = new Map<string, number>();
  for (const line of report.lines) {
    if (line.decision.kind !== "skipped") continue;
    // Group by the reason, without the detail in brackets.
    const reason = line.decision.reason.replace(/ \(.*\)$/, "");
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  }

  const unsynced = report.lines.filter((line) =>
    line.decision.kind === "moved" && line.decision.artifactSyncError !== undefined);
  const lines = [
    `Looked at ${report.checked} stored merge event${report.checked === 1 ? "" : "s"} that a task holds.`,
    `Cards a merge could have left behind: ${report.lines.length}.`,
    report.apply
      ? `Moved to merged: ${count("moved")}.`
      : `Would move to merged: ${count("would_move")}.`,
    `Skipped: ${count("skipped")}.`,
    ...[...skipped].map(([reason, total]) => `  ${total} skipped: ${reason}`),
    `Failed: ${count("failed")}.`,
  ];
  for (const line of report.lines) {
    if (line.decision.kind === "failed") {
      lines.push(`  ${line.roomId} ${line.taskId}: ${shorten(line.decision.error, 200)}`);
    }
  }
  if (unsynced.length > 0) {
    lines.push(`Moved, but the shared artifact was not synced: ${unsynced.length}.`);
    for (const line of unsynced) {
      const error = line.decision.kind === "moved" ? line.decision.artifactSyncError ?? "" : "";
      lines.push(`  ${line.roomId} ${line.taskId}: ${shorten(error, 200)}`);
    }
  }
  if (!report.apply) {
    lines.push("Dry run: nothing was changed. Run again with --apply to move the cards.");
  }
  return lines;
}

/**
 * The live resolver of the task a pull request event belongs to, with one
 * difference: its work lease search does not mark expired leases as expired,
 * which `getActiveTaskLeases` does. A dry run must not write.
 */
const { resolveLinkedTaskForRepoRoomEvent } = createRepoRoomEventTaskResolver({
  findTaskByWorkflowArtifactMatches,
  findTaskByPrUrl,
  findTaskByActiveWorkflowLease: async (projectId, workflow) => {
    const findTaskInRoom = async (roomId: string): Promise<Task | undefined> => {
      const lease = (await readActiveTaskLeases(roomId)).find((candidate) =>
        candidate.kind === "work" &&
        isActiveCoordinationLease(candidate) &&
        leaseMatchesWorkflowArtifact({
          lease: candidate,
          prUrl: workflow.prUrl,
          branchRef: workflow.branchRef,
        })
      );
      return lease ? getTaskById(roomId, lease.task_id) : undefined;
    };

    const parentTask = await findTaskInRoom(projectId);
    if (parentTask) return parentTask;
    for (const focusRoom of await getFocusRoomsForParent(projectId)) {
      if (focusRoom.focus_status === "concluded") continue;
      const focusTask = await findTaskInRoom(focusRoom.id);
      if (focusTask) return focusTask;
    }
    return undefined;
  },
  getTaskById,
});

/**
 * A reason to leave the event alone when it may have been applied before, or
 * null when it never was. Three things must hold:
 *
 *   1. The delivery that stored the event is recorded as failed on the refused
 *      merge. The route marks a delivery processed when the handler finishes and
 *      failed only when it throws, so a processed delivery is one whose merge
 *      applied (or had nothing to apply), and one that failed on anything else
 *      may have applied the merge before it failed.
 *   2. The status message the live projection posts for this event does not
 *      exist. It has a fixed id, and the projection posts it right after it
 *      moves the task. Without this check, an admin's reopen of a card that the
 *      merge had moved, followed by a GitHub redelivery that the old code
 *      refused, would look like a stuck card.
 *   3. No "was merged" status message of this task was posted since the event
 *      arrived. A person can mark a stuck card merged by hand, and a later
 *      reopen of that card is a decision this repair must not undo.
 */
async function whyItMayHaveBeenApplied(input: {
  stored: GitHubRoomEvent;
  task: Task;
}): Promise<string | null> {
  const { stored, task } = input;
  if (!stored.delivery_id) return "its delivery is not recorded";
  const delivery = await getGitHubWebhookDelivery(stored.delivery_id);
  if (!delivery) return "its delivery is not recorded";
  if (delivery.status !== "failed") return `its delivery was ${delivery.status}`;
  if (!REFUSED_MERGE_ERROR.test(delivery.error ?? "")) {
    return `its delivery failed on something else: ${shorten(delivery.error ?? "no error text", 80)}`;
  }

  const traces = await getMergeApplicationTraces({
    task_room_id: task.room_id,
    event_room_id: stored.room_id,
    status_message_client_id: `${githubProjectionMessageIdBase(stored)}:task-status`,
    merged_message_prefix: formatTaskLifecycleStatus({
      id: task.id,
      title: "",
      status: "merged",
      assignee: null,
    }).trim(),
    since: stored.created_at,
  });
  if (traces.status_message_posted) return "its status message was posted";
  if (traces.merged_message_posted_since) return "the task was marked merged after the event arrived";
  return null;
}

type Examined = { card: Omit<MergeRepairLine, "decision"> } & (
  /** The reason the card stays where it is. */
  | { skip: string }
  /** Moves the card. */
  | { move: () => Promise<{ artifactSyncError?: string }> }
);

/** Reads only. Null when the event cannot have left a card behind. */
async function examineEvent(stored: GitHubRoomEvent): Promise<Examined | null> {
  const event = rehydratePullRequestRoomEvent(stored);
  if (!event || event.action !== "closed" || !event.pullRequest.merged) return null;

  // The live webhook looked for the task from the repo room.
  const eventRoom = stored.room_id ? await getProjectById(stored.room_id) : null;
  const repoRoom = eventRoom?.parent_room_id
    ? await getProjectById(eventRoom.parent_room_id)
    : eventRoom;
  if (!repoRoom) return null;

  // The task the event goes to today, and only if it is the task it was linked to.
  const resolution = await resolveLinkedTaskForRepoRoomEvent(repoRoom, event);
  const task = resolution.task;
  if (!task || task.id !== stored.linked_task_id || !REPAIRABLE_STATUSES.has(task.status)) return null;

  const card = {
    roomId: task.room_id,
    taskId: task.id,
    title: task.title,
    status: task.status,
    prUrl: event.pullRequest.url,
    mergedAt: toIsoTime(stored.event_order_at),
  };
  const skipped = (reason: string): Examined => ({ card, skip: reason });

  // A card that points at another pull request is not waiting for this merge:
  // its pull request was reverted and redone, say. The resolver can still reach
  // it through its work lease, which matches by branch.
  if (task.pr_url && task.pr_url !== event.pullRequest.url) {
    return skipped(`the card now points at another pull request (${task.pr_url})`);
  }

  // A merge from before the task existed cannot be the task's work.
  if (!(Date.parse(stored.event_order_at) >= Date.parse(task.created_at))) {
    return skipped("the task was created after the pull request merged");
  }

  // Only the latest stored state of the pull request counts: one reopened or
  // closed since is no merge.
  const newest = await getNewestPullRequestRoomEvent(event.pullRequest.url);
  if (newest && newest.id !== stored.id) {
    return skipped(`the pull request has a newer stored event (${newest.action})`);
  }

  const applied = await whyItMayHaveBeenApplied({ stored, task });
  if (applied) return skipped(`cannot prove it was never applied (${applied})`);

  const projected = projectRepoRoomEvent({ event, currentStatus: task.status });
  if (!projected || !isValidTransition(task.status, projected.newStatus as TaskStatus, { githubEvent: true })) {
    return skipped(`the live rules do not move a card in ${task.status}`);
  }

  const taskRoom = await getProjectForResolvedTask(repoRoom, task);
  const [leases, locks] = await Promise.all([
    readActiveTaskLeases(taskRoom.id, task.id),
    getActiveTaskLocks(taskRoom.id, task.id),
  ]);
  const decision = evaluateWorkflowArtifactMutation({
    mutation: "webhook_projection",
    taskId: task.id,
    prUrl: event.pullRequest.url,
    branchRef: event.pullRequest.headRef,
    leases,
    locks,
  });
  if (decision.kind === "deny") {
    return skipped(decision.code === "active_lock"
      ? "needs a person (the task is locked)"
      : "needs a person (no active work lease)");
  }

  return {
    card,
    move: async () => {
      // No installation id: the live path's GitHub check run is skipped, so
      // the repair makes no GitHub call. A merge starts no agent turn: the
      // live projection posts its status message without an agent prompt.
      const projection = await applyRepoRoomEventToTask(taskRoom, task, event, {
        installationId: null,
        githubRoutingContext: toGitHubRoutingContext(resolution),
        messageIdBase: githubProjectionMessageIdBase(stored),
      });
      if (!projection.authoritative || projection.task?.status !== projected.newStatus) {
        throw new Error("the live projection did not move the card");
      }
      await recordCoordinationDecision({
        roomId: taskRoom.id,
        taskId: task.id,
        mutation: "webhook_projection",
        decision: "allow",
        actorLabel: REPAIR_ACTOR_LABEL,
        actorKey: null,
        actorInstanceId: null,
        reason: `Repaired stored merge event ${stored.id} of ${event.pullRequest.url}: `
          + `the webhook refused it and left the card in ${task.status}.`,
        leaseId: decision.lease.id,
      });

      // The live handler brings the room's shared artifact for the pull request
      // to merged after the card; the refused delivery never got there. The card
      // has moved, so a failure here is reported on its line and nothing is undone.
      try {
        if (stored.room_id) {
          await syncRoomSharedArtifactsForGitHubRoomEvent({
            room_id: stored.room_id,
            event: { ...stored, roomEvent: event },
            linked_task_id: task.id,
          });
        }
        return {};
      } catch (error) {
        return { artifactSyncError: describeError(error) };
      }
    },
  };
}

/**
 * Finds the merge events that a task holds and that were never applied, and
 * moves their cards to merged when `apply` is set. A dry run reads only. One
 * card that fails does not stop the others.
 */
export async function repairUnappliedMergeEvents(options: {
  apply: boolean;
  log?: (line: string) => void;
}): Promise<MergeRepairReport> {
  const log = options.log ?? (() => {});
  const events = await listLinkedPullRequestMergeEvents();
  const report: MergeRepairReport = { apply: options.apply, checked: events.length, lines: [] };

  log(options.apply
    ? "Apply: moving the cards that a merge left behind."
    : "Dry run: nothing is changed. Add --apply to move the cards.");
  const record = (line: MergeRepairLine) => {
    report.lines.push(line);
    log(formatMergeRepairLine(line));
  };
  const failure = (error: unknown): MergeRepairDecision => ({ kind: "failed", error: describeError(error) });

  for (const stored of events) {
    let examined: Examined | null;
    try {
      examined = await examineEvent(stored);
    } catch (error) {
      // The card is not known when the failure comes before it was read.
      record({
        roomId: stored.room_id ?? "-",
        taskId: stored.linked_task_id ?? "-",
        title: "-",
        status: "-",
        prUrl: stored.github_object_url ?? "-",
        mergedAt: toIsoTime(stored.event_order_at),
        decision: failure(error),
      });
      continue;
    }
    if (!examined) continue;

    if ("skip" in examined) {
      record({ ...examined.card, decision: { kind: "skipped", reason: examined.skip } });
    } else if (!options.apply) {
      record({ ...examined.card, decision: { kind: "would_move" } });
    } else {
      try {
        record({ ...examined.card, decision: { kind: "moved", ...(await examined.move()) } });
      } catch (error) {
        record({ ...examined.card, decision: failure(error) });
      }
    }
  }
  return report;
}
