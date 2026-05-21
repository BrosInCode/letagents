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
  patchFiles?: RentalPatchPullRequestFile[];
  commitMessage?: string | null;
  title: string;
  body?: string | null;
}

export interface RentalPatchPullRequestFile {
  path: string;
  operation: "modify" | "create" | "delete";
  content?: string;
}

export interface RentalPatchPullRequest {
  number: number;
  url: string;
  title: string;
  headRef: string | null;
  baseRef: string | null;
  commitSha?: string | null;
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
  allowNotFound?: boolean;
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

  if (input.allowNotFound && response.status === 404) {
    return null;
  }

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

function parseSha(result: unknown, code: string): string {
  if (typeof result !== "object" || result === null) {
    throw new RentalGitHubPrError(code, 502);
  }
  const sha = (result as Record<string, unknown>).sha;
  if (typeof sha !== "string" || !sha.trim()) {
    throw new RentalGitHubPrError(code, 502);
  }
  return sha;
}

function parseRefObjectSha(result: unknown, code: string): string {
  if (typeof result !== "object" || result === null) {
    throw new RentalGitHubPrError(code, 502);
  }
  const object = (result as Record<string, unknown>).object;
  if (typeof object !== "object" || object === null) {
    throw new RentalGitHubPrError(code, 502);
  }
  const sha = (object as Record<string, unknown>).sha;
  if (typeof sha !== "string" || !sha.trim()) {
    throw new RentalGitHubPrError(code, 502);
  }
  return sha;
}

function parseCommitTreeSha(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    throw new RentalGitHubPrError("github_commit_response_invalid", 502);
  }
  const tree = (result as Record<string, unknown>).tree;
  if (typeof tree !== "object" || tree === null) {
    throw new RentalGitHubPrError("github_commit_response_invalid", 502);
  }
  const sha = (tree as Record<string, unknown>).sha;
  if (typeof sha !== "string" || !sha.trim()) {
    throw new RentalGitHubPrError("github_commit_response_invalid", 502);
  }
  return sha;
}

function encodeGitRefPath(ref: string): string {
  return encodeURI(ref.trim()).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function normalizePatchPath(filePath: string): string {
  const normalizedInput = filePath.replace(/\\/g, "/");
  const segments = normalizedInput
    .replace(/^\.\//, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (
    normalizedInput.startsWith("/") ||
    normalizedInput.includes("\0") ||
    segments.includes("..") ||
    /^[a-zA-Z]:/.test(normalizedInput)
  ) {
    throw new RentalGitHubPrError("invalid_patch_path", 409);
  }
  const normalized = segments.join("/");
  if (!normalized) {
    throw new RentalGitHubPrError("invalid_patch_path", 409);
  }
  return normalized;
}

function toGitTreeEntry(file: RentalPatchPullRequestFile): Record<string, unknown> {
  const path = normalizePatchPath(file.path);
  if (file.operation === "delete") {
    return {
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    };
  }
  if (typeof file.content !== "string") {
    throw new RentalGitHubPrError("patch_content_missing", 409);
  }
  return {
    path,
    mode: "100644",
    type: "blob",
    content: file.content,
  };
}

async function createPatchCommitBranch(input: {
  fetchImpl: typeof fetch;
  token: string;
  fullName: string;
  baseBranch: string;
  workBranch: string;
  patchFiles: RentalPatchPullRequestFile[];
  commitMessage: string;
}): Promise<string> {
  if (input.patchFiles.length === 0) {
    throw new RentalGitHubPrError("patch_files_required", 409);
  }

  const repoUrl = `https://api.github.com/repos/${encodeURI(input.fullName)}`;
  const baseRef = encodeGitRefPath(`heads/${input.baseBranch}`);
  const workRef = encodeGitRefPath(`heads/${input.workBranch}`);

  const baseRefResult = await githubApiRequest({
    fetchImpl: input.fetchImpl,
    url: `${repoUrl}/git/ref/${baseRef}`,
    method: "GET",
    token: input.token,
  });
  const baseCommitSha = parseRefObjectSha(
    baseRefResult,
    "github_base_ref_response_invalid",
  );

  const baseCommit = await githubApiRequest({
    fetchImpl: input.fetchImpl,
    url: `${repoUrl}/git/commits/${baseCommitSha}`,
    method: "GET",
    token: input.token,
  });
  const baseTreeSha = parseCommitTreeSha(baseCommit);

  const tree = await githubApiRequest({
    fetchImpl: input.fetchImpl,
    url: `${repoUrl}/git/trees`,
    method: "POST",
    token: input.token,
    body: {
      base_tree: baseTreeSha,
      tree: input.patchFiles.map(toGitTreeEntry),
    },
  });
  const treeSha = parseSha(tree, "github_tree_response_invalid");

  const commit = await githubApiRequest({
    fetchImpl: input.fetchImpl,
    url: `${repoUrl}/git/commits`,
    method: "POST",
    token: input.token,
    body: {
      message: input.commitMessage,
      tree: treeSha,
      parents: [baseCommitSha],
    },
  });
  const commitSha = parseSha(commit, "github_commit_response_invalid");

  const existingRef = await githubApiRequest({
    fetchImpl: input.fetchImpl,
    url: `${repoUrl}/git/ref/${workRef}`,
    method: "GET",
    token: input.token,
    allowNotFound: true,
  });

  if (existingRef) {
    await githubApiRequest({
      fetchImpl: input.fetchImpl,
      url: `${repoUrl}/git/refs/${workRef}`,
      method: "PATCH",
      token: input.token,
      body: { sha: commitSha, force: true },
    });
  } else {
    await githubApiRequest({
      fetchImpl: input.fetchImpl,
      url: `${repoUrl}/git/refs`,
      method: "POST",
      token: input.token,
      body: { ref: `refs/heads/${input.workBranch}`, sha: commitSha },
    });
  }

  return commitSha;
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
  const commitSha = input.patchFiles?.length
    ? await createPatchCommitBranch({
        fetchImpl,
        token,
        fullName,
        baseBranch,
        workBranch,
        patchFiles: input.patchFiles,
        commitMessage: input.commitMessage?.trim() || input.title,
      })
    : null;

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

  return { ...parsePullRequestResult(result), commitSha };
}
