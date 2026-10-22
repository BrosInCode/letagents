import type { Task } from "../db.js";
import type { FocusGitHubRoutingContext } from "../focus-rooms/settings.js";
import {
  buildRepoRoomEventArtifactMatches,
  extractReferencedTaskId,
  getRepoRoomEventReferenceTexts,
  type RepoPullRequestRef,
  type RepoRoomEvent,
  type TaskWorkflowArtifactMatch,
} from "../repo-workflow.js";

export interface RepoRoomEventTaskResolution {
  task: Task | undefined;
  matchedByTaskReference: boolean;
  matchedByWorkflowArtifact: boolean;
  /** The card's `external_ref` names a ticket key found in the branch, PR title or PR body. */
  matchedByTicketKey?: boolean;
  /**
   * PR6: the pull request is on the card through a Jev link, suggested or
   * accepted by a person. Only an accepted link lets a rule fire.
   */
  jevLink?: "jev_suggested" | "jev_confirmed";
}

/** The texts a ticket key may appear in. */
export interface RepoEventTicketKeyInputs {
  branchRef?: string | null;
  title?: string | null;
  body?: string | null;
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
  /**
   * Finds the card whose `external_ref` names a key in the inputs. It must
   * return undefined without running a detector when the room has no card
   * with an external ref.
   */
  findTaskByTicketKeys?(
    projectId: string,
    inputs: RepoEventTicketKeyInputs
  ): Promise<Task | undefined>;
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

export function getBranchWorkflowRef(event: RepoRoomEvent): string | null {
  switch (event.kind) {
    case "push":
      return event.push.refType === "branch" ? event.push.ref || null : null;
    case "branch_ref":
      return event.branch.refType === "branch" ? event.branch.ref || null : null;
    default:
      return null;
  }
}

/**
 * How a ticket key or a Jev link, not a lease or an explicit link, put this
 * pull request on the card. Later events for it match by URL and keep the
 * key's quiet handling.
 */
function artifactLinkFlags(task: Task, pullRequestUrl: string): Pick<RepoRoomEventTaskResolution, "matchedByTicketKey" | "jevLink"> {
  const mark = task.workflow_artifacts.find((artifact) => artifact.url === pullRequestUrl && artifact.linked_by)?.linked_by;
  if (mark === "ticket_key") return { matchedByTicketKey: true };
  if (mark === "jev_suggested" || mark === "jev_confirmed") return { jevLink: mark };
  return {};
}

function taskIdsMatch(left: string | null | undefined, right: string): boolean {
  return Boolean(left && left.toLowerCase() === right.toLowerCase());
}

export function createRepoRoomEventTaskResolver(deps: RepoRoomEventTaskResolverDeps) {
  async function resolveTaskByTicketKeys(
    project: { id: string },
    inputs: RepoEventTicketKeyInputs,
    referencedTaskId: string | null
  ): Promise<RepoRoomEventTaskResolution | null> {
    if (!deps.findTaskByTicketKeys) {
      return null;
    }

    const task = await deps.findTaskByTicketKeys(project.id, inputs);
    if (!task) {
      return null;
    }

    // A key is an explicit link, like a PR URL on the card. It runs only after
    // URL and lease matching find nothing, so those always win. The branch and
    // title count in any form; the body counts only as "Fixes|Closes|Resolves KEY".
    return {
      task,
      matchedByTaskReference: taskIdsMatch(referencedTaskId, task.id),
      matchedByWorkflowArtifact: true,
      matchedByTicketKey: true,
    };
  }

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
    const branchRef = getBranchWorkflowRef(event);

    if (branchRef) {
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

      if (deps.findTaskByActiveWorkflowLease) {
        const leaseTask = await deps.findTaskByActiveWorkflowLease(project.id, {
          branchRef,
        });
        if (leaseTask) {
          return {
            task: leaseTask,
            matchedByTaskReference: taskIdsMatch(referencedTaskId, leaseTask.id),
            matchedByWorkflowArtifact: true,
          };
        }
      }

      const keyTask = await resolveTaskByTicketKeys(project, { branchRef }, referencedTaskId);
      if (keyTask) {
        return keyTask;
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

    if (event.kind === "pull_request" || event.kind === "pull_request_participant") {
      const artifactTask =
        (await deps.findTaskByWorkflowArtifactMatches(project.id, artifactMatches)) ??
        (await deps.findTaskByPrUrl(project.id, event.pullRequest.url));

      if (artifactTask) {
        return {
          task: artifactTask,
          matchedByTaskReference: taskIdsMatch(referencedTaskId, artifactTask.id),
          matchedByWorkflowArtifact: true,
          ...artifactLinkFlags(artifactTask, event.pullRequest.url),
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

      const keyTask = await resolveTaskByTicketKeys(project, {
        branchRef: event.pullRequest.headRef,
        title: event.pullRequest.title,
        body: event.pullRequest.body,
      }, referencedTaskId);
      if (keyTask) {
        return keyTask;
      }

      // PR/review prose can quote examples or tasks belonging to other rooms.
      // A room-local task number alone does not establish a workflow link.
      return emptyRepoRoomEventTaskResolution();
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
          ...artifactLinkFlags(artifactTask, event.pullRequest.url),
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

      const keyTask = await resolveTaskByTicketKeys(project, {
        branchRef: event.pullRequest.headRef,
        title: event.pullRequest.title,
        body: event.pullRequest.body,
      }, referencedTaskId);
      if (keyTask) {
        return keyTask;
      }

      // PR/review prose can quote examples or tasks belonging to other rooms.
      // A room-local task number alone does not establish a workflow link.
      return emptyRepoRoomEventTaskResolution();
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
