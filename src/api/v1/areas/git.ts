import { listPullRequests, type CheckSummary, type PullRequestLink } from "../../../../shared/api/git.mjs";
import type { MyWorkPullRequest } from "../../../../shared/ticket-connectors.mjs";
import { listOpenPullRequestsFromEvents } from "../../db/github/open-pull-requests.js";
import { defineRoute, type ApiRoute } from "../route.js";
import { repoBinding, toRoomSummary } from "./rooms.js";

const PULL_REQUEST_LIMIT = 100;
const SUCCESSFUL_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

// Routes for the methods in shared/api/git.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listPullRequests, async (_input, { room, access }) => {
    if (access.kind !== "repo") return { repo: null, pullRequests: [], truncated: false };
    const repo = toRoomSummary(room, access, await repoBinding(room, access)).repo;
    const { pullRequests, truncated } = await listOpenPullRequestsFromEvents(room.id, { limit: PULL_REQUEST_LIMIT });
    return {
      repo: repo?.fullName ?? null,
      truncated,
      pullRequests: pullRequests.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        draft: pr.draft,
        headRef: pr.head_ref,
        baseRef: pr.base_ref,
        updatedAt: pr.updated_at,
        checks: summarizeChecks(pr.check_runs),
        checkRuns: pr.check_runs,
        reviews: {
          total: pr.reviews.length,
          approved: pr.reviews.filter((review) => review.state === "approved").length,
          changesRequested: pr.reviews.filter((review) => review.state === "changes_requested").length,
        },
        reviewers: pr.reviews,
        requestedReviewers: pr.requested_reviewers,
        taskIds: pr.task_ids,
      })),
    };
  }),
];

/** The same counting the board's PR badges use (`getTasksGitHubArtifactStatus`). */
function summarizeChecks(runs: ReadonlyArray<{ conclusion: string | null }>): CheckSummary {
  const summary = { total: runs.length, success: 0, failure: 0, pending: 0 };
  for (const run of runs) {
    const conclusion = run.conclusion?.toLowerCase();
    if (conclusion && SUCCESSFUL_CONCLUSIONS.has(conclusion)) summary.success++;
    else if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) summary.failure++;
    else summary.pending++;
  }
  return summary;
}

/** The pull request a task or release links, in the API's shape. Tasks and planning use it too. */
export function toPullRequestLink(pr: MyWorkPullRequest): PullRequestLink {
  const number = pr.number !== null && /^\d+$/.test(pr.number) ? Number(pr.number) : null;
  return {
    url: pr.url,
    number,
    title: pr.title,
    state: pr.merged ? "merged" : pr.state,
    draft: pr.draft,
    checks: pr.check_summary,
    reviews: pr.review_summary
      ? { total: pr.review_summary.total, approved: pr.review_summary.approved, changesRequested: pr.review_summary.changes_requested }
      : null,
  };
}
