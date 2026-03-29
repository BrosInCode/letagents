import crypto from "crypto";

import { normalizeRoomName } from "./room-routing.js";

export interface GitHubWebhookAccount {
  id: number | string;
  login: string;
  type?: string;
}

export interface GitHubWebhookInstallation {
  id: number | string;
  account?: GitHubWebhookAccount;
  target_type?: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
}

export interface GitHubWebhookRepository {
  id: number | string;
  name: string;
  full_name: string;
  owner?: {
    login: string;
  };
}

export interface GitHubWebhookPullRequest {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  draft?: boolean;
  merged?: boolean;
  user?: {
    login: string;
  };
  merged_by?: {
    login: string;
  } | null;
}

export interface GitHubWebhookPayload {
  action?: string;
  installation?: GitHubWebhookInstallation;
  organization?: GitHubWebhookAccount;
  repository?: GitHubWebhookRepository;
  repositories_added?: GitHubWebhookRepository[];
  repositories_removed?: GitHubWebhookRepository[];
  pull_request?: GitHubWebhookPullRequest;
  changes?: {
    repository?: {
      name?: { from: string };
    };
    owner?: {
      from?: { login: string };
    };
  };
  sender?: {
    login: string;
  };
}

export interface GitHubWebhookMetadata {
  deliveryId: string | null;
  eventName: string | null;
  signature256: string | null;
}

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function getGitHubWebhookMetadata(
  headers: Record<string, string | string[] | undefined>
): GitHubWebhookMetadata {
  return {
    deliveryId: getHeaderValue(headers["x-github-delivery"]),
    eventName: getHeaderValue(headers["x-github-event"]),
    signature256: getHeaderValue(headers["x-hub-signature-256"]),
  };
}

export function verifyGitHubWebhookSignature(
  body: Buffer,
  signatureHeader: string | null | undefined,
  webhookSecret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", webhookSecret)
    .update(body)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function buildGitHubRepoRoomId(fullName: string): string {
  return normalizeRoomName(`github.com/${fullName}`);
}

export function getGitHubRepositoryOwnerLogin(repository: GitHubWebhookRepository): string {
  if (repository.owner?.login) {
    return repository.owner.login;
  }

  const [ownerLogin] = repository.full_name.split("/", 1);
  return ownerLogin ?? "";
}

export function getGitHubInstallationTarget(
  payload: GitHubWebhookPayload
): GitHubWebhookAccount | null {
  if (payload.installation?.account?.login) {
    return payload.installation.account;
  }

  if (payload.organization?.login) {
    return payload.organization;
  }

  return null;
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

export function formatGitHubPullRequestEventMessage(input: {
  action: string;
  repositoryFullName: string;
  pullRequest: GitHubWebhookPullRequest;
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  const actor = input.senderLogin || input.pullRequest.user?.login || "github";
  const prLabel = `PR #${input.pullRequest.number}`;
  const title = input.pullRequest.title.trim();
  const taskSuffix = input.linkedTaskId ? ` linked to ${input.linkedTaskId}` : "";

  switch (input.action) {
    case "opened":
      return `${prLabel} opened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.html_url}`;
    case "reopened":
      return `${prLabel} reopened by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.html_url}`;
    case "ready_for_review":
      return `${prLabel} is ready for review in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.html_url}`;
    case "synchronize":
      return `${prLabel} received new commits from ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.html_url}`;
    case "converted_to_draft":
      return `${prLabel} was converted to draft by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${input.pullRequest.html_url}`;
    case "closed":
      if (input.pullRequest.merged) {
        const merger = input.pullRequest.merged_by?.login || actor;
        return `${prLabel} was merged by ${merger} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.html_url}`;
      }
      return `${prLabel} was closed by ${actor} in ${input.repositoryFullName}${taskSuffix}: ${title} ${input.pullRequest.html_url}`;
    default:
      return null;
  }
}

export function formatGitHubRepositoryEventMessage(input: {
  action: string;
  repositoryFullName: string;
  oldFullName?: string | null;
  senderLogin?: string | null;
}): string | null {
  const actor = input.senderLogin || "github";
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
