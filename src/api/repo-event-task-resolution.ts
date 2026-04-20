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
