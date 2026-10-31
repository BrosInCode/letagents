import { getPullRequestLabel } from "./providers.js";
import { buildTaskWorkflowArtifactMatches } from "./task-artifacts.js";
import type {
  RepoPullRequestParticipant,
  RepoPullRequestRef,
  RepoRoomEvent,
  RepoWorkflowProvider,
  TaskWorkflowArtifactMatch,
} from "./types.js";

export function formatRepoPullRequestEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  pullRequest: RepoPullRequestRef;
  senderLogin?: string | null;
  linkedTaskId?: string | null;
  redactTitle?: boolean;
}): string | null {
  const actor = input.senderLogin || input.pullRequest.authorLogin || input.provider;
  const prLabel = getPullRequestLabel(input.provider, input.pullRequest.number);
  const title = input.pullRequest.title.trim();
  const titleSegment = input.redactTitle || !title ? "" : `: ${title}`;
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.action) {
    case "opened":
      return `${prLabel} opened by ${actor} in ${input.repositoryFullName}${taskSuffix}${titleSegment} ${input.pullRequest.url}`;
    case "reopened":
      return `${prLabel} reopened by ${actor} in ${input.repositoryFullName}${taskSuffix}${titleSegment} ${input.pullRequest.url}`;
    case "ready_for_review":
      return `${prLabel} is ready for review in ${input.repositoryFullName}${taskSuffix}${titleSegment} ${input.pullRequest.url}`;
    case "synchronize":
      return `${prLabel} received new commits from ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.url}`;
    case "converted_to_draft":
      return `${prLabel} was converted to draft by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.url}`;
    case "closed":
      if (input.pullRequest.merged) {
        const merger = input.pullRequest.mergedByLogin || actor;
        return `${prLabel} was merged by ${merger} in ${input.repositoryFullName}${taskSuffix}${titleSegment} ${input.pullRequest.url}`;
      }
      return `${prLabel} was closed by ${actor} in ${input.repositoryFullName}${taskSuffix}${titleSegment} ${input.pullRequest.url}`;
    default:
      return null;
  }
}

/**
 * Review requests and assignments. A user is named with an @ mention so the
 * room names them. A team has no account to mention, so it is named in words.
 */
export function formatRepoPullRequestParticipantEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  pullRequest: RepoPullRequestRef;
  participant: RepoPullRequestParticipant;
  senderLogin?: string | null;
  linkedTaskId?: string | null;
  redactTitle?: boolean;
}): string | null {
  // Only the sender names the actor. With no sender, the " by <login>" clause is omitted.
  const by = input.senderLogin ? ` by ${input.senderLogin}` : "";
  const prLabel = getPullRequestLabel(input.provider, input.pullRequest.number);
  const title = input.pullRequest.title.trim();
  const titleSegment = input.redactTitle || !title ? "" : `: ${title}`;
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";
  const context = `in ${input.repositoryFullName}${taskSuffix}${titleSegment} ${input.pullRequest.url}`;
  const { participant } = input;
  const login = participant.login;
  // A team is named by its slug only, never by its display name.
  const teamOwner = input.repositoryFullName.split("/")[0];
  const teamLabel = participant.team_slug ? `${teamOwner}/${participant.team_slug}` : null;

  switch (input.action) {
    case "review_requested":
      if (login) return `@${login} review requested${by} on ${prLabel} ${context}`;
      return teamLabel ? `Review requested from team ${teamLabel}${by} on ${prLabel} ${context}` : null;
    case "review_request_removed":
      if (login) return `Review request for @${login} removed${by} on ${prLabel} ${context}`;
      return teamLabel ? `Review request for team ${teamLabel} removed${by} on ${prLabel} ${context}` : null;
    case "assigned":
      return login ? `@${login} assigned${by} to ${prLabel} ${context}` : null;
    case "unassigned":
      return login ? `@${login} unassigned${by} from ${prLabel} ${context}` : null;
    default:
      return null;
  }
}

export function formatRepoRepositoryEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  oldFullName?: string | null;
  senderLogin?: string | null;
}): string | null {
  const actor = input.senderLogin || input.provider;
  switch (input.action) {
    case "renamed":
      return input.oldFullName
        ? `Repository renamed from ${input.oldFullName} to ${input.repositoryFullName} by ${actor}`
        : `Repository ${input.repositoryFullName} was renamed by ${actor}`;
    case "transferred":
      return input.oldFullName
        ? `Repository transferred from ${input.oldFullName} to ${input.repositoryFullName} by ${actor}`
        : `Repository ${input.repositoryFullName} was transferred by ${actor}`;
    default:
      return null;
  }
}

