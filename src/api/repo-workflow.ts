import { normalizeRoomName } from "./room-routing.js";

export type RepoWorkflowProvider = "github" | "gitlab" | "bitbucket";

const REPO_PROVIDER_HOSTS: Record<RepoWorkflowProvider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

const HOST_TO_PROVIDER = new Map<string, RepoWorkflowProvider>(
  Object.entries(REPO_PROVIDER_HOSTS).map(([provider, host]) => [
    host,
    provider as RepoWorkflowProvider,
  ])
);

export interface RepoRoomRef {
  provider: RepoWorkflowProvider;
  host: string;
  namespace: string;
  repo: string;
  fullName: string;
}

export interface RepoPullRequestRef {
  number: number;
  title: string;
  url: string;
  body?: string | null;
  merged?: boolean;
  authorLogin?: string | null;
  mergedByLogin?: string | null;
}

export type TaskWorkflowRefKind = "pull_request" | "merge_request";
export type TaskWorkflowRefProvider = RepoWorkflowProvider | "unknown";

export interface TaskWorkflowRef {
  provider: TaskWorkflowRefProvider;
  kind: TaskWorkflowRefKind;
  label: string;
  url: string;
}

function getProviderHost(provider: RepoWorkflowProvider): string {
  return REPO_PROVIDER_HOSTS[provider];
}

function getPullRequestLabel(provider: RepoWorkflowProvider, number: number): string {
  switch (provider) {
    case "gitlab":
      return `MR !${number}`;
    default:
      return `PR #${number}`;
  }
}

export function buildRepoRoomId(provider: RepoWorkflowProvider, fullName: string): string {
  return normalizeRoomName(`${getProviderHost(provider)}/${fullName}`);
}

export function parseRepoRoomName(roomName: string): RepoRoomRef | null {
  const normalized = normalizeRoomName(roomName);
  const parts = normalized.split("/");
  const host = parts[0]?.toLowerCase();
  const provider = host ? HOST_TO_PROVIDER.get(host) : undefined;

  if (!provider || parts.length < 3) {
    return null;
  }

  const repo = parts.at(-1) ?? "";
  const namespace = parts.slice(1, -1).join("/");

  if (!namespace || !repo) {
    return null;
  }

  return {
    provider,
    host,
    namespace,
    repo,
    fullName: `${namespace}/${repo}`,
  };
}

export function extractReferencedTaskId(
  ...texts: Array<string | null | undefined>
): string | null {
  for (const value of texts) {
    if (!value) {
      continue;
    }

    const match = /\b(task_\d+)\b/i.exec(value);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

export function formatRepoPullRequestEventMessage(input: {
  provider: RepoWorkflowProvider;
  action: string;
  repositoryFullName: string;
  pullRequest: RepoPullRequestRef;
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  const actor = input.senderLogin || input.pullRequest.authorLogin || input.provider;
  const prLabel = getPullRequestLabel(input.provider, input.pullRequest.number);
  const title = input.pullRequest.title.trim();
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.action) {
    case "opened":
      return `${prLabel} opened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    case "reopened":
      return `${prLabel} reopened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    case "ready_for_review":
      return `${prLabel} is ready for review in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
    case "synchronize":
      return `${prLabel} received new commits from ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.url}`;
    case "converted_to_draft":
      return `${prLabel} was converted to draft by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.url}`;
    case "closed":
      if (input.pullRequest.merged) {
        const merger = input.pullRequest.mergedByLogin || actor;
        return `${prLabel} was merged by ${merger} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
      }
      return `${prLabel} was closed by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.url}`;
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

export function buildTaskWorkflowRefs(input: {
  prUrl?: string | null;
}): TaskWorkflowRef[] {
  if (!input.prUrl) {
    return [];
  }

  try {
    const url = new URL(input.prUrl);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");

    if (hostname === "github.com") {
      const match = /^\/[^/]+\/[^/]+\/pull\/(\d+)$/.exec(path);
      if (match) {
        return [{
          provider: "github",
          kind: "pull_request",
          label: `PR #${match[1]}`,
          url: input.prUrl,
        }];
      }
    }

    if (hostname === "gitlab.com") {
      const match = /^\/.+\/-\/merge_requests\/(\d+)$/.exec(path);
      if (match) {
        return [{
          provider: "gitlab",
          kind: "merge_request",
          label: `MR !${match[1]}`,
          url: input.prUrl,
        }];
      }
    }

    if (hostname === "bitbucket.org") {
      const match = /^\/[^/]+\/[^/]+\/pull-requests\/(\d+)$/.exec(path);
      if (match) {
        return [{
          provider: "bitbucket",
          kind: "pull_request",
          label: `PR #${match[1]}`,
          url: input.prUrl,
        }];
      }
    }
  } catch {
    // Fall through to a generic link when the stored URL is not parseable.
  }

  return [{
    provider: "unknown",
    kind: "pull_request",
    label: "Review",
    url: input.prUrl,
  }];
}
