import { ApiError } from "../../../../shared/api/core.mjs";
import { getTask, listTasks, type Task as ApiTask, type TaskWorker } from "../../../../shared/api/tasks.mjs";
import { pullRequestsFor, pullRequestUrl } from "../../connectors/my-work.js";
import { getActiveTaskLeases, getTaskById, getTasks, getTasksGitHubArtifactStatus, type Task, type TaskLease } from "../../db.js";
import { defineRoute, type ApiRoute } from "../route.js";
import { toPullRequestLink } from "./git.js";

// Routes for the methods in shared/api/tasks.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listTasks, async ({ status, after, limit }, { room }) => {
    const page = await getTasks(room.id, status, { after, limit });
    const tasks = await toApiTasks(room.id, page.tasks);
    return { tasks, nextAfter: page.has_more ? tasks.at(-1)?.id ?? null : null };
  }),
  defineRoute(getTask, async ({ taskId }, { room }) => {
    const task = await getTaskById(room.id, taskId);
    if (!task) throw new ApiError("not_found", "No task with this id in this room.");
    const [result] = await toApiTasks(room.id, [task]);
    return result!;
  }),
];

/** Reviewers and pull request state for a page of tasks: one read of each, not one per task. */
async function toApiTasks(roomId: string, tasks: readonly Task[]): Promise<ApiTask[]> {
  if (!tasks.length) return [];
  const [leases, prStatus] = await Promise.all([
    getActiveTaskLeases(roomId),
    getTasksGitHubArtifactStatus(roomId, tasks.map((task) => Number(task.id.slice("task_".length)))),
  ]);
  return tasks.map((task) => toApiTask(task, leases, prStatus.get(task.id)));
}

/**
 * A pull request Jev only suggested is not the task's until a person confirms
 * it, so neither its link nor its GitHub state shows (as in the release queue).
 */
function confirmedPullRequests(task: Task, prStatus: Parameters<typeof pullRequestsFor>[1]) {
  const artifacts = task.workflow_artifacts.filter((artifact) => artifact.linked_by !== "jev_suggested");
  const urls = new Set([task.pr_url, ...artifacts.filter((artifact) => artifact.kind === "pull_request").map((artifact) => artifact.url ?? null)]
    .map(pullRequestUrl).filter(Boolean));
  const status = prStatus?.pr_url && urls.has(pullRequestUrl(prStatus.pr_url)) ? prStatus : undefined;
  return pullRequestsFor({ pr_url: task.pr_url, workflow_artifacts: artifacts }, status);
}

function toApiTask(task: Task, leases: readonly TaskLease[], prStatus: Parameters<typeof pullRequestsFor>[1]): ApiTask {
  const reviewers = leases
    .filter((lease) => lease.task_id === task.id && lease.kind === "review")
    .map((lease): TaskWorker => ({ name: lease.actor_label, agentKey: lease.agent_key }));
  const separator = task.external_ref?.indexOf(":") ?? -1;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    assignee: task.assignee ? { name: task.assignee, agentKey: task.assignee_agent_key } : null,
    reviewers,
    createdBy: task.created_by,
    externalRef: task.external_ref,
    ticketKey: task.external_ref && separator > 0 ? task.external_ref.slice(separator + 1) : null,
    ticketState: task.ticket_state,
    pullRequests: confirmedPullRequests(task, prStatus).map(toPullRequestLink),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}