export function formatRepoIssueEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  issue: { number: number; title: string; url: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  const actor = input.senderLogin || input.provider;
  const issueLabel = `Issue #${input.issue.number}`;
  const title = input.issue.title.trim();
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.action) {
    case "opened":
      return `${issueLabel} opened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.issue.url}`;
    case "closed":
      return `${issueLabel} closed by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.issue.url}`;
    case "reopened":
      return `${issueLabel} reopened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.issue.url}`;
    case "labeled":
    case "unlabeled":
      return null;
    default:
      return null;
  }
}

export function formatRepoIssueCommentEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  issue: { number: number; title: string };
  comment: { body: string; url: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
  isPullRequest?: boolean;
}): string | null {
  if (input.action !== "created") return null;

  const actor = input.senderLogin || input.provider;
  const contextLabel = input.isPullRequest
    ? getPullRequestLabel(input.provider, input.issue.number)
    : `Issue #${input.issue.number}`;
  const bodyPreview = input.comment.body.length > 80
    ? input.comment.body.slice(0, 77) + "..."
    : input.comment.body;
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  return `${actor} commented on ${contextLabel} in ${input.repositoryFullName}${taskSuffix}: "${bodyPreview}" ${input.comment.url}`;
}

export function formatRepoPullRequestReviewEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  pullRequest: { number: number; title: string };
  review: { state: string; url: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  if (input.action !== "submitted") return null;

  const actor = input.senderLogin || input.provider;
  const prLabel = getPullRequestLabel(input.provider, input.pullRequest.number);
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.review.state) {
    case "approved":
      return `${actor} approved ${prLabel} in ${input.repositoryFullName}${taskSuffix} ${input.review.url}`;
    case "changes_requested":
      return `${actor} requested changes on ${prLabel} in ${input.repositoryFullName}${taskSuffix} ${input.review.url}`;
    case "commented":
      return `${actor} reviewed ${prLabel} in ${input.repositoryFullName}${taskSuffix} ${input.review.url}`;
    default:
      return null;
  }
}

export function formatRepoCheckRunEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  checkRun: {
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    appName?: string | null;
  };
  linkedTaskId?: string | null;
}): string | null {
  if (input.action !== "completed") return null;

  const conclusion = input.checkRun.conclusion || "unknown";
  const appLabel = input.checkRun.appName ? ` (${input.checkRun.appName})` : "";
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  if (isLowSignalCheckRunConclusion(conclusion)) return null;

  return `Check "${input.checkRun.name}"${appLabel} ${conclusion} in ${input.repositoryFullName}${taskSuffix} ${input.checkRun.url}`;
}

export function formatRepoPushEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  push: { ref: string; refType: string; afterSha?: string | null; compareUrl?: string | null };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  if (input.action !== "push") return null;

  const actor = input.senderLogin || input.provider;
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";
  const shortSha = input.push.afterSha ? ` ${input.push.afterSha.slice(0, 7)}` : "";
  const urlSuffix = input.push.compareUrl ? ` ${input.push.compareUrl}` : "";

  return `${actor} pushed${shortSha} to ${input.push.refType} ${input.push.ref} in ${input.repositoryFullName}${taskSuffix}${urlSuffix}`;
}

export function formatRepoBranchLifecycleEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  branch: { ref: string; refType: string };
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  const actor = input.senderLogin || input.provider;
  const action = input.action === "delete" ? "deleted" : input.action === "create" ? "created" : null;
  if (!action) return null;

  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";
  return `${actor} ${action} ${input.branch.refType} ${input.branch.ref} in ${input.repositoryFullName}${taskSuffix}`;
}

// A cancelled check is almost always a run that a newer push replaced (CI
// cancels a pull request's unfinished run), and a stale one never ran: each
// posted one message per job, so a busy PR filled the room with them.
function isLowSignalCheckRunConclusion(conclusion: string | null | undefined): boolean {
  return ["success", "skipped", "neutral", "cancelled", "stale"].includes((conclusion || "").toLowerCase());
}

