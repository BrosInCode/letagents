import type { Task } from "./db.js";
import type { FocusGitHubRoutingContext } from "./focus-room-settings.js";
import {
  buildRepoRoomEventArtifactMatches,
  extractReferencedTaskId,
  getRepoRoomEventReferenceTexts,
  type RepoPullRequestRef,
  type RepoRoomEvent,
  type TaskWorkflowArtifactMatch,
} from "./repo-workflow.js";

export interface RepoRoomEventTaskResolution {
  task: Task | undefined;
  matchedByTaskReference: boolean;
  matchedByWorkflowArtifact: boolean;
}

export interface RepoRoomEventTaskResolverDeps {
  findTaskByWorkflowArtifactMatches(
    projectId: string,
    matches: TaskWorkflowArtifactMatch[]
  ): Promise<Task | undefined>;
  findTaskByPrUrl(projectId: string, prUrl: string): Promise<Task | undefined>;
  findTaskByActiveWorkflowLease?(
    projectId: string,
    workflow: { prUrl?: string | null; branchRef?: string | null }
  ): Promise<Task | undefined>;
  getTaskById(projectId: string, taskId: string): Promise<Task | undefined>;
}

export function emptyRepoRoomEventTaskResolution(): RepoRoomEventTaskResolution {
  return {
    task: undefined,
    matchedByTaskReference: false,
    matchedByWorkflowArtifact: false,
  };
}

export function toGitHubRoutingContext(
  taskResolution: RepoRoomEventTaskResolution
): FocusGitHubRoutingContext {
  return {
    matched_task_reference: taskResolution.matchedByTaskReference,
    matched_workflow_artifact: taskResolution.matchedByWorkflowArtifact,
  };
}

export function getPullRequestWorkflowRef(event: RepoRoomEvent): RepoPullRequestRef | null {
  switch (event.kind) {
    case "pull_request":
    case "pull_request_review":
      return event.pullRequest;
    default:
      return null;
  }
}

function taskIdsMatch(left: string | null | undefined, right: string): boolean {
  return Boolean(left && left.toLowerCase() === right.toLowerCase());
}

export function createRepoRoomEventTaskResolver(deps: RepoRoomEventTaskResolverDeps) {
  async function resolveTaskByActiveWorkflowLease(
    project: { id: string },
    pullRequest: RepoPullRequestRef,
    referencedTaskId: string | null
  ): Promise<RepoRoomEventTaskResolution | null> {
    if (!deps.findTaskByActiveWorkflowLease) {
      return null;
    }

    const task = await deps.findTaskByActiveWorkflowLease(project.id, {
      prUrl: pullRequest.url,
      branchRef: pullRequest.headRef,
    });
    if (!task) {
      return null;
    }

    return {
      task,
      matchedByTaskReference: taskIdsMatch(referencedTaskId, task.id),
      matchedByWorkflowArtifact: true,
    };
  }

  async function resolveTaskByArtifactsOrReferences(
    project: { id: string },
    artifactMatches: TaskWorkflowArtifactMatch[],
    ...fallbackTexts: Array<string | null | undefined>
  ): Promise<RepoRoomEventTaskResolution> {
    const referencedTaskId = extractReferencedTaskId(...fallbackTexts);
    const artifactTask = await deps.findTaskByWorkflowArtifactMatches(
      project.id,
      artifactMatches
    );
    if (artifactTask) {
      return {
        task: artifactTask,
        matchedByTaskReference: taskIdsMatch(referencedTaskId, artifactTask.id),
        matchedByWorkflowArtifact: true,
      };
    }

    if (!referencedTaskId) {
      return emptyRepoRoomEventTaskResolution();
    }

    const task = await deps.getTaskById(project.id, referencedTaskId);
    return {
      task: task ?? undefined,
      matchedByTaskReference: Boolean(task),
      matchedByWorkflowArtifact: false,
    };
  }

  async function resolveLinkedTaskForRepoRoomEvent(
    project: { id: string },
    event: RepoRoomEvent
  ): Promise<RepoRoomEventTaskResolution> {
    const artifactMatches = buildRepoRoomEventArtifactMatches(event);
    const referencedTaskId = extractReferencedTaskId(...getRepoRoomEventReferenceTexts(event));

    if (event.kind === "pull_request") {
      const artifactTask =
        (await deps.findTaskByWorkflowArtifactMatches(project.id, artifactMatches)) ??
        (await deps.findTaskByPrUrl(project.id, event.pullRequest.url));

      if (artifactTask) {
        return {
          task: artifactTask,
          matchedByTaskReference: taskIdsMatch(referencedTaskId, artifactTask.id),
          matchedByWorkflowArtifact: true,
        };
      }

      const leaseTask = await resolveTaskByActiveWorkflowLease(
        project,
        event.pullRequest,
        referencedTaskId
      );
      if (leaseTask) {
        return leaseTask;
      }

      if (!referencedTaskId) {
        return emptyRepoRoomEventTaskResolution();
      }

      const task = await deps.getTaskById(project.id, referencedTaskId);
      return {
        task: task ?? undefined,
        matchedByTaskReference: Boolean(task),
        matchedByWorkflowArtifact: false,
      };
    }

    if (event.kind === "pull_request_review") {
      const artifactTask = await deps.findTaskByWorkflowArtifactMatches(
        project.id,
        artifactMatches
      );
      if (artifactTask) {
        return {
          task: artifactTask,
          matchedByTaskReference: taskIdsMatch(referencedTaskId, artifactTask.id),
          matchedByWorkflowArtifact: true,
        };
      }

      const prUrlTask = await deps.findTaskByPrUrl(project.id, event.pullRequest.url);
      if (prUrlTask) {
        return {
          task: prUrlTask,
          matchedByTaskReference: taskIdsMatch(referencedTaskId, prUrlTask.id),
          matchedByWorkflowArtifact: true,
        };
      }

      const leaseTask = await resolveTaskByActiveWorkflowLease(
        project,
        event.pullRequest,
        referencedTaskId
      );
      if (leaseTask) {
        return leaseTask;
      }

      if (!referencedTaskId) {
        return emptyRepoRoomEventTaskResolution();
      }

      const task = await deps.getTaskById(project.id, referencedTaskId);
      return {
        task: task ?? undefined,
        matchedByTaskReference: Boolean(task),
        matchedByWorkflowArtifact: false,
      };
    }

    return resolveTaskByArtifactsOrReferences(
      project,
      artifactMatches,
      ...getRepoRoomEventReferenceTexts(event)
    );
  }

  return {
    resolveLinkedTaskForRepoRoomEvent,
    resolveTaskByArtifactsOrReferences,
  };
}
