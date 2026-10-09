import {
  getActiveTaskLeases,
  getActiveTaskLocks,
  getProjectById,
  journalApprovalSettlesRequestedChanges,
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
  upsertTaskPullRequestArtifact,
  type RepoRoomEvent,
  type TaskWorkflowArtifact,
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

/** The GitHub App's own login, which every review the broker publishes carries. */
async function githubAppLogin(): Promise<string | null> {
  const slug = (await getGitHubAppConfig()).appSlug?.trim();
  return slug ? `${slug}[bot]` : null;
}

/** A task in one of these already shipped its pull request. */
const SHIPPED_TASK_STATUSES = new Set<TaskStatus>(["merged", "done"]);

function pullRequestState(event: Extract<RepoRoomEvent, { kind: "pull_request" }>): string {
  if (event.action === "closed") return event.pullRequest.merged ? "merged" : "closed";
  if (event.action === "ready_for_review") return "open";
  return event.action === "converted_to_draft" || event.pullRequest.draft ? "draft" : "open";
}

/**
 * A pull request for a task that already shipped is a follow-up: the task
 * keeps the pull request it shipped with and shows this one beside it while
 * it is in review. Linking one needs the work lease like any workflow change
 * (`link`); one already shown keeps its state current without it, so it stops
 * showing as in review once it merges after the task closed. Undefined when
 * the event is not a follow-up; null when nothing changed.
 */
function followUpPullRequestArtifacts(
  task: Task,
  event: RepoRoomEvent,
  options: { link: boolean }
): TaskWorkflowArtifact[] | null | undefined {
  if (event.kind !== "pull_request" || !task.pr_url || task.pr_url === event.pullRequest.url
    || !SHIPPED_TASK_STATUSES.has(task.status)) return undefined;
  if (!options.link && !task.workflow_artifacts.some((artifact) => artifact.url === event.pullRequest.url)) return null;
  return upsertTaskPullRequestArtifact(task.workflow_artifacts, {
    provider: event.provider,
    kind: "pull_request",
    number: event.pullRequest.number,
    title: event.pullRequest.title,
    url: event.pullRequest.url,
    state: pullRequestState(event),
  });
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
    messageIdBase?: string | null;
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
          client_message_id: input.messageIdBase
            ? `${input.messageIdBase}:coordination-deny`
            : null,
          parent_client_message_id: input.messageIdBase
            ? `${input.messageIdBase}:coordination-deny-anchor`
            : null,
        }
      );
      const followUp = followUpPullRequestArtifacts(linkedTask, event, { link: false });
      const refreshed = followUp ? await updateTask(project.id, linkedTask.id, { workflow_artifacts: followUp }) : null;
      return { task: refreshed ?? linkedTask, authoritative: false };
    }

    await updateTaskLeaseWorkflowRefs(project.id, decision.lease.id, {
      pr_url: pullRequest.url,
      ...(pullRequest.headRef ? { branch_ref: pullRequest.headRef } : {}),
    });
  }

  const updates: { status?: TaskStatus; pr_url?: string; workflow_artifacts?: TaskWorkflowArtifact[] } = {};
  const followUp = followUpPullRequestArtifacts(linkedTask, event, { link: true });
  if (followUp) {
    updates.workflow_artifacts = followUp;
  } else if (followUp === undefined && event.kind === "pull_request" && linkedTask.pr_url !== event.pullRequest.url) {
    updates.pr_url = event.pullRequest.url;
  }

  const projectedTaskState = projectRepoRoomEvent({
    event,
    currentStatus: linkedTask.status,
    approvalSettlesRequestedChanges: event.kind === "pull_request_review" && linkedTask.status === "blocked"
      && event.review.state === "approved"
      && await journalApprovalSettlesRequestedChanges({
        room_id: project.id,
        task_id: linkedTask.id,
        pull_number: event.pullRequest.number,
        head_sha: event.pullRequest.headSha,
        review_id: event.review.id,
        review_body: event.review.body,
        reviewer_login: event.senderLogin,
        app_login: await githubAppLogin(),
      }),
  });

  if (projectedTaskState) {
    updates.status = projectedTaskState.newStatus as TaskStatus;
    if (event.kind === "pull_request") {
      updates.pr_url = event.pullRequest.url;
    }
  }

  if (!updates.status && !updates.pr_url && !updates.workflow_artifacts) {
    return { task: linkedTask, authoritative: true };
  }

  const nextTask = await updateTask(project.id, linkedTask.id, updates, { githubEvent: true });
  if (nextTask) {
    if (updates.status) {
      await emitTaskLifecycleStatusMessage(project.id, nextTask, {
        agent_prompt_kind: shouldAutoPromptForBoardProjection(projectedTaskState)
          ? "auto"
          : null,
        event_kind: "github",
        github_routing_context: input.githubRoutingContext,
        client_message_id: input.messageIdBase
          ? `${input.messageIdBase}:task-status`
          : null,
        parent_client_message_id: input.messageIdBase
          ? `${input.messageIdBase}:task-status-anchor`
          : null,
      });
    }
    return { task: nextTask, authoritative: true };
  }

  return { task: linkedTask, authoritative: true };
}
