import { listPullRequests, type CheckSummary, type PullRequestLink, type PullRequestList } from "../../../../shared/api/git.mjs";
import type { MyWorkPullRequest } from "../../../../shared/ticket-connectors.mjs";
import { listOpenPullRequestsFromEvents } from "../../db/github/open-pull-requests.js";
import { defineRoute, type ApiRoute } from "../route.js";
import { repoBinding, toRoomSummary } from "./rooms.js";

const PULL_REQUEST_LIMIT = 100;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ROOMS = 500;
const cache = new Map<string, { at: number; value: PullRequestList }>();
const SUCCESSFUL_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

// Routes for the methods in shared/api/git.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listPullRequests, async (_input, { room, access }) => {
    if (access.kind !== "repo") return { repo: null, pullRequests: [], truncated: false };
    // Room access is checked before this runs, so one room's answer may serve
    // every reader of that room for a short while.
    const cached = cache.get(room.id);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const binding = await repoBinding(room, access);
    const repo = toRoomSummary(room, access, binding).repo;
    if (!repo) return { repo: null, pullRequests: [], truncated: false };
    const { pullRequests, truncated } = await listOpenPullRequestsFromEvents(room.id, {
      repoRoomId: access.repoRoomName,
      host: repo.host,
      fullName: repo.fullName,
      repositoryId: binding?.repository_id ?? null,
    }, { limit: PULL_REQUEST_LIMIT });
    const value: PullRequestList = {
      repo: repo.fullName,
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
    remember(room.id, value);
    return value;
  }),
];

function remember(roomId: string, value: PullRequestList): void {
  if (cache.size >= CACHE_MAX_ROOMS) {
    const now = Date.now();
    for (const [key, entry] of cache) if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
    // Still full of fresh entries: drop the oldest (Map keeps insertion order).
    if (cache.size >= CACHE_MAX_ROOMS) cache.delete(cache.keys().next().value!);
  }
  cache.set(roomId, { at: Date.now(), value });
}

/** The same outcome sets the board's PR badges use (`getTasksGitHubArtifactStatus`). */
function summarizeChecks(runs: ReadonlyArray<{ conclusion: string | null }>): CheckSummary {
  const summary: CheckSummary = { total: runs.length, success: 0, failure: 0, pending: null };
  for (const run of runs) {
    const conclusion = run.conclusion?.toLowerCase();
    if (conclusion && SUCCESSFUL_CONCLUSIONS.has(conclusion)) summary.success++;
    else if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) summary.failure++;
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
    // Only completed runs are stored, so nothing is known to be pending.
    checks: pr.check_summary ? { ...pr.check_summary, pending: null } : null,
    reviews: pr.review_summary
      ? { total: pr.review_summary.total, approved: pr.review_summary.approved, changesRequested: pr.review_summary.changes_requested }
      : null,
  };
}