export function buildRepoRoomEventArtifactMatches(event: RepoRoomEvent): TaskWorkflowArtifactMatch[] {
  switch (event.kind) {
    case "pull_request":
    case "pull_request_participant":
      return buildTaskWorkflowArtifactMatches({
        provider: event.provider,
        kind: "pull_request",
        url: event.pullRequest.url,
        number: event.pullRequest.number,
      });
    case "issue":
    case "issue_comment":
      return buildTaskWorkflowArtifactMatches({
        provider: event.provider,
        kind: event.issue.isPullRequest ? "pull_request" : "issue",
        url: event.issue.url,
        number: event.issue.number,
      });
    case "pull_request_review":
      return [
        ...buildTaskWorkflowArtifactMatches({
          provider: event.provider,
          kind: "review",
          id: event.review.id,
          url: event.review.url,
        }),
        ...buildTaskWorkflowArtifactMatches({
          provider: event.provider,
          kind: "pull_request",
          url: event.pullRequest.url,
          number: event.pullRequest.number,
        }),
      ];
    case "check_run":
      return buildTaskWorkflowArtifactMatches({
        provider: event.provider,
        kind: "check_run",
        number: event.checkRun.suiteId,
        id: event.checkRun.id,
        title: event.checkRun.name,
        url: event.checkRun.url,
      });
    case "repository":
      return [];
    case "push":
      return event.push.refType === "branch"
        ? buildTaskWorkflowArtifactMatches({
          provider: event.provider,
          kind: "branch",
          ref: event.push.ref,
        })
        : [];
    case "branch_ref":
      return event.branch.refType === "branch"
        ? buildTaskWorkflowArtifactMatches({
          provider: event.provider,
          kind: "branch",
          ref: event.branch.ref,
        })
        : [];
    default:
      return [];
  }
}

export function getRepoRoomEventReferenceTexts(
  event: RepoRoomEvent
): Array<string | null | undefined> {
  switch (event.kind) {
    case "pull_request":
    case "pull_request_participant":
      return [event.pullRequest.title, event.pullRequest.body];
    case "issue":
      return [event.issue.title];
    case "issue_comment":
      return [event.issue.title, event.comment.body];
    case "pull_request_review":
      return [event.pullRequest.title, event.pullRequest.body, event.review.body];
    case "check_run":
    case "repository":
      return [];
    case "push":
      return [event.push.ref, event.push.headCommitMessage];
    case "branch_ref":
      return [event.branch.ref];
    default:
      return [];
  }
}

export function formatRepoRoomEventMessage(input: {
  event: RepoRoomEvent;
  linkedTaskId?: string | null;
  redactUntrustedTaskReference?: boolean;
}): string | null {
  switch (input.event.kind) {
    case "pull_request":
      return formatRepoPullRequestEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        pullRequest: input.event.pullRequest,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
        redactTitle: input.redactUntrustedTaskReference,
      });
    case "pull_request_participant":
      return formatRepoPullRequestParticipantEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        pullRequest: input.event.pullRequest,
        participant: input.event.participant,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
        redactTitle: input.redactUntrustedTaskReference,
      });
    case "issue":
      return formatRepoIssueEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        issue: input.event.issue,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    case "issue_comment":
      return formatRepoIssueCommentEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        issue: {
          number: input.event.issue.number,
          title: input.event.issue.title,
        },
        comment: input.event.comment,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
        isPullRequest: Boolean(input.event.issue.isPullRequest),
      });
    case "pull_request_review":
      return formatRepoPullRequestReviewEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        pullRequest: {
          number: input.event.pullRequest.number,
          title: input.event.pullRequest.title,
        },
        review: {
          state: input.event.review.state,
          url: input.event.review.url,
        },
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    case "check_run":
      return formatRepoCheckRunEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        checkRun: input.event.checkRun,
        linkedTaskId: input.linkedTaskId,
      });
    case "repository":
      return formatRepoRepositoryEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        oldFullName: input.event.oldFullName,
        senderLogin: input.event.senderLogin,
      });
    case "push":
      return formatRepoPushEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        push: input.event.push,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    case "branch_ref":
      return formatRepoBranchLifecycleEventMessage({
        provider: input.event.provider,
        action: input.event.action,
        repositoryFullName: input.event.repositoryFullName,
        branch: input.event.branch,
        senderLogin: input.event.senderLogin,
        linkedTaskId: input.linkedTaskId,
      });
    default:
      return null;
  }
}
