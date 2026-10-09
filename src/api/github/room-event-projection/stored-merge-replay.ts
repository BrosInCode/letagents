import {
  claimGitHubRoomEventForTask,
  getActiveTaskLeases,
  getActiveTaskLocks,
  getLatestPullRequestRoomEvent,
  getProjectById,
  getTaskById,
  isValidTransition,
  releaseGitHubRoomEventFromTask,
  type GitHubRoomEvent,
  type Project,
  type Task,
  type TaskStatus,
} from "../../db.js";
import { evaluateWorkflowArtifactMutation } from "../../coordination-policy.js";
import {
  projectPullRequestEvent,
  projectRepoRoomEvent,
} from "../../repo-workflow.js";
import { recordCoordinationDecision } from "../../server/room-services.js";
import { toGitHubRoutingContext } from "../repo-event-task-resolution.js";
import { rehydratePullRequestRoomEvent } from "../room-events.js";
import {
  emitGitHubRoomEventUpdate,
  githubProjectionMessageIdBase,
} from "../room-event-projection.js";
import { applyRepoRoomEventToTask } from "./task-projection.js";
import { resolveLinkedTaskForRepoRoomEvent } from "./task-resolver.js";

/** The pull requests a task points at: its link, its pull request artifacts, its work leases. */
function linkedPullRequestUrls(
  task: Task,
  leases: ReadonlyArray<{ kind: string; pr_url?: string | null }>
): string[] {
  const urls = [
    task.pr_url,
    ...task.workflow_artifacts
      .filter((artifact) => artifact.kind === "pull_request")
      .map((artifact) => artifact.url),
    ...leases.filter((lease) => lease.kind === "work").map((lease) => lease.pr_url),
  ];
  return [...new Set(urls.map((url) => url?.trim()).filter((url): url is string => Boolean(url)))];
}

async function replayStoredEvent(input: {
  project: Project;
  repoProject: Project;
  task: Task;
  stored: GitHubRoomEvent;
  actorLabel: string | null;
}): Promise<Task | null> {
  const { project, repoProject, task, stored } = input;
  // A linked event already had its turn: the live path applied it to that task.
  if (stored.linked_task_id) return null;

  const event = rehydratePullRequestRoomEvent(stored);
  if (!event || event.action !== "closed" || !event.pullRequest.merged) return null;
  // A merge from before the task existed cannot be the task's work.
  if (!(Date.parse(stored.event_order_at) >= Date.parse(task.created_at))) return null;

  const projected = projectRepoRoomEvent({ event, currentStatus: task.status });
  if (!projected || !isValidTransition(task.status, projected.newStatus as TaskStatus, { githubEvent: true })) return null;

  // The live resolver, so the event goes to the one task it would have gone to.
  const resolution = await resolveLinkedTaskForRepoRoomEvent(repoProject, event);
  if (resolution.task?.room_id !== task.room_id || resolution.task.id !== task.id) return null;

  const [leases, locks] = await Promise.all([
    getActiveTaskLeases(project.id, task.id),
    getActiveTaskLocks(project.id, task.id),
  ]);
  const decision = evaluateWorkflowArtifactMutation({
    mutation: "webhook_projection",
    taskId: task.id,
    prUrl: event.pullRequest.url,
    branchRef: event.pullRequest.headRef,
    leases,
    locks,
  });
  if (decision.kind === "deny") return null;

  if (!(await claimGitHubRoomEventForTask(stored.id, task.id))) return null;
  try {
    await recordCoordinationDecision({
      roomId: project.id,
      taskId: task.id,
      mutation: "webhook_projection",
      decision: "allow",
      actorLabel: input.actorLabel,
      actorKey: null,
      actorInstanceId: null,
      reason: `Replayed stored merge event ${stored.id} of ${event.pullRequest.url} after it was linked to ${task.id}.`,
      leaseId: decision.lease.id,
    });
    // With no installation id, the live path's GitHub check run is skipped:
    // a replay makes no GitHub call.
    const projection = await applyRepoRoomEventToTask(project, task, event, {
      installationId: null,
      githubRoutingContext: toGitHubRoutingContext(resolution),
      messageIdBase: githubProjectionMessageIdBase(stored),
    });
    if (!projection.authoritative || !projection.task || projection.task.status !== projected.newStatus) {
      await releaseGitHubRoomEventFromTask(stored.id, task.id);
      return null;
    }
    if (stored.room_id) {
      emitGitHubRoomEventUpdate(stored.room_id, { ...stored, linked_task_id: task.id });
    }
    return projection.task;
  } catch (error) {
    // Keep the link only once the task shows the merge, so the event is not
    // applied twice. In every other case the next replay must be able to try.
    const current = await getTaskById(project.id, task.id).catch(() => undefined);
    if (current?.status !== projected.newStatus) {
      await releaseGitHubRoomEventFromTask(stored.id, task.id).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * A pull request that merged before it was linked to a task never moved the
 * task: the webhook found no task to move. Once the task holds the link, this
 * runs the stored merge through the live projection, lease check included, so
 * the task moves as it would have had the link been there. It reads only the
 * room's stored webhook events and changes nothing a live merge could not.
 * Returns the task when it moved, null when nothing applied.
 */
export async function replayStoredPullRequestMergeForTask(input: {
  project: Project;
  task: Task;
  actorLabel: string | null;
}): Promise<Task | null> {
  const task = await getTaskById(input.project.id, input.task.id);
  if (!task) return null;

  // Cheap exit for the many task writes that no merge could follow.
  const wouldMerge = projectPullRequestEvent({
    action: "closed",
    merged: true,
    currentStatus: task.status,
  });
  if (!wouldMerge || !isValidTransition(task.status, wouldMerge.newStatus as TaskStatus, { githubEvent: true })) return null;

  const urls = linkedPullRequestUrls(task, await getActiveTaskLeases(input.project.id, task.id));
  if (urls.length === 0) return null;

  const repoRoomId = input.project.parent_room_id ?? input.project.id;
  const repoProject = repoRoomId === input.project.id
    ? input.project
    : await getProjectById(repoRoomId);
  if (!repoProject) return null;

  for (const url of urls) {
    // Only the PR's latest stored state counts: a PR closed or reopened since is no merge.
    const stored = await getLatestPullRequestRoomEvent({
      repo_room_id: repoProject.id,
      task_room_id: input.project.id,
      github_object_url: url,
    });
    if (!stored) continue;
    const moved = await replayStoredEvent({
      project: input.project,
      repoProject,
      task,
      stored,
      actorLabel: input.actorLabel,
    });
    if (moved) return moved;
  }
  return null;
}
