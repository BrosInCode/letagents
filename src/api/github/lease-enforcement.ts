import type { CoordinationDecisionResult, CoordinationLeaseLike } from "../coordination-policy.js";
import type { GitHubAppConfig } from "./config.js";
import { githubRequestJson, mintInstallationToken } from "./app-client.js";
import type { RepoPullRequestRef } from "../repo-workflow.js";

// Re-exported for existing importers; the implementation now lives in app-client.
export { createGitHubAppJwt } from "./app-client.js";

export const LETAGENTS_LEASE_CHECK_NAME = "letagents-lease";

export type GitHubLeaseEnforcementMode = "off" | "checks" | "flag" | "close";

export interface GitHubLeaseCheckRunPlan {
  name: typeof LETAGENTS_LEASE_CHECK_NAME;
  headSha: string;
  conclusion: "success" | "failure";
  title: string;
  summary: string;
  text: string;
}

export interface GitHubLeaseEnforcementPlan {
  checkRun: GitHubLeaseCheckRunPlan | null;
  commentBody: string | null;
  closePullRequest: boolean;
}

export interface GitHubLeasePublishResult {
  status: "published" | "skipped";
  reason?: string;
}

const DEFAULT_PROTECTED_BRANCH_NAMES = new Set([
  "main",
  "master",
  "staging",
  "production",
]);

const CLOSEABLE_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

function normalizeBranchRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^refs\/heads\//, "");
}

function slugifyBranchSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agent";
}

function isProtectedBranchRef(
  branchRef: string | null | undefined,
  protectedBranchNames: ReadonlySet<string>
): boolean {
  const normalized = normalizeBranchRef(branchRef);
  return normalized ? protectedBranchNames.has(normalized.toLowerCase()) : false;
}

function getDecisionLease(decision: CoordinationDecisionResult): CoordinationLeaseLike | null {
  return decision.kind === "allow" ? decision.lease : decision.lease ?? null;
}

function buildFailureText(input: {
  linkedTaskId: string;
  pullRequest: Pick<RepoPullRequestRef, "number" | "headRef" | "url">;
  decision: CoordinationDecisionResult;
  protectedBranch: boolean;
}): string {
  const lease = getDecisionLease(input.decision);
  const expectedBranch = lease?.branch_ref
    ? ` Expected leased branch: ${lease.branch_ref}.`
    : "";

  if (input.protectedBranch) {
    return (
      `PR #${input.pullRequest.number} is linked to ${input.linkedTaskId}, ` +
      `but head branch "${input.pullRequest.headRef}" is protected.${expectedBranch}`
    );
  }

  const reason = input.decision.kind === "deny"
    ? input.decision.reason
    : "The PR does not satisfy the LetAgents lease policy.";
  return (
    `PR #${input.pullRequest.number} is not authorized for ${input.linkedTaskId}. ` +
    `${reason}${expectedBranch}`
  );
}

export function resolveGitHubLeaseEnforcementMode(
  value: string | null | undefined = process.env.LETAGENTS_GITHUB_ENFORCEMENT_MODE
): GitHubLeaseEnforcementMode {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "off":
    case "checks":
    case "flag":
    case "close":
      return normalized;
    default:
      return "checks";
  }
}

export function buildLeasedBranchRef(input: {
  taskId: string;
  agentKey: string;
}): string {
  return `letagents/${input.taskId}/${slugifyBranchSegment(input.agentKey)}`;
}

