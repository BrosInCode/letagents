import {
  getActiveTaskLeases,
  getActiveTaskLocks,
  getProjectById,
  updateTask,
  updateTaskLeaseWorkflowRefs,
  type Project,
  type Task,
  type TaskStatus,
} from "../../db.js";
import {
  evaluateWorkflowArtifactMutation,
  type CoordinationDecisionResult,
} from "../../coordination-policy.js";
import type { FocusGitHubRoutingContext } from "../../focus-rooms/settings.js";
import { getGitHubAppConfig } from "../config.js";
import {
  buildGitHubLeaseEnforcementPlan,
  publishGitHubLeaseEnforcement,
  resolveGitHubLeaseEnforcementMode,
} from "../lease-enforcement.js";
import {
  getPullRequestWorkflowRef,
} from "../repo-event-task-resolution.js";
import {
  projectRepoRoomEvent,
  shouldAutoPromptForBoardProjection,
  type RepoRoomEvent,
} from "../../repo-workflow.js";
import {
  emitTaskAnchoredMessage,
  emitTaskLifecycleStatusMessage,
  recordCoordinationDecision,
} from "../../server/room-services.js";

export interface RepoRoomEventTaskProjection {
  task: Task | undefined;
  authoritative: boolean;
}

export async function getProjectForResolvedTask(
  fallbackProject: Project,
  linkedTask: Pick<Task, "room_id"> | undefined
): Promise<Project> {
  if (!linkedTask || linkedTask.room_id === fallbackProject.id) {
    return fallbackProject;
  }

  return (await getProjectById(linkedTask.room_id)) ?? fallbackProject;
}

async function maybePublishGitHubLeaseEnforcement(input: {
  project: Project;
  event: RepoRoomEvent;
  linkedTask: Task;
  decision: CoordinationDecisionResult;
  installationId: string | null;
}): Promise<void> {
  if (input.event.provider !== "github" || input.event.kind !== "pull_request") {
    return;
  }

  const plan = buildGitHubLeaseEnforcementPlan({
    action: input.event.action,
    linkedTaskId: input.linkedTask.id,
    pullRequest: input.event.pullRequest,
    decision: input.decision,
    mode: resolveGitHubLeaseEnforcementMode(),
  });
  if (!plan) {
    return;
  }

  try {
    const config = await getGitHubAppConfig();
    await publishGitHubLeaseEnforcement({
      config,
      installationId: input.installationId,
      repositoryFullName: input.event.repositoryFullName,
      pullRequestNumber: input.event.pullRequest.number,
      plan,
      detailsUrl: `${config.baseUrl}/in/${input.project.id}`,
    });
  } catch (error) {
    console.warn(
      "[github] failed to publish letagents-lease enforcement",
      error instanceof Error ? error.message : error
    );
  }
}

export async function applyRepoRoomEventToTask(
  project: Project,
  linkedTask: Task | undefined,
  event: RepoRoomEvent,
  input: {
    installationId: string | null;
    githubRoutingContext: FocusGitHubRoutingContext;
  }
): Promise<RepoRoomEventTaskProjection> {
  if (!linkedTask) {
    return { task: undefined, authoritative: false };
  }

  const pullRequest = getPullRequestWorkflowRef(event);
  if (pullRequest) {
    const [leases, locks] = await Promise.all([
      getActiveTaskLeases(project.id, linkedTask.id),
      getActiveTaskLocks(project.id, linkedTask.id),
    ]);
    const decision = evaluateWorkflowArtifactMutation({
      mutation: "webhook_projection",
      taskId: linkedTask.id,
      prUrl: pullRequest.url,
      branchRef: pullRequest.headRef,
      leases,
      locks,
    });

    await recordCoordinationDecision({
      roomId: project.id,
      taskId: linkedTask.id,
      mutation: "webhook_projection",
      decision: decision.kind,
      actorLabel: event.senderLogin ? `github:${event.senderLogin}` : "github",
      actorKey: null,
      actorInstanceId: null,
      reason: decision.kind === "deny"
        ? decision.reason
        : `Allowed webhook_projection with lease ${decision.lease.id}.`,
      leaseId: decision.kind === "allow"
        ? decision.lease.id
        : decision.lease?.id ?? null,
      lockId: decision.kind === "deny" ? decision.lock?.id ?? null : null,
    });

    await maybePublishGitHubLeaseEnforcement({
      project,
      event,
      linkedTask,
      decision,
      installationId: input.installationId,
    });

    if (decision.kind === "deny") {
      await emitTaskAnchoredMessage(
        project.id,
        "letagents",
        `[status] Ignored unleased GitHub ${event.kind} projection for ${linkedTask.id}: ${decision.reason}`,
        linkedTask,
        {
          parent_activity: "GitHub projection",
          parent_event_kind: "major_activity",
          event_kind: "github",
          github_routing_context: input.githubRoutingContext,
        }
      );
      return { task: linkedTask, authoritative: false };
    }

    await updateTaskLeaseWorkflowRefs(project.id, decision.lease.id, {
      pr_url: pullRequest.url,
      ...(pullRequest.headRef ? { branch_ref: pullRequest.headRef } : {}),
    });
  }

  const updates: { status?: TaskStatus; pr_url?: string } = {};
  if (event.kind === "pull_request" && linkedTask.pr_url !== event.pullRequest.url) {
    updates.pr_url = event.pullRequest.url;
  }

  const projectedTaskState = projectRepoRoomEvent({
    event,
    currentStatus: linkedTask.status,
  });

  if (projectedTaskState) {
    updates.status = projectedTaskState.newStatus as TaskStatus;
    if (event.kind === "pull_request") {
      updates.pr_url = event.pullRequest.url;
    }
  }

  if (!updates.status && !updates.pr_url) {
    return { task: linkedTask, authoritative: true };
  }

  const nextTask = await updateTask(project.id, linkedTask.id, updates);
  if (nextTask) {
    if (updates.status) {
      await emitTaskLifecycleStatusMessage(project.id, nextTask, {
        agent_prompt_kind: shouldAutoPromptForBoardProjection(projectedTaskState)
          ? "auto"
          : null,
        event_kind: "github",
        github_routing_context: input.githubRoutingContext,
      });
    }
    return { task: nextTask, authoritative: true };
  }

  return { task: linkedTask, authoritative: true };
}
