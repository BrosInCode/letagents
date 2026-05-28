import type { GitHubWebhookPayload } from "../github-app.js";
import type {
  RepoIssueRef,
  RepoPullRequestRef,
} from "../repo-workflow.js";

export function toGitHubId(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

export function normalizeDeliveryId(deliveryId: string | null | undefined): string | null {
  return toGitHubId(deliveryId);
}

export function buildDeliveryScopedKey(baseKey: string, deliveryId: string): string {
  return `${baseKey}:delivery:${deliveryId}`;
}

export function toRepoPullRequestRef(
  payload: GitHubWebhookPayload["pull_request"],
): RepoPullRequestRef | null {
  if (!payload) {
    return null;
  }

  return {
    number: payload.number,
    title: payload.title,
    url: payload.html_url,
    body: payload.body,
    headRef: payload.head?.ref,
    headSha: payload.head?.sha,
    merged: payload.merged,
    authorLogin: payload.user?.login,
    mergedByLogin: payload.merged_by?.login,
  };
}

export function toRepoIssueRef(
  payload: GitHubWebhookPayload["issue"],
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

export function getPreviousRepositoryFullName(payload: GitHubWebhookPayload): string | null {
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

export function getPullRequestState(
  payload: GitHubWebhookPayload["pull_request"],
  action: string,
): string {
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

export function getInstallationState(action: string): string {
  if (action === "deleted") {
    return "deleted";
  }
  if (action === "suspend") {
    return "suspended";
  }
  return "active";
}

export function getRepoIdentity(fullName: string): string {
  return fullName.trim().toLowerCase();
}

export function buildInstallationRepositoriesKey(
  installationId: string,
  action: string,
  repositories: GitHubWebhookPayload["repositories_added"] | GitHubWebhookPayload["repositories_removed"],
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