export function buildGitHubLeaseEnforcementPlan(input: {
  action: string;
  linkedTaskId: string;
  pullRequest: Pick<
    RepoPullRequestRef,
    "number" | "url" | "headRef" | "headSha"
  >;
  decision: CoordinationDecisionResult;
  mode?: GitHubLeaseEnforcementMode;
  protectedBranchNames?: ReadonlySet<string>;
}): GitHubLeaseEnforcementPlan | null {
  const mode = input.mode ?? resolveGitHubLeaseEnforcementMode();
  if (mode === "off") {
    return null;
  }

  const protectedBranch = isProtectedBranchRef(
    input.pullRequest.headRef,
    input.protectedBranchNames ?? DEFAULT_PROTECTED_BRANCH_NAMES
  );
  const authorized = input.decision.kind === "allow" && !protectedBranch;
  const lease = getDecisionLease(input.decision);
  const failureText = authorized
    ? null
    : buildFailureText({
        linkedTaskId: input.linkedTaskId,
        pullRequest: input.pullRequest,
        decision: input.decision,
        protectedBranch,
      });
  const successText = lease
    ? (
        `PR #${input.pullRequest.number} is linked to ${input.linkedTaskId} ` +
        `and matches active work lease ${lease.id}.`
      )
    : `PR #${input.pullRequest.number} is linked to ${input.linkedTaskId}.`;
  const text = authorized ? successText : failureText ?? "";
  const summary = authorized
    ? `${text} Required ${LETAGENTS_LEASE_CHECK_NAME} checks can gate protected branch merges.`
    : text;

  return {
    checkRun: input.pullRequest.headSha
      ? {
          name: LETAGENTS_LEASE_CHECK_NAME,
          headSha: input.pullRequest.headSha,
          conclusion: authorized ? "success" : "failure",
          title: authorized ? "LetAgents lease verified" : "LetAgents lease required",
          summary,
          text,
        }
      : null,
    commentBody:
      !authorized && (mode === "flag" || mode === "close")
        ? [
            `LetAgents could not verify an active work lease for ${input.linkedTaskId}.`,
            "",
            failureText,
            "",
            `Required check: \`${LETAGENTS_LEASE_CHECK_NAME}\``,
          ].join("\n")
        : null,
    closePullRequest:
      !authorized &&
      mode === "close" &&
      CLOSEABLE_PULL_REQUEST_ACTIONS.has(input.action),
  };
}

export async function publishGitHubLeaseEnforcement(input: {
  config: GitHubAppConfig;
  installationId: string | null;
  repositoryFullName: string;
  pullRequestNumber: number;
  plan: GitHubLeaseEnforcementPlan | null;
  detailsUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<GitHubLeasePublishResult> {
  if (!input.plan) {
    return { status: "skipped", reason: "no_plan" };
  }
  if (!input.installationId) {
    return { status: "skipped", reason: "missing_installation" };
  }
  if (!input.config.appId || !input.config.privateKey) {
    return { status: "skipped", reason: "missing_github_app_credentials" };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const token = await mintInstallationToken({
    config: input.config,
    installationId: input.installationId,
    fetchImpl,
  });
  const repoPath = encodeURI(input.repositoryFullName);

  if (input.plan.checkRun) {
    await githubRequestJson({
      fetchImpl,
      url: `https://api.github.com/repos/${repoPath}/check-runs`,
      method: "POST",
      token,
      body: {
        name: input.plan.checkRun.name,
        head_sha: input.plan.checkRun.headSha,
        status: "completed",
        conclusion: input.plan.checkRun.conclusion,
        details_url: input.detailsUrl ?? undefined,
        output: {
          title: input.plan.checkRun.title,
          summary: input.plan.checkRun.summary,
          text: input.plan.checkRun.text,
        },
      },
    });
  }

  if (input.plan.commentBody) {
    await githubRequestJson({
      fetchImpl,
      url: `https://api.github.com/repos/${repoPath}/issues/${input.pullRequestNumber}/comments`,
      method: "POST",
      token,
      body: { body: input.plan.commentBody },
    });
  }

  if (input.plan.closePullRequest) {
    await githubRequestJson({
      fetchImpl,
      url: `https://api.github.com/repos/${repoPath}/pulls/${input.pullRequestNumber}`,
      method: "PATCH",
      token,
      body: { state: "closed" },
    });
  }

  return { status: "published" };
}
