import type { GitHubRoomEventMetadata, GitHubRoomEventType } from "./db/schema.js";
import { type GitHubWebhookPayload } from "./github-app.js";
import {
  type RepoIssueRef,
  type RepoPullRequestRef,
  type RepoRoomEvent,
} from "./repo-workflow.js";

const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "converted_to_draft",
  "closed",
]);

const SUPPORTED_ISSUE_ACTIONS = new Set(["opened", "reopened", "closed"]);
const SUPPORTED_ISSUE_COMMENT_ACTIONS = new Set(["created"]);
const SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS = new Set(["submitted"]);
const SUPPORTED_CHECK_RUN_ACTIONS = new Set(["completed"]);
const SUPPORTED_REPOSITORY_ACTIONS = new Set(["renamed", "transferred"]);
const SUPPORTED_INSTALLATION_REPOSITORY_ACTIONS = new Set(["added", "removed"]);

export interface MaterializedGitHubRoomEvent {
  event_type: GitHubRoomEventType;
  action: string;
  idempotency_key: string;
  github_object_id: string | null;
  github_object_url: string | null;
  title: string | null;
  state: string | null;
  actor_login: string | null;
  metadata: GitHubRoomEventMetadata | null;
  roomEvent: RepoRoomEvent | null;
}

function toGitHubId(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function toRepoPullRequestRef(
  payload: GitHubWebhookPayload["pull_request"]
): RepoPullRequestRef | null {
  if (!payload) {
    return null;
  }

  return {
    number: payload.number,
    title: payload.title,
    url: payload.html_url,
    body: payload.body,
    merged: payload.merged,
    authorLogin: payload.user?.login,
    mergedByLogin: payload.merged_by?.login,
  };
}

function toRepoIssueRef(
  payload: GitHubWebhookPayload["issue"]
): RepoIssueRef | null {
  if (!payload) {
    return null;
  }

  return {
    number: payload.number,
    title: payload.title,
    url: payload.html_url,
    isPullRequest: Boolean(payload.pull_request),
  };
}

function getPreviousRepositoryFullName(payload: GitHubWebhookPayload): string | null {
  if (!payload.repository || !payload.action) {
    return null;
  }

  if (payload.action === "renamed" && payload.changes?.repository?.name?.from) {
    const ownerLogin = payload.repository.owner?.login
      ?? payload.repository.full_name.split("/", 1)[0]
      ?? "";
    return `${ownerLogin}/${payload.changes.repository.name.from}`;
  }

  if (payload.action === "transferred" && payload.changes?.owner?.from?.login) {
    return `${payload.changes.owner.from.login}/${payload.repository.name}`;
  }

  return null;
}

function getPullRequestState(payload: GitHubWebhookPayload["pull_request"], action: string): string {
  if (payload?.merged) {
    return "merged";
  }

  if (payload?.state) {
    return payload.state;
  }

  if (action === "closed") {
    return "closed";
  }

  if (payload?.draft) {
    return "draft";
  }

  return "open";
}

function getInstallationState(action: string): string {
  if (action === "deleted") {
    return "deleted";
  }
  if (action === "suspend") {
    return "suspended";
  }
  return "active";
}

function getRepoIdentity(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function buildInstallationRepositoriesKey(
  installationId: string,
  action: string,
  repositories: GitHubWebhookPayload["repositories_added"] | GitHubWebhookPayload["repositories_removed"]
): string | null {
  const repositoryIds = (repositories ?? [])
    .map((repository) => toGitHubId(repository.id))
    .filter((value): value is string => Boolean(value))
    .sort();

  if (repositoryIds.length === 0) {
    return null;
  }

  return `installation_repositories:${installationId}:${action}:${repositoryIds.join(",")}`;
}

export function materializeGitHubWebhookEvent(
  eventName: string,
  payload: GitHubWebhookPayload
): MaterializedGitHubRoomEvent | null {
  const action = payload.action;
  if (!action) {
    return null;
  }

  const actorLogin = payload.sender?.login ?? null;

  if (eventName === "installation") {
    const installationId = toGitHubId(payload.installation?.id);
    if (!installationId) {
      return null;
    }

    return {
      event_type: "installation",
      action,
      idempotency_key: `installation:${installationId}:${action}`,
      github_object_id: installationId,
      github_object_url: null,
      title: payload.installation?.account?.login ?? payload.organization?.login ?? null,
      state: getInstallationState(action),
      actor_login: actorLogin,
      metadata: {
        target_login: payload.installation?.account?.login ?? payload.organization?.login ?? null,
        target_type: payload.installation?.target_type ?? null,
        repository_selection: payload.installation?.repository_selection ?? null,
        permissions: payload.installation?.permissions ?? null,
      },
      roomEvent: null,
    };
  }

  if (eventName === "installation_repositories") {
    const installationId = toGitHubId(payload.installation?.id);
    if (
      !installationId ||
      !SUPPORTED_INSTALLATION_REPOSITORY_ACTIONS.has(action)
    ) {
      return null;
    }

    const repositories =
      action === "added" ? payload.repositories_added : payload.repositories_removed;
    const idempotencyKey = buildInstallationRepositoriesKey(installationId, action, repositories);
    if (!idempotencyKey) {
      return null;
    }

    return {
      event_type: "installation_repositories",
      action,
      idempotency_key: idempotencyKey,
      github_object_id: installationId,
      github_object_url: null,
      title: payload.installation?.account?.login ?? payload.organization?.login ?? null,
      state: action,
      actor_login: actorLogin,
      metadata: {
        target_login: payload.installation?.account?.login ?? payload.organization?.login ?? null,
        repositories_added: (payload.repositories_added ?? []).map((repository) => ({
          id: toGitHubId(repository.id),
          full_name: repository.full_name,
        })),
        repositories_removed: (payload.repositories_removed ?? []).map((repository) => ({
          id: toGitHubId(repository.id),
          full_name: repository.full_name,
        })),
      },
      roomEvent: null,
    };
  }

  if (!payload.repository) {
    return null;
  }

  const base = {
    provider: "github" as const,
    action,
    repositoryFullName: payload.repository.full_name,
    senderLogin: actorLogin,
  };
  const repoIdentity = getRepoIdentity(payload.repository.full_name);

  switch (eventName) {
    case "pull_request": {
      if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(action)) {
        return null;
      }

      const pullRequest = toRepoPullRequestRef(payload.pull_request);
      if (!pullRequest) {
        return null;
      }

      let idempotencyKey = `${repoIdentity}:pr:${pullRequest.number}:${action}`;
      if (action === "synchronize") {
        const headSha = payload.pull_request?.head?.sha?.trim();
        if (!headSha) {
          return null;
        }
        idempotencyKey = `${repoIdentity}:pr:${pullRequest.number}:sync:${headSha}`;
      }

      return {
        event_type: "pull_request",
        action,
        idempotency_key: idempotencyKey,
        github_object_id: String(pullRequest.number),
        github_object_url: pullRequest.url,
        title: pullRequest.title,
        state: getPullRequestState(payload.pull_request, action),
        actor_login: actorLogin ?? pullRequest.authorLogin ?? null,
        metadata: {
          body: pullRequest.body ?? null,
          draft: payload.pull_request?.draft ?? null,
          merged: payload.pull_request?.merged ?? null,
          head_sha: payload.pull_request?.head?.sha ?? null,
        },
        roomEvent: {
          ...base,
          kind: "pull_request",
          pullRequest,
        },
      };
    }
    case "issues": {
      if (!SUPPORTED_ISSUE_ACTIONS.has(action)) {
        return null;
      }

      const issue = toRepoIssueRef(payload.issue);
      if (!issue) {
        return null;
      }

      return {
        event_type: "issue",
        action,
        idempotency_key: `${repoIdentity}:issue:${issue.number}:${action}`,
        github_object_id: String(issue.number),
        github_object_url: issue.url,
        title: issue.title,
        state: payload.issue?.state ?? (action === "closed" ? "closed" : "open"),
        actor_login: actorLogin ?? payload.issue?.user?.login ?? null,
        metadata: {
          labels: payload.issue?.labels?.map((label) => label.name) ?? [],
          is_pull_request: issue.isPullRequest ?? false,
        },
        roomEvent: {
          ...base,
          kind: "issue",
          issue,
        },
      };
    }
    case "issue_comment": {
      if (!SUPPORTED_ISSUE_COMMENT_ACTIONS.has(action)) {
        return null;
      }

      const issue = toRepoIssueRef(payload.issue);
      if (!issue || !payload.comment) {
        return null;
      }

      return {
        event_type: "issue_comment",
        action,
        idempotency_key: `${repoIdentity}:comment:${payload.comment.id}:created`,
        github_object_id: String(issue.number),
        github_object_url: payload.comment.html_url,
        title: issue.title,
        state: payload.issue?.state ?? null,
        actor_login: actorLogin ?? payload.comment.user?.login ?? null,
        metadata: {
          body: payload.comment.body,
          is_pull_request: issue.isPullRequest ?? false,
        },
        roomEvent: {
          ...base,
          kind: "issue_comment",
          issue,
          comment: {
            body: payload.comment.body,
            url: payload.comment.html_url,
          },
        },
      };
    }
    case "pull_request_review": {
      if (!SUPPORTED_PULL_REQUEST_REVIEW_ACTIONS.has(action)) {
        return null;
      }

      const pullRequest = toRepoPullRequestRef(payload.pull_request);
      if (!pullRequest || !payload.review) {
        return null;
      }

      return {
        event_type: "pull_request_review",
        action,
        idempotency_key: `${repoIdentity}:review:${payload.review.id}:submitted`,
        github_object_id: String(pullRequest.number),
        github_object_url: payload.review.html_url,
        title: pullRequest.title,
        state: payload.review.state,
        actor_login: actorLogin ?? payload.review.user?.login ?? null,
        metadata: {
          body: payload.review.body ?? null,
        },
        roomEvent: {
          ...base,
          kind: "pull_request_review",
          pullRequest,
          review: {
            id: String(payload.review.id),
            state: payload.review.state,
            url: payload.review.html_url,
            body: payload.review.body,
          },
        },
      };
    }
    case "check_run": {
      if (!SUPPORTED_CHECK_RUN_ACTIONS.has(action) || !payload.check_run) {
        return null;
      }

      return {
        event_type: "check_run",
        action,
        idempotency_key: `${repoIdentity}:check_run:${payload.check_run.id}:completed`,
        github_object_id: String(payload.check_run.id),
        github_object_url: payload.check_run.html_url,
        title: payload.check_run.name,
        state: payload.check_run.conclusion ?? payload.check_run.status,
        actor_login: actorLogin,
        metadata: {
          status: payload.check_run.status,
          conclusion: payload.check_run.conclusion,
          app_name: payload.check_run.app?.name ?? null,
        },
        roomEvent: {
          ...base,
          kind: "check_run",
          checkRun: {
            id: String(payload.check_run.id),
            name: payload.check_run.name,
            status: payload.check_run.status,
            conclusion: payload.check_run.conclusion,
            url: payload.check_run.html_url,
            appName: payload.check_run.app?.name ?? null,
          },
        },
      };
    }
    case "repository": {
      if (!SUPPORTED_REPOSITORY_ACTIONS.has(action)) {
        return null;
      }

      const oldFullName = getPreviousRepositoryFullName(payload);
      if (!oldFullName) {
        return null;
      }

      const repositoryId = toGitHubId(payload.repository.id);

      return {
        event_type: "repository",
        action,
        idempotency_key: `${repoIdentity}:repository:${repositoryId ?? repoIdentity}:${action}:${oldFullName.toLowerCase()}`,
        github_object_id: repositoryId,
        github_object_url: null,
        title: payload.repository.full_name,
        state: null,
        actor_login: actorLogin,
        metadata: {
          old_full_name: oldFullName,
        },
        roomEvent: {
          ...base,
          kind: "repository",
          oldFullName,
        },
      };
    }
    default:
      return null;
  }
}

export function materializeGitHubRoomEvent(
  eventName: string,
  payload: GitHubWebhookPayload
): RepoRoomEvent | null {
  return materializeGitHubWebhookEvent(eventName, payload)?.roomEvent ?? null;
}
