/**
 * GitHub App PR handoff for approved rental patches.
 *
 * Patch Gate validates and records proposals locally. When the
 * renter approves a proposal, this module asks the LetAgents GitHub
 * App to open a pull request from the rental work branch to the
 * session base branch. The branch itself must already exist on
 * GitHub; this handoff is deliberately PR creation only.
 */

import type { GitHubAppInstallation, GitHubAppRepository } from "../db.js";
import {
  getGitHubAppInstallationById,
  getGitHubAppRepositoryByFullName,
} from "../db.js";
import {
  getGitHubAppConfig,
  type GitHubAppConfig,
} from "../github-config.js";
import { createGitHubAppJwt } from "../github-lease-enforcement.js";

export interface RentalPatchPullRequestInput {
  repoProvider: string | null | undefined;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  workBranch: string | null | undefined;
  title: string;
  body?: string | null;
}

export interface RentalPatchPullRequest {
  number: number;
  url: string;
  title: string;
  headRef: string | null;
  baseRef: string | null;
}

export interface RentalGitHubPrDeps {
  getConfig(): Promise<GitHubAppConfig>;
  getRepositoryByFullName(fullName: string): Promise<GitHubAppRepository | undefined>;
  getInstallationById(installationId: string): Promise<GitHubAppInstallation | undefined>;
  fetchImpl?: typeof fetch;
}

export class RentalGitHubPrError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "RentalGitHubPrError";
  }
}

export const defaultRentalGitHubPrDeps: RentalGitHubPrDeps = {
  getConfig: getGitHubAppConfig,
  getRepositoryByFullName: getGitHubAppRepositoryByFullName,
  getInstallationById: getGitHubAppInstallationById,
  fetchImpl: fetch,
};

function trimRequired(value: string | null | undefined, code: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new RentalGitHubPrError(code, 409);
  }
  return trimmed;
}

function assertGitHubSession(input: RentalPatchPullRequestInput): {
  fullName: string;
  baseBranch: string;
  workBranch: string;
} {
  const provider = input.repoProvider?.trim() || "github";
  if (provider !== "github") {
    throw new RentalGitHubPrError("unsupported_repo_provider", 409);
  }

  const owner = trimRequired(input.repoOwner, "missing_repo_owner");
  const repo = trimRequired(input.repoName, "missing_repo_name");
  const baseBranch = trimRequired(input.baseBranch, "missing_base_branch");
  const workBranch = trimRequired(input.workBranch, "missing_work_branch");
  if (baseBranch === workBranch) {
    throw new RentalGitHubPrError("work_branch_matches_base", 409);
  }

  return { fullName: `${owner}/${repo}`, baseBranch, workBranch };
}

function isInstallationActive(
  repository: GitHubAppRepository | undefined,
  installation: GitHubAppInstallation | undefined,
): installation is GitHubAppInstallation {
  return Boolean(
    repository &&
      installation &&
      !repository.removed_at &&
      !installation.suspended_at &&
      !installation.uninstalled_at,
  );
}

async function githubApiRequest(input: {
  fetchImpl: typeof fetch;
  url: string;
  method: string;
  token: string;
  body?: unknown;
}): Promise<unknown> {
  const response = await input.fetchImpl(input.url, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "User-Agent": "letagents",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new RentalGitHubPrError(
      "github_api_error",
      response.status >= 400 && response.status < 500 ? 409 : 502,
      `GitHub API ${input.method} ${input.url} failed: ${response.status} ${body}`,
    );
  }

  if (response.status === 204) return null;
  return response.json();
}

async function createInstallationAccessToken(input: {
  config: GitHubAppConfig;
  installationId: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  if (!input.config.appId || !input.config.privateKey) {
    throw new RentalGitHubPrError("github_app_not_configured", 503);
  }

  const jwt = createGitHubAppJwt({
    appId: input.config.appId,
    privateKey: input.config.privateKey,
  });
  const result = await githubApiRequest({
    fetchImpl: input.fetchImpl,
    url: `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    method: "POST",
    token: jwt,
  });
  const token =
    typeof result === "object" && result && "token" in result
      ? String((result as { token: unknown }).token)
      : "";
  if (!token) {
    throw new RentalGitHubPrError("github_installation_token_missing", 502);
  }
  return token;
}

function parsePullRequestResult(result: unknown): RentalPatchPullRequest {
  if (typeof result !== "object" || result === null) {
    throw new RentalGitHubPrError("github_pr_response_invalid", 502);
  }
  const obj = result as Record<string, unknown>;
  const number = typeof obj.number === "number" ? obj.number : NaN;
  const url = typeof obj.html_url === "string" ? obj.html_url : "";
  const title = typeof obj.title === "string" ? obj.title : "";
  if (!Number.isFinite(number) || !url) {
    throw new RentalGitHubPrError("github_pr_response_invalid", 502);
  }
  const head = typeof obj.head === "object" && obj.head !== null
    ? obj.head as Record<string, unknown>
    : {};
  const base = typeof obj.base === "object" && obj.base !== null
    ? obj.base as Record<string, unknown>
    : {};
  return {
    number,
    url,
    title,
    headRef: typeof head.ref === "string" ? head.ref : null,
    baseRef: typeof base.ref === "string" ? base.ref : null,
  };
}

export async function openRentalPatchPullRequest(
  input: RentalPatchPullRequestInput,
  deps: RentalGitHubPrDeps = defaultRentalGitHubPrDeps,
): Promise<RentalPatchPullRequest> {
  const { fullName, baseBranch, workBranch } = assertGitHubSession(input);
  const repository = await deps.getRepositoryByFullName(fullName);
  const installation = repository
    ? await deps.getInstallationById(repository.installation_id)
    : undefined;
  if (!isInstallationActive(repository, installation)) {
    throw new RentalGitHubPrError("github_app_not_connected", 409);
  }

  const config = await deps.getConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await createInstallationAccessToken({
    config,
    installationId: installation.installation_id,
    fetchImpl,
  });

  const result = await githubApiRequest({
    fetchImpl,
    url: `https://api.github.com/repos/${encodeURI(fullName)}/pulls`,
    method: "POST",
    token,
    body: {
      title: trimRequired(input.title, "missing_pr_title"),
      head: workBranch,
      base: baseBranch,
      body: input.body?.trim() || undefined,
      draft: false,
    },
  });

  return parsePullRequestResult(result);
}
