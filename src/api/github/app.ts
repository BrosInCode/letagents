import crypto from "crypto";

import {
  buildRepoRoomId,
  formatRepoPullRequestEventMessage,
  formatRepoRepositoryEventMessage,
} from "../repo-workflow.js";
import { toGitHubRepoPullRequestRef } from "./pull-request-ref.js";

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
  html_url?: string;
  default_branch?: string;
  private?: boolean;
  updated_at?: string | null;
  pushed_at?: string | null;
  owner?: {
    login: string;
  };
}

export interface GitHubWebhookPullRequest {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  draft?: boolean;
  merged?: boolean;
  state?: string;
  changed_files?: number | null;
  additions?: number | null;
  deletions?: number | null;
  base?: {
    ref?: string;
    sha?: string;
  };
  head?: {
    ref?: string;
    sha?: string;
    repo?: {
      id?: number | string | null;
      name?: string | null;
      full_name?: string | null;
      owner?: {
        login?: string | null;
      } | null;
    } | null;
  };
  user?: {
    login: string;
    id?: number;
  };
  merged_by?: {
    login: string;
  } | null;
  requested_reviewers?: Array<{ login: string; id?: number }>;
  assignees?: Array<{ login: string; id?: number }>;
}

export interface GitHubWorkflowRun {
  workflow_id?: number;
  id: number; run_attempt?: number; name?: string; display_title?: string;
  html_url: string; status: string; conclusion: string | null;
  head_sha: string; head_branch?: string | null;
  created_at?: string; updated_at?: string; run_started_at?: string;
  repository?: { id: number; full_name: string };
  head_repository?: { id: number; full_name: string } | null;
  pull_requests?: Array<{ number: number; head?: { sha?: string; ref?: string }; base?: { repo?: { id?: number } } }>;
}

export interface GitHubWebhookPayload {
  action?: string;
  updated_at?: string;
  workflow_run?: GitHubWorkflowRun;
  workflow_job?: {
    id: number; run_id: number; run_attempt?: number; name: string;
    html_url: string; head_sha: string; head_branch?: string;
    status: string; conclusion: string | null;
    created_at?: string; started_at?: string | null; completed_at?: string | null;
    steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
  };
  thread?: { node_id?: string; id?: number | string; updated_at?: string; comments?: Array<{ id: number; pull_request_review_id?: number; in_reply_to_id?: number; user?: { login: string } }> };
  ref?: string;
  ref_type?: string;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  compare?: string;
  master_branch?: string;
  description?: string | null;
  pusher_type?: string;
  pusher?: {
    name?: string;
    email?: string;
  };
  head_commit?: {
    id?: string;
    message?: string;
    timestamp?: string | null;
    url?: string;
    author?: {
      name?: string;
      email?: string;
      username?: string;
    };
    committer?: {
      name?: string;
      email?: string;
      username?: string;
    };
  } | null;
  commits?: Array<{
    id?: string;
    message?: string;
    timestamp?: string | null;
    url?: string;
  }>;
  installation?: GitHubWebhookInstallation;
  member?: GitHubWebhookAccount;
  organization?: GitHubWebhookAccount;
  repository?: GitHubWebhookRepository;
  repositories?: GitHubWebhookRepository[];
  repositories_added?: GitHubWebhookRepository[];
  repositories_removed?: GitHubWebhookRepository[];
  pull_request?: GitHubWebhookPullRequest;
  issue?: {
    number: number;
    title: string;
    html_url: string;
    state?: string;
    created_at?: string | null;
    updated_at?: string | null;
    user?: { login: string };
    labels?: Array<{ name: string }>;
    pull_request?: { url?: string }; // present when the "issue" is actually a PR
  };
  comment?: {
    id: number;
    pull_request_review_id?: number;
    in_reply_to_id?: number;
    commit_id?: string;
    body: string;
    html_url: string;
    created_at?: string | null;
    updated_at?: string | null;
    user?: { login: string };
  };
  review?: {
    id: number;
    commit_id?: string;
    state: string;
    body?: string | null;
    html_url: string;
    submitted_at?: string | null;
    updated_at?: string | null;
    user?: { login: string; id?: number };
  };
  requested_reviewer?: { login: string; id?: number };
  requested_team?: { slug: string; name?: string };
  assignee?: { login: string; id?: number };
  check_run?: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    head_sha?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    app?: { name: string };
    check_suite?: {
      id?: number | string;
      head_branch?: string | null;
      head_sha?: string | null;
    } | null;
  };
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
    id?: number;
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
  return buildRepoRoomId("github", fullName);
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

export { extractReferencedTaskId } from "../repo-workflow.js";

export function formatGitHubPullRequestEventMessage(input: {
  action: string;
  repositoryFullName: string;
  pullRequest: GitHubWebhookPullRequest;
  senderLogin?: string | null;
  linkedTaskId?: string | null;
}): string | null {
  return formatRepoPullRequestEventMessage({
    provider: "github",
    action: input.action,
    repositoryFullName: input.repositoryFullName,
    pullRequest: toGitHubRepoPullRequestRef(input.pullRequest),
    senderLogin: input.senderLogin,
    linkedTaskId: input.linkedTaskId,
  });
}

export function formatGitHubRepositoryEventMessage(input: {
  action: string;
  repositoryFullName: string;
  oldFullName?: string | null;
  senderLogin?: string | null;
}): string | null {
  return formatRepoRepositoryEventMessage({
    provider: "github",
    action: input.action,
    repositoryFullName: input.repositoryFullName,
    oldFullName: input.oldFullName,
    senderLogin: input.senderLogin,
  });
}
